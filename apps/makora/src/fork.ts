// Forks: a Durable fork of a conversation at an earlier entry that keeps the Python variables and the files as they were
// there. Inside a git repository the fork's files are a git worktree of its own, at a commit of the fork point's file
// snapshot; the record of each fork is a `makora.fork` document on the fork.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	type Cursor,
	configure,
	defineDocFamily,
	type EntryId,
	type EntryRecord,
	type Harness,
} from "@earendil-works/pi-durable";
import { pythonDetails } from "./repl/details.ts";
import { commitTree, git } from "./repl/git-tree.ts";
import type { MakoraSession } from "./session.ts";
import { messageText } from "./transcript-rows.ts";
import { addWorktree, findRepo, type RepoPlace, removeWorktree, worktreePath } from "./worktrees.ts";

/** Where a fork's files live. */
export type ForkFiles =
	/** A worktree at a commit of the fork point's file snapshot, kept alive by `forkRef`. */
	| { readonly kind: "snapshot"; readonly path: string; readonly commit: string; readonly tree: string }
	/** A worktree at the repository's HEAD: no cell before the fork point saved a file snapshot. */
	| { readonly kind: "head"; readonly path: string; readonly commit: string }
	/** The parent's folder: outside a git repository, or in one without commits or snapshot. */
	| { readonly kind: "shared" };

/** The `makora.fork` document of a fork. */
export type ForkRecord = {
	/** `fork N`, N counting the session's forks. */
	readonly label: string;
	readonly parentConversationId: ConversationId;
	/** The last entry the fork shares with its parent. */
	readonly forkEntryId: EntryId;
	readonly files: ForkFiles;
	/** Removed by the user: its worktree is gone, Durable keeps the transcript. */
	readonly removed?: true;
};

/** A fork of the session. */
export type Fork = { readonly conversationId: ConversationId; readonly record: ForkRecord };

/** A user message a fork can start before: the fork shares history through `at`, the entry before `message`. */
export type ForkPoint = { readonly message: EntryId; readonly at: EntryId; readonly text: string };

/** A new fork, and what the user should know about its files. */
export type CreatedFork = Fork & { readonly conversation: Conversation; readonly notice?: string };

