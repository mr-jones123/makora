// What the dashboard's keys do to the selected agent: open its diff, merge a finished writer, stop a running agent,
// remove an agent with its children (or a fork, as forks are removed). Each asks for confirmation first and returns
// the line the dashboard shows as its outcome.
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type ControlApi, childOf, children, mergeAgent, removeAgent, stopAgent } from "../agents/control.ts";
import type { AgentRecord } from "../agents/types.ts";
import { hasUncommittedChanges, removeFork } from "../fork.ts";
import { tildify } from "../paths.ts";
import type { MakoraSession } from "../session.ts";
import { fitStart } from "./bars.ts";
import type { AgentFacts, DashboardRow } from "./dashboard.ts";
import type { SinceTab } from "./diff-state.ts";

/** What the actions need from the TUI. */
export interface ActionHost {
	readonly session: MakoraSession;
	/** Ask the user to confirm `title`, explained by `detail`; `action` labels the confirming choice. */
	confirm(title: string, action: string, detail?: string): Promise<boolean>;
}

/** How an action ended: the line to show, and the conversations it removed. */
export type ActionOutcome = { readonly note: string | undefined; readonly removed: readonly ConversationId[] };

/** Where `d` opens the diff view: a folder, and the commit its work started at. */
export type DiffTarget =
	| { readonly kind: "open"; readonly cwd: string; readonly since: SinceTab | undefined }
	| { readonly kind: "refused"; readonly note: string };

const context = BACKGROUND_CONTEXT;

/** The diff `d` shows: a subagent's worktree against its base commit, a fork's against its fork point, the root's folder. */
export function diffTarget(row: DashboardRow): DiffTarget {
	const { who, cwd, name } = row.facts;
	switch (who.kind) {
		case "main":
			return cwd === undefined
				? { kind: "refused", note: `${name} has no folder.` }
				: { kind: "open", cwd, since: undefined };
		case "fork": {
			const { files } = who.fork;
			if (files.kind === "shared" || cwd === undefined) return { kind: "open", cwd: cwd ?? "", since: undefined };
			return {
				kind: "open",
				cwd,
				since: { kind: "since", commit: files.commit, label: `fork point ${files.commit.slice(0, 7)}` },
			};
		}
		case "agent": {
			const { worktree, state } = who.record;
			if (worktree.kind === "shared") return { kind: "open", cwd: worktree.cwd, since: undefined };
			if (state.kind === "queued") return { kind: "refused", note: `${name} is queued and has no worktree yet.` };
			if (!existsSync(worktree.root))
				return { kind: "refused", note: `${name}'s worktree ${tildify(worktree.root)} is gone.` };
			const since: SinceTab = {
				kind: "since",
				commit: worktree.baseCommit,
				label: `base ${worktree.baseCommit.slice(0, 7)}`,
			};
			return { kind: "open", cwd: worktree.root, since };
		}
	}
}

/** `m`: merge a done write agent's branch into its parent's folder, after a confirmation. */
export async function mergeRow(host: ActionHost, row: DashboardRow): Promise<ActionOutcome> {
	const record = await current(host, row);
	if (record === undefined) return noted("Only a subagent's branch merges.");
	const { name, state, worktree } = record;
	if (state.kind === "merged") return noted(`${name} is merged already, as ${state.mergeCommit.slice(0, 7)}.`);
	if (state.kind !== "done" || state.result.mode !== "write" || worktree.kind !== "worktree") {
		return noted(
			`${name} is ${state.kind === "done" ? `a ${record.mode} agent` : state.kind}; only a done write agent merges.`,
		);
	}
	const parent = await host.session.harness.conversation(record.parentConversationId, context);
	const cwd = (await parent?.agent(context))?.cwd ?? host.session.meta.cwd;
	const { files, added, removed } = state.result.diffStat;
	const title = `Merge ${name} (${files} ${files === 1 ? "file" : "files"}, +${added} −${removed}) into ${short(cwd)}?`;
	if (!(await host.confirm(title, `Merge ${name}`))) return CANCELLED;
	const outcome = await mergeAgent(controlApi(host.session), record, cwd, host.session.git, context);
	return noted(
		"conflicts" in outcome
			? `${name} conflicts in ${outcome.conflicts.join(", ")}; the merge was aborted and nothing changed.`
			: `Merged ${name} into ${tildify(cwd)} as ${outcome.commit.slice(0, 7)}.`,
	);
}

