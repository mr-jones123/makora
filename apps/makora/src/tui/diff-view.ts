// The full-screen diff view: tabs over the repository's changes and history, a file or commit list, and the diff, laid
// out as list + diff (A), one stacked column when narrow (B), or list + side-by-side diff (C).
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffFile, DiffLine } from "../git/diff.ts";
import {
	baseBranch,
	baseFiles,
	commitFiles,
	history,
	openRepo,
	type Repo,
	revert,
	stage,
	stagedFiles,
	unstage,
	unstagedFiles,
} from "../git/repo.ts";
import { hintLine, spread } from "./bars.ts";
import { askBlock } from "./diff-ask.ts";
import { type Doc, type DocRow, fileDoc, type LineStyle, rowTarget, stackedDoc } from "./diff-doc.ts";
import {
	type CommitEntry,
	type DiffAction,
	type DiffReady,
	type DiffState,
	type DiffTab,
	type FileArea,
	type FileEntry,
	fileKey,
	listEntries,
	OPENING,
	reduceDiff,
	type TabContent,
} from "./diff-state.ts";
import type { MakoraKeybinding } from "./keybindings.ts";
import { type Paint, theme } from "./theme.ts";

/** What the diff view needs from the TUI. */
export interface DiffHost {
	/** The terminal's rows; the view fills them. */
	rows(): number;
	/** Schedule a frame. */
	render(): void;
	/** Back to the main screen. */
	close(): void;
	/** Back to the main screen with `text` inserted into the editor. */
	ask(text: string): void;
	/** Ask the user to confirm `title`; `action` labels the confirming choice. */
	confirm(title: string, action: string): Promise<boolean>;
}

/** List and unified diff (A), every file stacked in one column (B), list and side-by-side diff (C). */
type Layout = "list" | "stacked" | "split";

const STACKED_BELOW = 100;
const SPLIT_FROM = 120;
/** Title, tab row, two rules and the hint row. */
const CHROME_ROWS = 5;

type DiffKey = Extract<MakoraKeybinding, `app.diff.${string}`>;

const DIFF_KEYS: readonly DiffKey[] = [
	"app.diff.close",
	"app.diff.up",
	"app.diff.down",
	"app.diff.focusDiff",
	"app.diff.focusList",
	"app.diff.pageUp",
	"app.diff.pageDown",
	"app.diff.nextHunk",
	"app.diff.previousHunk",
	"app.diff.nextTab",
	"app.diff.previousTab",
	"app.diff.stage",
	"app.diff.unstage",
	"app.diff.revert",
	"app.diff.split",
	"app.diff.ask",
];

/** What stage, unstage and revert do: the area they apply to, why not elsewhere, the change, and its confirmation. */
interface FileOperation {
	readonly area: FileArea;
	readonly refusal: string;
	run(repo: Repo, file: DiffFile): Promise<void>;
	done(file: DiffFile): string;
	confirm?(file: DiffFile): { readonly title: string; readonly action: string };
}

const FILE_OPERATIONS: Readonly<Record<"app.diff.stage" | "app.diff.unstage" | "app.diff.revert", FileOperation>> = {
	"app.diff.stage": {
		area: "unstaged",
		refusal: "Stage works on unstaged files (Working tree tab).",
		run: stage,
		done: (file) => `Staged ${file.path}`,
	},
	"app.diff.unstage": {
		area: "staged",
		refusal: "Unstage works on staged files.",
		run: unstage,
		done: (file) => `Unstaged ${file.path}`,
	},
	"app.diff.revert": {
		area: "unstaged",
		refusal: "Revert works on unstaged files (Working tree tab).",
		run: revert,
		done: (file) => `${file.status === "?" ? "Deleted" : "Reverted"} ${file.path}`,
		confirm: (file) =>
			file.status === "?"
				? { title: `Delete untracked ${file.path}?`, action: "Delete the file" }
				: { title: `Revert ${file.path}?`, action: "Discard its working-tree changes" },
	},
};

