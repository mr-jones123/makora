// The text agents exchange: a child's first input (its task and brief), a finished child's result for its parent, and
// a message between agents. The model reads the XML; the transcript keeps the same facts as entry data for the TUI.
// Also the notice about a child's worktree setup that its transcript and its parent's show.
import { tildify } from "../paths.ts";
import type { Relationship } from "./docs.ts";
import type { AgentRecord, AgentState } from "./types.ts";
import type { Preparation } from "./worktree.ts";

/** The entry kind of a child's result delivered to its parent. */
export const AGENT_RESULT_ENTRY = "makora.agent-result";
/** The entry kind of a message from another agent. */
export const AGENT_MESSAGE_ENTRY = "makora.agent-message";

/** The data of an `AGENT_RESULT_ENTRY` entry. */
export type AgentResultData = { readonly name: string; readonly state: AgentState };
/** The data of an `AGENT_MESSAGE_ENTRY` entry. */
export type AgentMessageData = { readonly from: string; readonly relationship: Relationship; readonly text: string };

/**
 * The child's first input: its task in `<agent_task>`, then what it needs to know to work and hand back, including a
 * setup command that was not approved (`prepared`).
 */
export function agentBrief(
	record: AgentRecord,
	parent: string,
	siblings: readonly string[],
	prepared: Preparation | undefined,
): string {
	const { worktree, budget } = record;
	const where =
		worktree.kind === "shared"
			? `You share your parent's folder ${worktree.cwd}: there is no git repository, so your changes land there directly.`
			: record.mode === "review"
				? `You work in your own checkout ${worktree.cwd}, detached at ${worktree.baseRef} (${worktree.baseCommit.slice(0, 7)}).`
				: `You work in your own worktree ${worktree.cwd} on branch ${worktree.branch}, from ${worktree.baseRef} (${worktree.baseCommit.slice(0, 7)}).`;
	const handBack =
		record.mode === "review"
			? "Hand back your findings as your final answer. Change nothing that matters: this checkout and anything you change in it are discarded with you."
			: "Hand back commit-ready work in your worktree and a short summary of what you changed as your final answer. makora commits what you leave uncommitted; your work reaches your parent only when it merges your branch.";
	const limits = [
		...(budget.usd === undefined ? [] : [`$${budget.usd}`]),
		...(budget.minutes === undefined ? [] : [`${budget.minutes} minutes`]),
	];
	const family = siblings.length === 0 ? "" : ` Your siblings: ${siblings.join(", ")}.`;
	const setup =
		prepared?.kind === "skipped"
			? [
					`The project's worktree setup command did not run, because the user has not approved it: \`${prepared.request.command}\`. Install what you need yourself, or tell your parent.`,
				]
			: [];
	return [
		`<agent_task name="${record.name}" mode="${record.mode}">`,
		record.task,
		"</agent_task>",
		"",
		`You are the subagent "${record.name}", started by ${parent}. ${where}`,
		`Budget: ${limits.join(", ")}.`,
		...setup,
		handBack,
		`Message your parent or siblings with \`await send(name, text)\` ("parent" for ${parent}).${family}`,
	].join("\n");
}

/**
 * The notice about a child's worktree setup: the command's output, why the worktree could not be added, or that the
 * command is not approved and how to approve it.
 */
export function setupNotice(prepared: Exclude<Preparation, { readonly kind: "ready" }>, settingsFile: string): string {
	if (prepared.kind !== "skipped") return prepared.output;
	const { repository, command, sha256 } = prepared.request;
	return [
		`Skipped the worktree setup command: it is not approved for ${tildify(repository)}.`,
		`$ ${command}`,
		`To approve it, start makora (not print mode) in this repository and approve it when a subagent needs it, or add ${JSON.stringify({ repository, sha256 })} to "agents.approvedSetups" in ${tildify(settingsFile)}.`,
	].join("\n");
}

/** What the parent reads when a child it is not waiting on finishes. */
export function agentResultText(name: string, state: AgentState): string {
	return `<agent_result name="${name}" state="${state.kind}">\n${describeState(state) || state.kind}\n</agent_result>`;
}

/** A message from another agent as its receiver reads it; the sender is decided by the host, never by Python. */
export function agentMessageText(message: AgentMessageData): string {
	return `<agent_message from="${message.from}" relationship="${message.relationship}">\n${message.text}\n</agent_message>`;
}

/** What a child's state says beyond its kind: its summary, branch head and diff stat, or why it stopped. */
export function describeState(state: AgentState): string {
	switch (state.kind) {
		case "queued":
		case "running":
		case "removed":
			return "";
		case "stopped":
			return `${state.reason}${state.detail === undefined ? "" : `: ${state.detail}`}`;
		case "done":
		case "merged": {
			const { result } = state;
			const head =
				result.mode === "write"
					? `${state.kind === "merged" ? `merged as ${state.mergeCommit.slice(0, 7)}; ` : ""}head ${result.headCommit.slice(0, 7)}, ${result.diffStat.files} files +${result.diffStat.added} -${result.diffStat.removed}\n`
					: "";
			return `${head}${result.summary}`;
		}
	}
}

/** A child's state as a line `name: kind` followed by what it says beyond its kind. */
export function stateLines(name: string, state: AgentState): string {
	const more = describeState(state);
	return more === "" ? `${name}: ${state.kind}` : `${name}: ${state.kind}\n${more}`;
}
