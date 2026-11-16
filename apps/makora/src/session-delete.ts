// Deleting a session's files outside its directory: the worktrees it made (forks', review checkouts, write worktrees),
// the write branches that hold nothing of the user's, its refs, and its folders under makora's worktree roots. A write
// branch with unmerged commits stays, with what its worktree left uncommitted committed to it first: deleting a session
// must not delete work a child made and nobody merged. Used by `makora rm` and when an ephemeral session closes.
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type Cursor, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentsDoc } from "./agents/docs.ts";
import type { AgentRecord } from "./agents/types.ts";
import { commitWork } from "./agents/worktree.ts";
import { type MakoraApp, worktreeRoots } from "./app.ts";
import { readFork } from "./fork.ts";
import { GitWrites } from "./git/writes.ts";
import { reapKernels } from "./kernel/manager.ts";
import { git } from "./repl/git-tree.ts";
import { lockSession, type SessionMeta, sessionDatabase, sessionDir } from "./sessions.ts";
import { removeWorktree } from "./worktrees.ts";

/** A worktree the session made, as its records name it. */
export type SessionWorktree = {
	readonly kind: "fork" | "review" | "write";
	readonly path: string;
	/** A folder of the repository the worktree belongs to, to find it by once the worktree is gone. */
	readonly repository: string;
	/** A subagent's record: a write child's branch and base, and the work to commit before its worktree goes. */
	readonly record?: AgentRecord;
};

/** What happens to a write child's branch: kept while it holds work nobody merged, else deleted. */
export type BranchFate = { readonly name: string; readonly keep: boolean; readonly why: string };

/**
 * One worktree to remove: the main worktree of its repository (undefined when that is gone too), whether it has
 * uncommitted changes, and its branch.
 */
export type PlannedWorktree = {
	readonly worktree: SessionWorktree;
	readonly repository: string | undefined;
	/** A kept branch gets them as a commit; anywhere else they go with the worktree, and the confirmation says so. */
	readonly changed: boolean;
	readonly branch: BranchFate | undefined;
};

/** What deleting a session's files does, decided before anything is deleted. */
export type CleanupPlan = {
	readonly sessionId: string;
	readonly roots: readonly string[];
	readonly worktrees: readonly PlannedWorktree[];
	/** Worktrees the records name outside the session's folders under makora's roots: left alone. */
	readonly outside: readonly string[];
	/** The main worktree of each repository the session used: pruned, and its `refs/makora/<session>/` deleted. */
	readonly repositories: readonly string[];
};

/** A stored session held for deleting: what goes and what stays, before anything is deleted. */
export type SessionDeletion = {
	readonly plan: CleanupPlan;
	/** Kill kernels a crashed process left, remove the worktrees, branches, refs and folders, then the session's directory. */
	run(): Promise<void>;
	/** Give back the session's lock, deleted or not. */
	release(): void;
};

/**
 * Hold stored session `meta` for deleting: take its lock, which fails while another process has it open, read its
 * worktrees from its records without resuming any work, and plan what goes.
 */
