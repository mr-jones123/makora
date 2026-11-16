// The agents dashboard (layout A): reads every agent of the session from Durable (the main conversation, its forks,
// and the subagents with their children) and draws the list and the selected agent's inspector. What each row and
// inspector line says is decided in `dashboard.ts`.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	type Harness,
	LiveDoc,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsDoc, MessageLogDoc } from "../agents/docs.ts";
import { identityOf, ROOT_NAME } from "../agents/family.ts";
import type { AgentMessage } from "../agents/types.ts";
import { readFork } from "../fork.ts";
import { gitBranch } from "../project.ts";
import { transcriptRows } from "../transcript-rows.ts";
import { totalCost } from "../usage.ts";
import { formatCost, formatElapsed, hintLine, spread } from "./bars.ts";
import {
	type AgentFacts,
	type AgentKind,
	budgetBar,
	type DashboardRow,
	glyph,
	type InspectorExtras,
	inspectorLines,
	SECTIONS,
	type Section,
} from "./dashboard.ts";
import { MAKORA_KEYBINDINGS, type MakoraKeybinding } from "./keybindings.ts";
import { theme } from "./theme.ts";

/** What the dashboard reads from Durable at each poll. */
export type AgentsSnapshot = {
	readonly facts: readonly AgentFacts[];
	/** The session's message log, oldest first. */
	readonly messages: readonly AgentMessage[];
};

const ENTRY_PAGE = 200;

/**
 * The session's agents (the root, every fork, and every subagent) in conversation order, with the message log.
 */
export async function loadAgents(harness: Harness, rootId: ConversationId, context: Context): Promise<AgentsSnapshot> {
	const conversations = await scanConversations(harness, context);
	const [facts, log] = await Promise.all([
		Promise.all(conversations.map((record) => agentFacts(harness, record.id, rootId, context))),
		harness.snapshot(MessageLogDoc, context),
	]);
	return {
		facts: facts.filter((each): each is AgentFacts => each !== undefined),
		messages: log?.messages ?? [],
	};
}

/** The worktrees the session keeps: forks' and subagents' that are not removed (a queued subagent has none yet). */
export async function countWorktrees(harness: Harness, context: Context): Promise<number> {
	let count = 0;
	for (const conversation of await scanConversations(harness, context)) {
		const [fork, children] = await Promise.all([
			readFork(harness, conversation.id, context),
			harness.snapshot(AgentsDoc, conversation.id, context),
		]);
		if (fork !== undefined && fork.removed !== true && fork.files.kind !== "shared") count++;
		for (const record of Object.values(children?.agents ?? {})) {
			const live = record.state.kind !== "removed" && record.state.kind !== "queued";
			if (live && record.worktree.kind === "worktree") count++;
		}
	}
	return count;
}

async function scanConversations(harness: Harness, context: Context): Promise<ConversationRecord[]> {
	const conversations: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, ENTRY_PAGE, cursor), context);
		conversations.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return conversations;
}

