// The TUI's live model of one conversation of the open session: its transcript and live state, the task graph, and
// the derived numbers the bars show. Watches Durable and tells the TUI when anything changed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Conversation,
	ConversationTranscript,
	type ConversationView,
	type ConversationWatch,
	type EntryId,
	type LiveState,
	type ModelRef,
	type TaskGraph,
	type TaskGraphWatch,
	type TranscriptItem,
	type UsageState,
} from "@earendil-works/pi-durable";
import { type ForkRecord, readFork } from "../fork.ts";
import type { KernelStatus } from "../kernel/manager.ts";
import type { MakoraSession } from "../session.ts";
import { type TranscriptRow, transcriptRows } from "../transcript-rows.ts";

/** A message the TUI itself adds to the transcript: command output, login steps, errors. */
export interface LocalRow {
	readonly kind: "info" | "notice";
	readonly key: string;
	readonly message: string;
}

/** A row the transcript view draws. */
export type FeedRow = TranscriptRow | LocalRow;

/** Everything the main screen shows of the session, as of the last change. */
export interface FeedState {
	readonly rows: readonly FeedRow[];
	/** Entries exist before the first loaded one. */
	readonly hasEarlier: boolean;
	readonly live: LiveState | undefined;
	readonly busy: boolean;
	readonly model: ModelRef | undefined;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	readonly cwd: string;
	/** Session cost in USD, every conversation summed. */
	readonly costUsd: number;
	/** Conversations with work running, and parked tool calls. */
	readonly running: number;
	readonly waiting: number;
	/** Tokens of the newest request's context, from its usage. */
	readonly contextTokens: number | undefined;
	readonly graph: TaskGraph;
	/** The conversation's Python kernel, for the dock. */
	readonly kernel: KernelStatus;
}

const EMPTY_GRAPH: TaskGraph = { tasks: {} };

/** Watches one conversation of a session for the TUI. */
export class SessionFeed {
	readonly session: MakoraSession;
	readonly conversation: Conversation;
	readonly #transcript: ConversationTranscript;
	readonly #listeners = new Set<() => void>();
	/** Local rows by the newest entry when each was added; `undefined` for rows added before any entry. */
	readonly #local = new Map<EntryId | undefined, LocalRow[]>();
	#view: ConversationView | undefined;
	#entries: ConversationView["entries"] = [];
	#hasEarlier = false;
	#graph: TaskGraph = EMPTY_GRAPH;
	#usage: UsageState | undefined;
	#agent: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel; cwd?: string } = {};
	#watch: ConversationWatch | undefined;
	#graphWatch: TaskGraphWatch | undefined;
	#derivedPending = false;
	#derivedTimer: NodeJS.Timeout | undefined;
	#stopped = false;
	#localCounter = 0;
	#state: FeedState | undefined;
	#fork: ForkRecord | undefined;
	readonly #unsubscribeKernels: () => void;

