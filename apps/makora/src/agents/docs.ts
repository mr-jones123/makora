// The Durable state of subagents: what a conversation keeps about its children, a child about itself, a waiting call
// about what it waits for, the session's running slots and message log, and the signals that wake parked work.
import { type ConversationId, defineDoc, defineDocFamily, defineSignal, type TaskId } from "@earendil-works/pi-durable";
import { lit, obj, oneOf, str, union } from "@earendil-works/pi-schema";
import type { AgentMessageLog, AgentsDocument, StopReason } from "./types.ts";

/** What the runtime keeps per child next to its record: the anchor task driving it and the round it watches. */
export type AgentRuntime = {
	readonly anchor: TaskId;
	/**
	 * The anchor's current round: it sleeps on `settled-<round>` and `control-<round>`. Whoever moves the record out of
	 * `running` advances it in the same commit, so a later wake-up message is watched under the next round.
	 */
	readonly round: number;
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
type Waiter = {
	readonly task: TaskId;
	readonly names: string[];
	readonly policy: "any" | "all";
	/** The signal key the call sleeps on now; a new key for every park. */
	readonly key: string;
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

/** `makora.agent-slots`: the anchors holding one of the session's running slots, and those queued for one, in order. */
export const SlotsDoc = defineDoc<{ running: TaskId[]; queued: TaskId[] }>({
	kind: "makora.agent-slots",
	version: 1,
	scope: "session",
	initial: () => ({ running: [], queued: [] }),
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

/** Tells an anchor to stop its child, with the reason and what happened, or that the child was removed. */
export const AgentControl = defineSignal({
	name: "makora.agent-control",
	version: 1,
	schema: union([
		obj({ kind: lit("stop"), reason: oneOf(STOP_REASONS), detail: str() }),
		obj({ kind: lit("remove") }),
	]),
});

/** Hands a queued anchor the running slot another anchor released. */
export const AgentSlot = defineSignal({ name: "makora.agent-slot", version: 1, schema: obj({}) });

/** The keys an anchor sleeps on in `round`. */
export function roundKeys(round: number): { readonly settled: string; readonly control: string } {
	return { settled: `settled-${round}`, control: `control-${round}` };
}
