// Makora's model collection: every built-in provider, plus in fake mode (`--fake`, `MAKORA_FAKE=1`) a scripted faux
// provider for demos and tests that drives the Python REPL by keywords in the prompt and answers in markdown.
import type { CredentialStore, Message } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";

/** The fake provider's only model. */
export const FAKE_MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

/** The built-in providers reading credentials from `credentials`, plus the fake provider when `fake`. */
export function createMakoraModels(credentials: CredentialStore, fake: boolean): MutableModels {
	const models = builtinModels({ credentials });
	if (fake) addFakeProvider(models);
	return models;
}

/**
 * The fake model's scripts: the first keyword the prompt contains picks the cells it runs, one `python` call per
 * turn, before its markdown answer.
 */
export const FAKE_SCRIPTS: readonly { readonly keyword: string; readonly cells: readonly string[] }[] = [
	{ keyword: "crash", cells: ["import os; os._exit(1)"] },
	{ keyword: "scribble", cells: ['await write("late.txt", "late\\n")\nimport os; os._exit(1)'] },
	{ keyword: "edit", cells: ['print(await edit("notes.txt", "world", "there"))'] },
	{
		keyword: "long",
		cells: [
			'text = await read("long.txt")\nprint(len(text.splitlines()), text == open("long.txt").read())',
			'try:\n    await read("wide.txt")\nexcept Exception as error:\n    print("refused:", error)',
		],
	},
	{
		keyword: "context",
		cells: ['print(ctx.input())\nprint([entry["role"] for entry in await ctx.transcript(limit=5)])'],
	},
	{
		keyword: "schema",
		cells: [
			'answer = await llm("pick a number", schema={"type": "object", "properties": {"answer": {"type": "integer"}}, "required": ["answer"]})\nprint(answer["answer"] + 1)',
		],
	},
	{ keyword: "remember", cells: ["print(x)"] },
	{ keyword: "file", cells: ['await write("fake.txt", "hi")', 'print(await read("fake.txt"))'] },
	{ keyword: "tool", cells: ['print(await bash("echo hello; sleep 2"))'] },
	{ keyword: "ask", cells: ['print(await llm("say hi"))'] },
	{ keyword: "python", cells: ["x = 41", "print(x + 1)"] },
];

// Responses depend on the committed transcript, not on a queue position, so a run reopened after a crash gets the
// same answer it would have had.
function addFakeProvider(models: MutableModels): void {
	const faux = fauxProvider({
		api: "makora-faux",
		models: [
			{
				id: FAKE_MODEL.modelId,
				name: "Faux",
				reasoning: true,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			},
		],
		tokensPerSecond: 120,
	});
	models.setProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			faux.appendResponses([(transcript) => fakeResponse(transcript.messages)]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
}

function fakeResponse(messages: readonly Message[]) {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const input = messages[lastUser];
	const text = input?.role === "user" ? userText(input) : "";
	// A request without tools is a cell's `llm()` call; one with a schema asks for JSON in its system prompt.
	if (!messages.some((message) => message.role === "system" && (message.toolsAdded?.length ?? 0) > 0)) {
		const wantsJson = messages.some(
			(message) =>
				message.role === "system" && typeof message.content === "string" && message.content.includes("JSON Schema"),
		);
		return fauxAssistantMessage([
			fauxText(wantsJson ? '```json\n{"answer": 42}\n```' : `Fake model here. You asked: ${text}`),
		]);
	}
	const results = messages
		.slice(lastUser + 1)
		.flatMap((message) => (message.role === "toolResult" && message.toolName === "python" ? [message] : []));
	const script = FAKE_SCRIPTS.find((candidate) => text.includes(candidate.keyword));
	const cell = script?.cells[results.length];
	if (script !== undefined && cell !== undefined) {
		return fauxAssistantMessage(
			[
				fauxThinking(
					`The script for "${script.keyword}" runs cell ${results.length + 1} of ${script.cells.length}.`,
				),
				fauxText(`Running cell ${results.length + 1}.`),
				fauxToolCall("python", { code: cell }),
			],
			{ stopReason: "toolUse" },
		);
	}
	const last = results.at(-1);
	if (last !== undefined) {
		const output = last.content.flatMap((part) => (part.type === "text" ? [part.text.trim()] : [])).join("\n");
		return fauxAssistantMessage([
			fauxThinking("The cells finished; summarizing the last one."),
			fauxText(
				`The \`python\` cell ${last.isError ? "failed" : "finished"}. Its output:\n\n\`\`\`\n${output}\n\`\`\`\n\nThat is all the fake model does with the REPL.`,
			),
		]);
	}
	return fauxAssistantMessage([
		fauxThinking("Answering from the fake script."),
		fauxText(
			`## Fake answer\n\nYou wrote: **${text}**\n\n- This is makora's fake model; no provider was called.\n- Mention ${FAKE_SCRIPTS.map((each) => `\`${each.keyword}\``).join(", ")} in a prompt to run Python cells.`,
		),
	]);
}

function userText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
