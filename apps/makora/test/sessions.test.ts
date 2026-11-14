import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createSession,
	latestSession,
	listSessions,
	lockSession,
	readSession,
	SessionLockedError,
	updateSession,
} from "../src/sessions.ts";
import { lockInChild } from "./fixtures/lock-child.ts";

const temporarySessions = () => mkdtempSync(join(tmpdir(), "makora-sessions-"));

describe("session list", () => {
	it("lists sessions newest updatedAt first and finds the latest one of a cwd", () => {
		const dir = temporarySessions();
		const a = createSession(dir, "/work/a", 1_000);
		const b = createSession(dir, "/work/b", 2_000);
		const c = createSession(dir, "/work/a", 3_000);
		updateSession(dir, a, { title: "first prompt" }, 4_000);

		assert.deepEqual(
			listSessions(dir).map((meta) => meta.id),
			[a.id, c.id, b.id],
		);
		assert.equal(latestSession(dir, "/work/a")?.id, a.id);
		assert.equal(latestSession(dir, "/work/b")?.id, b.id);
		assert.equal(latestSession(dir, "/work/none"), undefined);
		assert.equal(readSession(dir, a.id)?.title, "first prompt");
	});

	it("gives time-sortable ids and skips directories without a readable meta.json", () => {
		const dir = temporarySessions();
		const older = createSession(dir, "/w", 1_000);
		const newer = createSession(dir, "/w", 2_000);
		assert.ok(older.id < newer.id);
		writeFileSync(join(dir, older.id, "meta.json"), "{not json");
		assert.deepEqual(
			listSessions(dir).map((meta) => meta.id),
			[newer.id],
		);
		assert.deepEqual(listSessions(join(dir, "missing")), []);
	});
});

describe("session lock", () => {
	it("refuses a session another process holds, naming its pid", async () => {
		const dir = temporarySessions();
		const meta = createSession(dir, "/w");
		const holder = lockInChild(dir, meta.id, 30_000);
		try {
			assert.deepEqual(await holder.outcome, { locked: true });
			assert.throws(
				() => lockSession(dir, meta.id),
				(error: unknown) => error instanceof SessionLockedError && error.pid === holder.child.pid,
			);
		} finally {
			holder.child.kill("SIGKILL");
		}
	});

	it("holds a session once per process until released", async () => {
		const dir = temporarySessions();
		const meta = createSession(dir, "/w");
		const lock = lockSession(dir, meta.id);
		assert.throws(() => lockSession(dir, meta.id), SessionLockedError);
		assert.deepEqual(await lockInChild(dir, meta.id, 0).outcome, { locked: false, holder: process.pid });
		lock.release();
		lockSession(dir, meta.id).release();
	});

	it("gives the lock of a killed holder to exactly one of several concurrent openers", async () => {
		const dir = temporarySessions();
		const meta = createSession(dir, "/w");
		const holder = lockInChild(dir, meta.id, 30_000);
		assert.deepEqual(await holder.outcome, { locked: true });
		holder.child.kill("SIGKILL");
		await once(holder.child, "exit");

		const openers = Array.from({ length: 6 }, () => lockInChild(dir, meta.id, 3_000));
		try {
			const outcomes = await Promise.all(openers.map((opener) => opener.outcome));
			assert.equal(outcomes.filter((outcome) => outcome.locked).length, 1, JSON.stringify(outcomes));
		} finally {
			for (const opener of openers) opener.child.kill("SIGKILL");
		}
	});
});