/** The diff view. `open` (re)loads it for a directory; it renders the whole screen. */
export class DiffView implements Component {
	/** PgUp and PgDn scroll the diff, not the main transcript. */
	readonly capturesViewportInput = true;
	readonly #host: DiffHost;
	#state: DiffState = OPENING;
	#repo: Repo | undefined;
	#cwd = "";
	/** Bumped by every tab load, so only the newest load's result lands. */
	#generation = 0;
	#width = 0;
	#height = 1;
	#memo: { readonly inputs: readonly unknown[]; readonly doc: Doc | undefined } | undefined;

	constructor(host: DiffHost) {
		this.#host = host;
	}

	/** Find the repository holding `cwd` and load the current tab. */
	open(cwd: string): void {
		this.#cwd = cwd;
		void this.#open(cwd).catch((error: unknown) => this.#dispatch({ type: "message", text: describe(error) }));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const id = DIFF_KEYS.find((key) => keys.matches(data, key));
		if (id === undefined) return;
		if (this.#state.kind !== "ready") {
			if (id === "app.diff.close") this.#host.close();
			return;
		}
		this.#dispatch({ type: "message", text: undefined });
		this.#act(id, this.#state);
		this.#showSelectedCommit();
	}

	render(width: number): string[] {
		this.#width = width;
		this.#height = Math.max(1, this.#host.rows() - CHROME_ROWS);
		const state = this.#state;
		const rule = theme.border("─".repeat(width));
		const body =
			state.kind === "ready"
				? this.#body(state, width)
				: [theme.muted(state.kind === "opening" ? "loading…" : `Not a git repository: ${this.#cwd}`)];
		const lines = [
			this.#title(state, width),
			state.kind === "ready" ? tabRow(state) : "",
			rule,
			...Array.from({ length: this.#height }, (_, index) => body[index] ?? ""),
			rule,
			this.#hint(state, width),
		];
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	async #open(cwd: string): Promise<void> {
		const repo = await openRepo(cwd);
		this.#repo = repo;
		if (repo === undefined) {
			this.#dispatch({ type: "notRepo" });
			return;
		}
		const base = await baseBranch(repo);
		const tabs: DiffTab[] = [
			{ kind: "working" },
			{ kind: "staged" },
			...(base === undefined ? [] : [{ kind: "base", base } as const]),
			{ kind: "history" },
		];
		this.#dispatch({ type: "opened", repo: repo.name, tabs });
		await this.#load();
	}

	async #load(): Promise<void> {
		const state = this.#state;
		const repo = this.#repo;
		if (state.kind !== "ready" || repo === undefined) return;
		const generation = ++this.#generation;
		let content: TabContent;
		try {
			content = await loadTab(repo, state.tabs[state.tab]!);
		} catch (error) {
			content = { kind: "failed", message: describe(error) };
		}
		if (generation !== this.#generation) return;
		this.#dispatch({ type: "loaded", tab: state.tab, content });
		this.#showSelectedCommit();
	}

	/** In History, load the selected commit's files unless they are shown or loading. */
	#showSelectedCommit(): void {
		const state = this.#state;
		const repo = this.#repo;
		if (state.kind !== "ready" || state.content.kind !== "history" || repo === undefined) return;
		const sha = state.content.entries[state.selected]?.commit.sha;
		if (sha === undefined || state.content.shown?.sha === sha) return;
		this.#dispatch({ type: "commitLoading", sha });
		commitFiles(repo, sha).then(
			(files) => {
				const now = this.#state;
				if (now.kind === "ready" && now.content.kind === "history" && now.content.shown?.sha === sha)
					this.#dispatch({ type: "commitLoaded", sha, files });
			},
			(error: unknown) => this.#dispatch({ type: "message", text: describe(error) }),
		);
	}

	#dispatch(action: DiffAction): void {
		this.#state = reduceDiff(this.#state, action);
		this.#host.render();
	}

