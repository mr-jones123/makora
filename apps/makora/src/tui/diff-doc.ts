// The diff pane's rows: one file's hunks unified or side by side, or many files stacked under collapsible headers.
import type { DiffFile, DiffLine, Hunk } from "../git/diff.ts";
import { type FileEntry, fileKey } from "./diff-state.ts";

/** One row of the diff pane. Line rows point into their hunk by index, so the ask block can mark the line. */
export type DocRow =
	| { readonly kind: "file"; readonly entry: FileEntry; readonly collapsed: boolean }
	| { readonly kind: "hunk"; readonly entry: FileEntry; readonly hunk: Hunk }
	| { readonly kind: "line"; readonly entry: FileEntry; readonly hunk: Hunk; readonly index: number }
	/** Side by side: the old line on the left, the new one on the right; either can be missing. */
	| {
			readonly kind: "pair";
			readonly entry: FileEntry;
			readonly hunk: Hunk;
			readonly old: number | undefined;
			readonly new: number | undefined;
	  }
	| { readonly kind: "note"; readonly entry: FileEntry; readonly text: string };

/** How hunk lines are laid out. */
export type LineStyle = "unified" | "split";

/** A file's rows. */
export interface Doc {
	readonly rows: readonly DocRow[];
	/** Digits of the largest line number, the width of each line-number column. */
	readonly digits: number;
}

/** The rows of `entry`'s diff, without a file header. */
export function fileDoc(entry: FileEntry, style: LineStyle): Doc {
	return { rows: fileRows(entry, style), digits: digitsOf([entry.file]) };
}

/** Every entry under a `▾`/`▸` header; collapsed entries show the header alone. */
export function stackedDoc(entries: readonly FileEntry[], collapsed: ReadonlySet<string>, style: LineStyle): Doc {
	const rows: DocRow[] = [];
	for (const entry of entries) {
		const closed = collapsed.has(fileKey(entry));
		rows.push({ kind: "file", entry, collapsed: closed });
		if (!closed) rows.push(...fileRows(entry, style));
	}
	return { rows, digits: digitsOf(entries.map((entry) => entry.file)) };
}

/** Rows of one file shown before a "N more lines" note; diffs can be huge. */
const MAX_FILE_ROWS = 2000;

function fileRows(entry: FileEntry, style: LineStyle): DocRow[] {
	const { body } = entry.file;
	if (body.kind === "binary") return [{ kind: "note", entry, text: "binary file" }];
	if (body.kind === "omitted") return [{ kind: "note", entry, text: body.reason }];
	if (body.hunks.length === 0)
		return [
			{
				kind: "note",
				entry,
				text: entry.file.status === "R" ? "renamed, no content changes" : "no content changes",
			},
		];
	const rows: DocRow[] = [];
	for (const hunk of body.hunks) {
		rows.push({ kind: "hunk", entry, hunk });
		if (style === "unified")
			for (let index = 0; index < hunk.lines.length; index++) rows.push({ kind: "line", entry, hunk, index });
		else for (const pair of pairLines(hunk.lines)) rows.push({ kind: "pair", entry, hunk, ...pair });
	}
	if (rows.length <= MAX_FILE_ROWS) return rows;
	const hidden = rows.length - MAX_FILE_ROWS;
	return [...rows.slice(0, MAX_FILE_ROWS), { kind: "note", entry, text: `${hidden} more lines` }];
}

/** A hunk's lines side by side: context on both sides, each run of deletions beside the additions that follow it. */
function pairLines(lines: readonly DiffLine[]): { old: number | undefined; new: number | undefined }[] {
	const pairs: { old: number | undefined; new: number | undefined }[] = [];
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind === "context") {
			pairs.push({ old: index, new: index });
			index++;
			continue;
		}
		const dels: number[] = [];
		const adds: number[] = [];
		while (lines[index]?.kind === "del") dels.push(index++);
		while (lines[index]?.kind === "add") adds.push(index++);
		for (let row = 0; row < Math.max(dels.length, adds.length); row++) pairs.push({ old: dels[row], new: adds[row] });
	}
	return pairs;
}

function digitsOf(files: readonly DiffFile[]): number {
	let largest = 0;
	for (const file of files)
		if (file.body.kind === "text")
			for (const hunk of file.body.hunks)
				largest = Math.max(largest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
	return Math.max(3, String(largest).length);
}

/** The hunk and line `row` points at, for asking about it; the line is undefined on a hunk header. */
export function rowTarget(row: DocRow): { entry: FileEntry; hunk: Hunk; line: number | undefined } | undefined {
	switch (row.kind) {
		case "hunk":
			return { entry: row.entry, hunk: row.hunk, line: undefined };
		case "line":
			return { entry: row.entry, hunk: row.hunk, line: row.index };
		case "pair":
			return { entry: row.entry, hunk: row.hunk, line: row.new ?? row.old };
		default:
			return undefined;
	}
}
