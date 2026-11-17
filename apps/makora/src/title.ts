// A session's name: the first line of its first input, and then the model's few-word name for what the session is
// about, from the same first input. One small call per session, and any failure leaves the first line in place.
import { type Api, contentText, type Message, type Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";

/** The longest a session's title gets, in characters. */
export const TITLE_LENGTH = 80;

// Enough for six words and the end of the reply.
const TITLE_TOKENS = 32;

// A first message may be a pasted file or a long plan; a name comes from its opening.
const MESSAGE_CHARS = 4_000;

const NAME_PROMPT =
	"You name a coding session from the user's first message. Reply with at most six words, in Title Case, saying " +
	"what the session is about. No quotes, no period at the end, no preamble.";

/**
 * The title `text` makes on its own: its first non-empty line, without the quotes, marks and trailing punctuation
 * a message tends to open with, cut to `TITLE_LENGTH`. Undefined when it has no word.
 */
export function titleOf(text: string): string | undefined {
	const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
	const bare = line
		.trim()
		.replace(/^[`'"*_#>\s]+/, "")
		.replace(/[`'"*_\s]+$/, "")
		.replace(/[.:;,]+$/, "")
		.trim();
	if (bare === "") return undefined;
	const title = bare.replace(/\s+/g, " ").slice(0, TITLE_LENGTH).trim();
	return title === "" ? undefined : title;
}

/**
 * Ask `model` to name a session from its first message `first`, and return the name, or undefined when the call
 * fails or the answer holds no word. Throws only what the provider throws.
 */
export async function nameSession(
	models: MutableModels,
	model: Model<Api>,
	first: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const now = Date.now();
	const messages: Message[] = [
		{ role: "system", content: NAME_PROMPT, timestamp: now },
		{ role: "user", content: [{ type: "text", text: first.slice(0, MESSAGE_CHARS) }], timestamp: now },
	];
	const message = await models.completeSimple(
		model,
		{ messages },
		{ cacheRetention: "none", maxTokens: TITLE_TOKENS, ...(signal === undefined ? {} : { signal }) },
	);
	return titleOf(contentText(message.content));
}
