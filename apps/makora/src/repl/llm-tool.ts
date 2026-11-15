// The `llm` tool behind `await llm(...)` in a cell: one model call, no agent loop, schema-checked JSON on request.
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type JsonObject } from "@earendil-works/pi-durable";
import { compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { parseModelRef } from "../app.ts";
import { messageText } from "../transcript-rows.ts";

const LlmParameters = obj({
	prompt: str({ description: "The whole prompt, sent as one user message" }),
	schema: opt(unknown({ description: "JSON Schema the answer must match; the answer is then parsed JSON" })),
	model: opt(str({ description: "provider/modelId; default: the conversation's model" })),
});

const LlmOutput = obj({ text: str(), json: opt(unknown()) });

/** One model call through the conversation's model, callable from cells only. */
export const llmTool = defineTool({
	name: "llm",
	description: "One model call without tools. With `schema`, the answer is JSON checked against it.",
	parameters: LlmParameters,
	structuredOutputSchema: LlmOutput,
	callers: ["tools"],
	async execute(args, api, context) {
		const ref = args.model === undefined ? (await api.agent(context)).model : parseModelRef(args.model);
		if (ref === undefined)
			throw new Error(args.model === undefined ? "No model is configured" : `Bad model: ${args.model}`);
		const model = api.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) throw new Error(`Unknown model ${ref.provider}/${ref.modelId}`);
		const message = await api.models.completeSimple(
			model,
			{
				...(args.schema === undefined
					? {}
					: {
							systemPrompt: `Answer with one JSON value matching this JSON Schema, and nothing else:\n${JSON.stringify(args.schema)}`,
						}),
				messages: [{ role: "user", content: args.prompt, timestamp: api.now() }],
			},
			context.abortSignal === undefined ? {} : { signal: context.abortSignal },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `The model call ended: ${message.stopReason}`);
		}
		const text = messageText(message);
		const output = [{ type: "text" as const, text }];
		if (args.schema === undefined) {
			const plain: JsonObject = { text };
			return { output, structuredOutput: plain, usage: message.usage };
		}
		const json = parseAnswer(text);
		// The schema comes from the cell: a trust boundary, so a broken schema is the call's error.
		const errors = compile(args.schema as object).errors(json);
		if (errors.length > 0) {
			const why = errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ");
			throw new Error(`The answer does not match the schema: ${why}\n${text}`);
		}
		const checked: JsonObject = { text, json };
		return { output, structuredOutput: checked, usage: message.usage };
	},
});

// Models often wrap JSON in a code fence.
function parseAnswer(text: string): JsonValue {
	const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1];
	try {
		return JSON.parse(fenced ?? text) as JsonValue;
	} catch {
		throw new Error(`The answer is not JSON:\n${text}`);
	}
}
