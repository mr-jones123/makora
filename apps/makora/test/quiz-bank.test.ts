import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compile } from "@earendil-works/pi-schema";
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
		const questions = [question(0, ["a1b2c3d4", "static page", "docs/decisions.md"]), ...bank().questions.slice(1)];
		const resolved = resolveBank(bank({ questions }), [FIRST, SECOND, OTHER]);
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
		]);
	});

	it("lists every problem: a missing summary, a sha outside the range, an ambiguous prefix, repeated options", () => {
		const questions = [
			question(0, ["deadbeef"]),
			{ ...question(1, ["a1b2c3d"]), options: ["Same", "same", "Other", "Third"] },
			...bank().questions.slice(2),
		];
		const resolved = resolveBank(bank({ summaries: { a1b2c3d4: "Adds the first part." }, questions }), [
			FIRST,
			SECOND,
			OTHER,
		]);
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
		const resolved = resolveBank(bank({ summaries: {}, questions }), []);
		assert.deepEqual(resolved, { kind: "invalid", errors: ["range: a1b2c3d4^..HEAD has no commits"] });
	});
});
