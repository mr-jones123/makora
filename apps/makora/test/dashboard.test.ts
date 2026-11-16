import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { AgentBudget, AgentMessage, AgentRecord, AgentState } from "../src/agents/types.ts";
import type { ToolCell } from "../src/tool-cell.ts";
import {
	type AgentFacts,
	budgetCells,
	type DashboardRow,
	dashboardRows,
	glyph,
	type InspectorExtras,
	inspectorLines,
} from "../src/tui/dashboard.ts";

const NOW = 1_000_000;
const BASE = "abc1234def5678abc1234def5678abc1234def56";
const ROOT = 1 as ConversationId;

function id(value: number): ConversationId {
	return value as ConversationId;
}

function main(overrides: Partial<AgentFacts> = {}): AgentFacts {
	return {
		conversationId: ROOT,
		parentId: undefined,
		who: { kind: "main" },
		name: "main",
		model: "faux/faux-1",
		cwd: "/repo",
		branch: "main",
		busy: false,
		costUsd: 0,
		turns: 0,
		startedAt: undefined,
		lastAt: undefined,
		cells: [],
		...overrides,
	};
}

type AgentOptions = {
	readonly parent?: ConversationId;
	readonly mode?: "write" | "review";
	readonly state?: AgentState;
	readonly budget?: AgentBudget;
	readonly facts?: Partial<AgentFacts>;
};

function agent(conversation: number, name: string, options: AgentOptions = {}): AgentFacts {
	const mode = options.mode ?? "review";
	const parent = options.parent ?? ROOT;
	const record: AgentRecord = {
		name,
		conversationId: id(conversation),
		parentConversationId: parent,
		depth: parent === ROOT ? 1 : 2,
		mode,
		task: `do the ${name} work\nwith a second line`,
		worktree: {
			kind: "worktree",
			repository: "/repo",
			cwd: `/worktrees/${name}`,
			root: `/worktrees/${name}`,
			baseCommit: BASE,
			baseRef: "HEAD",
			...(mode === "write" ? { branch: `makora/${name}-abcdef-${conversation}` } : {}),
		},
		budget: options.budget ?? { turns: 50 },
		createdAt: NOW - 60_000,
		state: options.state ?? { kind: "running" },
	};
	return {
		conversationId: id(conversation),
		parentId: parent,
		who: { kind: "agent", record },
		name,
		model: "faux/faux-1",
		cwd: record.worktree.cwd,
		branch: undefined,
		busy: record.state.kind === "running",
		costUsd: 0,
		turns: 0,
		startedAt: NOW - 60_000,
		lastAt: undefined,
		cells: [],
		...options.facts,
	};
}

function cell(number: number, code: string, status: ToolCell["status"]): ToolCell {
	return { callId: `call-${number}`, name: "python", args: { code }, status, cell: number };
}

const DONE_REVIEW: AgentState = { kind: "done", result: { mode: "review", summary: "looks fine" }, at: NOW - 30_000 };
const DONE_WRITE: AgentState = {
	kind: "done",
	result: {
		mode: "write",
		summary: "Added the usage line.\nTouched README.md only.",
		headCommit: "fedcba9876543210",
		diffStat: { files: 1, added: 1, removed: 0 },
	},
	at: NOW - 30_000,
};

function shape(rows: readonly DashboardRow[]) {
	return rows.map((row) => [row.section, row.facts.name, row.depth, row.state]);
}