export async function prepareDeletion(app: MakoraApp, meta: SessionMeta, context: Context): Promise<SessionDeletion> {
	const sessions = app.paths.sessions;
	const lock = lockSession(sessions, meta.id);
	try {
		const storage = await openNodeSqliteStorage(sessionDatabase(sessions, meta.id));
		const harness = await Harness.open(
			storage,
			{ models: app.models, registry: createRegistry(), readOnly: true },
			context,
		);
		let worktrees: SessionWorktree[];
		try {
			worktrees = await sessionWorktrees(harness, meta.cwd, context);
		} finally {
			await harness.close(context);
		}
		const plan = await planCleanup(worktrees, meta.cwd, meta.id, worktreeRoots(app));
		return {
			plan,
			async run() {
				const dir = sessionDir(sessions, meta.id);
				reapKernels(join(dir, "kernels"));
				await applyCleanup(plan, new GitWrites());
				rmSync(dir, { recursive: true, force: true });
			},
			release: () => lock.release(),
		};
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Every worktree the session's records name: forks' and subagents', removed ones included. */
export async function sessionWorktrees(harness: Harness, cwd: string, context: Context): Promise<SessionWorktree[]> {
	const worktrees: SessionWorktree[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, PAGE, cursor), context);
		for (const conversation of page.items) {
			const fork = await readFork(harness, conversation.id, context);
			// A fork's worktree is a worktree of the session's own repository (`ensureForkFiles`).
			if (fork !== undefined && fork.files.kind !== "shared") {
				worktrees.push({ kind: "fork", path: fork.files.path, repository: cwd });
			}
			const children = (await harness.snapshot(AgentsDoc, conversation.id, context))?.agents ?? {};
			for (const record of Object.values(children)) {
				const { worktree } = record;
				if (worktree.kind === "worktree") {
					worktrees.push({ kind: record.mode, path: worktree.root, repository: worktree.repository, record });
				}
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return worktrees;
}

const PAGE = 200;

/**
 * Decide what deleting session `sessionId`'s `worktrees` does: each one inside the session's folder under one of
 * `roots` goes, with a write branch that holds no work nobody merged; anything else is left alone.
 */
export async function planCleanup(
	worktrees: readonly SessionWorktree[],
	cwd: string,
	sessionId: string,
	roots: readonly string[],
): Promise<CleanupPlan> {
	const planned: PlannedWorktree[] = [];
	const outside: string[] = [];
	const repositories = new Set<string>();
	const own = await mainWorktree([cwd]);
	if (own !== undefined) repositories.add(own);
	for (const worktree of worktrees) {
		if (!roots.some((root) => inSessionFolder(root, worktree.path, sessionId))) {
			outside.push(worktree.path);
			continue;
		}
		const repository = await mainWorktree([worktree.repository, worktree.path, cwd]);
		if (repository !== undefined) repositories.add(repository);
		const status = existsSync(worktree.path)
			? await git(worktree.path, ["status", "--porcelain"]).catch(() => "")
			: "";
		const changed = status !== "";
		const branch =
			repository === undefined || worktree.record === undefined
				? undefined
				: await branchFate(worktree.record, repository, changed);
		planned.push({ worktree, repository, changed, branch });
	}
	return { sessionId, roots, worktrees: planned, outside, repositories: [...repositories] };
}

/** Whether `path` is a conversation's folder in session `sessionId`'s folder under `root`: `<repo>/<session>/<id>`. */
function inSessionFolder(root: string, path: string, sessionId: string): boolean {
	const inner = relative(root, path);
	if (inner.startsWith("..") || isAbsolute(inner)) return false;
	const parts = inner.split(sep);
	return parts.length === 3 && parts[1] === sessionId;
}

/** The main worktree of the repository holding the first of `paths` that still is in one. */
async function mainWorktree(paths: readonly string[]): Promise<string | undefined> {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(
			() => undefined,
		);
		if (common !== undefined) return basename(common) === ".git" ? dirname(common) : common;
	}
	return undefined;
}

/**
 * A write child's branch is kept while it holds work: changes left uncommitted in its worktree, or commits beyond its
 * base that are not merged (recorded as merged, or reachable from the repository's HEAD). Undefined without a branch.
 */
async function branchFate(record: AgentRecord, repository: string, changed: boolean): Promise<BranchFate | undefined> {
	const { worktree } = record;
	if (worktree.kind !== "worktree" || worktree.branch === undefined) return undefined;
	const name = worktree.branch;
	const exists = await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).catch(
		() => undefined,
	);
	if (exists === undefined) return undefined;
	if (changed) return { name, keep: true, why: "uncommitted work, which is committed to it first" };
	const ahead = Number(await git(repository, ["rev-list", "--count", `${worktree.baseCommit}..${name}`]));
	if (ahead === 0) return { name, keep: false, why: "no commits beyond its base" };
	const merged =
		record.state.kind === "merged" ||
		(await git(repository, ["merge-base", "--is-ancestor", name, "HEAD"]).then(
			() => true,
			() => false,
		));
	if (merged) return { name, keep: false, why: "merged" };
	return { name, keep: true, why: `${ahead} commit${ahead === 1 ? "" : "s"} not merged` };
}

/**
 * Carry out `plan`: commit what a kept branch's worktree left uncommitted, remove each worktree and each branch that
 * goes, prune the repositories, delete their `refs/makora/<session>/`, and remove the session's empty folders under
 * the roots. Converges: anything already gone is skipped, so a second run after a crash or a cleaned temp folder
 * finishes the job.
 */
export async function applyCleanup(plan: CleanupPlan, writes: GitWrites): Promise<void> {
	for (const { worktree, repository, branch } of plan.worktrees) {
		if (branch?.keep === true && worktree.record !== undefined) {
			await commitWork(worktree.record, `${worktree.record.name}: unfinished work (session deleted)`, "", writes);
		}
		// Planned paths are inside the session's own folder, so a folder git no longer knows as a worktree goes as a
		// folder.
		const folder = () => rmSync(worktree.path, { recursive: true, force: true });
		if (repository === undefined) {
			folder();
			continue;
		}
		await writes.run(repository, async () => {
			await removeWorktree(repository, worktree.path).catch(folder);
			if (branch !== undefined && !branch.keep) {
				// Gone already when an earlier run deleted it.
				await git(repository, ["branch", "-D", branch.name]).catch(() => undefined);
			}
		});
	}
	for (const repository of plan.repositories) {
		await writes.run(repository, async () => {
			await git(repository, ["worktree", "prune"]);
			const refs = await git(repository, ["for-each-ref", "--format=%(refname)", `refs/makora/${plan.sessionId}/`]);
			for (const ref of refs.split("\n").filter(Boolean)) await git(repository, ["update-ref", "-d", ref]);
		});
	}
	for (const root of plan.roots) {
		for (const repo of existsSync(root) ? readdirSync(root) : []) {
			removeIfEmpty(join(root, repo, plan.sessionId));
			removeIfEmpty(join(root, repo));
		}
	}
}

function removeIfEmpty(folder: string): void {
	try {
		rmdirSync(folder);
	} catch {
		// Not empty, not a folder, or gone.
	}
}

/** The confirmation's lines: what `plan` removes, which branches it keeps and why, and what it leaves alone. */
export function describeCleanup(plan: CleanupPlan, tildify: (path: string) => string): string[] {
	const lines: string[] = [];
	const kept: BranchFate[] = [];
	for (const { worktree, changed, branch } of plan.worktrees) {
		const goes = branch !== undefined && !branch.keep ? `, and its branch ${branch.name} (${branch.why})` : "";
		const lost = changed && branch?.keep !== true ? " with its uncommitted changes" : "";
		lines.push(`  removes ${LABELS[worktree.kind]} ${tildify(worktree.path)}${lost}${goes}`);
		if (branch?.keep === true) kept.push(branch);
	}
	for (const branch of kept) lines.push(`  keeps branch ${branch.name}: ${branch.why}`);
	for (const path of plan.outside)
		lines.push(`  leaves ${tildify(path)} alone: it is outside makora's worktree folders`);
	return lines;
}

const LABELS: Readonly<Record<SessionWorktree["kind"], string>> = {
	fork: "fork worktree",
	review: "review checkout",
	write: "write worktree",
};
