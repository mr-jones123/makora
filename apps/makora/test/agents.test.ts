import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { AgentsDoc, MessageLogDoc, SlotsDoc } from "../src/agents/docs.ts";
import { AgentUnreachable, admitInput, identityOf } from "../src/agents/family.ts";
import { AGENT_RESULT_ENTRY, type AgentResultData } from "../src/agents/prompts.ts";
import type { AgentRecord } from "../src/agents/types.ts";
import { openApp } from "../src/app.ts";
import { type MakoraSession, type OpenOptions, openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { messageText } from "../src/transcript-rows.ts";
import { removeRow } from "../src/tui/agent-actions.ts";
import { loadAgents } from "../src/tui/agents.ts";
import { dashboardRows } from "../src/tui/dashboard.ts";

const context = BACKGROUND_CONTEXT;

type Workspace = { readonly home: string; readonly repo: string; readonly review: string; readonly write: string };

/** A temp makora home whose settings put worktrees under the temp folder, and a git repository with one commit. */
function workspace(settings: Record<string, unknown> = {}): Workspace {
	// The real path: git reports top levels with macOS's /var -> /private/var link resolved.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-agents-")));
	const where = {
		home: join(root, "home"),
		repo: join(root, "repo"),
		review: join(root, "review-worktrees"),
		write: join(root, "write-worktrees"),
	};
	mkdirSync(where.home);
	mkdirSync(where.repo);
	writeFileSync(
		join(where.home, "settings.json"),
		JSON.stringify({ worktrees: { review: where.review, write: where.write }, ...settings }),
	);
	writeFileSync(join(where.repo, "README.md"), "# demo\n");
	git(where.repo, ["init", "-q", "-b", "main"]);
	git(where.repo, ["add", "README.md"]);
	git(where.repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"]);
	return where;
}

function open(where: Workspace, options: OpenOptions = {}): Promise<MakoraSession> {
	const app = openApp(where.home, true);
	return openSession(app, createSession(app.paths.sessions, where.repo), options, context);
}

/** Write the home's settings: worktrees under the workspace, and `agents`. */
function writeSettings(where: Workspace, agents: Record<string, unknown>): void {
	const worktrees = { review: where.review, write: where.write };
	writeFileSync(join(where.home, "settings.json"), JSON.stringify({ worktrees, agents }));
}

/** Set the repository's worktree setup command. */
function setupCommand(where: Workspace, command: string): void {
	mkdirSync(join(where.repo, ".makora"), { recursive: true });
	writeFileSync(join(where.repo, ".makora", "settings.json"), JSON.stringify({ worktreeSetup: command }));
}

/** The settings entry that approves `command` as the setup of the workspace's repository. */
function approval(where: Workspace, command: string) {
	return { repository: where.repo, sha256: createHash("sha256").update(command).digest("hex") };
}

/** Run `code` in a cell that prints `error: <message>` when it raises. */
function guarded(code: string): string {
	return `try:\n    ${code.replaceAll("\n", "\n    ")}\nexcept Exception as error:\n    print("error:", error)`;
}

/** Wait until the anchor of `conversation`'s child `name` has ended. */
async function anchorEnded(session: MakoraSession, conversation: Conversation, name: string): Promise<void> {
	const runtime = (await session.harness.snapshot(AgentsDoc, conversation.id, context))!.runtime[name]!;
	await until(`${name}'s anchor to end`, async () => {
		const graph = await session.harness.watchTaskGraph(context);
		const live = Object.hasOwn(graph.value.tasks, String(runtime.anchor));
		await graph.stop();
		return live ? undefined : true;
	});
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function ask(conversation: Conversation, text: string): Promise<void> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	assert.equal(settled.status, "done");
}

/** Run `code` as one cell of `conversation` (the fake model runs a fenced python block) and return its output. */
async function cell(conversation: Conversation, code: string): Promise<string> {
	await ask(conversation, `\`\`\`python\n${code}\n\`\`\``);
	const page = await conversation.entries({ order: "descending" }, 50, undefined, context);
	for (const entry of page.items) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult" && message.toolName === "python") return messageText(message);
	}
	throw new Error("no python cell");
}

/** Wait until every named child of `conversation` is in a state other than queued or running; their records. */
function settled(session: MakoraSession, conversation: Conversation, names: readonly string[]) {
	return until(`${names.join(", ")} to finish`, async () => {
		const children = await records(session, conversation.id);
		const finished = names.every((name) => {
			const kind = children[name]?.state.kind;
			return kind !== undefined && kind !== "queued" && kind !== "running";
		});
		return finished ? children : undefined;
	});
}

/** The output of the newest `tool` result of `conversation`. */
async function lastResult(conversation: Conversation, tool: string): Promise<string> {
	const page = await conversation.entries({ order: "descending" }, 100, undefined, context);
	for (const entry of page.items) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult" && message.toolName === tool) return messageText(message);
	}
	throw new Error(`no ${tool} result`);
}

/** The records of conversation `id`'s children, by name. */
async function records(session: MakoraSession, id: ConversationId): Promise<Record<string, AgentRecord>> {
	return { ...((await session.harness.snapshot(AgentsDoc, id, context))?.agents ?? {}) };
}

// Children run real kernels and a fake model streaming at a fixed rate, so the test waits on committed state with a
// deadline rather than on a fake clock.
async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** The user's tree as git sees it: status, HEAD, branch and the staged files. */
function userTree(repo: string) {
	return {
		status: git(repo, ["status", "--porcelain"]),
		head: git(repo, ["rev-parse", "HEAD"]),
		branch: git(repo, ["branch", "--show-current"]),
		staged: git(repo, ["diff", "--cached", "--name-only"]),
	};
}

