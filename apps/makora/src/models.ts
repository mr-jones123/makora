// Makora's model collection: every built-in provider, plus in fake mode (`--fake`, `MAKORA_FAKE=1`) a scripted faux
// provider for demos and tests that drives the Python REPL by keywords in the prompt and answers in markdown.
import {
	type CredentialStore,
	calculateCost,
	createAssistantMessageEventStream,
	type Message,
} from "@earendil-works/pi-ai";
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

/** A `wait_agents` call in a fake script. */
export type FakeWait = { readonly wait: { readonly names: readonly string[]; readonly policy: "any" | "all" } };

/**
 * The fake model's scripts: the first keyword the prompt contains picks the steps it runs, one per turn, before its
 * markdown answer. A string step is a `python` cell. A subagent matches keywords in its `<agent_task>` only, so the
 * brief around the task picks nothing.
 */
export const FAKE_SCRIPTS: readonly { readonly keyword: string; readonly cells: readonly (string | FakeWait)[] }[] = [
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
	{ keyword: "bump", cells: ['x = 99\nawait write("fake.txt", "bumped")'] },
	// The dashboard demo: two reviewers, a writer slow enough to watch, and a sleeper to stop, each with a budget.
	{
		keyword: "dashboard",
		cells: [
			'team = [\n    await spawn("reviewer-a", "steady", mode="review", budget={"minutes": 5}),\n    await spawn("reviewer-b", "steady", mode="review"),\n    await spawn("writer", "patient-writer", mode="write", budget={"usd": 0.5}),\n    await spawn("sleeper", "doze", mode="review", budget={"usd": 1}),\n]\nprint([member["name"] + ": " + member["state"]["kind"] for member in team])',
		],
	},
	{
		keyword: "patient-writer",
		cells: [
			'print((await bash("sleep 4; echo drafted")).output.strip())',
			'await write("CHANGES.md", "usage: makora --fake\\n")',
		],
	},
	{ keyword: "doze", cells: ['print((await bash("sleep 600; echo rested")).output.strip())'] },
	{
		keyword: "agents",
		cells: [
			'team = [\n    await spawn("reviewer-a", "review", mode="review"),\n    await spawn("reviewer-b", "review and message-writer", mode="review"),\n    await spawn("writer", "wait-message, then write-change", mode="write"),\n]\nprint([member["name"] + ": " + member["state"]["kind"] for member in team])',
			{ wait: { names: ["reviewer-a", "reviewer-b", "writer"], policy: "all" } },
			'print(await merge("writer"))',
		],
	},
	{
		keyword: "trio",
		cells: [
			'team = [\n    await spawn("reviewer-a", "review", mode="review"),\n    await spawn("reviewer-b", "review", mode="review"),\n    await spawn("writer", "write-change", mode="write"),\n]\nprint([member["name"] + ": " + member["state"]["kind"] for member in team])',
		],
	},
	{
		keyword: "first-of",
		cells: [
			'await spawn("quick", "review", mode="review")\nawait spawn("slow", "slow", mode="review")',
			{ wait: { names: ["quick", "slow"], policy: "any" } },
		],
	},
	{
		keyword: "hear-from",
		cells: [
			'await spawn("slow", "slow", mode="review")\nawait spawn("talker", "message-parent", mode="review")',
			{ wait: { names: ["slow"], policy: "any" } },
		],
	},
	{
		keyword: "resume-team",
		cells: [
			'await spawn("slow-a", "steady", mode="review")\nawait spawn("slow-b", "steady", mode="review")\nawait spawn("talker", "message-sibling", mode="review")',
			{ wait: { names: ["slow-a", "slow-b", "talker"], policy: "all" } },
		],
	},
	{
		keyword: "deep-team",
		cells: ['await spawn("keeper", "nest-wait", mode="review")', { wait: { names: ["keeper"], policy: "all" } }],
	},
	{ keyword: "message-sibling", cells: ['print(await send("slow-a", "hello sibling"))'] },
	{
		keyword: "steady",
		cells: [
			'print((await bash("sleep 3; echo slept")).output.strip())',
			'print("README:", open("README.md").read().strip())',
		],
	},
	{ keyword: "message-parent", cells: ['print(await send("parent", "hello from below"))'] },
	{
		keyword: "message-writer",
		cells: ['print(await send("writer", "reviewer-b says: README.md needs a usage line"))'],
	},
	{
		keyword: "wait-message",
		cells: [{ wait: { names: [], policy: "any" } }, 'await write("CHANGES.md", "usage line added\\n")'],
	},
	{ keyword: "write-change", cells: ['await write("CHANGES.md", "writer was here\\n")'] },
	{ keyword: "review", cells: ['print("README:", open("README.md").read().strip())'] },
	{ keyword: "slow", cells: ['print((await bash("sleep 3; echo slept")).output.strip())'] },
	{
		keyword: "nest-collect",
		cells: [
			'await spawn("grandchild", "slow", mode="review")\nprint((await collect(["grandchild"]))["grandchild"]["state"]["kind"])',
		],
	},
	{
		keyword: "nest-wait",
		cells: ['await spawn("grandchild", "slow", mode="review")', { wait: { names: ["grandchild"], policy: "all" } }],
	},
	{
		keyword: "nest-hold",
		cells: ['await spawn("grandchild", "doze", mode="review")', { wait: { names: ["grandchild"], policy: "all" } }],
	},
	{
		keyword: "nest-deeper",
		cells: [
			'try:\n    await spawn("too-deep", "review", mode="review")\nexcept Exception as error:\n    print("refused:", error)',
		],
	},
	{ keyword: "nest-keep", cells: ['print((await spawn("grandchild", "slow", mode="review"))["state"]["kind"])'] },
	{
		keyword: "nest",
		cells: [
			'child = await spawn("grandchild", "nest-deeper", mode="review")\nprint((await collect(["grandchild"]))["grandchild"]["state"]["kind"])',
		],
	},
	{ keyword: "file", cells: ['await write("fake.txt", "hi")', 'print(await read("fake.txt"))'] },
	{ keyword: "tool", cells: ['print(await bash("echo hello; sleep 2"))'] },
	{ keyword: "ask", cells: ['print(await llm("say hi"))'] },
	{ keyword: "python", cells: ["x = 41", "print(x + 1)"] },
];

