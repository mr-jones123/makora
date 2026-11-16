// The `quiz_publish` tool behind `await quiz.publish(bank)` in a cell: checks the bank against the git range it names
// and that range's diffs, renders the quiz page with makora's template, saves it under the makora home, and opens it.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, int, obj, str } from "@earendil-works/pi-schema";
import type { DiffFile } from "../git/diff.ts";
import { commitFiles, type Repo, rangeCommits } from "../git/repo.ts";
import { tildify } from "../paths.ts";
import { findRepo } from "../worktrees.ts";
import { BankSchema, resolveBank } from "./bank.ts";
import { buildPage, renderPage } from "./page.ts";

/** Where quizzes go and how they reach the user. */
export type QuizOptions = {
	/** `<home>/quizzes`. */
	readonly quizzes: string;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
	/** Open the saved page in a browser; resolves whether that started. */
	readonly open: (path: string) => Promise<boolean>;
	/** Tell the user something about the session. */
	readonly inform: (message: string) => void;
};

const QuizParameters = obj({ bank: BankSchema });
const QuizOutput = obj({ path: str(), range: str(), commits: int(), opened: bool() });

/** Commits a page takes at most; a wider range is refused rather than rendered unreadably long. */
export const MAX_COMMITS = 200;

/** The `quiz_publish` tool for one session, callable from cells only. */
export function createQuizTool(options: QuizOptions): ToolRegistration<typeof QuizParameters> {
	return defineTool({
		name: "quiz_publish",
		description: "Check a session-quiz question bank, render it as a self-contained HTML page and open it.",
		parameters: QuizParameters,
		structuredOutputSchema: QuizOutput,
		callers: ["tools"],
		async execute({ bank }, api, context) {
			const cwd = (await api.agent(context)).cwd ?? options.defaultCwd;
			const place = await findRepo(cwd);
			if (place === undefined) throw new Error(`quiz.publish needs a git repository; ${cwd} is not in one`);
			const repo: Repo = { root: place.top, name: place.name };
			const commits = await rangeCommits(repo, bank.range).catch((error: unknown) => {
				throw new Error(`range: git cannot read ${bank.range}: ${gitMessage(error)}`);
			});
			if (commits.length > MAX_COMMITS) {
				throw new Error(`range: ${bank.range} has ${commits.length} commits; a quiz takes at most ${MAX_COMMITS}`);
			}
			const files = new Map<string, readonly DiffFile[]>();
			for (const commit of commits) files.set(commit.sha, await commitFiles(repo, commit.sha));
			const resolved = resolveBank(bank, commits, files);
			if (resolved.kind === "invalid") {
				const list = resolved.errors.map((error) => `- ${error}`).join("\n");
				throw new Error(`The bank has ${resolved.errors.length} problem(s); fix them and publish again:\n${list}`);
			}
			const createdAt = api.now();
			const page = buildPage(resolved.value, { project: place.name, createdAt, files, random: Math.random });
			const path = save(join(options.quizzes, place.dir), new Date(createdAt), renderPage(page));
			const opened = await options.open(path);
			const where = opened ? "opened in browser" : "open it in a browser";
			options.inform(`Quiz saved · ${tildify(path)} · ${where} · ${bank.range}, ${commits.length} commit(s)`);
			return {
				output: [{ type: "text" as const, text: `Saved the quiz to ${path}${opened ? " and opened it" : ""}.` }],
				structuredOutput: { path, range: bank.range, commits: commits.length, opened },
			};
		},
	});
}

// `<YYYY-MM-DD>-<n>.html` with the first free `n` of that day; the exclusive write keeps two quizzes of one day apart.
function save(dir: string, now: Date, html: string): string {
	mkdirSync(dir, { recursive: true });
	const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
	const taken = readdirSync(dir).flatMap((name) => {
		const n = name.match(new RegExp(`^${day}-(\\d+)\\.html$`))?.[1];
		return n === undefined ? [] : [Number(n)];
	});
	for (let n = Math.max(0, ...taken) + 1; ; n++) {
		const path = join(dir, `${day}-${n}.html`);
		try {
			writeFileSync(path, html, { flag: "wx" });
			return path;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
}

// execFile's error carries git's stderr; its first line says what git could not read.
function gitMessage(error: unknown): string {
	const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
	return typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0]! : String(error);
}
