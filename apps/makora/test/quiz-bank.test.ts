import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import type { DiffFile } from "../src/git/diff.ts";
import type { Commit } from "../src/git/log.ts";
import { BankSchema, type QuizBank, resolveBank } from "../src/quiz/bank.ts";

const FIRST: Commit = {
	sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
	subject: "feat: first",
	author: "me",
	date: 1,
	added: 3,
	removed: 1,
};
const SECOND: Commit = {
	sha: "a1b2c3d9999999999999999999999999999999ff",
	subject: "fix: second",
	author: "me",
	date: 2,
	added: 1,
	removed: 0,
};
const OTHER: Commit = {
	sha: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
	subject: "docs: third",
	author: "me",
	date: 3,
	added: 9,
	removed: 2,
};

/** FIRST changes src/a.ts (old lines 1-3, new lines 1-4) and adds a binary logo; OTHER adds a 400-line doc. */
const FILES = new Map<string, readonly DiffFile[]>([
	[
		FIRST.sha,
		[
			{
				path: "src/a.ts",
				status: "M",
				added: 2,
				removed: 1,
				body: {
					kind: "text",
					hunks: [
						{
							header: "@@ -1,3 +1,4 @@",
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 4,
							lines: [
								{ kind: "context", oldNo: 1, newNo: 1, text: "keep" },
								{ kind: "del", oldNo: 2, text: "old" },
								{ kind: "add", newNo: 2, text: "new" },
								{ kind: "add", newNo: 3, text: "more" },
								{ kind: "context", oldNo: 3, newNo: 4, text: "end" },
							],
						},
					],
				},
			},
			{ path: "logo.png", status: "A", added: 0, removed: 0, body: { kind: "binary" } },
		],
	],
	[SECOND.sha, []],
	[
		OTHER.sha,
		[
			{
				path: "docs/b.md",
				status: "A",
				added: 400,
				removed: 0,
				body: {
					kind: "text",
					hunks: [
						{
							header: "@@ -0,0 +1,400 @@",
							oldStart: 0,
							oldLines: 0,
							newStart: 1,
							newLines: 400,
							lines: Array.from({ length: 400 }, (_, index) => ({
								kind: "add" as const,
								newNo: index + 1,
								text: `doc ${index + 1}`,
							})),
						},
					],
				},
			},
		],
	],
]);

const COMMITS = [FIRST, SECOND, OTHER];

function annotation(change: Partial<QuizBank["annotations"][number]> = {}) {
	return {
		commit: "a1b2c3d4",
		file: "src/a.ts",
		line: 2,
		side: "new" as const,
		comment: "Replaces `old`, because the decision says so.",
		...change,
	};
}

function question(index: number, cites: string[] = ["a1b2c3d4"]) {
	return {
		question: `Why was choice ${index} made?`,
		options: ["Because of A", "Because of B", "Because of C", "Because of D"],
		correct: index % 4,
		explanation: `A source says so (${index}).`,
		category: "why" as const,
		cites,
	};
}

function bank(change: Partial<QuizBank> = {}): QuizBank {
	return {
		range: "a1b2c3d4^..HEAD",
		summaries: { a1b2c3d4: "Adds the first part.", a1b2c3d9: "Fixes the second.", "0f0f0f0": "Documents it." },
		decisions: [{ title: "Static page", summary: "The page scores itself; nothing is sent back." }],
		annotations: [annotation()],
		questions: Array.from({ length: 10 }, (_, index) => question(index)),
		...change,
	};
}

const schema = compile(BankSchema);

describe("the bank's schema", () => {
	it("accepts a bank with 10 questions of 4 options, a correct index, an explanation, a category and cites", () => {
		assert.deepEqual(schema.errors(bank()), []);
	});

	it("rejects each malformed field at its path", () => {
		const cases: [string, unknown][] = [
			["/questions/0/options", { ...question(0), options: ["a", "b", "c"] }],
			["/questions/0/correct", { ...question(0), correct: 4 }],
			["/questions/0/correct", { ...question(0), correct: 1.5 }],
			["/questions/0/cites", { ...question(0), cites: [] }],
			["/questions/0/category", { ...question(0), category: "trivia" }],
			["/questions/0/explanation", { ...question(0), explanation: "   " }],
			["/questions/0", { ...question(0), hint: "extra" }],
		];
		for (const [path, change] of [
			["/annotations/0/comment", { comment: "x".repeat(601) }],
			["/annotations/0/comment", { comment: " " }],
			["/annotations/0/side", { side: "both" }],
			["/annotations/0/line", { line: 0 }],
		] as const) {
			const errors = schema.errors({ ...bank(), annotations: [{ ...annotation(), ...change }] });
			assert.ok(
				errors.some((error) => error.path.startsWith(path)),
				`${JSON.stringify(change)} fails at ${path}: ${JSON.stringify(errors)}`,
			);
		}
		for (const [path, first] of cases) {
			const questions = [first, ...bank().questions.slice(1)];
			const errors = schema.errors({ ...bank(), questions });
			assert.ok(
				errors.some((error) => error.path.startsWith(path)),
				`${JSON.stringify(first)} fails at ${path}: ${JSON.stringify(errors)}`,
			);
		}
	});

	it("rejects a bank without exactly 10 questions and a range that reads as an option", () => {
		assert.ok(
			schema.errors(bank({ questions: bank().questions.slice(1) })).some((error) => error.path === "/questions"),
		);
		assert.ok(schema.errors(bank({ range: "--all" })).some((error) => error.path === "/range"));
	});
});

