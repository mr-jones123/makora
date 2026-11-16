// `await send(to, message)` in a cell: a message to the caller's parent, a sibling, a direct child, or all of them.
// The host builds the sender and relationship from the calling conversation, never from Python. A parked
// `wait_agents` of the receiver is woken with it; otherwise it arrives as a steer of the running work or as a new turn.
// Limits follow Prime Agent's: 16,384 characters, 20 pending inputs per receiver, 3 messages per sender refilling one
// per second, each refused with an error.
import type { Context } from "@earendil-works/chord/context";
import { defineTool, InboxDoc, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str, unknown } from "@earendil-works/pi-schema";
import { type AgentSelf, AgentWake, MessageLogDoc, RatesDoc, WaitersDoc } from "./docs.ts";
import { admitInput, familyOf, identityOf, type Member, ROOT_NAME } from "./family.ts";
import { AGENT_MESSAGE_ENTRY, type AgentMessageData, agentMessageText } from "./prompts.ts";

/** A message longer than this, after trimming, is refused. */
const MAX_MESSAGE_CHARS = 16_384;
/** A receiver with this many queued inputs refuses more. */
const MAX_PENDING = 20;
/** Messages a sender may send at once; one more comes back each `RATE_REFILL_MS`. */
const RATE_CAPACITY = 3;
const RATE_REFILL_MS = 1_000;
/** Messages the session's log keeps for the dashboard. */
const LOG_LIMIT = 200;

const SendParameters = obj({
	to: str({ description: 'A child\'s or sibling\'s name, "parent", or "all"' }),
	message: str(),
});

/** How one message reached its receiver. */
type Receipt = { readonly to: string; readonly status: "delivered" } | { readonly to: string; readonly error: string };

/** The `send` tool. */
export const sendTool: ToolRegistration<typeof SendParameters> = defineTool({
	name: "send",
	description: "Message this agent's parent, a sibling, a direct child, or all of them.",
	parameters: SendParameters,
	structuredOutputSchema: unknown(),
	callers: ["tools"],
	async execute(args, api, context) {
		const text = args.message.trim();
		if (text === "") throw new Error("Agent message cannot be empty");
		if (text.length > MAX_MESSAGE_CHARS) {
			throw new Error(`Agent message is too long: ${text.length} chars exceeds ${MAX_MESSAGE_CHARS}`);
		}
		const self = await identityOf(api, api.conversationId, context);
		const family = await familyOf(api, api.conversationId, self, context);
		const targets = resolve(family, args.to);
		await takeToken(api, context);
		const from = self?.name ?? ROOT_NAME;
		const receipts: Receipt[] = [];
		for (const target of targets) {
			try {
				await deliver(api, from, target, text, context);
				receipts.push({ to: target.name, status: "delivered" });
			} catch (error) {
				// One target's refusal fails a direct message; a broadcast reports it and goes on.
				if (args.to !== "all") throw error;
				receipts.push({ to: target.name, error: error instanceof Error ? error.message : String(error) });
			}
		}
		const output = receipts.map((each) => ("error" in each ? `${each.to}: ${each.error}` : `${each.to}: delivered`));
		return {
			output: [{ type: "text", text: output.join("\n") || "no one to message" }],
			structuredOutput: args.to === "all" ? { receipts } : receipts[0]!,
		};
	},
});

/** The members `to` names: the parent, everyone, or one sibling or child by name. */
function resolve(family: readonly Member[], to: string): Member[] {
	if (to === "all") return [...family];
	const matches = family.filter((member) =>
		to === "parent" ? member.relationship === "parent" : member.name === to && member.relationship !== "parent",
	);
	if (matches.length === 0) {
		const names = family.map((member) => (member.relationship === "parent" ? "parent" : member.name));
		throw new Error(
			`No ${to === "parent" ? "parent" : `sibling or child named ${to}`}; you can reach: ${names.join(", ") || "no one"}`,
		);
	}
	if (matches.length > 1) throw new Error(`${to} names both a sibling and a child; rename one`);
	return matches;
}

/** Spend one of the sender's message tokens, or refuse the send. Committed, so the limit holds across restarts. */
async function takeToken(api: ToolExecutionApi, context: Context): Promise<void> {
	await api.commit(async (tx) => {
		const rates = await tx.doc(RatesDoc);
		const key = String(api.conversationId);
		const now = api.now();
		const bucket = rates.buckets[key];
		const tokens =
			bucket === undefined
				? RATE_CAPACITY
				: Math.min(RATE_CAPACITY, bucket.tokens + (now - bucket.at) / RATE_REFILL_MS);
		if (tokens < 1) {
			throw new Error(
				`Agent message rate limit exceeded: ${RATE_CAPACITY} messages, then one per ${RATE_REFILL_MS / 1000} s`,
			);
		}
		rates.buckets[key] = { tokens: tokens - 1, at: now };
	}, context);
}

/** Deliver one message in one commit: wake the receiver's parked `wait_agents`, or admit it as an input; log it. */
async function deliver(
	api: ToolExecutionApi,
	from: string,
	target: Member,
	text: string,
	context: Context,
): Promise<void> {
	const pending = (await api.snapshot(InboxDoc, target.conversationId, context))?.items.length ?? 0;
	if (pending >= MAX_PENDING) {
		throw new Error(`${target.name} has too many pending messages: ${pending} unfinished, limit is ${MAX_PENDING}`);
	}
	const handle = (await api.conversation(target.conversationId, context))!;
	const targetSelf: AgentSelf | undefined = await identityOf(api, target.conversationId, context);
	// The receiver sees how the sender relates to it: the inverse of how it relates to the sender.
	const relationship = INVERSE[target.relationship];
	const message: AgentMessageData = { from, relationship, text };
	await api.commit(async (tx) => {
		const waiters = await tx.doc(WaitersDoc, target.conversationId);
		const log = await tx.doc(MessageLogDoc);
		const waiter = Object.values(waiters.waiters).find((each) => each.messages && !each.fired);
		if (waiter === undefined) {
			await admitInput(
				tx,
				{ handle, self: targetSelf },
				{
					content: agentMessageText(message),
					entry: { kind: AGENT_MESSAGE_ENTRY, data: message },
					requestId: `agent-message:${api.taskId}:${target.conversationId}`,
					from: relationship,
				},
				"steer",
			);
		} else {
			const result = await tx.signal(waiter.task, AgentWake, waiter.key, { kind: "message", ...message });
			if (result !== "delivered") throw new Error(`${target.name} is ending a wait; send again`);
			waiters.waiters[String(waiter.task)] = { ...waiter, fired: true };
		}
		log.messages.push({
			from,
			to: target.name,
			fromConversationId: api.conversationId,
			toConversationId: target.conversationId,
			text,
			at: api.now(),
		});
		if (log.messages.length > LOG_LIMIT) log.messages.splice(0, log.messages.length - LOG_LIMIT);
	}, context);
}

const INVERSE = { parent: "child", child: "parent", sibling: "sibling" } as const;
