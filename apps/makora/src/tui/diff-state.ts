// The diff view's state as a reducer: the repository's tabs and their loaded content, focus, selection and scroll.
import type { DiffFile } from "../git/diff.ts";
import type { Commit } from "../git/log.ts";

/** One tab of the diff view. */
export type DiffTab =
	| { readonly kind: "working" }
	| { readonly kind: "staged" }
	| { readonly kind: "base"; readonly base: string }
	| { readonly kind: "history" };

/** Where a listed file's change lives, which decides whether stage, unstage and revert apply to it. */
export type FileArea = "unstaged" | "staged" | "readonly";

/** A file row of the list or of a stacked diff. */
export interface FileEntry {
	readonly kind: "file";
	readonly file: DiffFile;
	readonly area: FileArea;
}

/** A commit row of the History tab. */
export interface CommitEntry {
	readonly kind: "commit";
	readonly commit: Commit;
}

/** The selected commit's files in the History tab. */
export type ShownCommit =
	| { readonly kind: "loading"; readonly sha: string }
	| { readonly kind: "loaded"; readonly sha: string; readonly files: readonly FileEntry[] };

/** What the current tab shows. */
export type TabContent =
	| { readonly kind: "loading" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "files"; readonly entries: readonly FileEntry[] }
	| {
			readonly kind: "history";
			readonly entries: readonly CommitEntry[];
			readonly shown: ShownCommit | undefined;
	  };

/** The pane that up and down move in. */
export type DiffFocus = "list" | "diff";

/** The view on a repository. */
export interface DiffReady {
	readonly kind: "ready";
	/** The repository's directory name. */
	readonly repo: string;
	readonly tabs: readonly DiffTab[];
	readonly tab: number;
	readonly content: TabContent;
	readonly focus: DiffFocus;
	/** The selected list entry. */
	readonly selected: number;
	/** The diff pane's cursor row and first shown row. */
	readonly cursor: number;
	readonly top: number;
	/** Side-by-side requested; shown when the width allows it. */
	readonly split: boolean;
	/** Collapsed files of stacked diffs, by `fileKey`. */
	readonly collapsed: ReadonlySet<string>;
	/** A one-line result or error shown in place of the hint row until the next key. */
	readonly message: string | undefined;
}

/** The diff view's state. */
export type DiffState = { readonly kind: "opening" } | { readonly kind: "notRepo" } | DiffReady;

/** A change to the diff view's state. Moves carry the pane geometry the view measured. */
export type DiffAction =
	| { readonly type: "opened"; readonly repo: string; readonly tabs: readonly DiffTab[] }
	| { readonly type: "notRepo" }
	| { readonly type: "loaded"; readonly tab: number; readonly content: TabContent }
	| { readonly type: "commitLoading"; readonly sha: string }
	| { readonly type: "commitLoaded"; readonly sha: string; readonly files: readonly DiffFile[] }
	| { readonly type: "switchTab"; readonly delta: number }
	| { readonly type: "focus"; readonly focus: DiffFocus }
	/** Move the list selection by `delta` entries. */
	| { readonly type: "select"; readonly delta: number }
	/** Move the diff cursor by `delta` rows of `rows`, keeping it within `height` shown rows. */
	| { readonly type: "moveCursor"; readonly delta: number; readonly rows: number; readonly height: number }
	/** Scroll the diff by `delta` pages of `height` rows. */
	| { readonly type: "page"; readonly delta: number; readonly rows: number; readonly height: number }
	/** Move the cursor to the next (`delta` 1) or previous (-1) row of `stops`, ascending row indices. */
	| {
			readonly type: "jump";
			readonly delta: 1 | -1;
			readonly stops: readonly number[];
			readonly rows: number;
			readonly height: number;
	  }
	| { readonly type: "toggleSplit" }
	| { readonly type: "toggleCollapsed"; readonly key: string }
	| { readonly type: "message"; readonly text: string | undefined };

/** The state of a view that has not found its repository yet. */
export const OPENING: DiffState = { kind: "opening" };

/** The key of a file in `collapsed`: a file can be listed both unstaged and staged. */
export function fileKey(entry: FileEntry): string {
	return `${entry.area}\0${entry.file.path}`;
}

/** The list entries of the current tab. */
export function listEntries(state: DiffReady): readonly (FileEntry | CommitEntry)[] {
	const { content } = state;
	return content.kind === "files" || content.kind === "history" ? content.entries : [];
}