describe("checking a bank against its range", () => {
	it("gives each commit, oldest first, its summary by sha prefix, and resolves each cite", () => {
		const questions = [
			question(0, ["a1b2c3d4", "static page", "docs/decisions.md", "src/a.ts:2"]),
			...bank().questions.slice(1),
		];
		const resolved = resolveBank(bank({ questions }), COMMITS, FILES);
		assert.equal(resolved.kind, "ok");
		if (resolved.kind !== "ok") return;
		assert.deepEqual(
			resolved.value.commits.map((commit) => [commit.sha, commit.summary]),
			[
				[FIRST.sha, "Adds the first part."],
				[SECOND.sha, "Fixes the second."],
				[OTHER.sha, "Documents it."],
			],
		);
		assert.deepEqual(resolved.value.questions[0]!.cites, [
			{ kind: "commit", text: "a1b2c3d4", sha: FIRST.sha },
			{ kind: "decision", text: "static page", index: 0 },
			{ kind: "source", text: "docs/decisions.md" },
			{ kind: "note", text: "src/a.ts:2", index: 0 },
		]);
	});

	it("places annotations on a line of their commit's diff, on either side, past the page's cap too", () => {
		const annotations = [
			annotation({ cites: ["static page", "src/a.ts:4"] }),
			annotation({ line: 2, side: "old" }),
			annotation({ line: 4, comment: "  Ends the file.  " }),
			annotation({ commit: "0f0f0f0", file: "docs/b.md", line: 350 }),
		];
		const resolved = resolveBank(bank({ annotations }), COMMITS, FILES);
		assert.equal(resolved.kind, "ok", JSON.stringify(resolved));
		if (resolved.kind !== "ok") return;
		assert.deepEqual(
			resolved.value.notes.map((note) => [note.sha, note.path, note.side, note.line, note.comment]),
			[
				[FIRST.sha, "src/a.ts", "new", 2, "Replaces `old`, because the decision says so."],
				[FIRST.sha, "src/a.ts", "old", 2, "Replaces `old`, because the decision says so."],
				[FIRST.sha, "src/a.ts", "new", 4, "Ends the file."],
				[OTHER.sha, "docs/b.md", "new", 350, "Replaces `old`, because the decision says so."],
			],
		);
		assert.deepEqual(resolved.value.notes[0]!.cites, [
			{ kind: "decision", text: "static page", index: 0 },
			{ kind: "note", text: "src/a.ts:4", index: 2 },
		]);
	});

	it("refuses annotations off their commit's diff: a bad commit, file, line or side, a binary file, a cite of no note", () => {
		const annotations = [
			annotation({ commit: "deadbeef" }),
			annotation({ file: "src/missing.ts" }),
			annotation({ line: 99 }),
			annotation({ line: 4, side: "old" }),
			annotation({ file: "logo.png", line: 1 }),
		];
		const questions = [question(0, ["src/a.ts:9"]), ...bank().questions.slice(1)];
		const resolved = resolveBank(bank({ annotations, questions }), COMMITS, FILES);
		assert.equal(resolved.kind, "invalid");
		if (resolved.kind !== "invalid") return;
		assert.deepEqual(resolved.errors, [
			"annotations[0].commit: deadbeef is not a commit of a1b2c3d4^..HEAD",
			"annotations[1].file: src/missing.ts is not in a1b2c3d4e's diff",
			"annotations[2].line: src/a.ts has no new line 99 in a1b2c3d4e's diff; its new lines there are 1-4",
			"annotations[3].line: src/a.ts has no old line 4 in a1b2c3d4e's diff; its old lines there are 1-3",
			"annotations[4].file: logo.png has no text diff in a1b2c3d4e",
			"questions[0].cites[0]: no annotation at src/a.ts:9",
		]);
	});

	it("lists every problem: a missing summary, a sha outside the range, an ambiguous prefix, repeated options", () => {
		const questions = [
			question(0, ["deadbeef"]),
			{ ...question(1, ["a1b2c3d"]), options: ["Same", "same", "Other", "Third"] },
			...bank().questions.slice(2),
		];
		const resolved = resolveBank(
			bank({ summaries: { a1b2c3d4: "Adds the first part." }, questions }),
			COMMITS,
			FILES,
		);
		assert.equal(resolved.kind, "invalid");
		if (resolved.kind !== "invalid") return;
		const expected = [
			/^summaries: no summary for a1b2c3d99 \(fix: second\)$/,
			/^summaries: no summary for 0f0f0f0f0 \(docs: third\)$/,
			/^questions\[0\]\.cites\[0\]: deadbeef is not a commit of a1b2c3d4\^\.\.HEAD$/,
			/^questions\[1\]\.cites\[0\]: a1b2c3d matches 2 commits/,
			/^questions\[1\]\.options: two options are the same$/,
		];
		for (const pattern of expected)
			assert.ok(
				resolved.errors.some((error) => pattern.test(error)),
				`${pattern}: ${resolved.errors.join(" | ")}`,
			);
		assert.equal(resolved.errors.length, expected.length);
	});

	it("refuses a range without commits", () => {
		const questions = bank().questions.map((each) => ({ ...each, cites: ["docs/decisions.md"] }));
		const resolved = resolveBank(bank({ summaries: {}, annotations: [], questions }), [], new Map());
		assert.deepEqual(resolved, { kind: "invalid", errors: ["range: a1b2c3d4^..HEAD has no commits"] });
	});
});
