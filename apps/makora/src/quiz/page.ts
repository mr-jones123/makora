// The quiz page: the data it shows (the checked bank, each question's options shuffled, the commits' diffs capped per
// file) and the self-contained HTML file made from the app's template with that data embedded.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DiffFile, FileStatus } from "../git/diff.ts";
import type { CitedQuestion, Decision, QuizContent, SummarizedCommit } from "./bank.ts";

/** One file of a commit as the page shows it: diff lines with their `+`, `-`, ` ` or `@@` prefix, at most a cap. */
export type PageFile = {
	readonly path: string;
	readonly oldPath?: string;
	readonly status: FileStatus;
	readonly added: number;
	readonly removed: number;
	readonly lines: readonly string[];
	/** Diff lines past the cap, not shown. */
	readonly more: number;
	/** Why the file has no lines: a binary file, or a diff git did not produce. */
	readonly note?: string;
};

/** A commit of the page with its files. */
export type PageCommit = SummarizedCommit & { readonly files: readonly PageFile[] };

/** Everything the page shows; embedded as JSON and drawn by the template's script. */
export type QuizPage = {
	readonly project: string;
	readonly range: string;
	/** When makora made the page, epoch milliseconds. */
	readonly createdAt: number;
	readonly commits: readonly PageCommit[];
	readonly decisions: readonly Decision[];
	/** Options in the order makora shuffled them; `correct` indexes that order. */
	readonly questions: readonly CitedQuestion[];
};

/** What the page is made of besides the checked bank. */
export type PageSources = {
	readonly project: string;
	readonly createdAt: number;
	/** Each commit's files by full sha. */
	readonly files: ReadonlyMap<string, readonly DiffFile[]>;
	/** Uniform in [0, 1), as `Math.random`. */
	readonly random: () => number;
};

/** Diff lines shown per file; the rest are counted. */
export const FILE_LINE_CAP = 300;

/** The page for `content`: diffs capped per file, and each question's options in a fresh random order. */
export function buildPage(content: QuizContent, sources: PageSources): QuizPage {
	return {
		project: sources.project,
		range: content.range,
		createdAt: sources.createdAt,
		commits: content.commits.map((commit) => ({
			...commit,
			files: (sources.files.get(commit.sha) ?? []).map(pageFile),
		})),
		decisions: content.decisions,
		questions: content.questions.map((question) => shuffleOptions(question, sources.random)),
	};
}

/** `question` with its options permuted (Fisher-Yates over `random`) and `correct` following the right option. */
export function shuffleOptions<Q extends { readonly options: readonly string[]; readonly correct: number }>(
	question: Q,
	random: () => number,
): Q {
	const order = question.options.map((_, index) => index);
	for (let index = order.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[order[index], order[other]] = [order[other]!, order[index]!];
	}
	return {
		...question,
		options: order.map((from) => question.options[from]!),
		correct: order.indexOf(question.correct),
	};
}

function pageFile(file: DiffFile): PageFile {
	const base = {
		path: file.path,
		...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
		status: file.status,
		added: file.added,
		removed: file.removed,
	};
	if (file.body.kind === "binary") return { ...base, lines: [], more: 0, note: "binary file" };
	if (file.body.kind === "omitted") return { ...base, lines: [], more: 0, note: file.body.reason };
	const lines = file.body.hunks.flatMap((hunk) => [
		hunk.header,
		...hunk.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`),
	]);
	return { ...base, lines: lines.slice(0, FILE_LINE_CAP), more: Math.max(0, lines.length - FILE_LINE_CAP) };
}

const TEMPLATE = fileURLToPath(new URL("../../assets/quiz/template.html", import.meta.url));
const DATA_SLOT = "__MAKORA_QUIZ_DATA__";

/** The self-contained HTML of `page`: the app's template with the page's data in its JSON script. */
export function renderPage(page: QuizPage): string {
	const template = readFileSync(TEMPLATE, "utf8");
	// A function replacement: `$&` or `$1` in the data must stay literal.
	return template.replace(DATA_SLOT, () => scriptJson(page));
}

/**
 * `value` as JSON that cannot end or comment out the `<script>` element holding it: `<`, `>` and `&` become `\u`
 * escapes, which JSON.parse reads back as the same characters. U+2028 and U+2029 too, for older parsers.
 */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[<>&\u2028\u2029]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
