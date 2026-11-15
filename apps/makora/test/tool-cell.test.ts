import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, SPINNER, type ToolCell, type ToolCellStatus, toolSummary } from "../src/tool-cell.ts";

const bash = (status: ToolCellStatus): ToolCell => ({
	callId: "c1",
	name: "bash",
	args: { command: "echo hello; sleep 2" },
	status,
});
const line = (cell: ToolCell, width = 80, now = 10_000, frame = 0) => {
	const summary = toolSummary(cell, width, now, frame);
	return `${summary.marker} ${summary.text}`;
};

describe("tool summary line", () => {
	it("shows the marker, tool, argument preview and duration for each state", () => {
		assert.equal(
			line(bash({ kind: "done", isError: false, durationMs: 2_034 })),
			"✓ bash · echo hello; sleep 2 · 2.0s",
		);
		assert.equal(line(bash({ kind: "done", isError: true, durationMs: 700 })), "✗ bash · echo hello; sleep 2 · 0.7s");
		assert.equal(
			line(bash({ kind: "running", startedAt: 9_100 }), 80, 10_000, 3),
			`${SPINNER[3]} bash · echo hello; sleep 2 · 0.9s`,
		);
		assert.equal(line(bash({ kind: "pending" })), "◌ bash · echo hello; sleep 2");
		assert.equal(line(bash({ kind: "parked" })), "◌ bash · echo hello; sleep 2");
	});

	it("previews paths for file tools and compact JSON for others, on one line", () => {
		const read: ToolCell = {
			callId: "r",
			name: "read",
			args: { path: "src/main.ts", offset: 3 },
			status: { kind: "pending" },
		};
		assert.equal(line(read), "◌ read · src/main.ts");
		const other: ToolCell = { callId: "o", name: "grep", args: { pattern: "x" }, status: { kind: "pending" } };
		assert.equal(line(other), '◌ grep · {"pattern":"x"}');
		const multiline = bash({ kind: "pending" });
		assert.equal(line({ ...multiline, args: { command: "cd a\n  make" } }), "◌ bash · cd a ⏎ make");
	});

	it("stays within the width in every state, truncating the preview first", () => {
		const long = { command: `printf '${"x".repeat(200)}'` };
		const states: ToolCellStatus[] = [
			{ kind: "pending" },
			{ kind: "running", startedAt: 0 },
			{ kind: "done", isError: false, durationMs: 125_000 },
		];
		for (const status of states) {
			const text = line({ callId: "c", name: "bash", args: long, status }, 40, 61_000);
			assert.ok(visibleWidth(text) <= 40, text);
			assert.ok(text.includes("…"), text);
		}
		assert.match(line({ callId: "c", name: "bash", args: long, status: states[2]! }, 40), / · 2m05s$/);
	});

	it("shows a python call's cell number and first code line", () => {
		const cell: ToolCell = {
			callId: "p",
			name: "python",
			args: { code: "\n  x = 41\nprint(x)" },
			status: { kind: "done", isError: false, durationMs: 2_034 },
			cell: 3,
		};
		assert.equal(line(cell), "✓ python · cell 3 · x = 41 · 2.0s");
		assert.equal(line({ ...cell, cell: undefined, status: { kind: "pending" } }), "◌ python · x = 41");
	});

	it("formats durations in seconds below a minute and minutes above", () => {
		assert.deepEqual(
			[formatDuration(400), formatDuration(12_000), formatDuration(185_000)],
			["0.4s", "12.0s", "3m05s"],
		);
	});
});
