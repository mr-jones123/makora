// The question bank a cell hands to `quiz.publish`: its schema, which Durable checks as the `quiz_publish` tool's
// arguments, and the checks against the range's commits and diffs that a schema cannot express. The bank comes from
// the model, so this is the trust boundary of the quiz.
import { arr, int, map, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { DiffFile } from "../git/diff.ts";
import type { Commit } from "../git/log.ts";
import { coveredLines, diffRows, findLine, type Side } from "./diff-rows.ts";

/** What a question asks about. */
export const CATEGORIES = ["built", "decided", "why", "what-if"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Questions per quiz and options per question. */
export const QUESTION_COUNT = 10;
export const OPTION_COUNT = 4;

/** The longest annotation comment, in characters: room for about 4 sentences. */
export const COMMENT_MAX = 600;

const Text = str({ pattern: "\\S" });

const QuestionSchema = obj({
	question: Text,
	options: arr(Text, { minItems: OPTION_COUNT, maxItems: OPTION_COUNT }),
	correct: int({ minimum: 0, maximum: OPTION_COUNT - 1, description: "Index of the right option" }),
	explanation: Text,
	category: oneOf(CATEGORIES),
	cites: arr(Text, { minItems: 1, description: "Commit shas, doc paths, decision titles or annotated file:line" }),
});

const AnnotationSchema = obj({
	commit: Text,
	file: Text,
	line: int({ minimum: 1, description: "The line's number on `side`" }),
	side: oneOf(["new", "old"] as const),
	comment: str({ pattern: "\\S", maxLength: COMMENT_MAX }),
	cites: opt(arr(Text)),
});

/** The bank's schema: the range, a summary per commit by sha, the decisions, annotations of diff lines, the questions. */
export const BankSchema = obj({
	range: str({ pattern: "^[^-\\s]", description: "The git revision range the quiz covers, such as abc1234..HEAD" }),
	summaries: map(Text, { description: "A short summary of each commit of the range, by sha or a prefix of 7+" }),
	decisions: arr(obj({ title: Text, summary: Text })),
	annotations: arr(AnnotationSchema, { description: "Inline comments on lines of the commits' diffs" }),
	questions: arr(QuestionSchema, { minItems: QUESTION_COUNT, maxItems: QUESTION_COUNT }),
});

/** A bank that passed the schema. */
export type QuizBank = Static<typeof BankSchema>;
/** One question; `correct` indexes `options`. */
export type Question = QuizBank["questions"][number];
/** A decision the page lists: a title and one line. */
export type Decision = QuizBank["decisions"][number];

/** A source a question or note cites: a commit of the range, a decision, a note, or anything else (a doc path). */
export type Cite =
	| { readonly kind: "commit"; readonly text: string; readonly sha: string }
	| { readonly kind: "decision"; readonly text: string; readonly index: number }
	| { readonly kind: "note"; readonly text: string; readonly index: number }
	| { readonly kind: "source"; readonly text: string };

/** A commit of the range with the bank's summary of it. */
export type SummarizedCommit = Commit & { readonly summary: string };

/** A question whose cites are resolved against the range, the decisions and the notes. */
export type CitedQuestion = Omit<Question, "cites"> & { readonly cites: readonly Cite[] };

/** An annotation placed on a line of a commit's diff: `path` is the file's path in that diff. */
export type Note = {
	readonly sha: string;
	readonly path: string;
	readonly side: Side;
	readonly line: number;
	readonly comment: string;
	readonly cites: readonly Cite[];
};

/** A bank checked against its range: everything the page shows except the diffs. */
export type QuizContent = {
	readonly range: string;
	/** Oldest first. */
	readonly commits: readonly SummarizedCommit[];
	readonly decisions: readonly Decision[];
	/** In the bank's order; a `note` cite indexes this list. */
	readonly notes: readonly Note[];
	readonly questions: readonly CitedQuestion[];
};

/** The content, or every problem found, each starting with the path of the field it is about. */
export type Resolved =
	| { readonly kind: "ok"; readonly value: QuizContent }
	| { readonly kind: "invalid"; readonly errors: string[] };

const SHA = /^[0-9a-f]{7,40}$/i;
const FILE_LINE = /^(.+):(\d+)$/;

/**
 * Check `bank` against `commits`, the commits of its range oldest first, and `files`, each commit's diff by full sha:
 * the range has commits, each has a summary, every summary and cited sha names exactly one of them, every annotation
 * names a line of its commit's diff on its side, and no question repeats an option. A cite equal to a decision's title
 * (ignoring case) links to that decision, and one of the form `file:line` to the annotation there.
 */
export function resolveBank(
	bank: QuizBank,
	commits: readonly Commit[],
	files: ReadonlyMap<string, readonly DiffFile[]>,
): Resolved {
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
	const located = bank.annotations.map((annotation, index) => {
		const path = `annotations[${index}]`;
		const commit = find(annotation.commit, `${path}.commit`);
		if (commit === undefined) return undefined;
		const short = commit.sha.slice(0, 9);
		const file = files
			.get(commit.sha)
			?.find((each) => each.path === annotation.file || each.oldPath === annotation.file);
		if (file === undefined) return void errors.push(`${path}.file: ${annotation.file} is not in ${short}'s diff`);
		const rows = diffRows(file);
		if (rows.length === 0) return void errors.push(`${path}.file: ${annotation.file} has no text diff in ${short}`);
		if (findLine(rows, annotation.side, annotation.line) < 0) {
			const covered = coveredLines(rows, annotation.side);
			return void errors.push(
				`${path}.line: ${annotation.file} has no ${annotation.side} line ${annotation.line} in ${short}'s diff; its ${annotation.side} lines there are ${covered}`,
			);
		}
		return { ...annotation, sha: commit.sha, path: file.path };
	});
	const titles = bank.decisions.map((decision) => decision.title.trim().toLowerCase());
	const cite = (text: string, path: string): Cite => {
		const decision = titles.indexOf(text.trim().toLowerCase());
		if (decision >= 0) return { kind: "decision", text, index: decision };
		const fileLine = text.match(FILE_LINE);
		if (fileLine !== null) {
			const [, file, line] = fileLine;
			const notes = bank.annotations.flatMap((annotation, index) =>
				(annotation.file === file || located[index]?.path === file) && annotation.line === Number(line)
					? [index]
					: [],
			);
			// An annotation that was not placed has its own error; the cite adds none.
			if (notes.length === 1 && located[notes[0]!] === undefined) return { kind: "source", text };
			if (notes.length === 1) return { kind: "note", text, index: notes[0]! };
			errors.push(
				notes.length === 0
					? `${path}: no annotation at ${text}`
					: `${path}: ${text} names ${notes.length} annotations; cite the commit instead`,
			);
			return { kind: "source", text };
		}
		if (!SHA.test(text)) return { kind: "source", text };
		const commit = find(text, path);
		return commit === undefined ? { kind: "source", text } : { kind: "commit", text, sha: commit.sha };
	};
	// A `note` cite indexes `located`; when every annotation was placed, that is also its index in `notes`, and when one
	// was not, the bank is refused below anyway.
	const notes = located.flatMap((note, index): Note[] =>
		note === undefined
			? []
			: [
					{
						sha: note.sha,
						path: note.path,
						side: note.side,
						line: note.line,
						comment: note.comment.trim(),
						cites: (note.cites ?? []).map((each, at) => cite(each, `annotations[${index}].cites[${at}]`)),
					},
				],
	);
	const questions = bank.questions.map((question, index) => {
		const options = new Set(question.options.map((option) => option.trim().toLowerCase()));
		if (options.size !== question.options.length)
			errors.push(`questions[${index}].options: two options are the same`);
		return { ...question, cites: question.cites.map((each, at) => cite(each, `questions[${index}].cites[${at}]`)) };
	});
	if (errors.length > 0) return { kind: "invalid", errors };
	return {
		kind: "ok",
		value: { range: bank.range, commits: summarized, decisions: bank.decisions, notes, questions },
	};
}
