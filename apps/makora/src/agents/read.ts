// The `agents` tool behind `agents.list()`, `agents.get(name)` and `agents.recent(name, limit)` in a cell: read-only
// views of the caller's children and their transcripts.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { messageText } from "../transcript-rows.ts";
import { childOf } from "./control.ts";
import { AgentsDoc } from "./docs.ts";

const ReadParameters = obj({
	action: oneOf(["list", "get", "recent"] as const),
	name: opt(str()),
	limit: opt(int({ minimum: 1, maximum: 50 })),
});

/** A preview of one transcript message is cut to this many characters. */
const PREVIEW_CHARS = 800;

/** The `agents` tool. */
export const agentsTool: ToolRegistration<typeof ReadParameters> = defineTool({
	name: "agents",
	description: "List this conversation's subagents, get one's record, or read its recent messages.",
	parameters: ReadParameters,
	structuredOutputSchema: unknown(),
	callers: ["tools"],
	async execute(args, api, context) {
		const agents = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? {};
		if (args.action === "list") {
			const records = Object.values(agents);
			return { output: [{ type: "text", text: `${records.length} agents` }], structuredOutput: records };
		}
		if (args.name === undefined) throw new Error(`agents.${args.action} needs a name`);
		const record = childOf(agents, args.name);
		if (args.action === "get") {
			return { output: [{ type: "text", text: `${record.name}: ${record.state.kind}` }], structuredOutput: record };
		}
		const limit = args.limit ?? 6;
		const page = await api.commit(
			(tx) => tx.scanEntries({ conversationId: record.conversationId, order: "descending" }, limit * 4),
			context,
		);
		const messages = page.items
			.flatMap((entry) => {
				const message = entry.model?.[0];
				if (message === undefined || message.role === "system") return [];
				const text = messageText(message);
				return [
					{ role: message.role, text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text },
				];
			})
			.slice(0, limit)
			.reverse();
		return { output: [{ type: "text", text: `${messages.length} messages` }], structuredOutput: messages };
	},
});
