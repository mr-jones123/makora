// The dream's two model calls: the analyzer, once per slice of a session, and the organizer, once per dream. Their
// prompts, the shape of the analyzer's reply, and the text each is shown.
import { arr, compile, int, lit, obj, type Static, str, union } from "@earendil-works/pi-schema";
import type { ClaimRow } from "./store.ts";

/** Recorded on every claim version a dream writes, so a bad prompt's output can be found and redone. */
export const PROMPT_VERSION = "memory-1";

const Evidence = obj({
	episode: int(),
	quote: str({ minLength: 1 }),
	polarity: union([lit("supports"), lit("contradicts"), lit("mentions")]),
});

/** The analyzer's reply. */
export const AnalyzerReply = obj({
	notes: arr(
		obj({
			subject: str({ minLength: 1 }),
			kind: union([lit("fact"), lit("decision"), lit("preference")]),
			scope: union([lit("project"), lit("global")]),
			statement: str({ minLength: 1 }),
			evidence: arr(Evidence),
		}),
	),
});

export type AnalyzerReply = Static<typeof AnalyzerReply>;

/** The analyzer's reply checked against its schema; model output, the dream's trust boundary. */
export const analyzerReply = compile(AnalyzerReply);

// General guidance and the model's judgment of what matters, not fixed rules: in Anthropic's memory tests, a rule such
// as "record only failures" cost the strongest models most of what memory gained them.
export const ANALYZER_PROMPT = `You read one part of a coding session between a user and an AI agent. Each episode is numbered, as [E123 role].

Write down what a later session in this project would otherwise have to find out again: how the code behaves, what was decided and why, what was tried and failed, and what the user prefers. Leave out what the code or git history already say plainly, and what only mattered inside this session.

Each note is one sentence a stranger understands. Give it a subject: a short title for what a wiki page about it would be called, such as "Session titles" or "Kernel snapshots". Mark its scope: "project" for this repository, "global" for the user in every project. Quote the episodes that show it, word for word, with the episode number. A note no episode shows is not a note.

Few lasting notes beat many passing ones.

Reply with one JSON object and nothing else:
{"notes": [{"subject": "...", "kind": "fact" | "decision" | "preference", "scope": "project" | "global", "statement": "...", "evidence": [{"episode": 123, "quote": "...", "polarity": "supports" | "contradicts" | "mentions"}]}]}`;

export const ORGANIZER_PROMPT = `You keep a project's memory: claims, each with an id, grouped under subjects. You get the claims memory holds now and new notes taken from recent sessions, each note with quotes from the transcripts.

Turn the notes into operations on memory:
- "create" a claim for something new. Give it a "ref" such as "n1" that other operations can name.
- "confirm" an existing claim a note shows again, instead of creating a duplicate.
- "revise" an existing claim whose wording a note corrects or sharpens.
- "supersede" an existing claim that is no longer true, "by" the claim (id or ref) that replaces it, so its history stays.
- "dispute" two claims that disagree when the transcripts do not settle which holds, with the "reason".
- "link" two claims that explain each other, with a short "relation" such as "caused by" or "part of".
- "retitle" a subject, by its key, when a better title is clear.

Every create, revise and confirm carries evidence: copy the quotes and episode numbers from the notes word for word. Reuse the subject titles memory already has when a claim belongs under one. Standards and procedures belong in AGENTS.md, which the user writes: do not make claims of them; list lines you would suggest for it in "agentsMd".

"report" says in a few sentences what changed and why.

Reply with one JSON object and nothing else:
{"ops": [{"op": "create", "ref": "n1", "subject": "...", "kind": "fact" | "decision" | "preference", "scope": "project" | "global", "statement": "...", "evidence": [{"episode": 123, "quote": "...", "polarity": "supports"}]}, {"op": "confirm", "claim": 7, "evidence": [...]}, {"op": "revise", "claim": 7, "statement": "...", "evidence": [...]}, {"op": "supersede", "claim": 7, "by": "n1"}, {"op": "dispute", "claim": 7, "other": 9, "reason": "..."}, {"op": "link", "from": 7, "to": "n1", "relation": "..."}, {"op": "retitle", "subject": "session-titles", "title": "..."}], "report": "...", "agentsMd": ["..."]}`;

/** One episode as the analyzer reads it. */
export interface PromptEpisode {
	readonly id: number;
	readonly role: string;
	readonly text: string;
}

// A slice of a session the analyzer reads in one call: about 30,000 tokens, so even a long session fits a cheap
// model's window in a few calls.
const SLICE_CHARS = 120_000;

/** `episodes` cut into slices the analyzer reads one call each, never splitting an episode. */
export function sliceEpisodes(episodes: readonly PromptEpisode[]): string[] {
	const slices: string[] = [];
	let current = "";
	for (const episode of episodes) {
		const text = `[E${episode.id} ${episode.role}]\n${episode.text}\n\n`;
		if (current !== "" && current.length + text.length > SLICE_CHARS) {
			slices.push(current);
			current = "";
		}
		current += text;
	}
	if (current !== "") slices.push(current);
	return slices;
}

/** The organizer's input: memory's claims, then the notes, as numbered lines it can refer to. */
export function organizerInput(project: string, claims: readonly ClaimRow[], notes: AnalyzerReply["notes"]): string {
	const held =
		claims.length === 0
			? "(none yet)"
			: claims
					.map(
						(claim) =>
							`#${claim.id} [${claim.status}, ${claim.kind}, ${claim.project === null ? "global" : "project"}] subject "${claim.subjectTitle}" (key ${claim.subjectKey}): ${claim.statement}`,
					)
					.join("\n");
	const taken = notes
		.map(
			(note, index) =>
				`note ${index + 1} [${note.kind}, ${note.scope}] subject "${note.subject}": ${note.statement}\n${note.evidence
					.map((each) => `  E${each.episode} ${each.polarity}: "${each.quote}"`)
					.join("\n")}`,
		)
		.join("\n\n");
	return `Project: ${project}\n\nClaims memory holds now:\n${held}\n\nNew notes:\n${taken || "(none)"}`;
}

/** The JSON object in a model's reply: a fenced block's, else the text from its first brace to its last. */
export function replyJson(text: string): unknown {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
	const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}
