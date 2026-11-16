// The dashboard list's window: which of its lines fit the rows the list has. It scrolls by the least that keeps the
// selected row in view, keeps the header of the section at the top on screen, and counts the rows cut off above and
// below as `↑ N more` and `↓ N more`.

/** One line of the whole list: a section's header, the blank line between sections, or a row by its index. */
export type ListLine =
	| { readonly kind: "header"; readonly title: string }
	| { readonly kind: "gap" }
	| { readonly kind: "row"; readonly index: number };

/** A line of the window: a list line, or a marker counting the rows cut off above or below. */
export type WindowLine = ListLine | { readonly kind: "more"; readonly direction: "up" | "down"; readonly rows: number };

/** What the list shows: the list line it starts at, which the next window scrolls from, and its lines. */
export type ListWindow = { readonly top: number; readonly lines: readonly WindowLine[] };

/**
 * The window of `lines` in `height` rows that shows row `selected`, starting from the window that started at list line
 * `previousTop` and moving it as little as possible. A list that fits is shown whole.
 */
export function listWindow(
	lines: readonly ListLine[],
	selected: number | undefined,
	height: number,
	previousTop: number,
): ListWindow {
	const whole = layout(lines, 0, height);
	if (whole.last === lines.length - 1) return { top: 0, lines: whole.lines };
	const target = lines.findIndex((line) => line.kind === "row" && line.index === selected);
	// Too short for both markers, a header and the row: the selected row alone.
	if (height < MIN_HEIGHT && target !== -1) return { top: target, lines: [lines[target]!] };
	let top = startAt(lines, Math.min(Math.max(previousTop, 0), lines.length - 1));
	if (target !== -1 && target < top) {
		// The first row of a section scrolls in with its header.
		top = lines[target - 1]?.kind === "header" ? target - 1 : target;
	}
	while (top < target && layout(lines, top, height).last < target) top = startAt(lines, top + 1);
	// After a resize or a shorter list: fill the rows below the last line rather than leave them empty.
	for (;;) {
		const earlier = previousStart(lines, top);
		if (earlier === undefined) break;
		const window = layout(lines, earlier, height);
		if (window.last !== lines.length - 1 || (target !== -1 && target < earlier)) break;
		top = earlier;
	}
	return { top, lines: layout(lines, top, height).lines };
}

/** An up marker, a section header, one row and a down marker. */
const MIN_HEIGHT = 4;

/** The window that starts at list line `top`, and the last list line it shows. */
function layout(
	lines: readonly ListLine[],
	top: number,
	height: number,
): { readonly lines: WindowLine[]; readonly last: number } {
	const shown: WindowLine[] = [];
	const above = rowsIn(lines, 0, top);
	if (above > 0) shown.push({ kind: "more", direction: "up", rows: above });
	if (lines[top]?.kind === "row") {
		const header = lines.slice(0, top).findLast((line) => line.kind === "header");
		if (header !== undefined) shown.push(header);
	}
	let next = top;
	// The last row stays free for the down marker while more than one line is left.
	while (next < lines.length && shown.length < height - (lines.length - next > 1 ? 1 : 0)) shown.push(lines[next++]!);
	// A header or gap cut off from the rows below it says nothing; the down marker counts those rows instead.
	while (next < lines.length && next > top && lines[next - 1]!.kind !== "row") {
		shown.pop();
		next--;
	}
	if (next < lines.length) shown.push({ kind: "more", direction: "down", rows: rowsIn(lines, next, lines.length) });
	return { lines: shown, last: next - 1 };
}

/** How many rows `lines` has from `start` up to `end`. */
function rowsIn(lines: readonly ListLine[], start: number, end: number): number {
	return lines.slice(start, end).filter((line) => line.kind === "row").length;
}

/** `index`, or the line after it when it is a gap: a window never starts on a blank line. */
function startAt(lines: readonly ListLine[], index: number): number {
	return lines[index]?.kind === "gap" ? index + 1 : index;
}

/** The start one line before `top`, past a gap; undefined at the top. */
function previousStart(lines: readonly ListLine[], top: number): number | undefined {
	if (top === 0) return undefined;
	return lines[top - 1]?.kind === "gap" ? top - 2 : top - 1;
}