	#act(id: DiffKey, state: DiffReady): void {
		const layout = layoutFor(this.#width, state.split);
		const doc = this.#doc(state, layout);
		const rows = doc?.rows.length ?? 0;
		const height = this.#height;
		switch (id) {
			case "app.diff.close":
				this.#host.close();
				break;
			case "app.diff.up":
			case "app.diff.down": {
				const delta = id === "app.diff.up" ? -1 : 1;
				const inList = paneOf(state, layout) === "list";
				this.#dispatch(inList ? { type: "select", delta } : { type: "moveCursor", delta, rows, height });
				break;
			}
			case "app.diff.focusDiff": {
				const row = doc?.rows[state.cursor];
				// B has no list to leave, so the key folds and unfolds the file under the cursor instead.
				if (layout !== "stacked" || state.content.kind !== "files")
					this.#dispatch({ type: "focus", focus: "diff" });
				else if (row?.kind === "file") this.#dispatch({ type: "toggleCollapsed", key: fileKey(row.entry) });
				break;
			}
			case "app.diff.focusList":
				this.#dispatch({ type: "focus", focus: "list" });
				break;
			case "app.diff.pageUp":
			case "app.diff.pageDown":
				this.#dispatch({ type: "page", delta: id === "app.diff.pageUp" ? -1 : 1, rows, height });
				break;
			case "app.diff.nextHunk":
			case "app.diff.previousHunk": {
				const stop = layout === "stacked" ? "file" : "hunk";
				const stops = (doc?.rows ?? []).flatMap((row, index) => (row.kind === stop ? [index] : []));
				this.#dispatch({ type: "jump", delta: id === "app.diff.nextHunk" ? 1 : -1, stops, rows, height });
				break;
			}
			case "app.diff.nextTab":
			case "app.diff.previousTab":
				this.#dispatch({ type: "switchTab", delta: id === "app.diff.nextTab" ? 1 : -1 });
				void this.#load();
				break;
			case "app.diff.stage":
			case "app.diff.unstage":
			case "app.diff.revert": {
				const entry =
					layout === "stacked" && state.content.kind === "files"
						? doc?.rows[state.cursor]?.entry
						: listEntries(state)[state.selected];
				void this.#change(FILE_OPERATIONS[id], entry);
				break;
			}
			case "app.diff.split":
				this.#dispatch(
					this.#width < SPLIT_FROM
						? { type: "message", text: `Side by side needs ${SPLIT_FROM} columns.` }
						: { type: "toggleSplit" },
				);
				break;
			case "app.diff.ask":
				this.#ask(state, doc?.rows[state.cursor]);
				break;
		}
	}

	/** Run `operation` on `entry` when it is in the operation's area, then reload the tab. */
	async #change(operation: FileOperation, entry: FileEntry | CommitEntry | undefined): Promise<void> {
		const repo = this.#repo;
		if (repo === undefined || entry?.kind !== "file" || entry.area !== operation.area) {
			this.#dispatch({ type: "message", text: operation.refusal });
			return;
		}
		const { file } = entry;
		const question = operation.confirm?.(file);
		if (question !== undefined && !(await this.#host.confirm(question.title, question.action))) return;
		try {
			await operation.run(repo, file);
			this.#dispatch({ type: "message", text: operation.done(file) });
		} catch (error) {
			this.#dispatch({ type: "message", text: describe(error) });
		}
		await this.#load();
	}

	#ask(state: DiffReady, row: DocRow | undefined): void {
		const target = row === undefined ? undefined : rowTarget(row);
		if (target === undefined) {
			this.#dispatch({ type: "message", text: "Move the cursor onto a diff line to ask about it." });
			return;
		}
		const tab = state.tabs[state.tab]!;
		const commit = state.content.kind === "history" ? state.content.shown?.sha : undefined;
		this.#host.ask(
			askBlock({
				path: target.entry.file.path,
				hunk: target.hunk,
				line: target.line,
				source: tab.kind === "working" && target.entry.area === "staged" ? "staged" : tabLabel(tab).toLowerCase(),
				...(commit === undefined ? {} : { commit }),
			}),
		);
	}

	/** The diff pane's rows, rebuilt only when what they show changed. */
	#doc(state: DiffReady, layout: Layout): Doc | undefined {
		const style: LineStyle = layout === "split" ? "split" : "unified";
		const inputs = [state.content, state.selected, state.collapsed, style, layout === "stacked"];
		const memo = this.#memo;
		if (memo?.inputs.every((input, index) => input === inputs[index])) return memo.doc;
		const doc = buildDoc(state, layout, style);
		this.#memo = { inputs, doc };
		return doc;
	}

	#title(state: DiffState, width: number): string {
		if (state.kind !== "ready") return theme.bold(theme.accent("Diff"));
		const left = `${theme.bold(theme.accent("Diff"))}${theme.muted(` · ${tabLabel(state.tabs[state.tab]!)} · ${state.repo}`)}`;
		const { content } = state;
		const files =
			content.kind === "files"
				? content.entries.map((entry) => entry.file)
				: content.kind === "history" && content.shown?.kind === "loaded"
					? content.shown.files.map((entry) => entry.file)
					: [];
		const added = files.reduce((sum, file) => sum + file.added, 0);
		const removed = files.reduce((sum, file) => sum + file.removed, 0);
		const right = `${theme.success(`+${added}`)} ${theme.error(`−${removed}`)}${theme.muted(` · ${files.length} ${files.length === 1 ? "file" : "files"}`)}`;
		return spread(left, right, width);
	}

	#hint(state: DiffState, width: number): string {
		if (state.kind === "ready" && state.message !== undefined) return theme.warning(state.message);
		const keys = getKeybindings();
		const first = (id: DiffKey) => keys.getKeys(id).slice(0, 1);
		if (state.kind !== "ready") return hintLine([[first("app.diff.close"), "back"]]);
		const stacked = layoutFor(width, state.split) === "stacked";
		// Back first: a narrow terminal truncates the row's end.
		return hintLine([
			[first("app.diff.close"), "back"],
			[[...first("app.diff.up"), ...first("app.diff.down")], "move"],
			[first("app.diff.focusDiff"), stacked && state.content.kind === "files" ? "fold" : "diff"],
			[stacked && state.content.kind === "files" ? [] : first("app.diff.focusList"), "list"],
			[[...first("app.diff.nextHunk"), ...first("app.diff.previousHunk")], stacked ? "file" : "hunk"],
			[first("app.diff.nextTab"), "tabs"],
			[first("app.diff.stage"), "stage"],
			[first("app.diff.unstage"), "unstage"],
			[first("app.diff.revert"), "revert"],
			[width >= SPLIT_FROM ? first("app.diff.split") : [], state.split ? "unified" : "side by side"],
			[first("app.diff.ask"), "ask"],
		]);
	}

	#body(state: DiffReady, width: number): string[] {
		const { content } = state;
		const height = this.#height;
		if (content.kind === "loading") return [theme.muted("loading…")];
		if (content.kind === "failed") return [theme.error(content.message)];
		const layout = layoutFor(width, state.split);
		const doc = this.#doc(state, layout);
		const focusDiff = paneOf(state, layout) === "diff";
		if (layout === "stacked")
			return focusDiff ? docLines(state, doc, width, height, true) : listLines(state, width, height, true);
		const listWidth =
			content.kind === "history"
				? Math.max(50, Math.min(80, Math.floor(width * 0.5)))
				: Math.max(28, Math.min(48, Math.floor(width * 0.3)));
		const diffWidth = Math.max(10, width - listWidth - 3);
		const left = listLines(state, listWidth, height, !focusDiff);
		const right = docLines(state, doc, diffWidth, height, focusDiff);
		return Array.from(
			{ length: height },
			(_, index) =>
				`${truncateToWidth(left[index] ?? "", listWidth, "…", true)} ${theme.border("│")} ${right[index] ?? ""}`,
		);
	}
}

