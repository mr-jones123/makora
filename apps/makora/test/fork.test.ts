import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { createFork, type Fork, forkPoints, forkRef, listForks, removeFork } from "../src/fork.ts";
import { type MakoraSession, openEphemeralSession, openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { messageText } from "../src/transcript-rows.ts";

const context = BACKGROUND_CONTEXT;

/** A temp makora home, and a folder to run in: a git repository with one commit, unless `git` is false. */
function workspace(git = true): { home: string; repo: string } {
	// The real path: git reports top levels with macOS's /var -> /private/var link resolved.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-fork-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "# demo\n");
	if (git) {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["add", "README.md"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"], {
			cwd: repo,
		});
	}
	return { home: join(root, "home"), repo };
}

function open(where: { home: string; repo: string }): Promise<MakoraSession> {
	const app = openApp(where.home, true);
	return openSession(app, createSession(app.paths.sessions, where.repo), {}, context);
}

async function ask(conversation: Conversation, text: string): Promise<void> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	assert.equal(settled.status, "done");
}

/** The output of the conversation's newest python cell. */
async function lastCell(conversation: Conversation): Promise<string> {
	const page = await conversation.entries({ order: "descending" }, 50, undefined, context);
	for (const entry of page.items) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult" && message.toolName === "python") return messageText(message);
	}
	throw new Error("no python cell");
}

/** Fork the root before its user message whose text is `text`. */
async function forkBefore(session: MakoraSession, text: string, worktrees: string) {
	const point = (await forkPoints(session.root, context)).find((candidate) => candidate.text === text);
	assert.ok(point !== undefined, `a fork point before "${text}"`);
	return createFork(session, session.root, point.at, worktrees, context);
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("forks", () => {
	it("keep the variables and files of the fork point in their own worktree", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await ask(session.root, "python");
			await ask(session.root, "file");
			await ask(session.root, "bump");
			const status = git(where.repo, ["status", "--porcelain"]);
			const head = git(where.repo, ["rev-parse", "HEAD"]);
			const branch = git(where.repo, ["branch", "--show-current"]);

			const worktrees = join(where.home, "worktrees");
			const fork = await forkBefore(session, "bump", worktrees);
			assert.equal(fork.record.label, "fork 1");
			assert.equal(fork.record.files.kind, "snapshot");
			assert.equal(fork.notice, undefined);
			assert.ok(fork.record.files.kind === "snapshot");
			const path = fork.record.files.path;
			assert.ok(path.startsWith(join(worktrees, "repo-")), path);
			assert.ok(path.endsWith(join(session.meta.id, String(fork.conversationId))), path);
			assert.equal((await fork.conversation.agent(context)).cwd, path);

			await ask(fork.conversation, "remember");
			assert.match(
				await lastCell(fork.conversation),
				/^Kernel restarted\. Variables restored to after cell 4: x\.\n41$/,
			);
			assert.equal(readFileSync(join(path, "fake.txt"), "utf8"), "hi");
			assert.equal(git(path, ["status", "--porcelain"]), "", "the worktree is clean at the fork point");
			assert.equal(git(path, ["rev-parse", "HEAD^"]).trim(), head.trim(), "the fork commit sits on HEAD");

			assert.equal(readFileSync(join(where.repo, "fake.txt"), "utf8"), "bumped");
			await ask(session.root, "remember");
			assert.equal((await lastCell(session.root)).trim(), "99", "the root's kernel kept its variables");

			assert.equal(git(where.repo, ["status", "--porcelain"]), status, "the main worktree's status");
			assert.equal(git(where.repo, ["rev-parse", "HEAD"]), head, "the main worktree's HEAD");
			assert.equal(git(where.repo, ["branch", "--show-current"]), branch, "the main worktree's branch");
			assert.equal(git(where.repo, ["diff", "--cached", "--name-only"]), "", "the real index is untouched");
		} finally {
			await session.close();
		}
	});

	it("start at HEAD and say so when no cell before the fork point saved files", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			writeFileSync(join(where.repo, "draft.txt"), "uncommitted\n");
			await ask(session.root, "hello");
			await ask(session.root, "again");
			const fork = await forkBefore(session, "again", join(where.home, "worktrees"));
			assert.equal(fork.record.files.kind, "head");
			assert.equal(
				fork.notice,
				"No file snapshot at the fork point; the fork's files start at HEAD (uncommitted changes are not included).",
			);
			assert.ok(fork.record.files.kind === "head");
			assert.equal(readFileSync(join(fork.record.files.path, "README.md"), "utf8"), "# demo\n");
			assert.equal(existsSync(join(fork.record.files.path, "draft.txt")), false);
		} finally {
			await session.close();
		}
	});

	it("start at HEAD in an ephemeral session, whose cells save no snapshots", async () => {
		const where = workspace();
		const session = await openEphemeralSession(openApp(where.home, true), where.repo, {}, context);
		try {
			await ask(session.root, "python");
			await ask(session.root, "again");
			const fork = await forkBefore(session, "again", join(where.home, "worktrees"));
			assert.equal(fork.record.files.kind, "head");
			await ask(fork.conversation, "remember");
			assert.match(
				await lastCell(fork.conversation),
				/^Kernel restarted empty: variables of earlier cells were lost \(snapshots are off\)\./,
			);
		} finally {
			await session.close();
		}
	});

	it("share the folder outside a git repository and say so", async () => {
		const where = workspace(false);
		const session = await open(where);
		try {
			await ask(session.root, "python");
			await ask(session.root, "again");
			const fork = await forkBefore(session, "again", join(where.home, "worktrees"));
			assert.deepEqual(fork.record.files, { kind: "shared" });
			assert.equal(
				fork.notice,
				"Not in a git repository; the fork shares this folder with the conversation it came from.",
			);
			assert.equal((await fork.conversation.agent(context)).cwd, where.repo);
			assert.equal(existsSync(join(where.home, "worktrees")), false);
		} finally {
			await session.close();
		}
	});

	it("are removed with their worktree and ref, and hidden", async () => {
		const where = workspace();
		const session = await open(where);
		try {
			await ask(session.root, "python");
			await ask(session.root, "again");
			const created = await forkBefore(session, "again", join(where.home, "worktrees"));
			assert.ok(created.record.files.kind === "snapshot");
			const path = created.record.files.path;
			await ask(created.conversation, "remember");
			writeFileSync(join(path, "scratch.txt"), "unsaved\n");
			assert.equal(session.kernels.status(created.conversationId).state, "running");
			const ref = forkRef(session, created.conversationId);
			assert.equal(git(where.repo, ["rev-parse", ref]).trim(), created.record.files.commit);

			const fork: Fork = { conversationId: created.conversationId, record: created.record };
			await removeFork(session, fork, context);
			assert.equal(existsSync(path), false);
			assert.equal(git(where.repo, ["worktree", "list"]).includes(path), false);
			assert.throws(() => git(where.repo, ["rev-parse", "--verify", "--quiet", ref]));
			assert.equal(session.kernels.status(created.conversationId).state, "none");
			const [listed] = await listForks(session.harness, context);
			assert.equal(listed?.record.removed, true);
			// Removing again converges.
			await removeFork(session, fork, context);
		} finally {
			await session.close();
		}
	});
});