/** The state after `action`. */
export function reduceDiff(state: DiffState, action: DiffAction): DiffState {
	if (action.type === "opened") {
		const previous = state.kind === "ready" ? state : undefined;
		const sameTabs = previous !== undefined && tabsEqual(previous.tabs, action.tabs);
		return {
			kind: "ready",
			repo: action.repo,
			tabs: action.tabs,
			tab: sameTabs ? previous.tab : 0,
			content: { kind: "loading" },
			focus: previous?.focus ?? "list",
			selected: sameTabs ? previous.selected : 0,
			cursor: 0,
			top: 0,
			split: previous?.split ?? false,
			collapsed: previous?.collapsed ?? new Set(),
			message: undefined,
		};
	}
	if (action.type === "notRepo") return { kind: "notRepo" };
	if (state.kind !== "ready") return state;
	return reduceReady(state, action);
}

function reduceReady(state: DiffReady, action: Exclude<DiffAction, { type: "opened" | "notRepo" }>): DiffReady {
	switch (action.type) {
		case "loaded": {
			if (action.tab !== state.tab) return state;
			const before = listEntries(state)[state.selected];
			const next = { ...state, content: action.content };
			const selected = Math.max(0, Math.min(state.selected, listEntries(next).length - 1));
			const after = listEntries(next)[selected];
			// A reload that keeps the same entry selected keeps the reader's place in its diff.
			const kept = before !== undefined && after !== undefined && entryKey(before) === entryKey(after);
			return { ...next, selected, ...(kept ? {} : { cursor: 0, top: 0 }) };
		}
		case "commitLoading":
			return withShown(state, { kind: "loading", sha: action.sha });
		case "commitLoaded":
			return withShown(state, {
				kind: "loaded",
				sha: action.sha,
				files: action.files.map((file) => ({ kind: "file", file, area: "readonly" })),
			});
		case "switchTab": {
			const count = state.tabs.length;
			const tab = (((state.tab + action.delta) % count) + count) % count;
			return { ...state, tab, content: { kind: "loading" }, selected: 0, cursor: 0, top: 0, focus: "list" };
		}
		case "focus":
			return { ...state, focus: action.focus };
		case "select": {
			const count = listEntries(state).length;
			const selected = Math.max(0, Math.min(count - 1, state.selected + action.delta));
			return selected === state.selected ? state : { ...state, selected, cursor: 0, top: 0 };
		}
		case "moveCursor":
			return withCursor(state, state.cursor + action.delta, state.top, action.rows, action.height);
		case "page": {
			const shift = action.delta * Math.max(1, action.height - 1);
			return withCursor(state, state.cursor + shift, state.top + shift, action.rows, action.height);
		}
		case "jump": {
			const target =
				action.delta > 0
					? action.stops.find((stop) => stop > state.cursor)
					: action.stops.findLast((stop) => stop < state.cursor);
			if (target === undefined) return state;
			// A jumped-to hunk header goes to the top of the pane, so its lines show below it.
			return withCursor(state, target, target, action.rows, action.height);
		}
		case "toggleSplit":
			return { ...state, split: !state.split, cursor: 0, top: 0 };
		case "toggleCollapsed": {
			const collapsed = new Set(state.collapsed);
			if (!collapsed.delete(action.key)) collapsed.add(action.key);
			return { ...state, collapsed };
		}
		case "message":
			return state.message === action.text ? state : { ...state, message: action.text };
	}
}

function entryKey(entry: FileEntry | CommitEntry): string {
	return entry.kind === "file" ? fileKey(entry) : entry.commit.sha;
}

function withShown(state: DiffReady, shown: ShownCommit): DiffReady {
	if (state.content.kind !== "history") return state;
	return { ...state, content: { ...state.content, shown } };
}

/** `cursor` clamped to `rows`, and the first shown row moved the least that keeps the cursor among `height` rows. */
function withCursor(state: DiffReady, cursor: number, top: number, rows: number, height: number): DiffReady {
	const at = Math.max(0, Math.min(rows - 1, cursor));
	const first = Math.max(0, Math.min(top, at, rows - height));
	return { ...state, cursor: at, top: Math.max(first, at - height + 1) };
}

function tabsEqual(a: readonly DiffTab[], b: readonly DiffTab[]): boolean {
	return a.length === b.length && a.every((tab, index) => JSON.stringify(tab) === JSON.stringify(b[index]));
}
