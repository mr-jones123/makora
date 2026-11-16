// makora's git writes to one repository, one at a time. Committing a child's work, merging, adding and removing
// worktrees and deleting branches take git's lock files (a worktree's `index.lock`, a branch's ref lock); two of them at
// once, such as removing a write child while its anchor commits its work, fail on the lock the other holds.
import { resolve } from "node:path";
import { git } from "../repl/git-tree.ts";

/**
 * Runs a session's git writes to each repository one after another. A repository is known by its common git dir, so
 * writes from its main worktree and from any linked worktree (a fork's, a child's) share one queue. A function that
 * takes `GitWrites` queues its own work; a git helper without it runs inside a queued piece of work.
 */
export class GitWrites {
	// The newest queued write per repository; an entry goes once its write settles with nothing queued after it, so the
	// map holds only repositories with writes in flight.
	readonly #tails = new Map<string, Promise<void>>();

	/** Run `work` once every write queued before it for the repository holding `path` has settled. */
	async run<T>(path: string, work: () => Promise<T>): Promise<T> {
		// A path that is gone keys itself: no other write can reach a worktree that no longer exists.
		const key = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() =>
			resolve(path),
		);
		const result = (this.#tails.get(key) ?? Promise.resolve()).then(work);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(key, tail);
		try {
			return await result;
		} finally {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		}
	}
}
