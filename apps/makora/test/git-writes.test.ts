import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GitWrites } from "../src/git/writes.ts";
import { git } from "../src/repl/git-tree.ts";

/** A repository with one commit, and a linked worktree of it. */
function repository(): { readonly repo: string; readonly linked: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-git-writes-")));
	const repo = join(root, "repo");
	const linked = join(root, "linked");
	const run = (cwd: string, args: readonly string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	run(root, ["init", "-q", "-b", "main", repo]);
	writeFileSync(join(repo, "README.md"), "# demo\n");
	run(repo, ["add", "README.md"]);
	run(repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"]);
	run(repo, ["worktree", "add", "-q", "--detach", linked]);
	return { repo, linked };
}

/** Records when each named piece of work starts and ends, to see whether two overlapped. */
function timeline() {
	const events: string[] = [];
	const work = (name: string) => async () => {
		events.push(`${name} start`);
		await sleep(150);
		events.push(`${name} end`);
		return name;
	};
	return { events, work };
}

describe("git writes", () => {
	it("run one at a time per repository, also from two of its worktrees, and side by side across repositories", async () => {
		const first = repository();
		const second = repository();
		const writes = new GitWrites();
		const { events, work } = timeline();
		const results = await Promise.all([
			writes.run(first.repo, work("a")),
			writes.run(first.linked, work("b")),
			writes.run(second.repo, work("c")),
		]);
		assert.deepEqual(results, ["a", "b", "c"]);
		assert.ok(events.indexOf("b start") > events.indexOf("a end"), events.join(", "));
		assert.ok(events.indexOf("c start") < events.indexOf("a end"), events.join(", "));
	});

	it("run a repository's writes in the order they were called, whichever worktree each comes from", async () => {
		const { repo, linked } = repository();
		const writes = new GitWrites();
		const order: number[] = [];
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				writes.run(index % 2 === 0 ? repo : linked, async () => {
					order.push(index);
				}),
			),
		);
		assert.deepEqual(
			order,
			Array.from({ length: 12 }, (_, index) => index),
		);
	});

	it("go on after a write that failed", async () => {
		const { repo } = repository();
		const writes = new GitWrites();
		await assert.rejects(
			writes.run(repo, async () => {
				throw new Error("broken");
			}),
			/broken/,
		);
		assert.equal(await writes.run(repo, async () => "next"), "next");
	});

	it("wait for an index.lock another process releases soon, and name a lock that stays", async () => {
		const { repo } = repository();
		writeFileSync(join(repo, "notes.txt"), "notes\n");
		const lock = join(repo, ".git", "index.lock");
		writeFileSync(lock, "");
		const released = sleep(400).then(() => rmSync(lock));
		const started = Date.now();
		await git(repo, ["add", "notes.txt"]);
		await released;
		assert.ok(Date.now() - started >= 400, "the add waited for the lock");
		assert.equal(await git(repo, ["diff", "--cached", "--name-only"]), "notes.txt");

		writeFileSync(lock, "");
		await assert.rejects(
			git(repo, ["reset", "-q"]),
			(error) =>
				error instanceof Error &&
				error.message.includes(`${lock} is held by another git process`) &&
				error.message.includes("If no git command is running there, delete that file"),
		);
		rmSync(lock);
	});
});