describe("dashboard rows", () => {
	it("put each agent in its section by state, indent children under a parent in the same section, and hide removed ones", () => {
		const rows = dashboardRows(
			[
				main(),
				agent(2, "reviewer-a"),
				agent(3, "reviewer-b", { state: { kind: "queued" } }),
				agent(4, "writer", { mode: "write", state: DONE_WRITE }),
				agent(5, "grandchild", { parent: id(2) }),
				agent(6, "checked", { state: DONE_REVIEW }),
				agent(7, "merged", {
					mode: "write",
					state: { kind: "merged", result: DONE_WRITE.result, mergeCommit: "1111111", at: NOW },
				}),
				agent(8, "halted", { state: { kind: "stopped", reason: "cost", detail: "spent $1", at: NOW } }),
				agent(9, "gone", { state: { kind: "removed", at: NOW } }),
				{
					...main(),
					conversationId: id(10),
					parentId: ROOT,
					name: "fork 1",
					who: {
						kind: "fork",
						fork: {
							label: "fork 1",
							parentConversationId: ROOT,
							forkEntryId: 3 as EntryId,
							files: { kind: "shared" },
						},
					},
				},
			],
			NOW,
		);
		assert.deepEqual(shape(rows), [
			["running", "reviewer-a", 0, "running"],
			["running", "grandchild", 1, "running"],
			["running", "reviewer-b", 0, "queued"],
			["waiting", "writer", 0, "waiting"],
			["done", "main", 0, "done"],
			["done", "checked", 1, "done"],
			["done", "merged", 1, "done"],
			["done", "halted", 1, "stopped"],
			["done", "fork 1", 1, "done"],
		]);
	});

	it("list the root under RUNNING while it has a run, with its children indented under it", () => {
		const rows = dashboardRows([main({ busy: true }), agent(2, "reviewer-a")], NOW);
		assert.deepEqual(shape(rows), [
			["running", "main", 0, "running"],
			["running", "reviewer-a", 1, "running"],
		]);
	});

	it("draw a spinner while running, ◌ for queued and waiting on you, ✓ done and ✗ stopped", () => {
		assert.equal(plain(glyph("running", 0)), "⠋");
		assert.equal(plain(glyph("running", 1)), "⠙");
		assert.equal(plain(glyph("queued", 0)), "◌");
		assert.equal(plain(glyph("waiting", 0)), "◌");
		assert.equal(plain(glyph("done", 0)), "✓");
		assert.equal(plain(glyph("stopped", 0)), "✗");
	});

	it("show mode and where each row works: branch for write, @short commit for review, the root's branch", () => {
		const rows = dashboardRows(
			[main({ busy: true }), agent(2, "reviewer-a"), agent(3, "writer", { mode: "write" })],
			NOW,
		);
		assert.deepEqual(
			rows.map((row) => [row.facts.name, row.mode, row.where]),
			[
				["main", "main", "main"],
				["reviewer-a", "review", "@abc1234"],
				["writer", "write", "makora/writer-abcdef-3"],
			],
		);
	});

	it("measure the budget bar against usd, else minutes, else turns, and none for the root", () => {
		const rows = dashboardRows(
			[
				main({ costUsd: 5 }),
				agent(2, "by-cost", { budget: { turns: 50, usd: 0.5, minutes: 1 }, facts: { costUsd: 0.25 } }),
				agent(3, "by-time", { budget: { turns: 50, minutes: 4 } }),
				agent(4, "by-turns", { facts: { turns: 10 } }),
			],
			NOW,
		);
		const budgets = Object.fromEntries(rows.map((row) => [row.facts.name, row.budget]));
		assert.equal(budgets.main, undefined);
		assert.deepEqual(budgets["by-cost"], { limit: "usd", fraction: 0.5 });
		// Started a minute before NOW and still running.
		assert.deepEqual(budgets["by-time"], { limit: "minutes", fraction: 0.25 });
		assert.deepEqual(budgets["by-turns"], { limit: "turns", fraction: 0.2 });
	});

	it("fill a 5-cell bar: none for no use, one for any use, all at or past the limit", () => {
		assert.deepEqual([0, 0.01, 0.2, 0.21, 0.5, 1, 1.7].map(budgetCells), [0, 1, 1, 2, 3, 5, 5]);
	});

	it("show the running cell's number only while the agent runs", () => {
		const cells = [
			cell(1, "x = 1", { kind: "done", isError: false }),
			cell(2, "await bash('sleep 9')", { kind: "running", startedAt: NOW }),
		];
		const rows = dashboardRows(
			[
				main(),
				agent(2, "busy", { facts: { cells } }),
				agent(3, "finished", { state: DONE_REVIEW, facts: { cells } }),
			],
			NOW,
		);
		assert.deepEqual(
			rows.map((row) => [row.facts.name, row.cell]),
			[
				["busy", 2],
				["main", undefined],
				["finished", undefined],
			],
		);
	});
});

