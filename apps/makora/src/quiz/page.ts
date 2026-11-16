// The quiz page: the data it shows (the checked bank, each question's options shuffled, the commits' diffs capped per
// file with the annotated lines kept and their notes placed) and the self-contained HTML file made from the app's
// template with that data embedded.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DiffFile, FileStatus } from "../git/diff.ts";
import type { CitedQuestion, Decision, Note, QuizContent, SummarizedCommit } from "./bank.ts";
import { type DiffRow, diffRows, findLine } from "./diff-rows.ts";

/** A row of a file on the page: a diff row, or a run of rows left out between two shown ones. */
export type PageRow = DiffRow | { readonly kind: "gap"; readonly hidden: number };

/** A note placed on the page: `row` indexes its file's `rows`, `index` is its place in the bank's annotations. */
export type PageNote = Omit<Note, "sha" | "path"> & { readonly index: number; readonly row: number };

/**
 * One file of a commit as the page shows it: its first rows up to a cap, plus the rows around each annotated line past
 * it, with gaps where rows are left out.
 */
export type PageFile = {
	readonly path: string;
	readonly oldPath?: string;
	readonly status: FileStatus;
	readonly added: number;
	readonly removed: number;
	readonly rows: readonly PageRow[];
	/** Rows after the last shown one. */
	readonly more: number;
	/** Why the file has no rows: a binary file, or a diff git did not produce. */
	readonly reason?: string;
	readonly notes: readonly PageNote[];
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

/** Diff rows shown per file before the notes' rows; the rest are counted. */
export const FILE_LINE_CAP = 300;

/** Rows shown before and after an annotated line that the cap would hide. */
export const NOTE_CONTEXT = 12;

/**
 * The page for `content`: diffs capped per file, each note on its line (which is shown even past the cap), and each
 * question's options in a fresh random order.
 */
export function buildPage(content: QuizContent, sources: PageSources): QuizPage {
	const notes = content.notes.map((note, index) => ({ ...note, index }));
	return {
		project: sources.project,
		range: content.range,
		createdAt: sources.createdAt,
		commits: content.commits.map((commit) => ({
			...commit,
			files: (sources.files.get(commit.sha) ?? []).map((file) =>
				pageFile(
					file,
					notes.filter((note) => note.sha === commit.sha && note.path === file.path),
				),
			),
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

// Notes come from `resolveBank`, which refused any note whose line is not in the file's diff.
function pageFile(file: DiffFile, notes: readonly (Note & { readonly index: number })[]): PageFile {
	const base = {
		path: file.path,
		...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
		status: file.status,
		added: file.added,
		removed: file.removed,
	};
	if (file.body.kind === "binary") return { ...base, rows: [], more: 0, reason: "binary file", notes: [] };
	if (file.body.kind === "omitted") return { ...base, rows: [], more: 0, reason: file.body.reason, notes: [] };
	const all = diffRows(file);
	const targets = notes.map((note) => findLine(all, note.side, note.line));
	const shown = new Set(Array.from({ length: Math.min(all.length, FILE_LINE_CAP) }, (_, at) => at));
	for (const target of targets) {
		for (let at = Math.max(0, target - NOTE_CONTEXT); at <= Math.min(all.length - 1, target + NOTE_CONTEXT); at++) {
			shown.add(at);
		}
	}
	const rows: PageRow[] = [];
	const placed = new Map<number, number>();
	let previous = -1;
	for (const at of [...shown].sort((a, b) => a - b)) {
		if (at > previous + 1) rows.push({ kind: "gap", hidden: at - previous - 1 });
		placed.set(at, rows.length);
		rows.push(all[at]!);
		previous = at;
	}
	return {
		...base,
		rows,
		more: all.length - 1 - previous,
		notes: notes.map(({ sha: _, path: __, ...note }, at) => ({ ...note, row: placed.get(targets[at]!)! })),
	};
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
