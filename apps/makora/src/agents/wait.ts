// Waiting for children without holding a process: `wait_agents`, offered to the model, and `collect`, which a cell
// awaits. Both park on a signal key registered in the conversation's `makora.agent-waiters` document; an anchor whose
// child finishes signals it, and `wait_agents` also wakes when a message for its conversation arrives. Registering and
// checking whether the children already finished happen in one commit, so no finish falls between them. A child gives
// its running slot to the queue in the commit that parks it, so its own children can run, and once its wait is over it
// claims a slot again (`slots.ts`) and returns only when it holds one. The root holds no slot.
import type { Context } from "@earendil-works/chord/context";
import {
	defineTool,
	InboxDoc,
	type TaskId,
	type ToolExecutionApi,
	type ToolPark,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { type AgentSelf, AgentSlot, AgentsDoc, AgentWake, type Waiter, WaitersDoc } from "./docs.ts";
import { identityOf } from "./family.ts";
import { AGENT_MESSAGE_ENTRY, agentMessageText, stateLines } from "./prompts.ts";
import { claimSlot, freeSlot } from "./slots.ts";
import type { AgentRecord } from "./types.ts";

const WaitParameters = obj({
	names: arr(str(), { description: "Children to wait for; [] waits only for a message" }),
	policy: opt(oneOf(["any", "all"] as const, { description: "any (default): the first to finish; all: every one" })),
});

const CollectParameters = obj({
	names: arr(str()),
	timeout: opt(num({ description: "Seconds; return what finished by then" })),
});

/** How a wait ended: the children it waits for finished or its deadline passed, or a message came. */
type Ended = { readonly kind: "children" } | { readonly kind: "message"; readonly text: string };

/**
 * Where a call is after `parks` parks for its children, the n-th on `wait-<n>`: waiting, or done waiting and parked on
 * `slot-<parks>` for the running slot its run needs before it goes on, with how the wait ended, so a slot that comes
 * later loses nothing.
 */
type WaitCheckpoint =
	| { readonly phase: "wait"; readonly parks: number }
	| { readonly phase: "slot"; readonly parks: number; readonly ended: Ended };

/** What one wait is for. */
type WaitSpec = {
	readonly names: string[];
	readonly policy: "any" | "all";
	/** `wait_agents` returns on a message to its conversation too. */
	readonly messages: boolean;
};

/** How a wait ended, or the park that continues it. */
type WaitOutcome =
	| { readonly kind: "children"; readonly records: Readonly<Record<string, AgentRecord>> }
	| { readonly kind: "message"; readonly text: string }
	| { readonly kind: "park"; readonly park: ToolPark<WaitCheckpoint> };

/** `wait_agents` and `collect`. */
export type WaitTools = {
	/** The model's `wait_agents`: parks until one or all named children finish, or a message arrives. */
	readonly waitAgents: ToolRegistration<typeof WaitParameters>;
	/** `await collect(names, timeout=None)` in a cell: every named child's record once all finished, or at the timeout. */
	readonly collect: ToolRegistration<typeof CollectParameters>;
};

/** `wait_agents` and `collect` over the session's limit of running children, read at each use. */
export function createWaitTools(maxRunning: () => number): WaitTools {
	const waitAgents = defineTool<typeof WaitParameters, never, WaitCheckpoint>({
		name: "wait_agents",
		description:
			"Park until one (policy any) or all (policy all) of the named subagents finish, or until a message for you arrives. Holds no process while it waits. Returns their results, or the message.",
		parameters: WaitParameters,
		callers: ["model"],
		replay: "safe",
		async execute(args, api, context) {
			const spec: WaitSpec = { names: [...args.names], policy: args.policy ?? "any", messages: true };
			const outcome = await waitFor(spec, api, maxRunning(), context);
			if (outcome.kind === "park") return outcome.park;
			const text =
				outcome.kind === "message"
					? outcome.text
					: spec.names.map((name) => stateLines(name, outcome.records[name]!.state)).join("\n\n");
			return { output: [{ type: "text", text }] };
		},
		cancel: (_args, api, context) => leave(api, maxRunning(), context),
	});
	const collect = defineTool<typeof CollectParameters, never, WaitCheckpoint>({
		name: "collect",
		description: "Wait until every named subagent finished, or the timeout passed; their records by name.",
		parameters: CollectParameters,
		structuredOutputSchema: unknown(),
		callers: ["tools"],
		replay: "safe",
		async execute(args, api, context) {
			const deadline =
				args.timeout === undefined
					? undefined
					: await api.memo("deadline", api.now() + args.timeout * 1000, context);
			const spec: WaitSpec = { names: [...args.names], policy: "all", messages: false };
			const outcome = await waitFor(spec, api, maxRunning(), context, deadline);
			if (outcome.kind === "park") return outcome.park;
			const records = outcome.kind === "children" ? outcome.records : {};
			const picked = Object.fromEntries(spec.names.map((name) => [name, records[name]!]));
			const text = spec.names.map((name) => `${name}: ${picked[name]!.state.kind}`).join("\n");
			return { output: [{ type: "text", text }], structuredOutput: picked };
		},
		cancel: (_args, api, context) => leave(api, maxRunning(), context),
	});
	return { waitAgents, collect };
}

type Api = ToolExecutionApi<never, WaitCheckpoint>;

/** What the commit of one `waitFor` decided: park for the children, or the wait ended and the run queued for a slot or holds one. */
type Step =
	| { readonly kind: "park" }
	| { readonly kind: "queued"; readonly ended: Ended }
	| { readonly kind: "over"; readonly ended: Ended };

/**
 * End the wait when it is over (the children finished, a message woke it, the deadline passed) and the run holds a
 * running slot of `limit`, or park: on a new key for the children, or for the slot.
 */
async function waitFor(
	spec: WaitSpec,
	api: Api,
	limit: number,
	context: Context,
	deadline?: number,
): Promise<WaitOutcome> {
	const at: WaitCheckpoint = api.checkpoint ?? { phase: "wait", parks: 0 };
	const children = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? {};
	const unknownNames = spec.names.filter((name) => !Object.hasOwn(children, name));
	if (unknownNames.length > 0) throw new Error(`No child named ${unknownNames.join(", ")}`);
	const message = at.phase === "wait" ? await wakingMessage(api, context) : undefined;
	const expired = deadline !== undefined && api.now() >= deadline;
	const self = await identityOf(api, api.conversationId, context);
	const parks = at.parks + 1;
	const step = await api.commit(async (tx): Promise<Step> => {
		const waiters = await tx.doc(WaitersDoc, api.conversationId);
		const ended =
			at.phase === "slot" ? at.ended : (message ?? (await endedNow(tx, spec, api.conversationId, expired)));
		const run = await runOf(tx, self);
		if (ended === undefined) {
			const keys = { key: `wait-${parks}`, slot: `slot-${parks}` };
			waiters.waiters[String(api.taskId)] = { task: api.taskId, ...spec, ...keys, fired: false };
			if (run !== undefined) await freeSlot(tx, run.anchor);
			return { kind: "park" };
		}
		delete waiters.waiters[String(api.taskId)];
		// A run that is ending (stopped, out of time) needs no slot to end; its anchor gives back whatever it holds.
		if (run === undefined || !run.running) return { kind: "over", ended };
		// The key the waiter registered for this park, under which the event that ended it may have queued the claim.
		const claim = { anchor: run.anchor, task: api.taskId, key: `slot-${at.parks}` };
		return (await claimSlot(tx, claim, "resuming", limit)) ? { kind: "over", ended } : { kind: "queued", ended };
	}, context);
	switch (step.kind) {
		case "park": {
			const until = deadline === undefined ? {} : { until: deadline };
			const checkpoint: WaitCheckpoint = { phase: "wait", parks };
			return { kind: "park", park: { sleep: { signals: [AgentWake.key(`wait-${parks}`)], checkpoint, ...until } } };
		}
		case "queued": {
			const checkpoint: WaitCheckpoint = { phase: "slot", parks: at.parks, ended: step.ended };
			return { kind: "park", park: { sleep: { signals: [AgentSlot.key(`slot-${at.parks}`)], checkpoint } } };
		}
		case "over":
			if (step.ended.kind === "message") return { kind: "message", text: step.ended.text };
			return { kind: "children", records: (await api.snapshot(AgentsDoc, api.conversationId, context))!.agents };
	}
}

/**
 * In the commit that signals `waiter` an event ending its wait (a message, or the finish that completes its children),
 * put the waiting child's run in line for a running slot, ahead of runs not started. A slot freed before the call runs
 * again, as the finishing child's is right after, then goes to it. Call it before the signal: a commit reads nothing
 * after one.
 */
export async function lineUpWake(tx: Tx, waiter: Waiter, self: Readonly<AgentSelf> | undefined): Promise<void> {
	const run = await runOf(tx, self);
	if (run?.running !== true) return;
	// Limit 0: a place in line, never a slot; the call takes a free one when it runs.
	await claimSlot(tx, { anchor: run.anchor, task: waiter.task, key: waiter.slot }, "resuming", 0);
}

/** The anchor whose slot a child's run holds, and whether the run goes on; undefined for the root, which holds none. */
async function runOf(
	tx: Tx,
	self: Readonly<AgentSelf> | undefined,
): Promise<{ readonly anchor: TaskId; readonly running: boolean } | undefined> {
	if (self === undefined) return undefined;
	const parent = await tx.doc(AgentsDoc, self.parentConversationId);
	return { anchor: parent.runtime[self.name]!.anchor, running: parent.agents[self.name]!.state.kind === "running" };
}

/** The message whose signal woke this wait, if one did. */
async function wakingMessage(api: Api, context: Context): Promise<Ended | undefined> {
	if (api.wake?.reason !== "signal") return undefined;
	const woken = await api.readSignal(AgentWake, api.wake.key, context);
	return woken !== undefined && "value" in woken && woken.value.kind === "message"
		? { kind: "message", text: agentMessageText(woken.value) }
		: undefined;
}

const QUEUED_MESSAGE = "A message for you is queued; you will read it right after this call.";

/** How the wait ended by now, read in `tx`: a message queued, the deadline passed, or the children finished. */
async function endedNow(
	tx: Tx,
	spec: WaitSpec,
	conversationId: Api["conversationId"],
	expired: boolean,
): Promise<Ended | undefined> {
	// A message that came as a steer before this wait registered waits in the inbox until this call returns.
	const inbox = spec.messages ? (await tx.doc(InboxDoc, conversationId)).items : [];
	if (inbox.some((item) => item.mode === "steer" && item.entry?.kind === AGENT_MESSAGE_ENTRY)) {
		return { kind: "message", text: QUEUED_MESSAGE };
	}
	const agents = (await tx.doc(AgentsDoc, conversationId)).agents;
	return expired || isOver(spec, agents) ? { kind: "children" } : undefined;
}

/** Whether the wait `spec` describes is over for `agents`: one or all of its children finished. */
export function isOver(spec: WaitSpec, agents: Readonly<Record<string, AgentRecord>>): boolean {
	const finished = spec.names.filter((name) => {
		const kind = agents[name]!.state.kind;
		return kind !== "queued" && kind !== "running";
	});
	return spec.policy === "any" ? finished.length > 0 : finished.length === spec.names.length;
}

/**
 * Unregister a cancelled call. Its run may go on without it: a restart ends the cell that awaited a `collect`, which is
 * not replay-safe, and Durable abandons the parked call. Nothing can park that run, so a running child claims its slot
 * back, ahead of runs not started, and counts against it again once it has one; a run that is ending has its claim
 * dropped by its anchor.
 */
async function leave(api: Api, limit: number, context: Context): Promise<void> {
	const self = await identityOf(api, api.conversationId, context);
	await api.commit(async (tx) => {
		delete (await tx.doc(WaitersDoc, api.conversationId)).waiters[String(api.taskId)];
		const run = await runOf(tx, self);
		if (run?.running !== true) return;
		await claimSlot(tx, { anchor: run.anchor, task: api.taskId, key: "cancelled" }, "resuming", limit);
	}, context);
}
