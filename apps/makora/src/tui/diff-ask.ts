// The block `a` puts into the editor: where a diff line is, and its hunk with the line marked, for asking about it.
import type { DiffLine, Hunk } from "../git/diff.ts";

/** A line (or a whole hunk, `line` undefined) to ask about. */
export interface AskTarget {
	readonly path: string;
	readonly hunk: Hunk;
	/** Index into `hunk.lines`. */
	readonly line: number | undefined;
	/** Which diff it is from: `working tree`, `staged`, `vs main`, `history`. */
	readonly source: string;
	/** The commit it is from, in History. */
	readonly commit?: string;
}

/** Hunk lines kept around the asked line; a longer hunk is trimmed to them. */
export const ASK_MAX_LINES = 30;

/**
 * `About <path>:<line>[ @ <sha7>] (<source>):` and a fenced `diff` block of the hunk, the asked line marked `← line N`;
 * ends with a newline so the question goes below it.
 */
export function askBlock(target: AskTarget): string {
	const { hunk, line } = target;
	const at = line === undefined ? undefined : hunk.lines[line];
	// The number a reader looks for: the new side, the old side for a deleted line or a hunk that only deletes.
	const number =
		at === undefined ? (hunk.newLines > 0 ? hunk.newStart : hunk.oldStart) : at.kind === "del" ? at.oldNo : at.newNo;
	const commit = target.commit === undefined ? "" : ` @ ${target.commit.slice(0, 7)}`;
	const { start, end } = window(hunk.lines.length, line ?? 0);
	const body: string[] = [hunk.header];
	if (start > 0) body.push(` … ${start} lines`);
	for (let index = start; index < end; index++) {
		const diffLine = hunk.lines[index]!;
		body.push(`${MARKS[diffLine.kind]}${diffLine.text}${index === line ? `     ← line ${number}` : ""}`);
		if (diffLine.noNewline) body.push("\\ No newline at end of file");
	}
	if (end < hunk.lines.length) body.push(` … ${hunk.lines.length - end} lines`);
	const fence = fenceFor(body);
	return `About ${target.path}:${number}${commit} (${target.source}):\n${fence}diff\n${body.join("\n")}\n${fence}\n`;
}

const MARKS: Readonly<Record<DiffLine["kind"], string>> = { context: " ", add: "+", del: "-" };

// A third of the window above the asked line and the rest below, shifted to stay inside the hunk.
function window(length: number, line: number): { start: number; end: number } {
	if (length <= ASK_MAX_LINES) return { start: 0, end: length };
	const start = Math.max(0, Math.min(length - ASK_MAX_LINES, line - Math.floor(ASK_MAX_LINES / 3)));
	return { start, end: start + ASK_MAX_LINES };
}

// A fence one backtick longer than any run of backticks in the hunk, so file content cannot close it.
function fenceFor(lines: readonly string[]): string {
	let longest = 0;
	for (const line of lines) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}