describe("subagents", () => {
	it("run review and write children in parallel, each in its own worktree, and hand back results", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			const before = userTree(where.repo);
			await ask(session.root, "trio");
			let mostRunning = 0;
			const done = await until("three finished children", async () => {
				const children = await records(session, session.root.id);
				const states = Object.values(children).map((each) => each.state.kind);
				mostRunning = Math.max(mostRunning, states.filter((state) => state === "running").length);
				return states.length === 3 && states.every((state) => state === "done") ? children : undefined;
			});
			assert.ok(mostRunning >= 2, `children ran in parallel (at most ${mostRunning} at once)`);

			const base = before.head;
			for (const name of ["reviewer-a", "reviewer-b"]) {
				const record = done[name]!;
				const worktree = record.worktree;
				assert.equal(record.mode, "review");
				assert.ok(worktree.kind === "worktree");
				assert.ok(worktree.root.startsWith(`${where.review}/repo-`), worktree.root);
				assert.equal(worktree.baseCommit, base);
				assert.equal(git(worktree.root, ["rev-parse", "HEAD"]), base, "detached at the ref");
				assert.throws(() => git(worktree.root, ["symbolic-ref", "-q", "HEAD"]), "no branch checked out");
				assert.ok(record.state.kind === "done");
				assert.equal(record.state.result.mode, "review");
				assert.match(record.state.result.summary, /README: # demo/);
			}

			const writer = done.writer!;
			assert.ok(writer.worktree.kind === "worktree" && writer.worktree.branch !== undefined);
			assert.ok(writer.worktree.root.startsWith(`${where.write}/repo-`), writer.worktree.root);
			assert.equal(git(writer.worktree.root, ["branch", "--show-current"]), writer.worktree.branch);
			assert.ok(writer.state.kind === "done" && writer.state.result.mode === "write");
			const { result } = writer.state;
			assert.equal(git(where.repo, ["rev-parse", writer.worktree.branch]), result.headCommit);
			assert.equal(git(where.repo, ["show", `${result.headCommit}:CHANGES.md`]), "writer was here");
			assert.deepEqual(result.diffStat, { files: 1, added: 1, removed: 0 });
			assert.equal(git(where.repo, ["log", "-1", "--format=%an", result.headCommit]), "makora");

			// The parent was not waiting, so each result came back as a follow-up input.
			await session.root.waitForIdle(context);
			const page = await session.root.entries({}, 200, undefined, context);
			const reported = page.items.flatMap((entry) => {
				if (entry.kind !== AGENT_RESULT_ENTRY) return [];
				// Written by the anchor's report.
				const data = entry.data as AgentResultData;
				return [data.name];
			});
			assert.deepEqual(reported.sort(), ["reviewer-a", "reviewer-b", "writer"]);

			assert.deepEqual(userTree(where.repo), before, "the user's index, branch and status are unchanged");
		} finally {
			await session.close();
		}
	});

	it("merge a write child's branch into the main tree, and give back conflicts with the tree left clean", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("writer", "write-change", mode="write")');
			const before = userTree(where.repo);
			await settled(session, session.root, ["writer"]);
			assert.deepEqual(userTree(where.repo), before, "nothing reaches the user's tree before the merge");

			const merged = await cell(session.root, 'print(await merge("writer"))');
			const head = git(where.repo, ["rev-parse", "HEAD"]);
			assert.match(merged, new RegExp(`'merged': True, 'commit': '${head}'`));
			assert.equal(git(where.repo, ["show", "HEAD:CHANGES.md"]), "writer was here");
			assert.equal(git(where.repo, ["rev-parse", "HEAD^1"]), before.head, "a merge commit on the user's branch");
			assert.equal(git(where.repo, ["status", "--porcelain"]), "");
			const record = (await records(session, session.root.id)).writer!;
			assert.ok(record.state.kind === "merged");
			assert.equal(record.state.mergeCommit, head);

			// A second child writes the same file from the old base; the user's branch now has another version.
			await cell(session.root, `await spawn("rival", "write-change", mode="write", base="${before.head}")`);
			await settled(session, session.root, ["rival"]);
			writeFileSync(join(where.repo, "CHANGES.md"), "the user's own line\n");
			git(where.repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qam", "user edit"]);
			const userHead = git(where.repo, ["rev-parse", "HEAD"]);
			const conflict = await cell(session.root, 'print(await merge("rival"))');
			assert.match(conflict, /\{'conflicts': \['CHANGES\.md'\]\}/);
			assert.equal(git(where.repo, ["status", "--porcelain"]), "", "the merge was aborted: the tree is clean");
			assert.equal(git(where.repo, ["rev-parse", "HEAD"]), userHead);
			assert.throws(() => git(where.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
			assert.equal((await records(session, session.root.id)).rival?.state.kind, "done", "a conflict keeps it done");
		} finally {
			await session.close();
		}
	});

	it("watch the run a user starts by typing into a finished child, then record and report its new result", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("reviewer", "review", mode="review")');
			const first = (await settled(session, session.root, ["reviewer"])).reviewer!;
			assert.ok(first.state.kind === "done");
			const firstAt = first.state.at;
			const child = (await session.harness.conversation(first.conversationId, context))!;

			await session.submit(child, "```python\nprint('asked again')\n```", context);
			const woken = (await records(session, session.root.id)).reviewer?.state.kind;
			assert.ok(woken === "queued" || woken === "running", `the input woke it (${woken})`);
			const second = await until("the second result", async () => {
				const record = (await records(session, session.root.id)).reviewer!;
				return record.state.kind === "done" && record.state.at > firstAt ? record.state : undefined;
			});
			assert.match(second.result.summary, /asked again/);

			await session.root.waitForIdle(context);
			const page = await session.root.entries({}, 200, undefined, context);
			const reports = page.items.filter(
				(entry) => entry.kind === AGENT_RESULT_ENTRY && (entry.data as AgentResultData).name === "reviewer",
			);
			assert.equal(reports.length, 2, "the parent heard about both runs");
		} finally {
			await session.close();
		}
	});

	it("queue a woken child for a running slot like a first run, and stop a woken run past its minutes", async () => {
		const where = workspace({ agents: { maxRunning: 1 } });
		const session = await open(where);
		try {
			const quick = '```python\nprint("first run")\n```';
			await cell(
				session.root,
				`await spawn("sleepy", ${JSON.stringify(quick)}, mode="review", budget={"minutes": 0.05})`,
			);
			const first = (await settled(session, session.root, ["sleepy"])).sleepy!;
			assert.ok(first.state.kind === "done");
			const firstAt = first.state.at;

			const slow = '```python\nprint((await bash("sleep 8; echo blocked")).output.strip())\n```';
			await cell(session.root, `await spawn("blocker", ${JSON.stringify(slow)}, mode="review")`);
			await until("the blocker to hold the slot", async () =>
				(await records(session, session.root.id)).blocker?.state.kind === "running" ? true : undefined,
			);
			assert.match(await cell(session.root, 'print(await send("sleepy", "once more"))'), /'status': 'delivered'/);
			const waiting = await records(session, session.root.id);
			assert.deepEqual([waiting.sleepy?.state.kind, waiting.blocker?.state.kind], ["queued", "running"]);
			let ranBeforeTheSlotFreed = false;
			await until("the woken run's result", async () => {
				const children = await records(session, session.root.id);
				const { sleepy, blocker } = children;
				if (sleepy?.state.kind === "running" && blocker?.state.kind === "running") ranBeforeTheSlotFreed = true;
				return sleepy?.state.kind === "done" && sleepy.state.at > firstAt ? true : undefined;
			});
			assert.equal(ranBeforeTheSlotFreed, false, "the woken child waited for the blocker's slot");

			const child = (await session.harness.conversation(first.conversationId, context))!;
			await session.submit(
				child,
				'```python\nprint((await bash("sleep 10; echo late")).output.strip())\n```',
				context,
			);
			const stopped = await until("the woken run to time out", async () => {
				const state = (await records(session, session.root.id)).sleepy?.state;
				return state?.kind === "stopped" ? state : undefined;
			});
			assert.deepEqual([stopped.reason, stopped.detail], ["time", "0.05 minutes passed"]);
		} finally {
			await session.close();
		}
	});

	it("queue a child for a running slot again after a first run that waited for one", async () => {
		const where = workspace({ agents: { maxRunning: 1 } });
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("blocker", "doze", mode="review")');
			await until("the blocker to run", async () =>
				(await records(session, session.root.id)).blocker?.state.kind === "running" ? true : undefined,
			);
			await cell(session.root, 'await spawn("twice", "review", mode="review")');
			assert.equal((await records(session, session.root.id)).twice?.state.kind, "queued");
			await cell(session.root, 'await stop("blocker")');
			const first = (await settled(session, session.root, ["twice"])).twice!;
			assert.ok(first.state.kind === "done");

			await cell(session.root, 'await spawn("again", "doze", mode="review")');
			await until("the second blocker to run", async () =>
				(await records(session, session.root.id)).again?.state.kind === "running" ? true : undefined,
			);
			assert.match(await cell(session.root, 'print(await send("twice", "once more"))'), /'status': 'delivered'/);
			assert.equal((await records(session, session.root.id)).twice?.state.kind, "queued");
			await cell(session.root, 'await stop("again")');
			const firstAt = first.state.at;
			await until(
				"the woken run's result",
				async () => {
					const state = (await records(session, session.root.id)).twice?.state;
					return state?.kind === "done" && state.at > firstAt ? true : undefined;
				},
				20_000,
			);
		} finally {
			await session.close();
		}
	});

	it("remove a child's worktree, keep an unmerged write branch, and remove a parent's children with it", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await cell(
				session.root,
				'await spawn("reviewer", "review", mode="review")\nawait spawn("writer", "write-change", mode="write")\nawait spawn("keeper", "nest-keep", mode="review")',
			);
			const done = await settled(session, session.root, ["reviewer", "writer", "keeper"]);
			const reviewer = done.reviewer!;
			const writer = done.writer!;
			assert.ok(reviewer.worktree.kind === "worktree" && writer.worktree.kind === "worktree");
			assert.ok(existsSync(reviewer.worktree.root) && existsSync(writer.worktree.root));
			const branch = writer.worktree.branch!;

			assert.match(await cell(session.root, 'print(await remove("reviewer"))'), /'removed': \['reviewer'\]/);
			assert.equal(existsSync(reviewer.worktree.root), false, "the review worktree is gone");
			assert.match(await cell(session.root, 'print(await remove("writer"))'), /'removed': \['writer'\]/);
			assert.equal(existsSync(writer.worktree.root), false, "the write worktree is gone");
			assert.equal(
				git(where.repo, ["rev-parse", branch]),
				(writer.state as { result: { headCommit: string } }).result.headCommit,
			);

			// The keeper's grandchild runs a slow cell; removing the keeper stops and removes it first.
			const keeper = done.keeper!;
			const grandchild = await until(
				"the grandchild",
				async () => (await records(session, keeper.conversationId)).grandchild,
			);
			assert.ok(grandchild.worktree.kind === "worktree");
			assert.match(
				await cell(session.root, 'print(await remove("keeper"))'),
				/'removed': \['grandchild', 'keeper'\]/,
			);
			const after = await records(session, keeper.conversationId);
			assert.equal(after.grandchild?.state.kind, "removed");
			assert.equal(existsSync(grandchild.worktree.root), false);
			const states = Object.values(await records(session, session.root.id)).map((each) => each.state.kind);
			assert.deepEqual(states, ["removed", "removed", "removed"]);
			assert.equal(git(where.repo, ["worktree", "list"]).split("\n").length, 1, "only the main worktree is left");
			const graph = await session.harness.watchTaskGraph(context);
			const anchors = Object.values(graph.value.tasks).filter((task) => task.kind === "makora.agent-anchor");
			await graph.stop();
			assert.deepEqual(anchors, [], "every anchor ended");
		} finally {
			await session.close();
		}
	});

	it("deliver a reviewer's message to the writer as a sibling's agent_message, and refuse over-limit sends", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await ask(session.root, "agents");
			const done = await records(session, session.root.id);
			assert.deepEqual(
				Object.values(done).map((each) => `${each.name}:${each.state.kind}`),
				["reviewer-a:done", "reviewer-b:done", "writer:merged"],
			);
			const writer = await session.harness.conversation(done.writer!.conversationId, context);
			const page = await writer!.entries({ order: "ascending" }, 200, undefined, context);
			const received = page.items.flatMap((entry) => {
				const message = entry.model?.[0];
				return message === undefined ? [] : [messageText(message)];
			});
			const message =
				'<agent_message from="reviewer-b" relationship="sibling">\nreviewer-b says: README.md needs a usage line\n</agent_message>';
			assert.ok(
				received.some((text) => text.includes(message)),
				`the writer read the message:\n${received.join("\n---\n")}`,
			);
			const log = (await session.harness.snapshot(MessageLogDoc, context))!.messages;
			assert.deepEqual(
				log.map((each) => `${each.from} -> ${each.to}: ${each.text}`),
				["reviewer-b -> writer: reviewer-b says: README.md needs a usage line"],
			);
			assert.equal(git(where.repo, ["show", "HEAD:CHANGES.md"]), "usage line added", "merged after the message");

			const limits = await cell(
				session.root,
				[
					"try:",
					'    await send("reviewer-a", "x" * 16385)',
					"except Exception as error:",
					'    print("size:", error)',
					"outcomes = []",
					"for i in range(4):",
					"    try:",
					'        outcomes.append(await send("reviewer-a", f"note {i}"))',
					"    except Exception as error:",
					"        outcomes.append(str(error))",
					'print("fourth:", outcomes[-1])',
				].join("\n"),
			);
			assert.match(limits, /size: Agent message is too long: 16385 chars exceeds 16384/);
			assert.match(limits, /fourth: Agent message rate limit exceeded: 3 messages, then one per 1 s/);
			await settled(session, session.root, ["reviewer-a"]);
			await session.root.waitForIdle(context);
		} finally {
			await session.close();
		}
	});

	it("wait_agents returns on the first finished child with policy any, and on a message", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await ask(session.root, "first-of");
			const first = await lastResult(session.root, "wait_agents");
			assert.match(first, /^quick: done\nThe `python` call finished\. Its output:\n\n```\nREADME: # demo\n```/m);
			assert.match(first, /^slow: running$/m);
			await settled(session, session.root, ["slow"]);
			await session.root.waitForIdle(context);

			const other = workspace();
			const second = await open(other);
			try {
				await ask(second.root, "hear-from");
				const heard = await lastResult(second.root, "wait_agents");
				assert.equal(
					heard,
					'<agent_message from="talker" relationship="child">\nhello from below\n</agent_message>',
				);
				assert.equal(
					(await records(second, second.root.id)).slow?.state.kind,
					"running",
					"woken before slow finished",
				);
				await settled(second, second.root, ["slow", "talker"]);
				await second.root.waitForIdle(context);
			} finally {
				await second.close();
			}
		} finally {
			await session.close();
		}
	});

	it("stop a child past its turns or its usd with that reason, refuse a spawn at depth 3, and queue a fifth child", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await cell(
				session.root,
				[
					'await spawn("turns", "python", mode="review", budget={"turns": 1})',
					'await spawn("money", "python", mode="review", budget={"usd": 0.0001})',
					'await spawn("nester", "nest", mode="review")',
				].join("\n"),
			);
			const done = await settled(session, session.root, ["turns", "money", "nester"]);
			assert.deepEqual(done.turns?.state.kind === "stopped" && [done.turns.state.reason, done.turns.state.detail], [
				"turns",
				"the turn budget ran out",
			]);
			assert.ok(
				done.money?.state.kind === "stopped" && done.money.state.reason === "cost",
				JSON.stringify(done.money),
			);
			assert.match(done.money.state.detail ?? "", /^spent \$\d+\.\d{4} of \$0\.0001$/);
			const money = await session.harness.conversation(done.money.conversationId, context);
			const cells = (await money!.entries({}, 100, undefined, context)).items.filter(
				(entry) => entry.model?.[0]?.role === "toolResult",
			);
			assert.equal(cells.length, 1, "no request after the round that went over");

			// A child stopped for cost takes no more input; one stopped for turns only from its parent or the user.
			assert.match(
				await cell(session.root, guarded('print(await send("money", "carry on"))')),
				/error: money was stopped for cost/,
			);
			const turns = (await session.harness.conversation(done.turns!.conversationId, context))!;
			const turnsSelf = await identityOf(session.harness, turns.id, context);
			await assert.rejects(
				session.harness.commit(
					(tx) =>
						admitInput(
							tx,
							{ handle: turns, self: turnsSelf },
							{ content: "from a sibling", requestId: "sibling-wake", from: "sibling" },
							"steer",
						),
					context,
				),
				(error) => error instanceof AgentUnreachable && /only its parent or the user/.test(error.message),
			);
			assert.match(
				await cell(session.root, 'print(await send("turns", "one more turn"))'),
				/'to': 'turns', 'status': 'delivered'/,
			);
			await settled(session, session.root, ["turns"]);

			const nester = done.nester!;
			assert.equal(nester.state.kind, "done");
			const grandchild = (await records(session, nester.conversationId)).grandchild!;
			assert.equal(grandchild.depth, 2);
			assert.equal(grandchild.state.kind, "done");
			const deep = await session.harness.conversation(grandchild.conversationId, context);
			const refused = await lastResult(deep!, "python");
			assert.match(refused, /^refused: Tool spawn is not available/);
			assert.equal(Object.keys(await records(session, grandchild.conversationId)).length, 0);

			await cell(session.root, 'for i in range(1, 6):\n    await spawn(f"slow-{i}", "slow", mode="review")');
			const names = ["slow-1", "slow-2", "slow-3", "slow-4", "slow-5"];
			let queuedWhileFull = false;
			let startedBeforeAnyDone = false;
			let queuedName: string | undefined;
			await until("five slow children to finish", async () => {
				const children = await records(session, session.root.id);
				const kinds = names.map((name) => children[name]?.state.kind);
				const running = kinds.filter((kind) => kind === "running").length;
				const queued = names.filter((name) => children[name]?.state.kind === "queued");
				if (queued.length === 1 && running === 4) {
					queuedWhileFull = true;
					queuedName = queued[0];
				}
				if (queuedName !== undefined && children[queuedName]?.state.kind === "running" && !kinds.includes("done")) {
					startedBeforeAnyDone = true;
				}
				return kinds.every((kind) => kind === "done") ? true : undefined;
			});
			assert.ok(queuedWhileFull, "a fifth child queued while four ran");
			assert.equal(startedBeforeAnyDone, false, "the queued child started only once another finished");
		} finally {
			await session.close();
		}
	});

	it("run the project's worktree setup once the user approved it, without provider keys, and stop the child when it fails", async () => {
		const where = workspace();
		const command = "echo prepared > SETUP.txt && (printenv MAKORA_TEST_API_KEY || echo no key) && echo setup ok";
		setupCommand(where, command);
		process.env.MAKORA_TEST_API_KEY = "secret";
		let session = await open(where);
		try {
			await cell(session.root, 'await spawn("unapproved", "review", mode="review")');
			const unapproved = (await settled(session, session.root, ["unapproved"])).unapproved!;
			assert.equal(unapproved.state.kind, "done", "a child whose setup is not approved still runs");
			assert.ok(unapproved.worktree.kind === "worktree");
			assert.equal(existsSync(join(unapproved.worktree.root, "SETUP.txt")), false, "the command did not run");
			const { sha256 } = approval(where, command);
			const [told] = await notices(session, unapproved.conversationId);
			assert.ok(told?.includes("not approved") && told.includes(command) && told.includes(sha256), told);
			await session.root.waitForIdle(context);
			const [parentTold] = await notices(session, session.root.id);
			assert.ok(parentTold?.startsWith("unapproved: ") && parentTold.includes(sha256), parentTold);
			await session.close();

			const asked: string[] = [];
			const askSetup: OpenOptions["askSetup"] = async (request) => {
				asked.push(request.command);
				return true;
			};
			session = await open(where, { askSetup });
			await cell(session.root, 'await spawn("prepared", "review", mode="review")');
			const prepared = (await settled(session, session.root, ["prepared"])).prepared!;
			assert.equal(prepared.state.kind, "done");
			assert.deepEqual(asked, [command]);
			assert.ok(prepared.worktree.kind === "worktree");
			assert.equal(git(prepared.worktree.root, ["status", "--porcelain"]), "?? SETUP.txt");
			assert.deepEqual(await notices(session, prepared.conversationId), [`$ ${command}\nno key\nsetup ok`]);
			const settings = JSON.parse(readFileSync(join(where.home, "settings.json"), "utf8"));
			assert.deepEqual(settings.agents.approvedSetups, [approval(where, command)], "the approval is kept");
			await cell(session.root, 'await spawn("again", "review", mode="review")');
			const again = (await settled(session, session.root, ["again"])).again!;
			assert.ok(again.worktree.kind === "worktree" && existsSync(join(again.worktree.root, "SETUP.txt")));
			assert.deepEqual(asked, [command], "an approved command is not asked about again");

			setupCommand(where, "echo broken >&2; exit 3");
			await cell(session.root, 'await spawn("broken", "review", mode="review")');
			const broken = (await settled(session, session.root, ["broken"])).broken!;
			assert.deepEqual(broken.state.kind === "stopped" && [broken.state.reason, broken.state.detail], [
				"error",
				"worktree setup failed",
			]);
		} finally {
			delete process.env.MAKORA_TEST_API_KEY;
			await session.close();
		}
	});
});