	constructor(session: MakoraSession, conversation: Conversation) {
		this.session = session;
		this.conversation = conversation;
		this.#transcript = new ConversationTranscript((query, limit, context) =>
			conversation.entries(query, limit, undefined, context),
		);
		this.#unsubscribeKernels = session.kernels.onChange(() => this.#changed());
	}

	/** The conversation's fork record, read at `start()`; undefined for a conversation that is not a fork. */
	get fork(): ForkRecord | undefined {
		return this.#fork;
	}

	/** Start watching; resolves once the first values are in. */
	async start(): Promise<void> {
		const context = BACKGROUND_CONTEXT;
		this.#fork = await readFork(this.session.harness, this.conversation.id, context);
		this.#watch = await this.conversation.watch(context);
		this.#merge(this.#watch.value);
		this.#watch.start(async (call) => {
			if (call.kind !== "value") return;
			this.#merge(call.value);
			this.#changed();
			this.#refreshDerived();
		});
		this.#graphWatch = await this.session.harness.watchTaskGraph(context);
		this.#graph = this.#graphWatch.value;
		this.#graphWatch.start(async (call) => {
			if (call.kind !== "value") return;
			this.#graph = call.value;
			this.#changed();
		});
		await this.#loadDerived();
	}

	/** Stop watching; a derived read still in flight then ends quietly. */
	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#derivedTimer);
		this.#unsubscribeKernels();
		await Promise.all([this.#watch?.stop(), this.#graphWatch?.stop()]);
	}

	/** Call `listener` after each change; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Add a TUI message after the current transcript. */
	addLocal(kind: LocalRow["kind"], message: string): void {
		const anchor = this.#entries.at(-1)?.id;
		const rows = this.#local.get(anchor) ?? [];
		rows.push({ kind, key: `local:${this.#localCounter++}`, message });
		this.#local.set(anchor, rows);
		this.#changed();
	}

	/** Load the page of entries before the first loaded one. */
	async loadEarlier(): Promise<void> {
		const view = await this.#transcript.loadEarlier(BACKGROUND_CONTEXT);
		this.#adopt(view.items);
		this.#changed();
	}

	/** Re-read the derived numbers now, after a model or settings change. */
	refresh(): Promise<void> {
		return this.#loadDerived().then(() => this.#changed());
	}

	/** The current state; recomputed after each change. */
	get state(): FeedState {
		this.#state ??= this.#compute();
		return this.#state;
	}

	#merge(view: ConversationView): void {
		this.#view = view;
		this.#adopt(this.#transcript.merge(view).items);
	}

	#adopt(items: readonly TranscriptItem[]): void {
		this.#hasEarlier = items[0]?.kind === "earlier";
		this.#entries = items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
	}

	#changed(): void {
		this.#state = undefined;
		for (const listener of this.#listeners) listener();
	}

	// Usage and the resolved agent are separate reads; at most one is in flight, and a change during it reads again.
	#refreshDerived(): void {
		if (this.#derivedPending || this.#stopped) return;
		this.#derivedPending = true;
		this.#derivedTimer = setTimeout(() => {
			this.#derivedTimer = undefined;
			void this.#loadDerived()
				.then(
					() => this.#changed(),
					// After `stop()` the session is closing and its reads fail by design; before it, the user should know.
					(error: unknown) => {
						if (!this.#stopped)
							this.addLocal(
								"notice",
								`Could not refresh usage: ${error instanceof Error ? error.message : String(error)}`,
							);
					},
				)
				.finally(() => {
					this.#derivedPending = false;
				});
		}, 250);
	}

	async #loadDerived(): Promise<void> {
		const context = BACKGROUND_CONTEXT;
		const [usage, agent] = await Promise.all([this.session.harness.usage(context), this.conversation.agent(context)]);
		this.#usage = usage;
		this.#agent = {
			...(agent.model === undefined ? {} : { model: agent.model }),
			thinkingLevel: agent.thinkingLevel,
			...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
		};
	}

	#compute(): FeedState {
		const live = this.#view?.docs["pi.live"] as LiveState | undefined;
		const rows: FeedRow[] = [
			...(this.#local.get(undefined) ?? []),
			...transcriptRows(this.#entries, live, (entry) => this.#local.get(entry.id) ?? []),
		];
		const tasks = Object.values(this.#graph.tasks);
		const busyConversations = new Set(
			tasks.filter((task) => task.state.status !== "sleeping").map((task) => task.conversationId),
		);
		const parked = tasks.filter(
			(task) => task.kind === "pi.tool" && (task.state.status === "sleeping" || task.state.status === "waiting"),
		);
		return {
			rows,
			hasEarlier: this.#hasEarlier,
			live,
			busy: live?.run !== undefined,
			model: this.#agent.model,
			thinkingLevel: this.#agent.thinkingLevel,
			cwd: this.#agent.cwd ?? this.session.meta.cwd,
			costUsd: totalCost(this.#usage),
			running: busyConversations.size,
			waiting: parked.length,
			contextTokens: this.#contextTokens(),
			graph: this.#graph,
			kernel: this.session.kernels.status(this.conversation.id),
		};
	}

	#contextTokens(): number | undefined {
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const message = this.#entries[index]!.model?.[0];
			if (message?.role !== "assistant") continue;
			const { usage } = message as AssistantMessage;
			const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			if (total > 0) return total;
		}
		return undefined;
	}
}

/** Every model and tool cost of `usage`, in USD. */
export function totalCost(usage: UsageState | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const bucket of [usage.models, usage.tools])
		for (const entry of Object.values(bucket)) total += entry.cost.total;
	return total;
}
