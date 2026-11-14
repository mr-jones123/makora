// Makora's model collection: every built-in provider, plus in fake mode (`--fake`, `MAKORA_FAKE=1`) a scripted faux
// provider for demos and tests that answers with markdown and runs one slow `bash` call on prompts mentioning "tool".
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
	const last = messages.findLast((message) => message.role !== "system");
	if (last?.role === "toolResult") {
		const output = last.content.flatMap((part) => (part.type === "text" ? [part.text.trim()] : [])).join("\n");
		return fauxAssistantMessage([
			fauxThinking("The command finished; summarizing its output."),
			fauxText(
				`The \`${last.toolName}\` call ${last.isError ? "failed" : "finished"}. Its output:\n\n\`\`\`\n${output}\n\`\`\`\n\nThat is all the fake model does with tools.`,
			),
		]);
	}
	const text = last?.role === "user" ? userText(last) : "";
	if (text.includes("tool")) {
		return fauxAssistantMessage(
			[
				fauxThinking("The user asked for a tool call; running a short shell command."),
				fauxText("Running a shell command."),
				fauxToolCall("bash", { command: "echo hello; sleep 2" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage([
		fauxThinking("Answering from the fake script."),
		fauxText(
			`## Fake answer\n\nYou wrote: **${text}**\n\n- This is makora's fake model; no provider was called.\n- Mention \`tool\` in a prompt to see a \`bash\` call.`,
		),
	]);
}

function userText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