describe("subagents on pstack tiers", () => {
	it('run a child spawned with model="judge" on the judge tier\'s model and thinking level, and "code" on the session model', async () => {
		const where = workspace({
			pstack: {
				models: { judge: { model: "faux/faux-2", thinking: "low" } },
				roles: { "bug-fix": "judge", "no such role": "code" },
			},
		});
		const session = await open(where);
		try {
			assert.ok(
				session.notices.some((notice) => notice.message.includes('"no such role"')),
				"the unknown role is reported when the session opens",
			);
			const output = await cell(
				session.root,
				[
					'await spawn("judged", "review", mode="review", model="judge")',
					'await spawn("coded", "review", mode="review", model="code")',
					guarded('await spawn("bogus", "review", mode="review", model="reviewer")'),
				].join("\n"),
			);
			const children = await settled(session, session.root, ["judged", "coded"]);
			assert.equal(children.bogus, undefined, "an unknown alias starts no child");
			assert.deepEqual(
				children.judged!.model,
				{ provider: "faux", modelId: "faux-2" },
				"the record keeps the model",
			);
			assert.equal(children.coded!.model, undefined, "a session-model tier copies the parent's model");

			const ran = async (record: AgentRecord) => {
				const child = (await session.harness.conversation(record.conversationId, context))!;
				const agent = await child.agent(context);
				const page = await child.entries({}, 50, undefined, context);
				const answer = page.items.map((entry) => entry.model?.[0]).find((message) => message?.role === "assistant");
				return {
					model: agent.model?.modelId,
					thinking: agent.thinkingLevel,
					answeredBy: answer?.role === "assistant" ? answer.model : undefined,
				};
			};
			assert.deepEqual(await ran(children.judged!), { model: "faux-2", thinking: "low", answeredBy: "faux-2" });
			const parent = await session.root.agent(context);
			assert.notEqual(parent.thinkingLevel, "low");
			assert.deepEqual(await ran(children.coded!), {
				model: "faux-1",
				thinking: parent.thinkingLevel,
				answeredBy: "faux-1",
			});
			assert.match(output, /error: Unknown model alias reviewer/);
		} finally {
			await session.close();
		}
	});
});

