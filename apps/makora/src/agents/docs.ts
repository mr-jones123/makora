// The Durable state of subagents: what a conversation keeps about its children, a child about itself, a waiting call
// about what it waits for, the session's running slots and message log, and the signals that wake parked work.
import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineSignal,
	type InputEntry,
	type TaskId,
} from "@earendil-works/pi-durable";
import { lit, obj, oneOf, str, union } from "@earendil-works/pi-schema";
import type { AgentMessageLog, AgentsDocument, StopReason } from "./types.ts";

/** An input that woke a finished child, kept until its anchor has a running slot and submits it. */
type HeldInput = { readonly content: string; readonly entry?: InputEntry; readonly requestId: string };

/** What the runtime keeps per child next to its record: the anchor task driving it and the round it watches. */
export type AgentRuntime = {
	readonly anchor: TaskId;
	/**
	 * The anchor's current round: it sleeps on `settled-<round>` and `control-<round>`. Whoever moves the record out of
	 * `running` advances it in the same commit, and so does the anchor when a wake-up queues the child, so a stop while
	 * it waits for a slot has a key of its own.
	 */
	readonly round: number;
	/** The input that woke the finished child, while it is queued for a running slot. */
	readonly held?: HeldInput;
};

/** The parent's document: the `AgentsDocument` the dashboard reads, plus each child's runtime. */
export type AgentsState = AgentsDocument & { readonly runtime: Readonly<Record<string, AgentRuntime>> };

/** `makora.agents` on a conversation: its children. */
export const AgentsDoc = defineDoc<AgentsState>({
	kind: "makora.agents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork of a conversation starts without its children.
	fork: "initial",
	initial: () => ({ agents: {}, runtime: {} }),
	checkpointWhen: () => true,
});

/** Who a child conversation is; written once, in the commit that creates it. */
export type AgentSelf = {
	readonly name: string;
	readonly parentConversationId: ConversationId;
	readonly depth: number;
};

// A family member is created with its seed, so a child is whole from the commit that creates it.
export const AgentSelfDoc = defineDocFamily<AgentSelf, AgentSelf>({
	kind: "makora.agent",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** The key of a conversation's `makora.agent` document. */
export const SELF_KEY = "self";

/** One parked `wait_agents` or `collect` call. */
export type Waiter = {
	readonly task: TaskId;
	readonly names: string[];
	readonly policy: "any" | "all";
	/** The signal key the call sleeps on now; a new key for every park. */
	readonly key: string;
	/** The signal key a child's call sleeps on for a running slot once an event on `key` ended its wait. */
	readonly slot: string;
	/** `wait_agents` also wakes on a message to its conversation; `collect` does not. */
	readonly messages: boolean;
	/** Signalled since it parked on `key`; a second event waits until it parks again. */
	readonly fired: boolean;
};

/** `makora.agent-waiters` on a conversation: its parked waits, by task. */
export const WaitersDoc = defineDoc<{ waiters: Record<string, Waiter> }>({
	kind: "makora.agent-waiters",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ waiters: {} }),
	checkpointWhen: () => false,
});

/** A claim on a running slot: the anchor whose child is to run, and the task and signal key the grant wakes. */
export type SlotClaim = { readonly anchor: TaskId; readonly task: TaskId; readonly key: string };

/**
 * `makora.agent-slots`: the anchors holding one of the session's running slots, and the claims waiting for one, in
 * order. A freed slot goes to the first claim in `resuming` (a child whose wait on its own children ended) before any
 * in `queued` (a child's first run, or a run an input woke).
 */
export const SlotsDoc = defineDoc<{ running: TaskId[]; resuming: SlotClaim[]; queued: SlotClaim[] }>({
	kind: "makora.agent-slots",
	version: 2,
	scope: "session",
	initial: () => ({ running: [], resuming: [], queued: [] }),
	checkpointWhen: () => true,
});

/** `makora.agent-messages`: the newest messages between the session's agents. */
export const MessageLogDoc = defineDoc<AgentMessageLog>({
	kind: "makora.agent-messages",
	version: 1,
	scope: "session",
	initial: () => ({ messages: [] }),
	checkpointWhen: () => false,
});

/** A sender's rate-limit bucket: tokens left at `at`. */
type RateBucket = { readonly tokens: number; readonly at: number };

/** `makora.agent-rates`: each sending conversation's message bucket, so limits hold across restarts. */
export const RatesDoc = defineDoc<{ readonly buckets: Readonly<Record<string, RateBucket>> }>({
	kind: "makora.agent-rates",
	version: 1,
	scope: "session",
	initial: () => ({ buckets: {} }),
	checkpointWhen: () => false,
});

/** How the sender of a message relates to its receiver. */
export type Relationship = "parent" | "sibling" | "child";

/** Wakes a parked wait: a child it waits for finished, or a message arrived for its conversation. */
export const AgentWake = defineSignal({
	name: "makora.agent-wake",
	version: 1,
	schema: union([
		obj({ kind: lit("finished"), name: str() }),
		obj({
			kind: lit("message"),
			from: str(),
			relationship: oneOf(["parent", "sibling", "child"] as const),
			text: str(),
		}),
	]),
});

const STOP_REASONS = ["user", "cost", "time", "turns", "error", "parent"] as const satisfies readonly StopReason[];

/** Tells an anchor to stop its child, with the reason and what happened, that the child was removed, or that an input woke it. */
export const AgentControl = defineSignal({
	name: "makora.agent-control",
	version: 1,
	schema: union([
		obj({ kind: lit("stop"), reason: oneOf(STOP_REASONS), detail: str() }),
		obj({ kind: lit("remove") }),
		obj({ kind: lit("wake") }),
	]),
});

/** Hands a claim the running slot an anchor gave up: a queued anchor, or a child's wait that ended. */
export const AgentSlot = defineSignal({ name: "makora.agent-slot", version: 1, schema: obj({}) });

/** The keys an anchor sleeps on in `round`. */
export function roundKeys(round: number): {
	readonly settled: string;
	readonly control: string;
	readonly slot: string;
} {
	return { settled: `settled-${round}`, control: `control-${round}`, slot: `slot-${round}` };
}