// Responses depend on the committed transcript, not on a queue position, so a run reopened after a crash gets the
// same answer it would have had. Usage is priced from the fake model's rates, so budgets in USD can be tested.
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
			const source = faux.provider.streamSimple(model, context, options);
			const priced = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done") calculateCost(model, event.message.usage);
					if (event.type === "error") calculateCost(model, event.error.usage);
					priced.push(event);
				}
				priced.end(await source.result());
			})();
			return priced;
		},
	});
}

const AGENT_NOTE = /^<agent_(result|message)\b/;
const AGENT_TASK = /<agent_task[^>]*>\n([\s\S]*?)\n<\/agent_task>/;
// A prompt with a fenced python block runs that block as its one cell: tests and demos write their own cells.
const PYTHON_FENCE = /```python\n([\s\S]*?)\n```/;

function fakeResponse(messages: readonly Message[]) {
	const isPrompt = (message: Message) => message.role === "user" && !AGENT_NOTE.test(userText(message));
	const lastUser = messages.findLastIndex(isPrompt);
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
		.flatMap((message) =>
			message.role === "toolResult" && (message.toolName === "python" || message.toolName === "wait_agents")
				? [message]
				: [],
		);
	const task = text.match(AGENT_TASK)?.[1] ?? text;
	const fenced = task.match(PYTHON_FENCE)?.[1];
	const script =
		fenced === undefined
			? FAKE_SCRIPTS.find((candidate) => task.includes(candidate.keyword))
			: { keyword: "python block", cells: [fenced] };
	// A message that arrived as a steer before the script's first step, a wait for a message, stands in for it.
	const tail = messages.slice(lastUser + 1);
	const first = script?.cells[0];
	const steered =
		typeof first === "object" &&
		first.wait.names.length === 0 &&
		tail.some((message) => message.role === "user" && userText(message).startsWith("<agent_message")) &&
		!results.some((result) => result.toolName === "wait_agents");
	const index = results.length + (steered ? 1 : 0);
	const cell = script?.cells[index];
	if (script !== undefined && cell !== undefined) {
		const step = index + 1;
		return fauxAssistantMessage(
			[
				fauxThinking(`The script for "${script.keyword}" runs step ${step} of ${script.cells.length}.`),
				fauxText(typeof cell === "string" ? `Running cell ${step}.` : "Waiting for the agents."),
				typeof cell === "string"
					? fauxToolCall("python", { code: cell })
					: fauxToolCall("wait_agents", { names: [...cell.wait.names], policy: cell.wait.policy }),
			],
			{ stopReason: "toolUse" },
		);
	}
	// A child's result or a message that arrived after the script ended.
	const note = messages.at(-1);
	if (note?.role === "user" && AGENT_NOTE.test(userText(note))) {
		return fauxAssistantMessage([fauxText(`Noted: ${userText(note).split("\n")[0]}`)]);
	}
	const last = results.at(-1);
	if (last !== undefined) {
		const output = last.content.flatMap((part) => (part.type === "text" ? [part.text.trim()] : [])).join("\n");
		return fauxAssistantMessage([
			fauxThinking("The cells finished; summarizing the last one."),
			fauxText(
				`The \`${last.toolName}\` call ${last.isError ? "failed" : "finished"}. Its output:\n\n\`\`\`\n${output}\n\`\`\`\n\nThat is all the fake model does with the REPL.`,
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
