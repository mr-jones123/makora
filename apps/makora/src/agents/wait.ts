// Waiting for children without holding a process: `wait_agents`, offered to the model, and `collect`, which a cell
// awaits. Both park on a signal key registered in the conversation's `makora.agent-waiters` document; an anchor whose
// child finishes signals it, and `wait_agents` also wakes when a message for its conversation arrives. Registering and
// checking whether the children already finished happen in one commit, so no finish falls between them.
import type { Context } from "@earendil-works/chord/context";
import {
	defineTool,
	InboxDoc,
	type ToolExecutionApi,
	type ToolPark,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { AgentsDoc, AgentWake, WaitersDoc } from "./docs.ts";
import { AGENT_MESSAGE_ENTRY, agentMessageText, stateLines } from "./prompts.ts";
import type { AgentRecord } from "./types.ts";

const WaitParameters = obj({
	names: arr(str(), { description: "Children to wait for; [] waits only for a message" }),
	policy: opt(oneOf(["any", "all"] as const, { description: "any (default): the first to finish; all: every one" })),
});

const CollectParameters = obj({
	names: arr(str()),
	timeout: opt(num({ description: "Seconds; return what finished by then" })),
});

/** How many times the call parked; each park sleeps on a key of its own. */
type WaitCheckpoint = { readonly parks: number };

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

/** The model's `wait_agents`: parks until one or all named children finish, or a message arrives. */
export const waitAgentsTool = defineTool<typeof WaitParameters, never, WaitCheckpoint>({
	name: "wait_agents",
	description:
		"Park until one (policy any) or all (policy all) of the named subagents finish, or until a message for you arrives. Holds no process while it waits. Returns their results, or the message.",
	parameters: WaitParameters,
	callers: ["model"],
	replay: "safe",
	async execute(args, api, context) {
		const spec: WaitSpec = { names: [...args.names], policy: args.policy ?? "any", messages: true };
		const outcome = await waitFor(spec, api, context);
		if (outcome.kind === "park") return outcome.park;
		const text =
			outcome.kind === "message"
				? outcome.text
				: spec.names.map((name) => stateLines(name, outcome.records[name]!.state)).join("\n\n");
		return { output: [{ type: "text", text }] };
	},
	cancel: (_args, api, context) => unregister(api, context),
});

/** `await collect(names, timeout=None)` in a cell: every named child's record once all finished, or at the timeout. */
export const collectTool: ToolRegistration<typeof CollectParameters> = defineTool<
	typeof CollectParameters,
	never,
	WaitCheckpoint
>({
	name: "collect",
	description: "Wait until every named subagent finished, or the timeout passed; their records by name.",
	parameters: CollectParameters,
	structuredOutputSchema: unknown(),
	callers: ["tools"],
	replay: "safe",
	async execute(args, api, context) {
		const deadline =
			args.timeout === undefined ? undefined : await api.memo("deadline", api.now() + args.timeout * 1000, context);
		const spec: WaitSpec = { names: [...args.names], policy: "all", messages: false };
		const outcome = await waitFor(spec, api, context, deadline);
		if (outcome.kind === "park") return outcome.park;
		const records = outcome.kind === "children" ? outcome.records : {};
		const picked = Object.fromEntries(spec.names.map((name) => [name, records[name]!]));
		const text = spec.names.map((name) => `${name}: ${picked[name]!.state.kind}`).join("\n");
		return { output: [{ type: "text", text }], structuredOutput: picked };
	},
	cancel: (_args, api, context) => unregister(api, context),
});

type Api = ToolExecutionApi<never, WaitCheckpoint>;

/** End the wait when it is over (the children finished, a message woke it, the deadline passed), or park on a new key. */
async function waitFor(spec: WaitSpec, api: Api, context: Context, deadline?: number): Promise<WaitOutcome> {
	const parks = api.checkpoint?.parks ?? 0;
	const children = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? {};
	const unknownNames = spec.names.filter((name) => !Object.hasOwn(children, name));
	if (unknownNames.length > 0) throw new Error(`No child named ${unknownNames.join(", ")}`);
	if (api.wake?.reason === "signal") {
		const woken = await api.readSignal(AgentWake, api.wake.key, context);
		if (woken !== undefined && "value" in woken && woken.value.kind === "message") {
			await unregister(api, context);
			return { kind: "message", text: agentMessageText(woken.value) };
		}
	}
	const expired = deadline !== undefined && api.now() >= deadline;
	const key = `wait-${parks + 1}`;
	const decision = await api.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, api.conversationId);
		const waiters = await tx.doc(WaitersDoc, api.conversationId);
		// A message that came as a steer before this wait registered waits in the inbox until this call returns.
		const inbox = spec.messages ? (await tx.doc(InboxDoc, api.conversationId)).items : [];
		const queued = inbox.some((item) => item.mode === "steer" && item.entry?.kind === AGENT_MESSAGE_ENTRY);
		if (expired || queued || isOver(spec, doc.agents)) {
			delete waiters.waiters[String(api.taskId)];
			return queued ? "message" : "over";
		}
		waiters.waiters[String(api.taskId)] = { task: api.taskId, ...spec, key, fired: false };
		return "park";
	}, context);
	if (decision === "message") return { kind: "message", text: QUEUED_MESSAGE };
	if (decision === "over") {
		return { kind: "children", records: (await api.snapshot(AgentsDoc, api.conversationId, context))!.agents };
	}
	const until = deadline === undefined ? {} : { until: deadline };
	return {
		kind: "park",
		park: { sleep: { signals: [AgentWake.key(key)], checkpoint: { parks: parks + 1 }, ...until } },
	};
}

const QUEUED_MESSAGE = "A message for you is queued; you will read it right after this call.";

function isOver(spec: WaitSpec, agents: Readonly<Record<string, AgentRecord>>): boolean {
	const finished = spec.names.filter((name) => {
		const kind = agents[name]!.state.kind;
		return kind !== "queued" && kind !== "running";
	});
	return spec.policy === "any" ? finished.length > 0 : finished.length === spec.names.length;
}

async function unregister(api: Api, context: Context): Promise<void> {
	await api.commit(async (tx) => {
		delete (await tx.doc(WaitersDoc, api.conversationId)).waiters[String(api.taskId)];
	}, context);
}
