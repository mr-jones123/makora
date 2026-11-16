// How a child is changed from outside it: `merge` brings a finished write child's branch into its parent's tree, `stop`
// ends a child's work and keeps everything, `remove` stops a child and its children and deletes their worktrees. The
// parent calls them as tools from cells; the dashboard calls them for the user. Each converges when it runs again.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationHandle,
	type ConversationId,
	defineTool,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, str, unknown } from "@earendil-works/pi-schema";
import type { KernelManager } from "../kernel/manager.ts";
import { git, MAKORA_AUTHOR } from "../repl/git-tree.ts";
import { AgentControl, AgentsDoc, roundKeys } from "./docs.ts";
import { stateLines } from "./prompts.ts";
import type { AgentRecord, StopReason } from "./types.ts";
import { removeAgentWorktree } from "./worktree.ts";

/** What merge, stop and remove run on: a tool call's API, or the host's harness with its clock. */
export type ControlApi = Pick<ToolExecutionApi, "commit" | "snapshot" | "now"> & {
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
};

/** Why a child is stopped, as its record keeps it. */
export type StopCause = { readonly reason: StopReason; readonly detail: string };

/** How a merge ended. */
export type MergeOutcome = { readonly merged: true; readonly commit: string } | { readonly conflicts: string[] };

const NameParameters = obj({ name: str({ description: "The child's name" }) });

const BY_PARENT: StopCause = { reason: "user", detail: "stopped by its parent" };

/** What the control tools run on. */
export type ControlOptions = {
	readonly kernels: KernelManager;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
};

/** `merge`, `stop` and `remove`, callable from cells. */
export function createControlTools(options: ControlOptions): ToolRegistration<typeof NameParameters>[] {
	return [
		defineTool({
			name: "merge",
			description:
				"Merge a finished write child's branch into this conversation's tree; conflicts come back as data.",
			parameters: NameParameters,
			structuredOutputSchema: unknown(),
			callers: ["tools"],
			async execute({ name }, api, context) {
				const record = childOf(await children(api, api.conversationId, context), name);
				const merged = await mergeAgent(api, record, (await api.agent(context)).cwd ?? options.defaultCwd, context);
				const text =
					"conflicts" in merged ? `conflicts: ${merged.conflicts.join(", ")}` : `merged ${merged.commit}`;
				return { output: [{ type: "text", text }], structuredOutput: merged };
			},
		}),
		defineTool({
			name: "stop",
			description: "Stop a child's work; it keeps its transcript and worktree until removed.",
			parameters: NameParameters,
			structuredOutputSchema: unknown(),
			callers: ["tools"],
			async execute({ name }, api, context) {
				const record = childOf(await children(api, api.conversationId, context), name);
				const stopped = await stopAgent(api, record, BY_PARENT, context);
				return { output: [{ type: "text", text: stateLines(name, stopped.state) }], structuredOutput: stopped };
			},
		}),
		defineTool({
			name: "remove",
			description: "Stop a child and its children, and delete their worktrees; an unmerged write branch is kept.",
			parameters: NameParameters,
			structuredOutputSchema: unknown(),
			callers: ["tools"],
			async execute({ name }, api, context) {
				const record = childOf(await children(api, api.conversationId, context), name);
				const removed = await removeAgent(api, record, BY_PARENT, options.kernels, context);
				return { output: [{ type: "text", text: `removed ${removed.join(", ")}` }], structuredOutput: { removed } };
			},
		}),
	];
}

/**
 * Merge done write child `record`'s branch into `cwd`, its parent's tree, with `--no-ff` as makora. Refuses while the
 * user has a merge, cherry-pick, revert or rebase in progress there. A conflict aborts the merge, leaves the tree as it
 * was, and comes back as the conflicting paths; a merge a hook or signing stopped is aborted and throws. Merging a
 * merged child returns its merge commit.
 */
export async function mergeAgent(
	api: ControlApi,
	record: AgentRecord,
	cwd: string,
	context: Context,
): Promise<MergeOutcome> {
	const { name, state, worktree } = record;
	if (state.kind === "merged") return { merged: true, commit: state.mergeCommit };
	if (state.kind !== "done") throw new Error(`${name} is ${state.kind}; only a done write child merges`);
	if (state.result.mode !== "write" || worktree.kind !== "worktree" || worktree.branch === undefined) {
		throw new Error(`${name} has no branch to merge (${state.result.mode} result)`);
	}
	const unfinished = await unfinishedOperation(cwd);
	if (unfinished !== undefined) {
		throw new Error(`Cannot merge ${name}: ${cwd} has ${unfinished} in progress; finish or abort it first`);
	}
	const env = { ...process.env, ...MAKORA_AUTHOR };
	const message = `Merge ${name} (${worktree.branch})`;
	try {
		await git(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, worktree.branch], env);
	} catch (error) {
		// No merge was in progress before, so a MERGE_HEAD now is this merge's. Without one, git refused to start (a
		// dirty tree in the way): the call's error.
		const started = await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => undefined);
		if (started === undefined) throw error;
		const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
		await git(cwd, ["merge", "--abort"]);
		// A merge that stopped without conflicts failed in a hook or in signing: its error says why.
		if (conflicts.length === 0) throw error;
		return { conflicts };
	}
	const commit = await git(cwd, ["rev-parse", "HEAD"]);
	await api.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, record.parentConversationId);
		const current = doc.agents[name]!;
		if (current.state.kind === "done") {
			doc.agents[name] = {
				...current,
				state: { kind: "merged", result: current.state.result, mergeCommit: commit, at: api.now() },
			};
		}
	}, context);
	return { merged: true, commit };
}

