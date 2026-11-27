// The agents dashboard's model: each conversation of the session as a row in its section (RUNNING, WAITING ON YOU,
// DONE), and the inspector's lines for the selected one. Pure: `agents.ts` reads Durable into `AgentFacts`, this file
// decides what the user sees of them.
import type { ConversationId } from "@earendil-works/pi-durable";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { describeState } from "../agents/prompts.ts";
import type { AgentMessage, AgentRecord } from "../agents/types.ts";
import type { ForkFiles, ForkRecord } from "../fork.ts";
import type { KernelStatus } from "../kernel/manager.ts";
import { argumentPreview, SPINNER, type ToolCell } from "../tool-cell.ts";
import { fitStart, formatCost, formatElapsed } from "./bars.ts";
import { type Paint, theme } from "./theme.ts";

/** Which conversation a row is: the root, a fork, or a subagent with its record. */
export type AgentKind =
	| { readonly kind: "main" }
	| { readonly kind: "fork"; readonly fork: ForkRecord }
	| { readonly kind: "agent"; readonly record: AgentRecord };

/** What the loader read of one conversation. */
export type AgentFacts = {
	readonly conversationId: ConversationId;
	/** The conversation it nests under: a subagent's parent, a fork's original; undefined for the root. */
	readonly parentId: ConversationId | undefined;
	readonly who: AgentKind;
	readonly name: string;
	/** `provider/modelId`. */
	readonly model: string | undefined;
	readonly cwd: string | undefined;
	/** The checked-out branch of the root's folder. */
	readonly branch: string | undefined;
	/** A run is in progress (`pi.live` has one), parked tool calls included. */
	readonly busy: boolean;
	readonly costUsd: number;
	/** Model responses so far. */
	readonly turns: number;
	readonly startedAt: number | undefined;
	readonly lastAt: number | undefined;
	/** Its python cells, oldest first. */
	readonly cells: readonly ToolCell[];
};

/** A list section. */
export type Section = "running" | "waiting" | "done";

/** Section order and titles. */
export const SECTIONS: readonly (readonly [Section, string])[] = [
	["running", "RUNNING"],
	["waiting", "WAITING ON YOU"],
	["done", "DONE"],
];

/** What a row's glyph says. `waiting`: a finished write agent whose branch is not merged. */
export type RowState = "running" | "queued" | "waiting" | "done" | "stopped";

/** The mode column: a subagent's mode, or what kind of conversation it is. */
export type RowMode = "main" | "fork" | "write" | "review";

/** Which limit a budget bar measures, and how much of it is used. */
export type BudgetUse = { readonly limit: "usd" | "minutes"; readonly fraction: number };

/** One row of the list. */
export type DashboardRow = {
	readonly facts: AgentFacts;
	readonly section: Section;
	readonly state: RowState;
	/** Indent: how many of its ancestors are listed in the same section above it. */
	readonly depth: number;
	readonly mode: RowMode;
	/** A branch, `@<short commit>`, or `shared`. */
	readonly where: string;
	/** Undefined for the root and forks, which have no budget. */
	readonly budget: BudgetUse | undefined;
	readonly elapsedMs: number | undefined;
	/** The cell running now. */
	readonly cell: number | undefined;
};

/**
 * The rows of `facts`, in display order: by section, then depth first through the ownership tree. Removed subagents
 * and forks are left out; a row whose parent is left out is listed as a top-level row.
 */
export function dashboardRows(facts: readonly AgentFacts[], now: number): DashboardRow[] {
	const shown = facts.filter(({ who }) =>
		who.kind === "agent" ? who.record.state.kind !== "removed" : who.kind !== "fork" || who.fork.removed !== true,
	);
	const ids = new Set(shown.map((each) => each.conversationId));
	const children = new Map<ConversationId | undefined, AgentFacts[]>();
	for (const each of shown) {
		const parent = each.parentId !== undefined && ids.has(each.parentId) ? each.parentId : undefined;
		children.set(parent, [...(children.get(parent) ?? []), each]);
	}
	const ordered: { readonly row: Omit<DashboardRow, "depth">; readonly ancestors: readonly Section[] }[] = [];
	const visit = (each: AgentFacts, ancestors: readonly Section[]): void => {
		const row = rowOf(each, now);
		ordered.push({ row, ancestors });
		for (const child of children.get(each.conversationId) ?? []) visit(child, [...ancestors, row.section]);
	};
	for (const top of children.get(undefined) ?? []) visit(top, []);
	return SECTIONS.flatMap(([section]) =>
		ordered
			.filter(({ row }) => row.section === section)
			.map(({ row, ancestors }) => ({ ...row, depth: ancestors.filter((each) => each === section).length })),
	);
}