describe("subagents waiting on their own children", () => {
	it("give a waiting child's slot to its grandchild, then back to the child ahead of a child not started yet", async () => {
		const where = workspace({ agents: { maxRunning: 1 } });
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("nester", "nest-collect", mode="review")');
			const nester = (await records(session, session.root.id)).nester!;
			await until(
				"the grandchild to run",
				async () =>
					(await records(session, nester.conversationId)).grandchild?.state.kind === "running" ? true : undefined,
				20_000,
			);
			await cell(session.root, 'await spawn("late", "review", mode="review")');
			let lateRanFirst = false;
			await until("both children to finish", async () => {
				const { late, nester: current } = await records(session, session.root.id);
				if (late?.state.kind === "running" && current?.state.kind === "running") lateRanFirst = true;
				return late?.state.kind === "done" && current?.state.kind === "done" ? true : undefined;
			});
			assert.equal(lateRanFirst, false, "the nester got the slot back before late started");
			assert.equal((await records(session, nester.conversationId)).grandchild?.state.kind, "done");
			const child = (await session.harness.conversation(nester.conversationId, context))!;
			assert.match(await lastResult(child, "python"), /^done$/m, "collect returned the grandchild's result");
			assert.deepEqual(await slots(session), { running: [], resuming: [], queued: [] });
		} finally {
			await session.close();
		}
	});

	it("run both grandchildren of two waiting children, never more than two runs at once", async () => {
		const where = workspace({ agents: { maxRunning: 2 } });
		const session = await open(where);
		try {
			await cell(
				session.root,
				'await spawn("left", "nest-wait", mode="review")\nawait spawn("right", "nest-wait", mode="review")',
			);
			let mostRunning = 0;
			const children = await until(
				"the children and grandchildren to finish",
				async () => {
					mostRunning = Math.max(mostRunning, (await slots(session)).running.length);
					const current = await records(session, session.root.id);
					const kinds: (string | undefined)[] = [];
					for (const name of ["left", "right"]) {
						const child = current[name];
						const grandchild = child && (await records(session, child.conversationId)).grandchild;
						kinds.push(child?.state.kind, grandchild?.state.kind);
					}
					return kinds.every((kind) => kind === "done") ? current : undefined;
				},
				30_000,
			);
			assert.equal(mostRunning, 2, "two runs held the slots, never more");
			for (const name of ["left", "right"]) {
				const child = (await session.harness.conversation(children[name]!.conversationId, context))!;
				assert.match(await lastResult(child, "wait_agents"), /^grandchild: done$/m);
			}
			assert.deepEqual(await slots(session), { running: [], resuming: [], queued: [] });
		} finally {
			await session.close();
		}
	});

	it("hand a waiting child the message that woke it once it has a slot again", async () => {
		const where = workspace({ agents: { maxRunning: 1 } });
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("listener", "nest-wait", mode="review")');
			const listener = (await records(session, session.root.id)).listener!;
			const anchor = (await session.harness.snapshot(AgentsDoc, session.root.id, context))!.runtime.listener!.anchor;
			await holdsSlot(session, listener.conversationId, "grandchild");
			assert.match(await cell(session.root, 'print(await send("listener", "news"))'), /'status': 'delivered'/);
			await until("the listener to queue for the slot", async () =>
				(await slots(session)).resuming.some((claim) => claim.anchor === anchor) ? true : undefined,
			);
			const conversation = (await session.harness.conversation(listener.conversationId, context))!;
			const heard = await until("the listener's wait to return", async () => {
				const page = await conversation.entries({ order: "descending" }, 100, undefined, context);
				const wait = page.items.find((entry) => entry.model?.[0]?.role === "toolResult");
				const message = wait?.model?.[0];
				return message?.role === "toolResult" && message.toolName === "wait_agents"
					? messageText(message)
					: undefined;
			});
			assert.equal(heard, '<agent_message from="main" relationship="parent">\nnews\n</agent_message>');
			await until("everything to settle", async () => {
				const { listener: current } = await records(session, session.root.id);
				const grandchild = (await records(session, listener.conversationId)).grandchild;
				const idle = current?.state.kind === "done" && grandchild?.state.kind === "done";
				const { running, resuming, queued } = await slots(session);
				return idle && running.length + resuming.length + queued.length === 0 ? true : undefined;
			});
		} finally {
			await session.close();
		}
	});

	it("keep the slots right when a child is stopped or removed while it waits without one", async () => {
		const where = workspace({ agents: { maxRunning: 1 } });
		const session = await open(where);
		try {
			// Stopped while it is queued for the slot its grandchild holds: a message ended its wait.
			await cell(session.root, 'await spawn("holder", "nest-hold", mode="review")');
			const holder = (await records(session, session.root.id)).holder!;
			const holderAnchor = (await session.harness.snapshot(AgentsDoc, session.root.id, context))!.runtime.holder!
				.anchor;
			const grandchildAnchor = await holdsSlot(session, holder.conversationId, "grandchild");
			assert.match(await cell(session.root, 'print(await send("holder", "news"))'), /'status': 'delivered'/);
			await until("the holder to queue for the slot", async () =>
				(await slots(session)).resuming.some((claim) => claim.anchor === holderAnchor) ? true : undefined,
			);
			await cell(session.root, 'await stop("holder")');
			await until("the holder to leave the queue", async () =>
				(await slots(session)).resuming.length === 0 ? true : undefined,
			);
			assert.deepEqual((await slots(session)).running, [grandchildAnchor], "the grandchild keeps its slot");
			assert.match(
				await cell(session.root, 'print(await remove("holder"))'),
				/'removed': \['grandchild', 'holder'\]/,
			);

			// Removed while it is parked, its grandchild holding the slot.
			await cell(session.root, 'await spawn("parker", "nest-hold", mode="review")');
			const parker = (await records(session, session.root.id)).parker!;
			await holdsSlot(session, parker.conversationId, "grandchild");
			assert.match(
				await cell(session.root, 'print(await remove("parker"))'),
				/'removed': \['grandchild', 'parker'\]/,
			);

			await cell(session.root, 'await spawn("after", "review", mode="review")');
			assert.equal(
				(await settled(session, session.root, ["after"])).after?.state.kind,
				"done",
				"a later child runs",
			);
			await until("every slot to be free", async () => {
				const { running, resuming, queued } = await slots(session);
				return running.length + resuming.length + queued.length === 0 ? true : undefined;
			});
		} finally {
			await session.close();
		}
	});
});

