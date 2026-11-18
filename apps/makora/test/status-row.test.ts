import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { type StatusRow, statusLine } from "../src/tui/bars.ts";
import { installKeybindings, pressedBindings } from "../src/tui/keybindings.ts";

const row: StatusRow = {
	model: "claude-opus-5-5",
	thinking: "high",
	cwd: "~/Programming/Self-Projects/makora",
	branch: "main",
	contextTokens: 50_000,
	contextWindow: 200_000,
	account: { text: "7d 59%", warn: false },
};

describe("the status row", () => {
	it("shows the folder, the context gauge with its numbers, and the plan usage when they fit", () => {
		const line = stripTerminalSequences(statusLine(row, 160));
		assert.match(
			line,
			/^claude-opus-5-5 · high · ~\/Programming\/Self-Projects\/makora \(main\) · ctx ━{20} 25% of 200k +7d 59%$/,
		);
	});

	it("shortens the folder from its start before the context gauge loses anything", () => {
		const line = stripTerminalSequences(statusLine(row, 90));
		assert.ok(visibleWidth(line) <= 90);
		assert.match(line, / · …[^ ]*makora \(main\) · ctx ━{20} 25% of 200k +7d 59%$/);
	});

	it("drops the folder when even its end would not fit, and keeps the gauge", () => {
		const line = stripTerminalSequences(statusLine(row, 72));
		assert.match(line, /^claude-opus-5-5 · high · ctx ━{20} 25% of 200k +7d 59%$/);
	});
});

describe("main-screen shortcuts", () => {
	installKeybindings(join(tmpdir(), "makora-no-keybindings.json"));

	it("act on a key's press, in the legacy and Kitty encodings", () => {
		assert.deepEqual(pressedBindings("\x0f", ["app.tools.expand", "app.diff"]), ["app.tools.expand"]);
		assert.deepEqual(pressedBindings("\x1b[111;5u", ["app.tools.expand"]), ["app.tools.expand"]);
	});

	it("ignore a key's release, which Kitty terminals report and which matches the same binding", () => {
		assert.deepEqual(pressedBindings("\x1b[111;5:3u", ["app.tools.expand"]), []);
	});

	it("give every binding of a shared key, in order, so a declining action passes the key on", () => {
		assert.deepEqual(pressedBindings("\x1b", ["app.back", "app.interrupt"]), ["app.back", "app.interrupt"]);
	});
});