function rowOf(facts: AgentFacts, now: number): Omit<DashboardRow, "depth"> {
	const state = stateOf(facts);
	const elapsedMs = elapsedOf(facts, state, now);
	const running = facts.cells.findLast((cell) => cell.status.kind === "running" || cell.status.kind === "parked");
	return {
		facts,
		section: SECTION_OF[state],
		state,
		mode: facts.who.kind === "agent" ? facts.who.record.mode : facts.who.kind,
		where: whereOf(facts.who, facts.branch),
		budget: facts.who.kind === "agent" ? budgetUse(facts.who.record, facts, elapsedMs) : undefined,
		elapsedMs,
		cell: state === "running" ? running?.cell : undefined,
	};
}

const SECTION_OF: Readonly<Record<RowState, Section>> = {
	running: "running",
	queued: "running",
	waiting: "waiting",
	done: "done",
	stopped: "done",
};

/** A subagent's state comes from its record; the root and forks run while they have a run, else are done. */
function stateOf(facts: AgentFacts): RowState {
	if (facts.who.kind !== "agent") return facts.busy ? "running" : "done";
	const { state } = facts.who.record;
	switch (state.kind) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "done":
			return state.result.mode === "write" ? "waiting" : "done";
		case "merged":
		case "removed":
			return "done";
		case "stopped":
			return "stopped";
	}
}

/** Time worked: from the first entry to now while it runs, else to when it finished or its last entry. */
function elapsedOf(facts: AgentFacts, state: RowState, now: number): number | undefined {
	if (facts.startedAt === undefined) return undefined;
	if (state === "running") return now - facts.startedAt;
	const record = facts.who.kind === "agent" ? facts.who.record.state : undefined;
	const end = record !== undefined && "at" in record ? record.at : (facts.lastAt ?? now);
	return Math.max(0, end - facts.startedAt);
}

/** The branch or commit a conversation works on: the root's `branch`, a fork's or review's `@<short commit>`. */
export function whereOf(who: AgentKind, branch: string | undefined): string {
	switch (who.kind) {
		case "main":
			return branch ?? "";
		case "fork":
			return who.fork.files.kind === "shared" ? "shared" : `@${who.fork.files.commit.slice(0, 7)}`;
		case "agent": {
			const { worktree } = who.record;
			if (worktree.kind === "shared") return "shared";
			return worktree.branch ?? `@${worktree.baseCommit.slice(0, 7)}`;
		}
	}
}

/** The limit the budget bar shows: cost when `usd` is set, else time when `minutes` is, else none. */
function budgetUse(record: AgentRecord, facts: AgentFacts, elapsedMs: number | undefined): BudgetUse | undefined {
	const { budget } = record;
	if (budget.usd !== undefined) return { limit: "usd", fraction: facts.costUsd / budget.usd };
	if (budget.minutes !== undefined)
		return { limit: "minutes", fraction: (elapsedMs ?? 0) / (budget.minutes * 60_000) };
}

/** Cells of a budget bar. */
const BUDGET_CELLS = 5;

/** Filled cells for `fraction` of a budget: any use fills one, a full or exceeded budget fills all. */
export function budgetCells(fraction: number): number {
	return Math.max(0, Math.min(BUDGET_CELLS, Math.ceil(fraction * BUDGET_CELLS)));
}

/** The bar `▰▰▱▱▱`; a spent budget is drawn as a warning, and no budget as blanks. */
export function budgetBar(use: BudgetUse | undefined): string {
	if (use === undefined) return " ".repeat(BUDGET_CELLS);
	const filled = budgetCells(use.fraction);
	const paint = use.fraction >= 1 ? theme.warning : theme.accent;
	return `${paint("▰".repeat(filled))}${theme.border("▱".repeat(BUDGET_CELLS - filled))}`;
}

