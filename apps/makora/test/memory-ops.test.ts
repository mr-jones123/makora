import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOps, checkOps, type DreamOp, type DreamScope, subjectKey } from "../src/memory/dream-ops.ts";
import { type MemoryStore, openMemory, selectClaims } from "../src/memory/store.ts";

/** A store holding one session with two episodes, in project `p`. */
function store(): MemoryStore {
	const memory = openMemory(":memory:");
	memory.db.exec(`INSERT INTO projects VALUES ('p', 'demo');
		INSERT INTO sessions (id, project, cwd, created_at, updated_at) VALUES ('s1', 'p', '/r', 1, 1);
		INSERT INTO dreams (id, status, project, cwd, budget_usd, created_at) VALUES (1, 'running', 'p', '/r', 1, 1);
		INSERT INTO episodes (id, session, conversation, entry, role, text, hash)
		VALUES (1, 's1', 'c', 'e1', 'user', 'We decided the cache lives in ~/.cache/demo.', 'h1'),
		       (2, 's1', 'c', 'e2', 'assistant', 'The cache  moved to\n~/.cache/demo2 in the end.', 'h2')`);
	return memory;
}

function scope(memory: MemoryStore): DreamScope {
	const episodes = new Map(
		(memory.db.prepare("SELECT id, text FROM episodes").all() as { id: number; text: string }[]).map((row) => [
			row.id,
			row.text,
		]),
	);
	const claims = new Set(selectClaims(memory.db, "1").map((claim) => claim.id));
	const subjects = new Set(
		(memory.db.prepare("SELECT key FROM subjects").all() as { key: string }[]).map((row) => row.key),
	);
	return { project: "p", episodes, claims, subjects };
}

const create = (ref: string, statement: string, episode: number, quote: string): DreamOp => ({
	op: "create",
	ref,
	subject: "Cache location",
	kind: "decision",
	scope: "project",
	statement,
	evidence: [{ episode, quote, polarity: "supports" }],
});

const context = { dream: 1, project: "p", promptVersion: "test", now: 1_000 };

describe("checking a dream's operations", () => {
	it("keeps a quote found in its episode, ignoring case and re-flowed whitespace", () => {
		const memory = store();
		const checked = checkOps([create("n1", "Cache moved.", 2, "the CACHE moved to ~/.cache/demo2")], scope(memory));
		assert.equal(checked.ops.length, 1);
		assert.deepEqual(checked.dropped, []);
	});

	it("drops a claim whose quotes no episode holds, and says why", () => {
		const memory = store();
		const checked = checkOps([create("n1", "Invented.", 1, "words nobody wrote")], scope(memory));
		assert.equal(checked.ops.length, 0);
		assert.match(checked.dropped[0]!, /quote not found in episode 1/);
		assert.match(checked.dropped[1]!, /no quote from the transcripts supports it/);
	});

	it("drops a quote from an episode the dream did not read", () => {
		const memory = store();
		const checked = checkOps([create("n1", "Cache.", 99, "the cache")], scope(memory));
		assert.equal(checked.ops.length, 0);
	});

	it("drops operations on claims that do not exist, and keeps refs to claims the dream creates", () => {
		const memory = store();
		const ops: DreamOp[] = [
			create("n1", "Cache in ~/.cache/demo.", 1, "the cache lives in ~/.cache/demo"),
			{ op: "link", from: "n1", to: "n2", relation: "part of" },
			{ op: "supersede", claim: 42, by: "n1" },
			{ op: "retitle", subject: "nope", title: "Nope" },
		];
		const checked = checkOps(ops, scope(memory));
		assert.deepEqual(
			checked.ops.map((op) => op.op),
			["create"],
		);
		assert.equal(checked.dropped.length, 3);
	});
});

describe("applying a dream's operations", () => {
	it("supersedes a claim so its history stays, with versions and evidence", () => {
		const memory = store();
		applyOps(
			memory.db,
			[create("n1", "The cache lives in ~/.cache/demo.", 1, "the cache lives in ~/.cache/demo")],
			context,
		);
		const [first] = selectClaims(memory.db, "1");
		const ops: DreamOp[] = [
			create("n2", "The cache lives in ~/.cache/demo2.", 2, "moved to ~/.cache/demo2"),
			{ op: "supersede", claim: first!.id, by: "n2" },
		];
		const applied = applyOps(memory.db, checkOps(ops, scope(memory)).ops, { ...context, now: 2_000 });
		assert.equal(applied.superseded, 1);
		const claims = selectClaims(memory.db, "1");
		assert.deepEqual(
			claims.map((claim) => [claim.statement, claim.status, claim.supersededBy]),
			[
				["The cache lives in ~/.cache/demo.", "superseded", claims[1]!.id],
				["The cache lives in ~/.cache/demo2.", "confirmed", null],
			],
		);
		assert.equal(claims[0]!.subjectKey, claims[1]!.subjectKey, "one subject page holds both");
		const versions = memory.db
			.prepare("SELECT status, retracted_at FROM claim_versions WHERE claim = ? ORDER BY id")
			.all(first!.id);
		assert.deepEqual(
			versions.map((row) => ({ ...row })),
			[
				{ status: "confirmed", retracted_at: 2_000 },
				{ status: "superseded", retracted_at: null },
			],
		);
	});

	it("records a dispute between two claims", () => {
		const memory = store();
		applyOps(
			memory.db,
			[create("a", "Cache in demo.", 1, "~/.cache/demo"), create("b", "Cache in demo2.", 2, "~/.cache/demo2")],
			context,
		);
		const [a, b] = selectClaims(memory.db, "1");
		applyOps(memory.db, [{ op: "dispute", claim: a!.id, other: b!.id, reason: "two locations" }], context);
		assert.deepEqual(
			selectClaims(memory.db, "1").map((claim) => claim.status),
			["disputed", "disputed"],
		);
		assert.equal(
			(memory.db.prepare("SELECT reason FROM conflicts").get() as { reason: string }).reason,
			"two locations",
		);
	});

	it("applies all of a dream or none of it", () => {
		const memory = store();
		const broken: DreamOp[] = [
			create("n1", "Cache.", 1, "the cache"),
			// Not checked: an unknown claim makes the confirm fail inside the transaction.
			{ op: "confirm", claim: 999, evidence: [{ episode: 1, quote: "the cache", polarity: "supports" }] },
		];
		assert.throws(() => applyOps(memory.db, broken, context));
		assert.equal(selectClaims(memory.db, "1").length, 0);
	});

	it("keeps none of a dream's changes when recording the dream as done fails", () => {
		const memory = store();
		assert.throws(() =>
			applyOps(memory.db, [create("n1", "Cache.", 1, "the cache")], context, () => {
				throw new Error("disk full");
			}),
		);
		assert.equal(selectClaims(memory.db, "1").length, 0);
	});

	it("files a title under one subject key, whatever its case and punctuation", () => {
		assert.equal(subjectKey("Session titles"), "session-titles");
		assert.equal(subjectKey("  Session   Titles!! "), "session-titles");
		assert.equal(subjectKey("…"), "untitled");
	});
});