/** `s`: stop a running or queued agent, after a confirmation; it keeps its transcript and worktree. */
export async function stopRow(host: ActionHost, row: DashboardRow): Promise<ActionOutcome> {
	const record = await current(host, row);
	if (record === undefined) return noted("Only subagents stop here; Ctrl+C in a conversation stops its run.");
	if (record.state.kind !== "running" && record.state.kind !== "queued") {
		return noted(`${record.name} is ${record.state.kind}; only a running or queued agent stops.`);
	}
	if (!(await host.confirm(`Stop ${record.name}? It keeps its transcript and worktree.`, `Stop ${record.name}`))) {
		return CANCELLED;
	}
	const cause = { reason: "user", detail: "stopped from the dashboard" } as const;
	await stopAgent(controlApi(host.session), record, cause, context);
	return noted(`Stopped ${record.name}.`);
}

/**
 * `x`: remove an agent and its children, saying what is deleted; or a fork, warning when its worktree has uncommitted
 * changes. The main conversation stays.
 */
export async function removeRow(
	host: ActionHost,
	row: DashboardRow,
	facts: readonly AgentFacts[],
): Promise<ActionOutcome> {
	const { who, name, conversationId } = row.facts;
	switch (who.kind) {
		case "main":
			return noted("The main conversation cannot be removed.");
		case "fork": {
			const fork = { conversationId, record: who.fork };
			const { files } = who.fork;
			const title =
				files.kind === "shared"
					? `Remove ${name}? Its folder is shared and stays.`
					: (await hasUncommittedChanges(fork))
						? `${name} has uncommitted changes in ${tildify(files.path)}. Remove it and discard them?`
						: `Remove ${name} and its worktree ${tildify(files.path)}?`;
			if (!(await host.confirm(title, `Remove ${name}`))) return CANCELLED;
			await removeFork(host.session, fork, context);
			return { note: `Removed ${name}.`, removed: [conversationId] };
		}
		case "agent": {
			const record = await current(host, row);
			if (record === undefined) return noted(`${name} is gone.`);
			const below = descendants(conversationId, facts);
			const also = below.length === 0 ? "" : ` Its children go too: ${below.map((each) => each.name).join(", ")}.`;
			if (!(await host.confirm(`Remove ${name}?`, `Remove ${name}`, `${deletes(record)}${also}`))) return CANCELLED;
			const cause = { reason: "user", detail: "removed from the dashboard" } as const;
			const names = await removeAgent(controlApi(host.session), record, cause, host.session, context);
			return {
				note: `Removed ${names.join(", ")}.`,
				removed: [conversationId, ...below.map((each) => each.conversationId)],
			};
		}
	}
}

/**
 * What removing `record` keeps and deletes: a review checkout goes with whatever was changed in it; an unmerged branch
 * is kept with all its work, since removing commits what is uncommitted; a merged branch goes with its worktree.
 */
function deletes(record: AgentRecord): string {
	const { worktree, state } = record;
	if (worktree.kind === "shared") return "It shares its parent's folder, which stays.";
	const path = tildify(worktree.root);
	if (worktree.branch === undefined) return `Deletes its checkout ${path} with anything changed in it.`;
	return state.kind === "merged"
		? `Deletes its merged branch ${worktree.branch} and its worktree ${path}.`
		: `Keeps its branch ${worktree.branch} with all its work: what is uncommitted is committed to it first. Then deletes its worktree ${path} and the files git ignores there.`;
}

/** A path short enough for a confirmation's title, which is one row: its end, where the agent's folder is named. */
function short(path: string): string {
	return fitStart(tildify(path), 28);
}

/** Every listed agent below `id`, nearest first. */
function descendants(id: ConversationId, facts: readonly AgentFacts[]): AgentFacts[] {
	const direct = facts.filter((each) => each.parentId === id && each.who.kind === "agent");
	return [...direct, ...direct.flatMap((each) => descendants(each.conversationId, facts))];
}

/** The row's subagent record as committed now: the dashboard's copy can be a poll old. */
async function current(host: ActionHost, row: DashboardRow): Promise<AgentRecord | undefined> {
	const { who } = row.facts;
	if (who.kind !== "agent") return undefined;
	const siblings = await children(host.session.harness, who.record.parentConversationId, context);
	return childOf(siblings, who.record.name);
}

/** The user declined the confirmation: nothing to say. */
const CANCELLED: ActionOutcome = { note: undefined, removed: [] };

function noted(note: string): ActionOutcome {
	return { note, removed: [] };
}

/** The control functions over the session's harness, as the user's hand rather than a tool call's. */
function controlApi(session: MakoraSession): ControlApi {
	const { harness } = session;
	return {
		commit: harness.commit.bind(harness),
		snapshot: harness.snapshot.bind(harness),
		conversation: harness.conversation.bind(harness),
		now: () => Date.now(),
	};
}