const GLYPHS: Readonly<Record<RowState, (frame: number) => string>> = {
	running: (frame) => theme.success(SPINNER[frame % SPINNER.length]!),
	queued: () => theme.muted("◌"),
	waiting: () => theme.warning("◌"),
	done: () => theme.muted("✓"),
	stopped: () => theme.error("✗"),
};

/** A row's state glyph: a spinner while running, `◌` queued or waiting on you, `✓` done, `✗` stopped. */
export function glyph(state: RowState, frame: number): string {
	return GLYPHS[state](frame);
}

/** What the inspector shows beyond the row: process state and reads the loader does for the selected row only. */
export type InspectorExtras = {
	readonly kernel: KernelStatus;
	/** The session's message log, oldest first. */
	readonly messages: readonly AgentMessage[];
	/** The worktree's changes against its base commit, untracked files included; undefined until read. */
	readonly changes: { readonly files: number; readonly added: number; readonly removed: number } | undefined;
	readonly now: number;
	readonly frame: number;
	readonly tildify: (path: string) => string;
};

const RECENT_CELLS = 3;
const RECENT_MESSAGES = 4;
const RESULT_LINES = 4;

/** The inspector's lines for `row`, each at most `width` columns. */
export function inspectorLines(row: DashboardRow, extras: InspectorExtras, width: number): string[] {
	const { facts } = row;
	const fit = (text: string) => truncateToWidth(text, width, "…");
	const label = (name: string, value: string, paint: Paint = theme.text) =>
		fit(`${theme.muted(name.padEnd(7))}${paint(value)}`);
	const heading = [theme.bold(theme.accent(facts.name)), row.mode, origin(facts)].filter((part) => part !== "");
	const lines = [fit(heading.join(theme.muted(" · ")))];
	if (facts.who.kind === "agent") lines.push(label("task", facts.who.record.task.split("\n")[0] ?? ""));
	lines.push(label("model", facts.model ?? "none"), label("kernel", kernelText(extras.kernel)));
	lines.push("", ...budgetLines(row, label));
	lines.push("", theme.dim("RECENT CELLS"), ...cellLines(facts.cells, extras, width));
	const messages = extras.messages
		.filter(
			(each) => each.fromConversationId === facts.conversationId || each.toConversationId === facts.conversationId,
		)
		.slice(-RECENT_MESSAGES);
	if (messages.length > 0) {
		lines.push("", theme.dim("MESSAGES"));
		for (const each of messages) {
			const text = each.text.replace(/\s*\n\s*/g, " ⏎ ").trim();
			lines.push(fit(`${theme.accent(`${each.from} → ${each.to}:`)} ${theme.text(text)}`));
		}
	}
	lines.push("", theme.dim(facts.who.kind === "agent" ? "WORKTREE" : "FOLDER"), ...folderLines(facts, extras, width));
	if (facts.who.kind === "agent") lines.push(...outcomeLines(facts.who.record, fit));
	return lines;
}

/** Where the row's files start: a branch or checkout from its base, a fork's files, the root's branch. */
function origin(facts: AgentFacts): string {
	switch (facts.who.kind) {
		case "main":
			return facts.branch ?? "";
		case "fork":
			return describeForkFiles(facts.who.fork.files);
		case "agent": {
			const { worktree } = facts.who.record;
			if (worktree.kind === "shared") return "shares its parent's folder";
			const base = `${worktree.baseRef} (${worktree.baseCommit.slice(0, 7)})`;
			return worktree.branch === undefined
				? `@${worktree.baseCommit.slice(0, 7)} from ${worktree.baseRef}`
				: `${worktree.branch} from ${base}`;
		}
	}
}

/** A fork's files as the inspector names them. */
function describeForkFiles(files: ForkFiles): string {
	switch (files.kind) {
		case "snapshot":
			return `worktree at the fork point's snapshot (${files.commit.slice(0, 7)})`;
		case "head":
			return `worktree at HEAD (${files.commit.slice(0, 7)})`;
		case "shared":
			return "shares the original's folder";
	}
}