// A family member is created with its seed, so a fork's record is whole from the commit that creates the fork. A fork
// of a fork starts without one and gets its own.
const ForkDoc = defineDocFamily<ForkRecord, ForkRecord>({
	kind: "makora.fork",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

const FORK_KEY = "fork";

/** The user messages of `conversation` that have an entry before them, newest first. */
export async function forkPoints(conversation: Conversation, context: Context): Promise<ForkPoint[]> {
	const points: ForkPoint[] = [];
	let after: { readonly message: EntryId; readonly text: string } | undefined;
	for await (const entry of newestFirst(conversation, undefined, context)) {
		if (after !== undefined) points.push({ ...after, at: entry.id });
		const message = entry.model?.[0];
		after =
			entry.kind === "pi.user" && message !== undefined
				? { message: entry.id, text: messageText(message) }
				: undefined;
	}
	return points;
}

/**
 * Fork `parent` after entry `at` as the session's next `fork N`. Inside a git repository the fork gets a worktree under
 * `worktrees` at the fork point's file snapshot, or at HEAD when there is none; otherwise it shares the parent's folder.
 * The fork's first cell restores the variables of the fork point from the history it shares with `parent`.
 */
export async function createFork(
	session: MakoraSession,
	parent: Conversation,
	at: EntryId,
	worktrees: string,
	context: Context,
): Promise<CreatedFork> {
	const parentCwd = (await parent.agent(context)).cwd ?? session.meta.cwd;
	const placement = await placeFiles(parentCwd, parent, at, context);
	const label = `fork ${(await listForks(session.harness, context)).length + 1}`;
	let created: { readonly record: ForkRecord; readonly cwd: string } | undefined;
	const conversation = await parent.fork(
		at,
		{
			ownership: { kind: "ownerless" },
			init: async (tx, id) => {
				const { files, cwd } = locate(placement, parentCwd, worktrees, session.meta.id, id);
				created = { record: { label, parentConversationId: parent.id, forkEntryId: at, files }, cwd };
				await tx.doc(ForkDoc, id, FORK_KEY, created.record);
				await configure(tx, id, { cwd });
			},
		},
		context,
	);
	// `init` ran in the creating commit, which `fork` awaited.
	const { record, cwd } = created!;
	const fork = { conversationId: conversation.id, record };
	try {
		await ensureForkFiles(session, fork);
		// The session's folder may be one git does not track, such as an empty or ignored one.
		mkdirSync(cwd, { recursive: true });
	} catch (error) {
		await markRemoved(session.harness, fork, context);
		throw error;
	}
	const notice = NOTICES[placement.kind === "shared" ? placement.reason : placement.kind];
	return { ...fork, conversation, ...(notice === undefined ? {} : { notice }) };
}

/** Every fork of the session, removed ones included, oldest first. */
export async function listForks(harness: Harness, context: Context): Promise<Fork[]> {
	const forks: Fork[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, PAGE, cursor), context);
		for (const conversation of page.items) {
			if (conversation.parent === undefined) continue;
			const record = await readFork(harness, conversation.id, context);
			if (record !== undefined) forks.push({ conversationId: conversation.id, record });
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return forks;
}

/** The fork record of conversation `id`, or undefined when it is not a fork. */
export function readFork(harness: Harness, id: ConversationId, context: Context): Promise<ForkRecord | undefined> {
	return harness.snapshot(ForkDoc, id, FORK_KEY, context);
}

/**
 * Give `fork` its worktree when it has none: right after the fork, and again when a crash came between the fork's
 * commit and its worktree or the folder was deleted. Runs git in the session's folder, a worktree of the same repository.
 */
export async function ensureForkFiles(session: MakoraSession, fork: Fork): Promise<void> {
	const { files } = fork.record;
	if (files.kind === "shared" || existsSync(files.path)) return;
	const repo = session.meta.cwd;
	if (files.kind === "snapshot") await git(repo, ["update-ref", forkRef(session, fork.conversationId), files.commit]);
	await addWorktree(repo, files.path, { kind: "detached", commit: files.commit });
}

/** Whether the fork's worktree has changes against the commit it started at, untracked files included. */
export async function hasUncommittedChanges(fork: Fork): Promise<boolean> {
	const { files } = fork.record;
	if (files.kind === "shared" || !existsSync(files.path)) return false;
	return (await git(files.path, ["status", "--porcelain"])).length > 0;
}

/**
 * Remove `fork`: stop its work and kernel, delete its worktree and keep-alive ref, and hide it. Durable keeps its
 * transcript. Each step converges, so removing again after a crash finishes the job.
 */
export async function removeFork(session: MakoraSession, fork: Fork, context: Context): Promise<void> {
	const id = fork.conversationId;
	await (await session.harness.conversation(id, context))?.abort(context);
	await session.kernels.stop(id);
	const { files } = fork.record;
	const repo = session.meta.cwd;
	if (files.kind !== "shared") await removeWorktree(repo, files.path);
	if (files.kind === "snapshot") await git(repo, ["update-ref", "-d", forkRef(session, id)]);
	await markRemoved(session.harness, fork, context);
}

/** The ref that keeps a snapshot fork's commit alive against `git gc`. */
export function forkRef(session: MakoraSession, id: ConversationId): string {
	return `refs/makora/${session.meta.id}/forks/${id}`;
}

/** Where a new fork's files come from, before the fork's worktree path is known. */
type Placement =
	| { readonly kind: "snapshot"; readonly repo: RepoPlace; readonly commit: string; readonly tree: string }
	| { readonly kind: "head"; readonly repo: RepoPlace; readonly commit: string }
	| { readonly kind: "shared"; readonly reason: "not_git" | "no_commits" };

const NOTICES: Readonly<Record<"snapshot" | "head" | "not_git" | "no_commits", string | undefined>> = {
	snapshot: undefined,
	head: "No file snapshot at the fork point; the fork's files start at HEAD (uncommitted changes are not included).",
	not_git: "Not in a git repository; the fork shares this folder with the conversation it came from.",
	no_commits: "No file snapshot at the fork point and the repository has no commits; the fork shares this folder.",
};

async function placeFiles(cwd: string, parent: Conversation, at: EntryId, context: Context): Promise<Placement> {
	const repo = await findRepo(cwd);
	if (repo === undefined) return { kind: "shared", reason: "not_git" };
	const head = await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => undefined);
	const tree = await snapshotTree(parent, at, context);
	// HEAD as the parent makes `git diff HEAD` in the fork show what the fork point had on top of the branch.
	if (tree !== undefined)
		return { kind: "snapshot", repo, tree, commit: await commitTree(repo.top, tree, head, "makora fork") };
	return head === undefined ? { kind: "shared", reason: "no_commits" } : { kind: "head", repo, commit: head };
}

/** The tree of the newest `python` result at or before `at` that saved one, as a bare sha. */
async function snapshotTree(conversation: Conversation, at: EntryId, context: Context): Promise<string | undefined> {
	for await (const entry of newestFirst(conversation, at, context)) {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult" || message.toolName !== "python") continue;
		const tree = pythonDetails(message.details)?.kernel.tree;
		if (tree !== undefined) return tree.slice("git:".length);
	}
	return undefined;
}

/** The fork's files and cwd: `worktrees/<repo dir>/<session>/<conversation>` plus the parent's relative folder. */
function locate(
	placement: Placement,
	parentCwd: string,
	worktrees: string,
	sessionId: string,
	id: ConversationId,
): { readonly files: ForkFiles; readonly cwd: string } {
	if (placement.kind === "shared") return { files: { kind: "shared" }, cwd: parentCwd };
	const path = worktreePath(worktrees, placement.repo, sessionId, id);
	const files: ForkFiles =
		placement.kind === "snapshot"
			? { kind: "snapshot", path, commit: placement.commit, tree: placement.tree }
			: { kind: "head", path, commit: placement.commit };
	return { files, cwd: join(path, placement.repo.relative) };
}

async function markRemoved(harness: Harness, fork: Fork, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		(await tx.doc(ForkDoc, fork.conversationId, FORK_KEY, fork.record)).removed = true;
	}, context);
}

const PAGE = 200;

// Fork-aware: a fork's history continues into its parent's entries up to the fork point.
async function* newestFirst(
	conversation: Conversation,
	maxEntryId: EntryId | undefined,
	context: Context,
): AsyncGenerator<EntryRecord> {
	const query =
		maxEntryId === undefined ? { order: "descending" as const } : { order: "descending" as const, maxEntryId };
	for (let cursor: Cursor | undefined; ; ) {
		const page = await conversation.entries(query, PAGE, cursor, context);
		yield* page.items;
		if (page.next === undefined) return;
		cursor = page.next;
	}
}
