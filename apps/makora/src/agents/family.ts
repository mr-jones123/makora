// Who a conversation is among the session's agents, the family it may reach (parent, siblings, direct children), and
// how an input reaches one of them: the root takes it as a steer or a new turn, a running child as a steer, and a
// finished child is woken: it queues for a running slot, and its anchor submits the input as the start of its next run,
// unless its budget keeps it stopped.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationHandle,
	type ConversationId,
	ConversationIdle,
	type DocumentReader,
	type InputEntry,
	type SubmissionId,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { totalCost } from "../usage.ts";
import {
	AgentControl,
	type AgentSelf,
	AgentSelfDoc,
	AgentsDoc,
	type Relationship,
	roundKeys,
	SELF_KEY,
} from "./docs.ts";
import type { AgentRecord } from "./types.ts";

/** The name the root conversation goes by. */
export const ROOT_NAME = "main";

/** One conversation the caller may reach, and how it relates to the caller. */
export type Member = {
	readonly name: string;
	readonly conversationId: ConversationId;
	readonly relationship: Relationship;
};

/** The conversation's own record as a child, or undefined for the root (and any conversation that is not a child). */
export function identityOf(
	reader: DocumentReader,
	id: ConversationId,
	context: Context,
): Promise<Readonly<AgentSelf> | undefined> {
	return reader.snapshot(AgentSelfDoc, id, SELF_KEY, context);
}

/** The caller's family: its parent, its siblings and its direct children, removed ones left out. */
export async function familyOf(
	reader: DocumentReader,
	callerId: ConversationId,
	self: AgentSelf | undefined,
	context: Context,
): Promise<Member[]> {
	const members: Member[] = [];
	if (self !== undefined) {
		const parentSelf = await identityOf(reader, self.parentConversationId, context);
		members.push({
			name: parentSelf?.name ?? ROOT_NAME,
			conversationId: self.parentConversationId,
			relationship: "parent",
		});
		const siblings = await reader.snapshot(AgentsDoc, self.parentConversationId, context);
		for (const record of Object.values(siblings?.agents ?? {})) {
			if (record.name !== self.name && record.state.kind !== "removed") {
				members.push({ name: record.name, conversationId: record.conversationId, relationship: "sibling" });
			}
		}
	}
	const children = await reader.snapshot(AgentsDoc, callerId, context);
	for (const record of Object.values(children?.agents ?? {})) {
		if (record.state.kind !== "removed") {
			members.push({ name: record.name, conversationId: record.conversationId, relationship: "child" });
		}
	}
	return members;
}

/** A conversation an input is for, looked up before the commit that admits it. */
export type InputTarget = {
	readonly handle: ConversationHandle;
	readonly self: Readonly<AgentSelf> | undefined;
};

/**
 * An input for a conversation: what its model reads, the entry its transcript shows (`pi.user` when unset, as for what
 * the user types), its request ID, and who sends it: the user, or an agent by how it relates to the receiver.
 */
export type AgentInput = {
	readonly content: string;
	readonly entry?: InputEntry;
	readonly requestId: string;
	readonly from: "user" | Relationship;
};

/** Why an input cannot reach a child right now. */
export class AgentUnreachable extends Error {}

/**
 * Admit `input` into `target` in `tx`, as the commit's one table write. The root gets it as `rootWhenBusy` while it
 * works, or as a new turn. A running child gets a steer, which joins the run its anchor watches. Both return the
 * submission. A finished child is woken: it is queued, its anchor is told, and the input is held until the anchor has a
 * running slot and submits it under its next round, so a woken run takes a slot and gets its time limit as a first run
 * does; that returns undefined. Throws `AgentUnreachable` for a queued, removed or finishing child, and for a finished
 * one its budget keeps stopped (`wakeRefusal`).
 */
export async function admitInput(
	tx: Tx,
	target: InputTarget,
	input: AgentInput,
	rootWhenBusy: "steer" | "followUp",
): Promise<SubmissionId | undefined> {
	const { handle, self } = target;
	const held = {
		content: input.content,
		requestId: input.requestId,
		...(input.entry === undefined ? {} : { entry: input.entry }),
	};
	const draft = { type: "input", ...held } as const;
	if (self === undefined) return handle.submit(tx, { ...draft, whenBusy: rootWhenBusy });
	const doc = await tx.doc(AgentsDoc, self.parentConversationId);
	const record = doc.agents[self.name]!;
	const runtime = doc.runtime[self.name]!;
	switch (record.state.kind) {
		case "queued":
			throw new AgentUnreachable(`${self.name} is queued for a running slot; message it once it runs`);
		case "removed":
			throw new AgentUnreachable(`${self.name} was removed`);
		case "running":
			try {
				return await handle.submit(tx, { ...draft, whenBusy: "steer", whenIdle: "reject" });
			} catch (error) {
				if (!(error instanceof ConversationIdle)) throw error;
				throw new AgentUnreachable(`${self.name} is finishing its run; send again once it is done`);
			}
		case "done":
		case "stopped":
		case "merged": {
			const refusal = await wakeRefusal(tx, record, input.from);
			if (refusal !== undefined) throw new AgentUnreachable(refusal);
			await tx.signal(runtime.anchor, AgentControl, roundKeys(runtime.round).control, { kind: "wake" });
			doc.runtime[self.name] = { ...runtime, held };
			doc.agents[self.name] = { ...record, state: { kind: "queued" } };
			return undefined;
		}
	}
}

/**
 * Why finished child `record` must not be woken by an input from `from`, or undefined. A child stopped for cost, or one
 * that spent its budget, stays stopped: a wake would spend more. One stopped for turns or time wakes only for its parent
 * or the user, who decide that it may go on.
 */
async function wakeRefusal(tx: Tx, record: AgentRecord, from: AgentInput["from"]): Promise<string | undefined> {
	const { name, state, budget } = record;
	if (state.kind === "stopped" && state.reason === "cost") {
		const spent = state.detail === undefined ? "" : ` (${state.detail})`;
		return `${name} was stopped for cost${spent} and takes no more input`;
	}
	if (budget.usd !== undefined) {
		const spent = totalCost(await tx.doc(UsageDoc, record.conversationId));
		if (spent >= budget.usd) {
			return `${name} spent $${spent.toFixed(4)} of its $${budget.usd} budget and takes no more input`;
		}
	}
	const limited = state.kind === "stopped" && (state.reason === "turns" || state.reason === "time");
	if (limited && from !== "parent" && from !== "user") {
		return `${name} was stopped for ${state.reason}; only its parent or the user can wake it`;
	}
	return undefined;
}