/** The session's running slots. */
async function slots(session: MakoraSession) {
	return (await session.harness.snapshot(SlotsDoc, context))!;
}

/** Wait until the anchor of `parentId`'s child `name` holds the session's only running slot; that anchor. */
function holdsSlot(session: MakoraSession, parentId: ConversationId, name: string) {
	return until(
		`${name} to hold the slot`,
		async () => {
			const anchor = (await session.harness.snapshot(AgentsDoc, parentId, context))?.runtime[name]?.anchor;
			const { running } = await slots(session);
			return anchor !== undefined && running.length === 1 && running[0] === anchor ? anchor : undefined;
		},
		20_000,
	);
}

describe("subagents when something goes wrong", () => {
	it("refuse to merge into an unfinished merge or rebase, and report a failing merge hook as an error", async () => {
		const where = workspace();
		const session = await open(where);
		const repo = (args: readonly string[]) =>
			git(where.repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args]);
		try {
			await cell(session.root, 'await spawn("writer", "write-change", mode="write")');
			await settled(session, session.root, ["writer"]);
			const merge = guarded('print(await merge("writer"))');

			// The user's own merge, stopped on a conflict, with their resolution typed in.
			const readme = join(where.repo, "README.md");
			repo(["checkout", "-qb", "side"]);
			writeFileSync(readme, "# side\n");
			repo(["commit", "-qam", "side"]);
			repo(["checkout", "-q", "main"]);
			writeFileSync(readme, "# main\n");
			repo(["commit", "-qam", "main"]);
			assert.throws(() => repo(["merge", "-q", "side"]), "the user's merge stops on a conflict");
			writeFileSync(readme, "# resolved by the user\n");
			const theirs = repo(["rev-parse", "MERGE_HEAD"]);
			assert.match(await cell(session.root, merge), /error: .*has a merge in progress/);
			assert.equal(readFileSync(readme, "utf8"), "# resolved by the user\n", "the user's resolution survives");
			assert.equal(repo(["rev-parse", "MERGE_HEAD"]), theirs, "the user's merge is still in progress");
			repo(["commit", "-qam", "merge side"]);

			const rebasing = resolve(where.repo, repo(["rev-parse", "--git-path", "rebase-merge"]));
			mkdirSync(rebasing);
			const head = repo(["rev-parse", "HEAD"]);
			assert.match(await cell(session.root, merge), /error: .*has a rebase in progress/);
			assert.equal(repo(["rev-parse", "HEAD"]), head, "nothing landed in the rebase");
			rmSync(rebasing, { recursive: true });

			const hook = join(where.repo, ".git", "hooks", "pre-merge-commit");
			writeFileSync(hook, "#!/bin/sh\necho no merges today >&2\nexit 1\n", { mode: 0o755 });
			const failed = await cell(session.root, merge);
			assert.match(failed, /error: [\s\S]*no merges today/);
			assert.doesNotMatch(failed, /conflicts/);
			assert.throws(() => repo(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), "the failed merge was aborted");
			assert.equal(repo(["status", "--porcelain"]), "");
			assert.equal(repo(["rev-parse", "HEAD"]), head);
			assert.equal((await records(session, session.root.id)).writer?.state.kind, "done");
			rmSync(hook);
			assert.match(await cell(session.root, merge), /'merged': True/);
		} finally {
			await session.close();
		}
	});

	it("finish a write child despite the repository's commit hook and signing, and free the slot of one whose worktree cannot be added", async () => {
		const where = workspace();
		writeSettings(where, { maxRunning: 1 });
		writeFileSync(join(where.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		git(where.repo, ["config", "commit.gpgsign", "true"]);
		git(where.repo, ["config", "gpg.program", "false"]);
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("writer", "write-change", mode="write")');
			const writer = (await settled(session, session.root, ["writer"])).writer!;
			assert.ok(writer.state.kind === "done" && writer.state.result.mode === "write", JSON.stringify(writer.state));
			assert.equal(git(where.repo, ["show", `${writer.state.result.headCommit}:CHANGES.md`]), "writer was here");

			const blocker = join(where.home, "blocker");
			writeFileSync(blocker, "");
			writeFileSync(
				join(where.home, "settings.json"),
				JSON.stringify({
					worktrees: { review: where.review, write: join(blocker, "write") },
					agents: { maxRunning: 1 },
				}),
			);
			await cell(
				session.root,
				'await spawn("blocked", "write-change", mode="write")\nawait spawn("after", "review", mode="review")',
			);
			const done = await settled(session, session.root, ["blocked", "after"]);
			const blocked = done.blocked!;
			assert.ok(blocked.state.kind === "stopped" && blocked.state.reason === "error", JSON.stringify(blocked.state));
			assert.match(blocked.state.detail ?? "", /^could not add its worktree: /);
			assert.equal(done.after?.state.kind, "done", "the slot went to the next child");
		} finally {
			await session.close();
		}
	});

	it("kill a setup whose child is removed, keep that child removed, and time out a setup that runs too long", async () => {
		const where = workspace();
		const finished = join(where.home, "finished");
		const command = `echo started > STARTED; sleep 3 && touch '${finished}'; exit 1`;
		setupCommand(where, command);
		writeSettings(where, { maxRunning: 1, approvedSetups: [approval(where, command)] });
		const session = await open(where);
		try {
			await cell(session.root, 'await spawn("doomed", "review", mode="review")');
			const doomed = (await records(session, session.root.id)).doomed!;
			assert.ok(doomed.worktree.kind === "worktree");
			const started = join(doomed.worktree.root, "STARTED");
			await until("the setup to start", async () => (existsSync(started) ? true : undefined));
			assert.match(await cell(session.root, 'print(await remove("doomed"))'), /'removed': \['doomed'\]/);
			await anchorEnded(session, session.root, "doomed");
			assert.equal((await records(session, session.root.id)).doomed?.state.kind, "removed", "it stays removed");

			writeSettings(where, { maxRunning: 1, setupTimeoutMinutes: 0.02, approvedSetups: [approval(where, command)] });
			await cell(session.root, 'await spawn("stuck", "review", mode="review")');
			const stuck = (await settled(session, session.root, ["stuck"])).stuck!;
			assert.deepEqual(stuck.state.kind === "stopped" && [stuck.state.reason, stuck.state.detail], [
				"error",
				"worktree setup timed out after 0.02 minutes",
			]);
			await sleep(3_500);
			assert.equal(existsSync(finished), false, "neither setup ran to its end");
		} finally {
			await session.close();
		}
	});

	it("commit a stopped write child's work to its branch, and say so before removing it", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			const task =
				'```python\nawait write("DRAFT.md", "half done\\n")\nprint((await bash("sleep 600")).output)\n```';
			await cell(session.root, `await spawn("drafter", ${JSON.stringify(task)}, mode="write")`);
			const drafter = (await records(session, session.root.id)).drafter!;
			assert.ok(drafter.worktree.kind === "worktree" && drafter.worktree.branch !== undefined);
			const { root, branch, baseCommit } = drafter.worktree;
			await until("the draft", async () => (existsSync(join(root, "DRAFT.md")) ? true : undefined));
			await cell(session.root, 'await stop("drafter")');
			const head = await until("the draft to be committed", async () => {
				const current = git(where.repo, ["rev-parse", branch]);
				return current === baseCommit ? undefined : current;
			});
			assert.equal(git(where.repo, ["show", `${head}:DRAFT.md`]), "half done");
			assert.equal(git(root, ["status", "--porcelain"]), "", "nothing is left uncommitted");

			const snapshot = await loadAgents(session.harness, session.root.id, context);
			const row = dashboardRows(snapshot.facts, Date.now()).find((each) => each.facts.name === "drafter")!;
			let asked = "";
			const confirm = async (title: string, _action: string, detail?: string) => {
				asked = `${title} ${detail}`;
				return true;
			};
			const outcome = await removeRow({ session, confirm }, row, snapshot.facts);
			assert.match(asked, new RegExp(`Keeps its branch ${branch} with all its work`));
			assert.match(asked, /deletes its worktree .* and the files git ignores there/);
			assert.equal(outcome.note, "Removed drafter.");
			assert.equal(existsSync(root), false);
			assert.equal(git(where.repo, ["show", `${branch}:DRAFT.md`]), "half done", "the branch keeps the work");
		} finally {
			await session.close();
		}
	});

	it("remove a write child while its anchor is committing its work, the two git writes taking turns", async () => {
		const where = workspace();
		// A clean filter that sleeps holds the worktree's index.lock through the anchor's `git add`, longer than makora
		// waits for a lock another process holds, so only the per-repository queue lets the removal through.
		writeFileSync(join(where.repo, ".gitattributes"), "*.slow filter=slow\n");
		git(where.repo, ["add", ".gitattributes"]);
		git(where.repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "slow filter"]);
		git(where.repo, ["config", "filter.slow.clean", "sleep 5; cat"]);
		const session = await open(where);
		try {
			const task = '```python\nawait write("WORK.slow", "settling\\n")\n```';
			await cell(session.root, `await spawn("settler", ${JSON.stringify(task)}, mode="write")`);
			const settler = (await records(session, session.root.id)).settler!;
			assert.ok(settler.worktree.kind === "worktree" && settler.worktree.branch !== undefined);
			const { root, branch } = settler.worktree;
			const gitDir = await until("the worktree", async () =>
				existsSync(root) ? git(root, ["rev-parse", "--absolute-git-dir"]) : undefined,
			);
			await until("the anchor's commit to hold the index lock", async () =>
				existsSync(join(gitDir, "index.lock")) ? true : undefined,
			);

			const snapshot = await loadAgents(session.harness, session.root.id, context);
			const row = dashboardRows(snapshot.facts, Date.now()).find((each) => each.facts.name === "settler")!;
			const outcome = await removeRow({ session, confirm: async () => true }, row, snapshot.facts);
			assert.equal(outcome.note, "Removed settler.");
			assert.equal(existsSync(root), false, "the worktree is gone");
			assert.equal(git(where.repo, ["show", `${branch}:WORK.slow`]), "settling", "the branch holds the work");
			await anchorEnded(session, session.root, "settler");
			assert.equal((await records(session, session.root.id)).settler?.state.kind, "removed");
			assert.deepEqual(
				session.notices.filter((notice) => /failed|cut off/.test(notice.message)),
				[],
				"the anchor did not fail",
			);
		} finally {
			await session.close();
		}
	});
});

/** The texts of the `makora.notice` entries of conversation `id`, oldest first. */
async function notices(session: MakoraSession, id: ConversationId): Promise<string[]> {
	const conversation = (await session.harness.conversation(id, context))!;
	const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);
	// Written by the anchor, always with a text.
	return page.items.flatMap((entry) =>
		entry.kind === "makora.notice" ? [(entry.data as { readonly text: string }).text] : [],
	);
}
