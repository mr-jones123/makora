// The project around a working directory: the directories from it up to its git repository root, and the branch.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The directories from `cwd` up to its git repository root, innermost first. Outside a repository, only `cwd`:
 * walking to `/` would pick up unrelated files.
 */
export function projectDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return [resolve(cwd)];
		dir = parent;
	}
}

/** The checked-out branch of the repository holding `cwd`, a short commit for a detached head, or undefined. */
export function gitBranch(cwd: string): string | undefined {
	const root = projectDirs(cwd).at(-1)!;
	let gitDir = join(root, ".git");
	try {
		// A worktree or submodule has a `.git` file pointing at its git directory.
		if (statSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, "utf8").match(/^gitdir: (.+)$/m)?.[1];
			if (pointer === undefined) return undefined;
			gitDir = resolve(root, pointer.trim());
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
	} catch {
		return undefined;
	}
}
