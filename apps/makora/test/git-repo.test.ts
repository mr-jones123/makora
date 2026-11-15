import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	baseBranch,
	baseFiles,
	chooseBase,
	commitFiles,
	history,
	openRepo,
	type Repo,
	revert,
	stage,
	stagedFiles,
	unstage,
	unstagedFiles,
} from "../src/git/repo.ts";

describe("chooseBase", () => {
	it("prefers main, then master, then the remote HEAD", () => {
		assert.equal(chooseBase({ branch: "feat", local: ["master", "main"], remoteHead: "origin/trunk" }), "main");
		assert.equal(chooseBase({ branch: "feat", local: ["master"], remoteHead: "origin/trunk" }), "master");
		assert.equal(chooseBase({ branch: "feat", local: [], remoteHead: "origin/trunk" }), "origin/trunk");
	});

	it("has no base when none exists or HEAD is on it", () => {
		assert.equal(chooseBase({ branch: "feat", local: [], remoteHead: undefined }), undefined);
		assert.equal(chooseBase({ branch: "main", local: ["main"], remoteHead: "origin/main" }), undefined);
		assert.equal(chooseBase({ branch: "trunk", local: [], remoteHead: "origin/trunk" }), undefined);
	});

	it("compares a detached HEAD against the base", () => {
		assert.equal(chooseBase({ branch: undefined, local: ["main"], remoteHead: undefined }), "main");
	});
});

describe("repository", () => {
	const repo = async (): Promise<Repo> => {
		const dir = mkdtempSync(join(tmpdir(), "makora-git-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		git("add", "a.txt");
		git("commit", "-qm", "first");
		git("switch", "-qc", "feat");
		writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
		git("commit", "-qam", "second");
		writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
		writeFileSync(join(dir, "new file.txt"), "fresh\n");
		const opened = await openRepo(dir);
		assert.ok(opened !== undefined);
		return opened;
	};

	it("lists unstaged changes then untracked files, and stages and unstages them", async () => {
		const opened = await repo();
		const before = await unstagedFiles(opened);
		assert.deepEqual(
			before.map((file) => [file.path, file.status, file.added, file.removed]),
			[
				["a.txt", "M", 1, 0],
				["new file.txt", "?", 1, 0],
			],
		);
		await stage(opened, before[1]!);
		const staged = await stagedFiles(opened);
		assert.deepEqual(
			staged.map((file) => [file.path, file.status]),
			[["new file.txt", "A"]],
		);
		await unstage(opened, staged[0]!);
		assert.deepEqual(await stagedFiles(opened), []);
		await revert(opened, before[0]!);
		await revert(opened, before[1]!);
		assert.deepEqual(await unstagedFiles(opened), []);
	});

	it("diffs against the base branch and reads history with per-commit counts", async () => {
		const opened = await repo();
		assert.equal(await baseBranch(opened), "main");
		assert.deepEqual(
			(await baseFiles(opened, "main")).map((file) => [file.path, file.added, file.removed]),
			[["a.txt", 2, 1]],
		);
		const commits = await history(opened);
		assert.deepEqual(
			commits.map((commit) => [commit.subject, commit.added, commit.removed]),
			[
				["second", 1, 1],
				["first", 2, 0],
			],
		);
		const [changed] = await commitFiles(opened, commits[0]!.sha);
		assert.equal(changed?.path, "a.txt");
	});

	it("lists untracked nested repositories and symlinks without reading them", async () => {
		const opened = await repo();
		const nested = join(opened.root, "nested");
		mkdirSync(nested);
		execFileSync("git", ["init", "-q"], { cwd: nested });
		writeFileSync(join(nested, "inner.txt"), "inner\n");
		symlinkSync(tmpdir(), join(opened.root, "to-dir"));
		symlinkSync("missing.txt", join(opened.root, "dangling"));
		const untracked = (await unstagedFiles(opened)).filter((file) => file.status === "?");
		assert.deepEqual(
			untracked.map((file) => [file.path, file.body.kind === "omitted" ? file.body.reason : file.body.kind]),
			[
				["dangling", "symlink to missing.txt"],
				["nested/", "directory, not shown"],
				["new file.txt", "text"],
				["to-dir", `symlink to ${tmpdir()}`],
			],
		);
	});

	it("unstages a file before the first commit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "makora-git-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "first.txt"), "one\n");
		const opened = await openRepo(dir);
		assert.ok(opened !== undefined);
		const [file] = await unstagedFiles(opened);
		await stage(opened, file!);
		assert.deepEqual(
			(await stagedFiles(opened)).map((each) => each.path),
			["first.txt"],
		);
		await unstage(opened, (await stagedFiles(opened))[0]!);
		assert.deepEqual(await stagedFiles(opened), []);
	});

	it("is undefined outside a repository", async () => {
		assert.equal(await openRepo(mkdtempSync(join(tmpdir(), "makora-nogit-"))), undefined);
	});
});
