// The git repository around a directory: reads its changes and history, and stages, unstages and reverts files.
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type DiffFile, parseDiff, type UntrackedContent, untrackedFile } from "./diff.ts";
import { type Commit, LOG_FORMAT, parseLog } from "./log.ts";

/** A repository: its top-level directory and the name shown for it. */
export interface Repo {
	readonly root: string;
	readonly name: string;
}

/** The repository holding `cwd`, or undefined outside one. */
export async function openRepo(cwd: string): Promise<Repo | undefined> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		return { root, name: basename(root) };
	} catch {
		return undefined;
	}
}

const run = promisify(execFile);

// Paths in diffs are relative to the top level, so every command after `openRepo` runs there. Literal pathspecs keep
// a file named like `:(glob)*` from matching other files in add, restore and ls-files.
async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await run("git", ["-c", "core.quotepath=false", "--literal-pathspecs", ...args], {
		cwd,
		maxBuffer: 256 * 1024 * 1024,
		encoding: "utf8",
	});
	return stdout;
}

// Fixed prefixes and no color, external diff or relative paths, whatever the user's git config says.
const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-relative", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

/** Working-tree changes not staged, untracked files after them. */
export function unstagedFiles(repo: Repo): Promise<DiffFile[]> {
	return workingTreeFiles(repo, undefined);
}

/** Everything the working tree changed since `commit`, untracked files after them: a subagent's work on its base. */
export function filesSince(repo: Repo, commit: string): Promise<DiffFile[]> {
	return workingTreeFiles(repo, commit);
}

/** `git diff` of the working tree against the index, or against `commit` when given, then the untracked files. */
async function workingTreeFiles(repo: Repo, commit: string | undefined): Promise<DiffFile[]> {
	const [patch, others] = await Promise.all([
		git(repo.root, ["diff", ...DIFF_ARGS, ...(commit === undefined ? [] : [commit])]),
		git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const paths = others.split("\0").filter((path) => path.length > 0);
	const untracked = await Promise.all(
		paths.map(async (path, index) =>
			index < UNTRACKED_READ_LIMIT
				? untrackedFile(path, await readUntracked(join(repo.root, path)))
				: ({
						path,
						status: "?",
						added: 0,
						removed: 0,
						body: { kind: "omitted", reason: `not read: over ${UNTRACKED_READ_LIMIT} untracked files` },
					} satisfies DiffFile),
		),
	);
	return [...parseDiff(patch), ...untracked];
}

const UNTRACKED_READ_LIMIT = 500;
const UNTRACKED_MAX_BYTES = 512 * 1024;

// `ls-files --others` also lists symlinks, untracked nested repositories as `dir/`, and files deleted since; reading
// one of them must not fail the whole listing.
async function readUntracked(path: string): Promise<UntrackedContent> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return { kind: "unread", reason: `symlink to ${await readlink(path)}` };
		if (info.isDirectory()) return { kind: "unread", reason: "directory, not shown" };
		// A FIFO would block the read forever.
		if (!info.isFile()) return { kind: "unread", reason: "special file, not shown" };
		if (info.size > UNTRACKED_MAX_BYTES) return { kind: "tooLarge", size: info.size };
		return { kind: "read", bytes: await readFile(path) };
	} catch (error) {
		return { kind: "unread", reason: `not read: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Changes staged in the index. */
export async function stagedFiles(repo: Repo): Promise<DiffFile[]> {
	return parseDiff(await git(repo.root, ["diff", "--cached", ...DIFF_ARGS]));
}

/** The refs that decide the base branch. */
export interface BaseRefs {
	/** The checked-out branch; undefined on a detached HEAD. */
	readonly branch: string | undefined;
	/** Which of `main` and `master` exist as local branches. */
	readonly local: readonly string[];
	/** The remote's default branch as `<remote>/<branch>`, when known. */
	readonly remoteHead: string | undefined;
}

/** The branch to compare against: `main`, else `master`, else the remote HEAD; undefined when none or HEAD is it. */
export function chooseBase(refs: BaseRefs): string | undefined {
	const base = ["main", "master"].find((name) => refs.local.includes(name)) ?? refs.remoteHead;
	if (base === undefined || refs.branch === undefined) return base;
	const baseBranch = base === refs.remoteHead ? base.slice(base.indexOf("/") + 1) : base;
	return baseBranch === refs.branch ? undefined : base;
}

/** The base branch of `repo` by `chooseBase`. */
export async function baseBranch(repo: Repo): Promise<string | undefined> {
	const [branch, local, remoteHead] = await Promise.all([
		optional(git(repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])),
		git(repo.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/main", "refs/heads/master"]),
		optional(git(repo.root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])),
	]);
	return chooseBase({ branch, local: local.split("\n").filter((name) => name.length > 0), remoteHead });
}

// Commands that exit non-zero for an expected absence: no branch checked out, no remote HEAD.
async function optional(output: Promise<string>): Promise<string | undefined> {
	try {
		return (await output).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Everything that differs between the working tree and where HEAD left `base`. */
export async function baseFiles(repo: Repo, base: string): Promise<DiffFile[]> {
	const mergeBase = (await git(repo.root, ["merge-base", "HEAD", base])).trim();
	return parseDiff(await git(repo.root, ["diff", ...DIFF_ARGS, mergeBase]));
}

const HISTORY_LIMIT = 300;

/** The newest commits of the current branch; none before the first commit. */
export async function history(repo: Repo): Promise<Commit[]> {
	const output = await optional(git(repo.root, ["log", "--no-color", `-n${HISTORY_LIMIT}`, ...LOG_FORMAT]));
	return output === undefined ? [] : parseLog(output);
}

/** The files a commit changed; a merge against its first parent. */
export async function commitFiles(repo: Repo, sha: string): Promise<DiffFile[]> {
	return parseDiff(
		await git(repo.root, ["show", ...DIFF_ARGS, "--format=", "--patch", "--diff-merges=first-parent", sha]),
	);
}

/** Stage the working-tree state of `file`. */
export async function stage(repo: Repo, file: DiffFile): Promise<void> {
	await git(repo.root, ["add", "--", file.path]);
}

/** Unstage `file`, both sides of a rename. */
export async function unstage(repo: Repo, file: DiffFile): Promise<void> {
	// `git restore --staged` needs a HEAD commit; `git reset` also works before the first one.
	await git(repo.root, ["reset", "-q", "--", file.path, ...(file.oldPath === undefined ? [] : [file.oldPath])]);
}

/** Drop the working-tree changes of `file`; an untracked file is deleted. */
export async function revert(repo: Repo, file: DiffFile): Promise<void> {
	if (file.status === "?") await rm(join(repo.root, file.path), { force: true });
	else await git(repo.root, ["restore", "--", file.path]);
}
