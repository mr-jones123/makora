// The question bank a cell hands to `quiz.publish`: its schema, which Durable checks as the `quiz_publish` tool's
// arguments, and the checks against the range's commits that a schema cannot express. The bank comes from the model,
// so this is the trust boundary of the quiz.
import { arr, int, map, obj, oneOf, type Static, str } from "@earendil-works/pi-schema";
import type { Commit } from "../git/log.ts";

/** What a question asks about. */
export const CATEGORIES = ["built", "decided", "why", "what-if"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Questions per quiz and options per question. */
export const QUESTION_COUNT = 10;
export const OPTION_COUNT = 4;

const Text = str({ pattern: "\\S" });

const QuestionSchema = obj({
	question: Text,
	options: arr(Text, { minItems: OPTION_COUNT, maxItems: OPTION_COUNT }),
	correct: int({ minimum: 0, maximum: OPTION_COUNT - 1, description: "Index of the right option" }),
	explanation: Text,
	category: oneOf(CATEGORIES),
	cites: arr(Text, { minItems: 1, description: "Commit shas, doc paths or decision titles" }),
});

/** The bank's schema: the commit range, a summary per commit by sha, the decisions, and the questions. */
export const BankSchema = obj({
	range: str({ pattern: "^[^-\\s]", description: "The git revision range the quiz covers, such as abc1234..HEAD" }),
	summaries: map(Text, { description: "A short summary of each commit of the range, by sha or a prefix of 7+" }),
	decisions: arr(obj({ title: Text, summary: Text })),
	questions: arr(QuestionSchema, { minItems: QUESTION_COUNT, maxItems: QUESTION_COUNT }),
});

/** A bank that passed the schema. */
export type QuizBank = Static<typeof BankSchema>;
/** One question; `correct` indexes `options`. */
export type Question = QuizBank["questions"][number];
/** A decision the page lists: a title and one line. */
export type Decision = QuizBank["decisions"][number];

/** A source a question cites: a commit of the range, a decision of the bank, or anything else (a doc path). */
export type Cite =
	| { readonly kind: "commit"; readonly text: string; readonly sha: string }
	| { readonly kind: "decision"; readonly text: string; readonly index: number }
	| { readonly kind: "source"; readonly text: string };

/** A commit of the range with the bank's summary of it. */
export type SummarizedCommit = Commit & { readonly summary: string };

/** A question whose cites are resolved against the range and the decisions. */
export type CitedQuestion = Omit<Question, "cites"> & { readonly cites: readonly Cite[] };

/** A bank checked against the commits of its range: everything the page shows except the diffs. */
export type QuizContent = {
	readonly range: string;
	/** Oldest first. */
	readonly commits: readonly SummarizedCommit[];
	readonly decisions: readonly Decision[];
	readonly questions: readonly CitedQuestion[];
};

/** The content, or every problem found, each starting with the path of the field it is about. */
export type Resolved =
	| { readonly kind: "ok"; readonly value: QuizContent }
	| { readonly kind: "invalid"; readonly errors: string[] };

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Check `bank` against `commits`, the commits of its range, oldest first: the range has commits, each has a summary,
 * every summary and every cited sha names exactly one of them, and no question repeats an option. A cite equal to a
 * decision's title (ignoring case) links to that decision.
 */
export function resolveBank(bank: QuizBank, commits: readonly Commit[]): Resolved {
	const errors: string[] = [];
	if (commits.length === 0) errors.push(`range: ${bank.range} has no commits`);
	const find = (sha: string, path: string): Commit | undefined => {
		const prefix = sha.toLowerCase();
		const matches = SHA.test(sha) ? commits.filter((commit) => commit.sha.startsWith(prefix)) : [];
		if (matches.length === 1) return matches[0];
		errors.push(
			matches.length === 0
				? `${path}: ${sha} is not a commit of ${bank.range}`
				: `${path}: ${sha} matches ${matches.length} commits of ${bank.range}; use more digits`,
		);
		return undefined;
	};
	const summaries = new Map<string, string>();
	for (const [sha, summary] of Object.entries(bank.summaries)) {
		const commit = find(sha, `summaries.${sha}`);
		if (commit !== undefined) summaries.set(commit.sha, summary.trim());
	}
	const summarized = commits.flatMap((commit) => {
		const summary = summaries.get(commit.sha);
		if (summary !== undefined) return [{ ...commit, summary }];
		errors.push(`summaries: no summary for ${commit.sha.slice(0, 9)} (${commit.subject})`);
		return [];
	});
	const titles = bank.decisions.map((decision) => decision.title.trim().toLowerCase());
	const questions = bank.questions.map((question, index) => {
		const options = new Set(question.options.map((option) => option.trim().toLowerCase()));
		if (options.size !== question.options.length)
			errors.push(`questions[${index}].options: two options are the same`);
		const cites = question.cites.map((cite, at): Cite => {
			const decision = titles.indexOf(cite.trim().toLowerCase());
			if (decision >= 0) return { kind: "decision", text: cite, index: decision };
			if (!SHA.test(cite)) return { kind: "source", text: cite };
			const commit = find(cite, `questions[${index}].cites[${at}]`);
			return commit === undefined ? { kind: "source", text: cite } : { kind: "commit", text: cite, sha: commit.sha };
		});
		return { ...question, cites };
	});
	if (errors.length > 0) return { kind: "invalid", errors };
	return { kind: "ok", value: { range: bank.range, commits: summarized, decisions: bank.decisions, questions } };
}
