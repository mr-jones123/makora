// A file's diff as the quiz page shows it: hunk headers and lines with their old and new line numbers, the rows an
// annotation points into by side and line number.
import type { DiffFile, DiffLine } from "../git/diff.ts";

/** A hunk's `@@` header, or one line of it. */
export type DiffRow = { readonly kind: "hunk"; readonly text: string } | DiffLine;

/** Which version of the file a line number counts in: after the commit (`new`) or before it (`old`). */
export type Side = "new" | "old";

/** Every row of `file`'s diff in order; none for a binary file or one git gave no diff for. */
export function diffRows(file: DiffFile): DiffRow[] {
	if (file.body.kind !== "text") return [];
	return file.body.hunks.flatMap((hunk): DiffRow[] => [{ kind: "hunk", text: hunk.header }, ...hunk.lines]);
}

/** The index in `rows` of line `line` on `side`, or -1. */
export function findLine(rows: readonly DiffRow[], side: Side, line: number): number {
	return rows.findIndex((row) => lineOn(row, side) === line);
}

/** The line numbers `rows` cover on `side`, as ranges such as `1-40, 88-120`, for an error message. */
export function coveredLines(rows: readonly DiffRow[], side: Side): string {
	const ranges: [number, number][] = [];
	for (const row of rows) {
		const number = lineOn(row, side);
		if (number === undefined) continue;
		const last = ranges.at(-1);
		if (last !== undefined && last[1] === number - 1) last[1] = number;
		else ranges.push([number, number]);
	}
	if (ranges.length === 0) return "none";
	return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
}

// A deleted line has no new number and an added one no old number.
function lineOn(row: DiffRow, side: Side): number | undefined {
	if (row.kind === "hunk") return undefined;
	if (side === "new") return row.kind === "del" ? undefined : row.newNo;
	return row.kind === "add" ? undefined : row.oldNo;
}