/** The layout for `width`: B when narrow, C when side by side is on and fits, else A. */
function layoutFor(width: number, split: boolean): Layout {
	if (width < STACKED_BELOW) return "stacked";
	return split && width >= SPLIT_FROM ? "split" : "list";
}

/** The pane that up and down move in: B's file tabs have only the diff. */
function paneOf(state: DiffReady, layout: Layout): "list" | "diff" {
	return layout === "stacked" && state.content.kind === "files" ? "diff" : state.focus;
}

function buildDoc(state: DiffReady, layout: Layout, style: LineStyle): Doc | undefined {
	const { content } = state;
	if (content.kind === "files") {
		if (layout === "stacked") return stackedDoc(content.entries, state.collapsed, style);
		const entry = content.entries[state.selected];
		return entry === undefined ? undefined : fileDoc(entry, style);
	}
	if (content.kind !== "history" || content.shown?.kind !== "loaded") return undefined;
	if (content.shown.sha !== content.entries[state.selected]?.commit.sha) return undefined;
	return stackedDoc(content.shown.files, state.collapsed, style);
}

async function loadTab(repo: Repo, tab: DiffTab): Promise<TabContent> {
	const entries = (files: readonly DiffFile[], area: FileArea): FileEntry[] =>
		files.map((file) => ({ kind: "file", file, area }));
	switch (tab.kind) {
		case "working": {
			const [unstaged, staged] = await Promise.all([unstagedFiles(repo), stagedFiles(repo)]);
			return { kind: "files", entries: [...entries(unstaged, "unstaged"), ...entries(staged, "staged")] };
		}
		case "staged":
			return { kind: "files", entries: entries(await stagedFiles(repo), "staged") };
		case "base":
			return { kind: "files", entries: entries(await baseFiles(repo, tab.base), "readonly") };
		case "history":
			return {
				kind: "history",
				entries: (await history(repo)).map((commit) => ({ kind: "commit", commit })),
				shown: undefined,
			};
	}
}

