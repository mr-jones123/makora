import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { AgentsDoc } from "../src/agents/docs.ts";
import type { AgentRecord } from "../src/agents/types.ts";
import { type MakoraApp, openApp } from "../src/app.ts";
import { createFork, forkPoints } from "../src/fork.ts";
import { type MakoraSession, openEphemeralSession, openSession } from "../src/session.ts";
import { createSession, sessionDir } from "../src/sessions.ts";

const context = BACKGROUND_CONTEXT;
const APP = resolve(import.meta.dirname, "..");

type Workspace = { readonly home: string; readonly repo: string; readonly review: string; readonly write: string };

/** A temp makora home whose settings put subagent worktrees under the temp folder, and a repository with one commit. */
function workspace(): Workspace {
	// The real path: git reports top levels with macOS's /var -> /private/var link resolved.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-delete-")));
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
		JSON.stringify({ worktrees: { review: where.review, write: where.write } }),
	);
	writeFileSync(join(where.repo, "README.md"), "# demo\n");
	git(where.repo, ["init", "-q", "-b", "main"]);
	git(where.repo, ["add", "README.md"]);
	git(where.repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"]);
	return where;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function ask(conversation: Conversation, text: string): Promise<void> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	assert.equal(settled.status, "done");
}

/** What a session made: a fork, a reviewer, a writer whose branch has a commit, and a writer that wrote nothing. */
type Made = {
	readonly fork: string;
	readonly reviewer: string;
	readonly writer: { readonly root: string; readonly branch: string };
	readonly idle: { readonly root: string; readonly branch: string };
};

/** Make a fork and three children in `session`, and wait until the children finished. */
async function makeEverything(session: MakoraSession, app: MakoraApp): Promise<Made> {
	await ask(session.root, "python");
	await ask(session.root, "file");
	const point = (await forkPoints(session.root, context)).find((candidate) => candidate.text === "file")!;
	const fork = await createFork(session, session.root, point.at, app.paths.worktrees, context);
	assert.ok(fork.record.files.kind !== "shared");
	const idle = JSON.stringify('```python\nprint("nothing to write")\n```');
	await ask(
		session.root,
		[
			"```python",
			'await spawn("reviewer", "review", mode="review")',
			'await spawn("writer", "write-change", mode="write")',
			`await spawn("idle", ${idle}, mode="write")`,
			"```",
		].join("\n"),
	);
	const done = await finished(session, ["reviewer", "writer", "idle"]);
	const root = (record: AgentRecord) => (record.worktree.kind === "worktree" ? record.worktree.root : "");
	const branch = (record: AgentRecord) => (record.worktree.kind === "worktree" ? record.worktree.branch! : "");
	return {
		fork: fork.record.files.path,
		reviewer: root(done.reviewer!),
		writer: { root: root(done.writer!), branch: branch(done.writer!) },
		idle: { root: root(done.idle!), branch: branch(done.idle!) },
	};
}

/** The root's children once every named one is done. */
async function finished(session: MakoraSession, names: readonly string[]): Promise<Record<string, AgentRecord>> {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const agents = (await session.harness.snapshot(AgentsDoc, session.root.id, context))?.agents ?? {};
		if (names.every((name) => agents[name]?.state.kind === "done")) return { ...agents };
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${names.join(", ")}: ${JSON.stringify(agents)}`);
		await sleep(20);
	}
}

/** Everything the session made is gone except the writer's branch and its commit. */
function assertCleaned(where: Workspace, app: MakoraApp, sessionId: string, made: Made): void {
	for (const path of [made.fork, made.reviewer, made.writer.root, made.idle.root]) {
		assert.equal(existsSync(path), false, `${path} is gone`);
	}
	assert.equal(git(where.repo, ["worktree", "list", "--porcelain"]).split("\n")[0], `worktree ${where.repo}`);
	assert.equal(git(where.repo, ["worktree", "list"]).split("\n").length, 1, "only the main worktree is left");
	assert.deepEqual(git(where.repo, ["branch", "--list", "makora/*", "--format=%(refname:short)"]).split("\n"), [
		made.writer.branch,
	]);
	assert.equal(git(where.repo, ["show", `${made.writer.branch}:CHANGES.md`]), "writer was here");
	assert.equal(git(where.repo, ["for-each-ref", `refs/makora/${sessionId}/`]), "", "the session's refs are gone");
	for (const root of [where.review, where.write, app.paths.worktrees]) {
		for (const repo of existsSync(root) ? readdirSync(root) : []) {
			assert.equal(existsSync(join(root, repo, sessionId)), false, `no session folder under ${root}/${repo}`);
		}
	}
}

describe("deleting a session", () => {
	it("remove its worktrees, refs, folders and empty branches, keep the branch with work, and say so first", async () => {
		const where = workspace();
		const app = openApp(where.home, true);
		const meta = createSession(app.paths.sessions, where.repo);
		const session = await openSession(app, meta, {}, context);
		let made: Made;
		try {
			made = await makeEverything(session, app);
		} finally {
			await session.close();
		}
		// A cleaned temp folder took the review checkout before the session was deleted.
		rmSync(made.reviewer, { recursive: true, force: true });

		const cli = (input: string) =>
			execFileSync(
				process.execPath,
				["--import", join(APP, "src/source.ts"), join(APP, "src/main.ts"), "rm", meta.id],
				{
					cwd: where.repo,
					env: { ...process.env, MAKORA_HOME: where.home },
					input,
					encoding: "utf8",
				},
			);
		assert.throws(() => cli("n\n"), "a no deletes nothing and exits 1");
		assert.ok(existsSync(made.writer.root) && existsSync(sessionDir(app.paths.sessions, meta.id)));
		const output = cli("y\n");
		assert.match(
			output,
			new RegExp(
				`removes write worktree ${made.idle.root}, and its branch ${made.idle.branch} \\(no commits beyond its base\\)`,
			),
		);
		assert.match(output, new RegExp(`keeps branch ${made.writer.branch}: 1 commit not merged`));
		assert.match(output, new RegExp(`removes fork worktree ${made.fork}`));
		assert.match(output, new RegExp(`Deleted session ${meta.id}\\.`));

		assertCleaned(where, app, meta.id, made);
		assert.equal(existsSync(sessionDir(app.paths.sessions, meta.id)), false, "the session's directory is gone");
	});

	it("do the same when an ephemeral session closes", async () => {
		const where = workspace();
		const app = openApp(where.home, true);
		const session = await openEphemeralSession(app, where.repo, {}, context);
		let made: Made;
		try {
			made = await makeEverything(session, app);
			assert.ok(existsSync(made.fork) && existsSync(made.writer.root) && existsSync(made.idle.root));
		} finally {
			await session.close();
		}
		assertCleaned(where, app, session.meta.id, made);
	});
});