function kernelText(status: KernelStatus): string {
	const vars = status.state === "running" || status.state === "restored" ? ` · ${status.variables} vars` : "";
	const saved = status.snapshotCell === undefined ? "" : ` · snapshot @ cell ${status.snapshotCell}`;
	return `${status.state}${vars}${saved}`;
}

/** `cost` and `time`, each `used / limit` where a subagent has the limit, and the turns used; used alone for the root. */
function budgetLines(row: DashboardRow, label: (name: string, value: string, paint?: Paint) => string): string[] {
	const { facts } = row;
	const time = row.elapsedMs === undefined ? "–" : formatElapsed(row.elapsedMs);
	if (facts.who.kind !== "agent") {
		return [label("cost", formatCost(facts.costUsd)), label("time", time), label("turns", String(facts.turns))];
	}
	const { budget } = facts.who.record;
	const of = (used: string, limit: string | undefined, over: boolean) =>
		[used, limit ?? "no limit"].join(" / ") + (over ? " · over" : "");
	const minutes = budget.minutes === undefined ? undefined : budget.minutes * 60_000;
	const lines: (readonly [string, string])[] = [
		[
			"cost",
			of(
				formatCost(facts.costUsd),
				budget.usd === undefined ? undefined : formatCost(budget.usd),
				budget.usd !== undefined && facts.costUsd > budget.usd,
			),
		],
		[
			"time",
			of(
				time,
				minutes === undefined ? undefined : formatElapsed(minutes),
				minutes !== undefined && (row.elapsedMs ?? 0) > minutes,
			),
		],
		["turns", String(facts.turns)],
	];
	return lines.map(([name, value]) => label(name, value, value.endsWith("over") ? theme.warning : theme.text));
}

function cellLines(cells: readonly ToolCell[], extras: InspectorExtras, width: number): string[] {
	const recent = cells.slice(-RECENT_CELLS);
	if (recent.length === 0) return [theme.muted("no cells yet")];
	return recent.map((cell) => {
		const marker = cellMarker(cell, extras.frame);
		const number = cell.cell === undefined ? "cell ?" : `cell ${cell.cell}`;
		return truncateToWidth(
			`${marker} ${theme.muted(number)} ${theme.text(argumentPreview(cell.name, cell.args))}`,
			width,
			"…",
		);
	});
}

function cellMarker(cell: ToolCell, frame: number): string {
	switch (cell.status.kind) {
		case "pending":
		case "parked":
			return theme.muted("◌");
		case "running":
			return theme.accent(SPINNER[frame % SPINNER.length]!);
		case "done":
			return cell.status.isError ? theme.error("✗") : theme.success("✓");
	}
}

/** The folder, or the worktree's changes against its base and its root, cut from the start so the end shows. */
function folderLines(facts: AgentFacts, extras: InspectorExtras, width: number): string[] {
	const path = (text: string, room = width) => theme.text(fitStart(extras.tildify(text), room));
	if (facts.who.kind !== "agent") return [path(facts.cwd ?? "")];
	const { worktree } = facts.who.record;
	if (worktree.kind === "shared") return [`${theme.muted("shares ")}${path(worktree.cwd, width - 7)}`];
	const { changes } = extras;
	const stat =
		changes === undefined
			? theme.muted("reading…")
			: `${theme.success(`+${changes.added}`)} ${theme.error(`−${changes.removed}`)}${theme.muted(` · ${changes.files} ${changes.files === 1 ? "file" : "files"} against ${worktree.baseCommit.slice(0, 7)}`)}`;
	return [truncateToWidth(stat, width, "…"), path(worktree.root)];
}

/** RESULT for a done or merged agent, STOPPED with the reason for a stopped one. */
function outcomeLines(record: AgentRecord, fit: (text: string) => string): string[] {
	const { state } = record;
	switch (state.kind) {
		case "done":
		case "merged": {
			const text = describeState(state)
				.split("\n")
				.filter((line) => line.trim() !== "");
			return ["", theme.dim("RESULT"), ...text.slice(0, RESULT_LINES).map((line) => fit(theme.text(line)))];
		}
		case "stopped":
			return ["", theme.dim("STOPPED"), fit(theme.warning(describeState(state)))];
		default:
			return [];
	}
}