function tabLabel(tab: DiffTab): string {
	switch (tab.kind) {
		case "working":
			return "Working tree";
		case "staged":
			return "Staged";
		case "base":
			return `vs ${tab.base}`;
		case "history":
			return "History";
	}
}

function tabRow(state: DiffReady): string {
	return state.tabs
		.map((tab, index) =>
			index === state.tab
				? theme.band(theme.bold(theme.accent(` ${tabLabel(tab)} `)))
				: theme.muted(` ${tabLabel(tab)} `),
		)
		.join(" ");
}

/** A list row: the selection bar and band, or an indent. */
function selectable(text: string, selected: boolean, focused: boolean, width: number): string {
	if (!selected) return ` ${text}`;
	const fitted = truncateToWidth(text, width - 1, "…", true);
	return `${theme.accent("▌")}${focused ? theme.band(fitted) : fitted}`;
}

/** The list pane: files (with CHANGES and STAGED sections in the Working tree tab) or commits. */
function listLines(state: DiffReady, width: number, height: number, focused: boolean): string[] {
	const entries = listEntries(state);
	if (entries.length === 0) return [theme.muted(state.content.kind === "history" ? " no commits" : " no changes")];
	const sections = state.tabs[state.tab]!.kind === "working";
	const rows: { readonly text: string; readonly entry?: number }[] = [];
	const now = Date.now();
	entries.forEach((entry, index) => {
		const previous = entries[index - 1];
		if (sections && entry.kind === "file" && (previous?.kind !== "file" || previous.area !== entry.area))
			rows.push({ text: ` ${theme.dim(entry.area === "staged" ? "STAGED" : "CHANGES")}` });
		const text = entry.kind === "file" ? fileRow(entry, width - 1) : commitRow(entry, width - 1, now);
		rows.push({ text, entry: index });
	});
	const at = rows.findIndex((row) => row.entry === state.selected);
	const top = Math.max(0, Math.min(at - Math.floor(height / 2), rows.length - height));
	return rows
		.slice(top, top + height)
		.map((row) =>
			row.entry === undefined ? row.text : selectable(row.text, row.entry === state.selected, focused, width),
		);
}

const STATUS_PAINT: Readonly<Record<DiffFile["status"], Paint>> = {
	M: theme.warning,
	A: theme.success,
	D: theme.error,
	R: theme.accent,
	"?": theme.muted,
};

function fileRow(entry: FileEntry, width: number): string {
	const { file } = entry;
	const counts = file.body.kind === "binary" ? theme.muted("bin") : changeCounts(file.added, file.removed);
	const name = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
	const room = Math.max(1, width - 2 - visibleWidth(counts) - 1);
	const path = fitStart(clean(name), room);
	return `${STATUS_PAINT[file.status](file.status)} ${theme.text(path)}${" ".repeat(Math.max(1, room - visibleWidth(path) + 1))}${counts}`;
}

function commitRow(entry: CommitEntry, width: number, now: number): string {
	const { commit } = entry;
	const author = truncateToWidth(commit.author, 12, "…", true);
	const counts = changeCounts(commit.added, commit.removed);
	// Fixed-width columns after the subject keep the authors, dates and counts aligned down the list.
	const right = `${theme.muted(`${author} ${relativeTime(commit.date, now).padStart(7)}`)} ${" ".repeat(Math.max(0, 9 - visibleWidth(counts)))}${counts}`;
	const room = Math.max(1, width - 8 - visibleWidth(right) - 1);
	const subject = truncateToWidth(clean(commit.subject), room, "…", true);
	return `${theme.accent(commit.sha.slice(0, 7))} ${theme.text(subject)} ${right}`;
}

