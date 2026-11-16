import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ListLine, type ListWindow, listWindow } from "../src/tui/list-window.ts";

/** The list of `sections` (title and row count), rows numbered across sections, a gap between sections. */
function list(sections: readonly (readonly [string, number])[]): ListLine[] {
	const lines: ListLine[] = [];
	let index = 0;
	for (const [title, count] of sections) {
		if (lines.length > 0) lines.push({ kind: "gap" });
		lines.push({ kind: "header", title });
		for (let row = 0; row < count; row++) lines.push({ kind: "row", index: index++ });
	}
	return lines;
}

/** The window as text: `RUNNING` for a header, `r3` for row 3, `↑ 2` and `↓ 5` for the markers, `` for a gap. */
function shown(window: ListWindow): string[] {
	return window.lines.map((line) => {
		if (line.kind === "header") return line.title;
		if (line.kind === "gap") return "";
		if (line.kind === "row") return `r${line.index}`;
		return `${line.direction === "up" ? "↑" : "↓"} ${line.rows}`;
	});
}

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, offset) => `r${from + offset}`);

// RUNNING r0-r11, WAITING ON YOU r12-r13, DONE r14-r29: 35 lines.
const LIST = list([
	["RUNNING", 12],
	["WAITING ON YOU", 2],
	["DONE", 16],
]);

describe("the dashboard list's window", () => {
	it("shows a list that fits whole, without markers", () => {
		const small = list([
			["RUNNING", 2],
			["DONE", 1],
		]);
		const window = listWindow(small, 2, 10, 0);
		assert.deepEqual(shown(window), ["RUNNING", "r0", "r1", "", "DONE", "r2"]);
		assert.equal(window.top, 0);
	});

	it("starts at the top with the selection there, and counts the rows below", () => {
		assert.deepEqual(shown(listWindow(LIST, 0, 10, 0)), ["RUNNING", ...rows(0, 7), "↓ 22"]);
	});

	it("scrolls by the least that shows a selection moved past the bottom, keeping its section's header", () => {
		const window = listWindow(LIST, 8, 10, 0);
		assert.deepEqual(shown(window), ["↑ 2", "RUNNING", ...rows(2, 8), "↓ 21"]);
		assert.deepEqual(shown(listWindow(LIST, 9, 10, window.top)), ["↑ 3", "RUNNING", ...rows(3, 9), "↓ 20"]);
	});

	it("keeps the window still while the selection moves inside it", () => {
		const window = listWindow(LIST, 8, 10, 0);
		assert.deepEqual(listWindow(LIST, 4, 10, window.top), window);
	});

	it("shows the last rows without a down marker when the selection is at the bottom", () => {
		assert.deepEqual(shown(listWindow(LIST, 29, 10, 0)), ["↑ 22", "DONE", ...rows(22, 29)]);
	});

	it("keeps the header of the section at the top on screen in the middle of a section", () => {
		const start = listWindow(LIST, 14, 10, listWindow(LIST, 29, 10, 0).top);
		assert.deepEqual(shown(start), ["↑ 14", "DONE", ...rows(14, 20), "↓ 9"]);
		assert.deepEqual(shown(listWindow(LIST, 22, 10, start.top)), ["↑ 16", "DONE", ...rows(16, 22), "↓ 7"]);
	});

	it("scrolls up to a selection above the window, bringing a section's first row in with its header", () => {
		const bottom = listWindow(LIST, 29, 10, 0);
		assert.deepEqual(shown(listWindow(LIST, 12, 10, bottom.top)), [
			"↑ 12",
			"WAITING ON YOU",
			"r12",
			"r13",
			"",
			"DONE",
			...rows(14, 16),
			"↓ 13",
		]);
	});

	it("never ends on a header or a gap cut off from its rows", () => {
		const short = list([
			["RUNNING", 3],
			["DONE", 5],
		]);
		assert.deepEqual(shown(listWindow(short, 0, 7, 0)), ["RUNNING", "r0", "r1", "r2", "↓ 5"]);
	});

	it("fills a taller screen after a resize, and shows the whole list once it fits", () => {
		const bottom = listWindow(LIST, 29, 10, 0);
		assert.deepEqual(shown(listWindow(LIST, 29, 20, bottom.top)), ["↑ 14", "DONE", ...rows(14, 29)]);
		const whole = listWindow(LIST, 29, 40, bottom.top);
		assert.equal(whole.top, 0);
		assert.equal(whole.lines.length, LIST.length);
	});

	it("keeps the selection in view after a resize to a shorter screen", () => {
		const top = listWindow(LIST, 7, 10, 0);
		assert.deepEqual(shown(listWindow(LIST, 7, 6, top.top)), ["↑ 5", "RUNNING", "r5", "r6", "r7", "↓ 22"]);
	});

	it("shows the selected row alone on a screen too short for the markers", () => {
		assert.deepEqual(shown(listWindow(LIST, 20, 3, 0)), ["r20"]);
		assert.deepEqual(shown(listWindow(LIST, 20, 4, 0)), ["↑ 20", "DONE", "r20", "↓ 9"]);
	});
});
