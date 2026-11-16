// Makora's git worktrees: where a conversation's own checkout lives outside the repository, and how it is added and
// removed. Forks and subagents both use them. Adding and removing are git writes: callers run them inside the session's
// `GitWrites` queue for the repository.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { git } from "./repl/git-tree.ts";

/** The repository a worktree comes from, as seen from a conversation's folder. */
export type RepoPlace = {
	/** Top level of the folder's worktree. */
	readonly top: string;
	/** The main repository's directory name, shared by all its worktrees. */
	readonly name: string;
	/** `<name>-<short hash of its path>`: the repository's directory under a worktree root. */
	readonly dir: string;
	/** The folder relative to `top`. */
	readonly relative: string;
};

/** What a new worktree checks out. */
export type WorktreeCheckout =
	| { readonly kind: "detached"; readonly commit: string }
	/** The branch, created at `base` when it does not exist yet. */
	| { readonly kind: "branch"; readonly branch: string; readonly base: string };

/** The repository holding `cwd`, or undefined outside git. */
export async function findRepo(cwd: string): Promise<RepoPlace | undefined> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
	if (top === undefined) return undefined;
	// A linked worktree (a fork's, a child's) still belongs under the main repository's directory.
	const common = resolve(top, await git(top, ["rev-parse", "--git-common-dir"]));
	const main = basename(common) === ".git" ? dirname(common) : common;
	const hash = createHash("sha256").update(main).digest("hex").slice(0, 8);
	return { top, name: basename(main), dir: `${basename(main)}-${hash}`, relative: relative(top, realpathSync(cwd)) };
}

/** The worktree of conversation `id`: `<root>/<repo dir>/<session>/<conversation>`. */
export function worktreePath(root: string, repo: RepoPlace, sessionId: string, id: ConversationId): string {
	return join(root, repo.dir, sessionId, String(id));
}

/**
 * Add a worktree at `path` from the repository holding `repo`, unless its folder exists. Converges after a crash and
 * after the folder was deleted by hand: git still lists such a worktree and refuses its path until it is pruned.
 */
export async function addWorktree(repo: string, path: string, checkout: WorktreeCheckout): Promise<void> {
	if (existsSync(path)) return;
	await git(repo, ["worktree", "prune"]);
	mkdirSync(dirname(path), { recursive: true });
	if (checkout.kind === "detached") {
		await git(repo, ["worktree", "add", "--detach", path, checkout.commit]);
		return;
	}
	const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`]).catch(
		() => undefined,
	);
	if (exists === undefined) await git(repo, ["worktree", "add", "-b", checkout.branch, path, checkout.base]);
	else await git(repo, ["worktree", "add", path, checkout.branch]);
}

/** Remove the worktree at `path`, uncommitted changes included; converges when its folder is already gone. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
	if (existsSync(path)) await git(repo, ["worktree", "remove", "--force", path]);
	else await git(repo, ["worktree", "prune"]);
}
