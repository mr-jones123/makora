// The agents view: every conversation of the session as a row (the root and the subagents tasks own), and the
// selected agent's details. Generic over the task graph, so subagents appear without changes here.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	type Harness,
	type TaskGraph,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER, type ToolCell, toolSummary } from "../tool-cell.ts";
import { responseEnd, transcriptRows } from "../transcript-rows.ts";
import { formatCost, formatElapsed, hintLine, spread } from "./bars.ts";
import { totalCost } from "./session-feed.ts";
import { theme } from "./theme.ts";

/** Which list section a row is in. */
export type AgentSection = "running" | "idle" | "done";

/** One agent: a conversation, its place in the ownership tree, and what the list and detail show of it. */
export interface AgentRow {
	readonly conversationId: ConversationId;
	readonly name: string;
	readonly section: AgentSection;
	/** Own status, which can differ from the section of the tree it is nested in. */
	readonly status: AgentSection;
	/** Nesting under its owner; 0 for a top-level agent. */
	readonly depth: number;
	readonly model: string | undefined;
	readonly cwd: string | undefined;
	readonly costUsd: number;
	readonly turns: number;
	readonly startedAt: number | undefined;
	readonly lastAt: number | undefined;
	/** Newest tool calls, oldest first, with when each started. */
	readonly recent: readonly { readonly at: number; readonly cell: ToolCell }[];
}

const SECTIONS: readonly AgentSection[] = ["running", "idle", "done"];
const RECENT_CALLS = 8;
const ENTRY_PAGE = 200;

/** The agent rows of the session behind `harness`, in display order: by section, each tree depth first. */
export async function loadAgentRows(
	harness: Harness,
	rootId: ConversationId,
	graph: TaskGraph,
	context: Context,
): Promise<AgentRow[]> {
	const conversations: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, ENTRY_PAGE, cursor), context);
		conversations.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const tasks = Object.values(graph.tasks);
	const liveTasks = new Set(tasks.map((task) => String(task.id)));
	const details = await Promise.all(
		conversations.map(async (record) => {
			const status: AgentSection = tasks.some(
				(task) => task.conversationId === record.id && task.state.status !== "sleeping",
			)
				? "running"
				: record.owner !== undefined && !liveTasks.has(String(record.owner.taskId))
					? "done"
					: "idle";
			return { record, status, ...(await conversationDetail(harness, record.id, context)) };
		}),
	);
	const children = new Map<ConversationId | undefined, typeof details>();
	const known = new Set(conversations.map((record) => record.id));
	for (const detail of details) {
		const owner = detail.record.owner?.conversationId;
		const parent = owner !== undefined && known.has(owner) ? owner : undefined;
		children.set(parent, [...(children.get(parent) ?? []), detail]);
	}
	const rows: AgentRow[] = [];
	const visit = (detail: (typeof details)[number], depth: number, section: AgentSection): void => {
		rows.push({
			conversationId: detail.record.id,
			name: detail.record.id === rootId ? "main" : `agent ${detail.record.id}`,
			section,
			status: detail.status,
			depth,
			model: detail.model,
			cwd: detail.cwd,
			costUsd: detail.costUsd,
			turns: detail.turns,
			startedAt: detail.startedAt,
			lastAt: detail.lastAt,
			recent: detail.recent,
		});
		for (const child of children.get(detail.record.id) ?? []) visit(child, depth + 1, section);
	};
	const tops = children.get(undefined) ?? [];
	for (const section of SECTIONS) for (const top of tops) if (top.status === section) visit(top, 0, section);
	return rows;
}

