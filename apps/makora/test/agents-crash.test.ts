import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationRecord, type Cursor, ToolResultEntry } from "@earendil-works/pi-durable";
import { AgentsDoc, MessageLogDoc } from "../src/agents/docs.ts";
import { openApp } from "../src/app.ts";
import { openSession } from "../src/session.ts";
import { latestSession } from "../src/sessions.ts";
import { messageText } from "../src/transcript-rows.ts";

const context = BACKGROUND_CONTEXT;
const APP = fileURLToPath(new URL("../", import.meta.url));

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run makora in print mode with the fake model, in `repo`, with `home` as its makora home. */
function makora(home: string, repo: string, args: readonly string[]): ChildProcess {
	return spawn(
		process.execPath,
		["--import", join(APP, "src/source.ts"), join(APP, "src/main.ts"), "--fake", ...args],
		{ cwd: repo, env: { ...process.env, MAKORA_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
	);
}

function exited(child: ChildProcess): Promise<{ code: number | null; output: string }> {
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	return new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
}

// A real makora process is killed while its children run, so the test waits on files it writes with a deadline.
async function until(what: string, check: () => boolean, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

describe("subagents after a crash", () => {
	it("resume with the session, run nothing twice, and get a deleted review worktree back", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-agents-crash-")));
		const home = join(root, "home");
		const repo = join(root, "repo");
		const review = join(root, "review-worktrees");
		mkdirSync(home);
		mkdirSync(repo);
		writeFileSync(join(home, "settings.json"), JSON.stringify({ worktrees: { review, write: join(root, "write") } }));
		writeFileSync(join(repo, "README.md"), "# demo\n");
		git(repo, ["init", "-q", "-b", "main"]);
		git(repo, ["add", "README.md"]);
		git(repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"]);

		const first = makora(home, repo, ["-p", "resume-team"]);
		const firstExit = exited(first);
		const sessions = join(home, "sessions");
		const kernels = () => {
			const [id] = existsSync(sessions) ? readdirSync(sessions) : [];
			const dir = id === undefined ? undefined : join(sessions, id, "kernels");
			return dir !== undefined && existsSync(dir) ? readdirSync(dir).length : 0;
		};
		// The root's kernel and both slow children's kernels: the children are inside their three-second cells.
		await until("three kernels", () => kernels() >= 3);
		await sleep(500);
		first.kill("SIGKILL");
		const killed = await firstExit;
		assert.equal(killed.code, null, `makora was killed:\n${killed.output}`);

		const meta = latestSession(sessions, repo)!;
		const reviewDir = join(review, readdirSync(review)[0]!, meta.id);
		const worktrees = readdirSync(reviewDir).map((name) => join(reviewDir, name));
		assert.equal(worktrees.length, 3);
		for (const worktree of worktrees) rmSync(worktree, { recursive: true, force: true });

		const second = await exited(makora(home, repo, ["--continue", "-p", ""]));
		assert.equal(second.code, 0, second.output);
		assert.match(second.output, /Restored the session; resuming \d+ unfinished task\(s\)\./);

		const app = openApp(home, true);
		const session = await openSession(app, meta, {}, context);
		try {
			const agents = (await session.harness.snapshot(AgentsDoc, session.root.id, context))!.agents;
			assert.deepEqual(
				Object.values(agents).map((each) => `${each.name}:${each.state.kind}`),
				["slow-a:done", "slow-b:done", "talker:done"],
			);
			const conversations: ConversationRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await session.harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
				conversations.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			assert.equal(conversations.length, 4, "the root and its three children, none twice");

			const log = (await session.harness.snapshot(MessageLogDoc, context))!.messages;
			assert.deepEqual(
				log.map((each) => `${each.from} -> ${each.to}: ${each.text}`),
				["talker -> slow-a: hello sibling"],
			);
			const slowA = await session.harness.conversation(agents["slow-a"]!.conversationId, context);
			const entries = (await slowA!.entries({ order: "ascending" }, 200, undefined, context)).items;
			const heard = entries.filter(
				(entry) => entry.model?.[0] && messageText(entry.model[0]).includes("hello sibling"),
			);
			assert.equal(heard.length, 1, "slow-a read the message once");
			const cells = entries.flatMap((entry) =>
				ToolResultEntry.is(entry) && entry.model?.[0] ? [messageText(entry.model[0])] : [],
			);
			assert.match(
				cells.at(-1)!,
				/^Kernel restarted empty: .*\nREADME: # demo$/,
				"the cell after the restart ran in its checkout",
			);

			const worktree = agents["slow-a"]!.worktree;
			assert.ok(worktree.kind === "worktree");
			assert.ok(existsSync(join(worktree.root, "README.md")), "the deleted review worktree was recreated");
			assert.equal(git(worktree.root, ["rev-parse", "HEAD"]), worktree.baseCommit, "at the same commit");

			// Spawning a name again reattaches to that child.
			const again = await session.root.submit(
				{
					type: "input",
					content: '```python\nprint((await spawn("slow-a", "steady", mode="review"))["state"]["kind"])\n```',
				},
				context,
			);
			assert.equal((await again.wait(context)).status, "done");
			const after = (await session.harness.snapshot(AgentsDoc, session.root.id, context))!.agents;
			assert.equal(Object.keys(after).length, 3);
			assert.equal(after["slow-a"]!.conversationId, agents["slow-a"]!.conversationId);
		} finally {
			await session.close();
		}
	});
});