// What git keeps in the git directory while an operation waits for the user, and what it is called.
const UNFINISHED = {
	MERGE_HEAD: "a merge",
	CHERRY_PICK_HEAD: "a cherry-pick",
	REVERT_HEAD: "a revert",
	"rebase-merge": "a rebase",
	"rebase-apply": "a rebase",
} as const;

/** The operation the user left unfinished in the worktree of `cwd`, which a merge must not land in or abort. */
async function unfinishedOperation(cwd: string): Promise<string | undefined> {
	const operations = Object.entries(UNFINISHED);
	const paths = (await git(cwd, ["rev-parse", ...operations.flatMap(([name]) => ["--git-path", name])])).split("\n");
	return operations[paths.findIndex((path) => existsSync(resolve(cwd, path)))]?.[1];
}

/**
 * Stop `record` for `cause`: a queued or running child is stopped in one commit that also tells its anchor and moves
 * it to its next round, then its conversation is aborted. Anything else stays as it is. Returns the record after.
 */
export async function stopAgent(
	api: ControlApi,
	record: AgentRecord,
	cause: StopCause,
	context: Context,
): Promise<AgentRecord> {
	const { name, parentConversationId: parentId } = record;
	await api.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, parentId);
		const current = doc.agents[name]!;
		if (current.state.kind !== "queued" && current.state.kind !== "running") return;
		const runtime = doc.runtime[name]!;
		await tx.signal(runtime.anchor, AgentControl, roundKeys(runtime.round).control, { kind: "stop", ...cause });
		doc.agents[name] = { ...current, state: { kind: "stopped", ...cause, at: api.now() } };
		doc.runtime[name] = { ...runtime, round: runtime.round + 1 };
	}, context);
	await (await api.conversation(record.conversationId, context))?.abort(context);
	return childOf(await children(api, parentId, context), name);
}

const PARENT_REMOVED: StopCause = { reason: "parent", detail: "its parent was removed" };

/**
 * Remove `record` and, first, its own children: stop it for `cause`, stop its kernel, delete its worktree (a merged
 * branch too), and mark it removed, which ends its anchor. Returns the names removed, deepest first.
 */
export async function removeAgent(
	api: ControlApi,
	record: AgentRecord,
	cause: StopCause,
	kernels: KernelManager,
	context: Context,
): Promise<string[]> {
	const removed: string[] = [];
	for (const child of Object.values(await children(api, record.conversationId, context))) {
		removed.push(...(await removeAgent(api, child, PARENT_REMOVED, kernels, context)));
	}
	const parentId = record.parentConversationId;
	const stopped = await stopAgent(api, record, cause, context);
	await kernels.stop(record.conversationId);
	if (stopped.state.kind !== "removed") await removeAgentWorktree(record, stopped.state.kind === "merged");
	await api.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, parentId);
		const current = doc.agents[record.name]!;
		if (current.state.kind === "removed") return;
		const runtime = doc.runtime[record.name]!;
		await tx.signal(runtime.anchor, AgentControl, roundKeys(runtime.round).control, { kind: "remove" });
		doc.agents[record.name] = { ...current, state: { kind: "removed", at: api.now() } };
	}, context);
	removed.push(record.name);
	return removed;
}

/** The children of conversation `parentId`, by name. */
export async function children(
	api: Pick<ControlApi, "snapshot">,
	parentId: ConversationId,
	context: Context,
): Promise<Readonly<Record<string, AgentRecord>>> {
	return (await api.snapshot(AgentsDoc, parentId, context))?.agents ?? {};
}

/** The caller's child `name`; a name the caller has no child under is the call's error. */
export function childOf(agents: Readonly<Record<string, AgentRecord>>, name: string): AgentRecord {
	const record = Object.hasOwn(agents, name) ? agents[name] : undefined;
	if (record === undefined) throw new Error(`No child named ${name}`);
	return record;
}