async function conversationDetail(harness: Harness, id: ConversationId, context: Context) {
	const conversation = await harness.conversation(id, context);
	const [agent, usage, newest, oldest] = await Promise.all([
		conversation?.agent(context),
		harness.snapshot(UsageDoc, id, context),
		conversation?.entries({}, ENTRY_PAGE, undefined, context),
		conversation?.entries({ order: "ascending" }, 1, undefined, context),
	]);
	const entries = [...(newest?.items ?? [])].reverse();
	const times = new Map<string, number>();
	let turns = 0;
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") continue;
		turns++;
		for (const block of message.content) if (block.type === "toolCall") times.set(block.id, responseEnd(message));
	}
	const recent = transcriptRows(entries, undefined)
		.flatMap((row) => (row.kind === "tool" ? [{ at: times.get(row.cell.callId) ?? 0, cell: row.cell }] : []))
		.slice(-RECENT_CALLS);
	const first = oldest?.items[0]?.model?.[0];
	const last = entries.at(-1)?.model?.[0];
	return {
		model: agent?.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}`,
		cwd: agent?.cwd,
		costUsd: totalCost(usage),
		turns,
		startedAt: first !== undefined && first.role !== "system" ? first.timestamp : undefined,
		lastAt: last !== undefined && last.role !== "system" ? last.timestamp : undefined,
		recent,
	};
}

/** What the agents view draws; read at each render. */
export interface AgentsSource {
	readonly rows: readonly AgentRow[];
	readonly selected: ConversationId | undefined;
	readonly sessionCostUsd: number;
	readonly sessionStartedAt: number;
	readonly frame: number;
	/** Shows a path with `~`. */
	readonly tildify: (path: string) => string;
}

/** What the agents view's keys do. */
export interface AgentsActions {
	move(delta: number): void;
	open(): void;
	back(): void;
}

const GLYPHS: Readonly<Record<AgentSection, (frame: number) => string>> = {
	running: (frame) => theme.success(SPINNER[frame % SPINNER.length]!),
	idle: () => theme.muted("◌"),
	done: () => theme.muted("✓"),
};

/** The full-screen agents view: title row, list and detail, hint row. */
export class AgentsView implements Component {
	readonly #source: () => AgentsSource;
	readonly #actions: AgentsActions;

	constructor(source: () => AgentsSource, actions: AgentsActions) {
		this.#source = source;
		this.#actions = actions;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.up")) this.#actions.move(-1);
		else if (keys.matches(data, "tui.select.down")) this.#actions.move(1);
		else if (keys.matches(data, "tui.select.confirm")) this.#actions.open();
		else if (keys.matches(data, "tui.select.cancel")) this.#actions.back();
	}

	/** The title row: `Agents · N running · M done`, and `$total · N req · elapsed`. */
	title(width: number): string {
		const { rows, sessionCostUsd, sessionStartedAt } = this.#source();
		const count = (status: AgentSection) => rows.filter((row) => row.status === status).length;
		const requests = rows.reduce((sum, row) => sum + row.turns, 0);
		const left = `${theme.bold(theme.accent("Agents"))}${theme.muted(` · ${count("running")} running · ${count("done")} done`)}`;
		const right = theme.muted(
			`${formatCost(sessionCostUsd)} · ${requests} req · ${formatElapsed(Date.now() - sessionStartedAt)}`,
		);
		return spread(left, right, width);
	}

	/** The hint row, from the select bindings. */
	hint(): string {
		const keys = getKeybindings();
		const first = (id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") =>
			keys.getKeys(id).slice(0, 1);
		return hintLine([
			[[...first("tui.select.up"), ...first("tui.select.down")], "select"],
			[first("tui.select.confirm"), "open"],
			[first("tui.select.cancel"), "back"],
		]);
	}

	render(width: number): string[] {
		const source = this.#source();
		const leftWidth = Math.max(30, Math.min(80, Math.floor(width * 0.58)));
		const rightWidth = Math.max(10, width - leftWidth - 3);
		const left = this.#list(source, leftWidth);
		const selected = source.rows.find((row) => row.conversationId === source.selected) ?? source.rows[0];
		const right = selected === undefined ? [] : detail(selected, source, rightWidth);
		const height = Math.max(left.length, right.length);
		const lines: string[] = [];
		for (let index = 0; index < height; index++) {
			const cell = left[index] ?? "";
			const pad = " ".repeat(Math.max(0, leftWidth - visibleWidth(cell)));
			lines.push(`${cell}${pad} ${theme.border("│")} ${right[index] ?? ""}`);
		}
		return lines;
	}

	#list(source: AgentsSource, width: number): string[] {
		const lines: string[] = [];
		const now = Date.now();
		for (const section of SECTIONS) {
			const rows = source.rows.filter((row) => row.section === section);
			if (rows.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(` ${theme.dim(section.toUpperCase())}`);
			for (const row of rows) {
				const elapsed =
					row.startedAt === undefined
						? ""
						: formatElapsed((row.status === "running" ? now : (row.lastAt ?? now)) - row.startedAt);
				const name = `${"  ".repeat(row.depth)}${row.name}`;
				const fixed = `${pad(formatCost(row.costUsd), 8)}${pad(elapsed, 7)}`;
				const where = row.cwd === undefined ? "" : source.tildify(row.cwd);
				// One column for the selection bar, two for the glyph, one before the fixed columns.
				const middleWidth = Math.max(0, width - 3 - 16 - visibleWidth(fixed) - 1);
				const middle = truncateToWidth(`${pad(row.model ?? "", 18)}${where}`, middleWidth, "…");
				const text = `${pad(truncateToWidth(name, 15, "…"), 16)}${middle}${" ".repeat(Math.max(0, middleWidth - visibleWidth(middle)))} ${theme.muted(fixed)}`;
				const glyph = GLYPHS[row.status](source.frame);
				const isSelected = row.conversationId === (source.selected ?? source.rows[0]?.conversationId);
				const line = `${glyph} ${text}`;
				lines.push(
					isSelected
						? `${theme.accent("▌")}${theme.band(`${line}${" ".repeat(Math.max(0, width - 1 - visibleWidth(line)))}`)}`
						: ` ${line}`,
				);
			}
		}
		return lines;
	}
}

function detail(row: AgentRow, source: AgentsSource, width: number): string[] {
	const fit = (text: string) => truncateToWidth(text, width, "…");
	const lines = [
		fit(theme.bold(theme.accent(row.name))),
		fit(theme.muted(`model  ${row.model ?? "none"}`)),
		fit(theme.muted(`cwd    ${row.cwd === undefined ? "" : source.tildify(row.cwd)}`)),
		"",
		fit(`${theme.text(formatCost(row.costUsd))}${theme.muted(` cost · ${row.turns} turns`)}`),
		"",
		theme.dim("RECENT"),
	];
	if (row.recent.length === 0) lines.push(theme.muted("no tool calls yet"));
	const now = Date.now();
	for (const { at, cell } of row.recent) {
		const time = new Date(at).toTimeString().slice(0, 5);
		const summary = toolSummary(cell, Math.max(10, width - 6), now, source.frame);
		const paint = summary.tone === "error" ? theme.error : summary.tone === "success" ? theme.success : theme.accent;
		lines.push(`${theme.dim(time)} ${paint(summary.marker)} ${theme.text(summary.text)}`);
	}
	return lines;
}

function pad(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