async function agentFacts(
	harness: Harness,
	id: ConversationId,
	rootId: ConversationId,
	context: Context,
): Promise<AgentFacts | undefined> {
	const [who, conversation] = await Promise.all([
		kindOf(harness, id, rootId, context),
		harness.conversation(id, context),
	]);
	if (who === undefined || conversation === undefined) return undefined;
	const [agent, usage, live, newest, oldest] = await Promise.all([
		conversation.agent(context),
		harness.snapshot(UsageDoc, id, context),
		harness.snapshot(LiveDoc, id, context),
		conversation.entries({}, ENTRY_PAGE, undefined, context),
		conversation.entries({ order: "ascending" }, 1, undefined, context),
	]);
	const entries = [...newest.items].reverse();
	const turns = entries.filter((entry) => entry.model?.[0]?.role === "assistant").length;
	const cells = transcriptRows(entries, live).flatMap((row) =>
		row.kind === "tool" && row.cell.name === "python" ? [row.cell] : [],
	);
	const first = oldest.items[0]?.model?.[0];
	const last = entries.at(-1)?.model?.[0];
	return {
		conversationId: id,
		parentId:
			who.kind === "agent"
				? who.record.parentConversationId
				: who.kind === "fork"
					? who.fork.parentConversationId
					: undefined,
		who,
		name: who.kind === "agent" ? who.record.name : who.kind === "fork" ? who.fork.label : ROOT_NAME,
		model: agent.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}`,
		cwd: agent.cwd,
		branch: who.kind === "main" && agent.cwd !== undefined ? gitBranch(agent.cwd) : undefined,
		busy: live?.run !== undefined,
		costUsd: totalCost(usage),
		turns,
		startedAt: first !== undefined && first.role !== "system" ? first.timestamp : undefined,
		lastAt: last !== undefined && last.role !== "system" ? last.timestamp : undefined,
		cells,
	};
}

async function kindOf(
	harness: Harness,
	id: ConversationId,
	rootId: ConversationId,
	context: Context,
): Promise<AgentKind | undefined> {
	if (id === rootId) return { kind: "main" };
	const [fork, self] = await Promise.all([readFork(harness, id, context), identityOf(harness, id, context)]);
	if (fork !== undefined) return { kind: "fork", fork };
	if (self === undefined) return undefined;
	const record = (await harness.snapshot(AgentsDoc, self.parentConversationId, context))?.agents[self.name];
	return record === undefined ? undefined : { kind: "agent", record };
}

/** What the dashboard draws; read at each render. */
export interface AgentsSource {
	readonly rows: readonly DashboardRow[];
	readonly selected: ConversationId | undefined;
	readonly sessionCostUsd: number;
	readonly sessionStartedAt: number;
	readonly frame: number;
	/** What the inspector shows of `row` beyond the row itself. */
	readonly extras: (row: DashboardRow) => InspectorExtras;
	/** A message shown in place of the hint row, such as the outcome of a merge. */
	readonly note: string | undefined;
}

/** What the dashboard's keys do; each acts on the selected row. */
export interface AgentsActions {
	move(delta: number): void;
	/** Make the selected conversation the main screen's. */
	open(): void;
	diff(): void;
	merge(): void;
	stop(): void;
	remove(): void;
	back(): void;
}

type AgentsKey = Extract<MakoraKeybinding, `app.agents.${string}`>;

const ACTION_KEYS: readonly (readonly [AgentsKey, "diff" | "merge" | "stop" | "remove"])[] = [
	["app.agents.diff", "diff"],
	["app.agents.merge", "merge"],
	["app.agents.stop", "stop"],
	["app.agents.remove", "remove"],
];

/** Below this width the inspector goes under the list. */
const SIDE_BY_SIDE_FROM = 100;

/** The full-screen dashboard: title row, list and inspector, hint row. */
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
		else {
			const action = ACTION_KEYS.find(([id]) => keys.matches(data, id))?.[1];
			if (action !== undefined) this.#actions[action]();
		}
	}

	/** `Agents · N running · M waiting on you · K done`, and `$total · N req · elapsed`. */
	title(width: number): string {
		const { rows, sessionCostUsd, sessionStartedAt } = this.#source();
		const count = (section: Section) => rows.filter((row) => row.section === section).length;
		const requests = rows.reduce((sum, row) => sum + row.facts.turns, 0);
		const counts = `${count("running")} running · ${count("waiting")} waiting on you · ${count("done")} done`;
		const left = `${theme.bold(theme.accent("Agents"))}${theme.muted(` · ${counts}`)}`;
		const right = theme.muted(
			`${formatCost(sessionCostUsd)} · ${requests} req · ${formatElapsed(Date.now() - sessionStartedAt)}`,
		);
		return spread(left, right, width);
	}

	/** The hint row from the bindings, or the source's note. */
	hint(): string {
		const { note } = this.#source();
		if (note !== undefined) return theme.warning(note);
		const keys = getKeybindings();
		const first = (
			id: AgentsKey | "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
		) => keys.getKeys(id).slice(0, 1);
		return hintLine([
			[[...first("tui.select.up"), ...first("tui.select.down")], "select"],
			[first("tui.select.confirm"), "open"],
			...ACTION_KEYS.map(([id]) => [first(id), MAKORA_KEYBINDINGS[id].description] as const),
			[first("tui.select.cancel"), "back"],
		]);
	}

	render(width: number): string[] {
		const source = this.#source();
		const selected = source.rows.find((row) => row.facts.conversationId === source.selected) ?? source.rows[0];
		if (width < SIDE_BY_SIDE_FROM) {
			const inspector = selected === undefined ? [] : inspectorLines(selected, source.extras(selected), width);
			return [...this.#list(source, selected, width), theme.border("─".repeat(width)), ...inspector];
		}
		const leftWidth = Math.min(84, Math.floor(width * 0.6));
		const rightWidth = width - leftWidth - 3;
		const left = this.#list(source, selected, leftWidth);
		const right = selected === undefined ? [] : inspectorLines(selected, source.extras(selected), rightWidth);
		return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
			const cell = left[index] ?? "";
			return `${cell}${" ".repeat(Math.max(0, leftWidth - visibleWidth(cell)))} ${theme.border("│")} ${right[index] ?? ""}`;
		});
	}

	#list(source: AgentsSource, selected: DashboardRow | undefined, width: number): string[] {
		const lines: string[] = [];
		for (const [section, title] of SECTIONS) {
			const rows = source.rows.filter((row) => row.section === section);
			if (rows.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(` ${theme.dim(title)}`);
			for (const row of rows) {
				const line = `${glyph(row.state, source.frame)} ${rowText(row, width - 3)}`;
				lines.push(
					row === selected
						? `${theme.accent("▌")}${theme.band(`${line}${" ".repeat(Math.max(0, width - 1 - visibleWidth(line)))}`)}`
						: ` ${line}`,
				);
			}
		}
		return lines;
	}
}

/** Name, mode, branch or ref, model, budget bar, cost, age and running cell, in `width` columns. */
function rowText(row: DashboardRow, width: number): string {
	const { facts } = row;
	const name = `${"  ".repeat(row.depth)}${facts.name}`;
	const model = facts.model?.slice(facts.model.indexOf("/") + 1) ?? "";
	const age = row.elapsedMs === undefined ? "" : formatElapsed(row.elapsedMs);
	const cell = row.state === "queued" ? "queued" : row.cell === undefined ? "" : `cell ${row.cell}`;
	const fixed = [
		[theme.muted(model), 11],
		[budgetBar(row.budget), 6],
		[theme.text(formatCost(facts.costUsd)), 8],
		[theme.muted(age), 7],
		[theme.accent(cell), 7],
	] as const;
	const whereWidth = Math.max(4, width - 16 - 7 - fixed.reduce((sum, [, size]) => sum + size, 0));
	const columns: (readonly [string, number])[] = [
		[theme.text(name), 16],
		[theme.muted(row.mode), 7],
		[theme.muted(row.where), whereWidth],
		...fixed,
	];
	return columns.map(([text, size]) => column(text, size)).join("");
}

/** `text` cut or padded to `width` columns, with a space before the next column. */
function column(text: string, width: number): string {
	const fitted = truncateToWidth(text, width - 1, "…");
	return `${fitted}${" ".repeat(Math.max(1, width - visibleWidth(fitted)))}`;
}