function changeCounts(added: number, removed: number): string {
	return `${theme.success(`+${added}`)} ${theme.error(`−${removed}`)}`;
}

/** The diff pane's shown rows; the cursor row gets the band when the pane is focused. */
function docLines(state: DiffReady, doc: Doc | undefined, width: number, height: number, focused: boolean): string[] {
	const { content } = state;
	if (doc === undefined) {
		if (content.kind === "history" && content.entries.length > 0) return [theme.muted("loading…")];
		return [];
	}
	const top = Math.max(0, Math.min(state.top, doc.rows.length - height));
	const cursor = Math.min(state.cursor, doc.rows.length - 1);
	return doc.rows.slice(top, top + height).map((row, index) => {
		const line = docRow(row, doc.digits, width);
		return focused && top + index === cursor ? theme.band(truncateToWidth(line, width, "…", true)) : line;
	});
}

const LINE_PAINT: Readonly<Record<DiffLine["kind"], Paint>> = {
	context: theme.text,
	add: theme.success,
	del: theme.error,
};

const MARKS: Readonly<Record<DiffLine["kind"], string>> = { context: " ", add: "+", del: "-" };

function docRow(row: DocRow, digits: number, width: number): string {
	const blank = " ".repeat(digits);
	switch (row.kind) {
		case "file": {
			const { file } = row.entry;
			const name = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
			const staged = row.entry.area === "staged" ? theme.muted(" · staged") : "";
			return `${theme.accent(row.collapsed ? "▸" : "▾")} ${STATUS_PAINT[file.status](file.status)} ${theme.bold(theme.text(clean(name)))} ${changeCounts(file.added, file.removed)}${staged}`;
		}
		case "hunk":
			return theme.accent(clean(row.hunk.header));
		case "note":
			return `${blank} ${blank}  ${theme.dim(theme.italic(row.text))}`;
		case "line": {
			const line = row.hunk.lines[row.index]!;
			const oldNo = line.kind === "add" ? blank : String(line.oldNo).padStart(digits);
			const newNo = line.kind === "del" ? blank : String(line.newNo).padStart(digits);
			return truncateToWidth(`${theme.dim(`${oldNo} ${newNo}`)} ${lineText(line)}`, width, "…");
		}
		case "pair": {
			const half = Math.max(1, Math.floor((width - 1) / 2));
			const side = (index: number | undefined, which: "old" | "new") => {
				const line = index === undefined ? undefined : row.hunk.lines[index];
				if (line === undefined) return " ".repeat(half);
				const number =
					which === "old" ? (line.kind === "add" ? 0 : line.oldNo) : line.kind === "del" ? 0 : line.newNo;
				return truncateToWidth(`${theme.dim(String(number).padStart(digits))} ${lineText(line)}`, half, "…", true);
			};
			return `${side(row.old, "old")}${theme.border("│")}${side(row.new, "new")}`;
		}
	}
}

function lineText(line: DiffLine): string {
	const eol = line.noNewline ? theme.dim(" ⊘ no newline at end") : "";
	return `${LINE_PAINT[line.kind](`${MARKS[line.kind]}${clean(line.text)}`)}${eol}`;
}

/** File text made safe to draw: tabs as spaces, control characters as their visible pictures (␛, ␍). */
function clean(text: string): string {
	let shown = "";
	for (const char of text) {
		const code = char.charCodeAt(0);
		shown += char === "\t" ? "    " : code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "␡" : char;
	}
	return shown;
}

/** `text` cut from the start to `width` columns, so a path keeps its file name. */
function fitStart(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	while (chars.length > 0 && visibleWidth(chars.join("")) > width - 1) chars.shift();
	return `…${chars.join("")}`;
}

function relativeTime(date: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - date) / 1000));
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
	if (seconds < 365 * 86_400) return `${Math.floor(seconds / (30 * 86_400))}mo ago`;
	return `${Math.floor(seconds / (365 * 86_400))}y ago`;
}

// Git's failures carry the command line first; the `fatal:`/`error:` line is what the user can act on.
function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? text;
}
