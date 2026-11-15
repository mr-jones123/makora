// Worktree states as git trees: captured with a temporary index, so the real index and branch never move, and kept
// alive against `git gc` by a commit chain under `refs/makora/<session>/<conversation>`.
import { execFile } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The tree of the git worktree holding `cwd`, untracked files included and ignored ones not, as `git:<sha>`; with
 * `ref`, also a commit of it on top of `ref`. Undefined outside a git repository.
 */
export async function captureTree(cwd: string, ref: string | undefined): Promise<string | undefined> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (top === undefined) return undefined;
	const index = join(tmpdir(), `makora-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		// Starting from the real index lets `git add` skip files whose stat data did not change.
		const real = resolve(top, await git(top, ["rev-parse", "--git-path", "index"]));
		try {
			copyFileSync(real, index);
		} catch {
			// A repository without commits or staged files has no index yet.
		}
		const env = { ...process.env, GIT_INDEX_FILE: index };
		await git(top, ["add", "-A"], env);
		const tree = await git(top, ["write-tree"], env);
		if (ref !== undefined) await keepAlive(top, tree, ref);
		return `git:${tree}`;
	} finally {
		rmSync(index, { force: true });
	}
}

/** Files that differ between `tree` (`git:<sha>`) and the worktree holding `cwd` now; undefined outside git. */
export async function changedFiles(cwd: string, tree: string): Promise<string[] | undefined> {
	const now = await captureTree(cwd, undefined);
	if (now === undefined) return undefined;
	if (now === tree) return [];
	const names = await git(cwd, ["diff-tree", "-r", "--name-only", tree.slice(4), now.slice(4)]).catch(() => undefined);
	return names === undefined ? undefined : names.split("\n").filter((name) => name.length > 0);
}

async function keepAlive(top: string, tree: string, ref: string): Promise<void> {
	const parent = await git(top, ["rev-parse", "--verify", "--quiet", ref]).catch(() => undefined);
	const env = { ...process.env, ...MAKORA_AUTHOR };
	const commit = await git(top, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "makora cell"], env);
	await git(top, ["update-ref", ref, commit]);
}

// commit-tree needs an identity; the user's may be unset, and these commits are makora's own.
const MAKORA_AUTHOR = {
	GIT_AUTHOR_NAME: "makora",
	GIT_AUTHOR_EMAIL: "makora@localhost",
	GIT_COMMITTER_NAME: "makora",
	GIT_COMMITTER_EMAIL: "makora@localhost",
};

async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await run("git", [...args], { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
	return stdout.trim();
}
