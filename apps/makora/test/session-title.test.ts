import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openApp } from "../src/app.ts";
import { createSession, readSession, updateSession } from "../src/sessions.ts";
import { nameSession, titleOf } from "../src/title.ts";

describe("the title a message makes on its own", () => {
	it("is its first line without the marks a message opens with", () => {
		assert.equal(titleOf("hey"), "hey");
		assert.equal(titleOf("\n\nFirst real line\nand the rest"), "First real line");
		assert.equal(titleOf("  `commit it.`  "), "commit it");
		assert.equal(titleOf("# Fix the kernel snapshot"), "Fix the kernel snapshot");
		assert.equal(titleOf('"Plan: ship it."'), "Plan: ship it");
	});

	it("is cut to the length a title keeps", () => {
		assert.equal(titleOf("x".repeat(200))?.length, 80);
	});

	it("is nothing when the message has no word", () => {
		assert.equal(titleOf("   \n\t\n "), undefined);
		assert.equal(titleOf(""), undefined);
	});
});

describe("naming a session with the model", () => {
	it("asks the model and keeps its answer", async () => {
		const home = mkdtempSync(join(tmpdir(), "makora-title-"));
		const app = openApp(home, true);
		const model = app.models.getModel("faux", "faux-1");
		assert.ok(model !== undefined);
		// The fake provider answers a request that offers no tools with what it was asked, so the reply says the
		// first message reached the model and its answer came back through the sanitiser.
		assert.equal(
			await nameSession(app.models, model, "Kernel audit", undefined),
			"Fake model here. You asked: Kernel audit",
		);
		rmSync(home, { recursive: true, force: true });
	});
});

describe("where a session's title came from", () => {
	it("is kept beside the title, so a named session is not named again", () => {
		const dir = mkdtempSync(join(tmpdir(), "makora-sessions-"));
		const meta = createSession(dir, "/tmp", 1_000);
		updateSession(dir, meta, { title: "Kernel audit", titleSource: "model" }, 2_000);
		assert.equal(readSession(dir, meta.id)?.titleSource, "model");
		rmSync(dir, { recursive: true, force: true });
	});

	it("is absent in a meta written before titles had a source", () => {
		const dir = mkdtempSync(join(tmpdir(), "makora-sessions-"));
		const meta = createSession(dir, "/tmp", 1_000);
		const file = join(dir, meta.id, "meta.json");
		writeFileSync(file, JSON.stringify({ id: meta.id, cwd: "/tmp", title: "old", createdAt: 1, updatedAt: 1 }));
		assert.deepEqual(readFileSync(file, "utf8").includes("titleSource"), false);
		const read = readSession(dir, meta.id);
		assert.equal(read?.title, "old");
		assert.equal(read?.titleSource, undefined);
		rmSync(dir, { recursive: true, force: true });
	});
});