describe("dashboard inspector", () => {
	const extras = (overrides: Partial<InspectorExtras> = {}): InspectorExtras => ({
		kernel: { state: "running", variables: 3, snapshotCell: 2 },
		messages: [],
		changes: { files: 2, added: 3, removed: 1 },
		now: NOW,
		frame: 0,
		tildify: (path) => path,
		...overrides,
	});

	function lines(facts: readonly AgentFacts[], name: string, more: Partial<InspectorExtras> = {}): string[] {
		const row = dashboardRows(facts, NOW).find((each) => each.facts.name === name)!;
		return inspectorLines(row, extras(more), 120).map(plain);
	}

	it("describe a waiting writer: origin, task, kernel, budgets, recent cells, messages, worktree and result", () => {
		const messages: AgentMessage[] = [
			{
				from: "reviewer-b",
				to: "writer",
				fromConversationId: id(3),
				toConversationId: id(4),
				text: "add a usage\nline",
				at: NOW,
			},
			{
				from: "reviewer-a",
				to: "main",
				fromConversationId: id(2),
				toConversationId: ROOT,
				text: "unrelated",
				at: NOW,
			},
		];
		const cells = [
			cell(1, "import os", { kind: "done", isError: false }),
			cell(2, "\nx = open('README.md').read()", { kind: "done", isError: true }),
			cell(3, "await write('CHANGES.md', 'x')", { kind: "done", isError: false }),
			cell(4, "print('done')", { kind: "running", startedAt: NOW }),
		];
		const writer = agent(4, "writer", {
			mode: "write",
			state: DONE_WRITE,
			budget: { turns: 50, usd: 0.5 },
			facts: { costUsd: 0.25, turns: 4, cells },
		});
		assert.deepEqual(lines([main(), writer], "writer", { messages }), [
			"writer · write · makora/writer-abcdef-4 from HEAD (abc1234)",
			"task   do the writer work",
			"model  faux/faux-1",
			"kernel running · 3 vars · snapshot @ cell 2",
			"",
			"cost   $0.25 / $0.50",
			"time   30s / no limit",
			"turns  4 / 50",
			"",
			"RECENT CELLS",
			"✗ cell 2 x = open('README.md').read()",
			"✓ cell 3 await write('CHANGES.md', 'x')",
			"⠋ cell 4 print('done')",
			"",
			"MESSAGES",
			"reviewer-b → writer: add a usage ⏎ line",
			"",
			"WORKTREE",
			"+3 −1 · 2 files against abc1234",
			"/worktrees/writer",
			"",
			"RESULT",
			"head fedcba9, 1 files +1 -0",
			"Added the usage line.",
			"Touched README.md only.",
		]);
	});

	it("give a stopped reviewer its stop reason and flag a budget it went over", () => {
		const halted = agent(2, "halted", {
			state: { kind: "stopped", reason: "cost", detail: "spent $0.6000 of $0.5", at: NOW },
			budget: { turns: 50, usd: 0.5 },
			facts: { costUsd: 0.6 },
		});
		const shown = lines([main(), halted], "halted", { kernel: { state: "none", variables: 0 }, changes: undefined });
		assert.equal(shown[0], "halted · review · @abc1234 from HEAD");
		assert.equal(shown[3], "kernel none");
		assert.equal(shown[5], "cost   $0.60 / $0.50 · over");
		assert.deepEqual(shown.slice(-6), [
			"WORKTREE",
			"reading…",
			"/worktrees/halted",
			"",
			"STOPPED",
			"cost: spent $0.6000 of $0.5",
		]);
	});

	it("show the root's branch, used amounts without limits, and its folder", () => {
		const shown = lines([main({ costUsd: 1.5, turns: 7, startedAt: NOW - 5_000, lastAt: NOW })], "main", {
			kernel: { state: "dead", variables: 0 },
		});
		assert.deepEqual(shown, [
			"main · main · main",
			"model  faux/faux-1",
			"kernel dead",
			"",
			"cost   $1.50",
			"time   5s",
			"turns  7",
			"",
			"RECENT CELLS",
			"no cells yet",
			"",
			"FOLDER",
			"/repo",
		]);
	});
});
