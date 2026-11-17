import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type DiffReady, type DiffState, reduceDiff } from "../src/tui/diff-state.ts";
import { DiffView } from "../src/tui/diff-view.ts";
import { installKeybindings } from "../src/tui/keybindings.ts";

function ready(): DiffReady {
	const state = reduceDiff(
		{ kind: "opening" },
		{ type: "opened", repo: "r", tabs: [{ kind: "working" }, { kind: "history" }], start: 0 },
	);
	assert.equal(state.kind, "ready");
	return state as DiffReady;
}

function apply(state: DiffState, ...actions: Parameters<typeof reduceDiff>[1][]): DiffReady {
	return actions.reduce<DiffState>((current, action) => reduceDiff(current, action), state) as DiffReady;
}

describe("full screen in the diff view's state", () => {
	it("starts off, and turning it on moves focus to the diff", () => {
		const state = ready();
		assert.equal(state.fullscreen, false);
		const on = apply(state, { type: "toggleFullscreen" });
		assert.equal(on.fullscreen, true);
		assert.equal(on.focus, "diff");
		assert.equal(apply(on, { type: "toggleFullscreen" }).fullscreen, false);
	});

	it("ends when focus moves to the hidden list or the tab changes", () => {
		const on = apply(ready(), { type: "toggleFullscreen" });
		assert.equal(apply(on, { type: "focus", focus: "list" }).fullscreen, false);
		assert.equal(apply(on, { type: "focus", focus: "diff" }).fullscreen, true);
		assert.equal(apply(on, { type: "switchTab", delta: 1 }).fullscreen, false);
	});

	it("survives a reopen of the same view", () => {
		const on = apply(ready(), { type: "toggleFullscreen" });
		const reopened = apply(on, { type: "opened", repo: "r", tabs: on.tabs, start: 0 });
		assert.equal(reopened.fullscreen, true);
	});
});

describe("the diff view in full screen", () => {
	it("hides the list and gives the diff the whole width", async () => {
		installKeybindings(join(tmpdir(), "makora-no-keybindings.json"));
		const repo = mkdtempSync(join(tmpdir(), "makora-diff-full-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(repo, "notes.md"), "start\n");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start");
		const tail = "the end of a long line";
		writeFileSync(join(repo, "notes.md"), `start\n${"x".repeat(120)} ${tail}\n`);

		const view = new DiffView({
			rows: () => 20,
			render: () => {},
			close: () => {},
			ask: () => {},
			confirm: async () => true,
		});
		view.open(repo);
		const width = 200;
		for (let i = 0; i < 100 && !view.render(width).some((line) => line.includes("notes.md")); i++) await sleep(20);
		const body = (lines: string[]) => lines.slice(3, -2).join("\n");

		const split = view.render(width);
		assert.match(body(split), /│/, "the list and the diff share the screen");
		assert.doesNotMatch(body(split), new RegExp(tail), "the pane cuts the long line");

		view.handleInput("f");
		const full = view.render(width);
		assert.doesNotMatch(body(full), /│/, "no list pane");
		assert.match(body(full), new RegExp(tail), "the whole line shows");
		assert.match(full.at(-1)!, /show list/);

		view.handleInput("f");
		assert.match(body(view.render(width)), /│/, "f again brings the list back");
		rmSync(repo, { recursive: true, force: true });
	});
});
