import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyOps, type DreamOp } from "../src/memory/dream-ops.ts";
import { type MemoryStore, openMemory } from "../src/memory/store.ts";
import { renderWiki, WIKI_MARKER, wikiData, writeWiki } from "../src/memory/wiki.ts";
import { folderProblem, setupWiki } from "../src/memory/wiki-setup.ts";

/** A store with one session and one claim about session titles. */
function memory(): MemoryStore {
	const store = openMemory(":memory:");
	store.db.exec(`INSERT INTO projects VALUES ('github.com/me/demo', 'demo');
		INSERT INTO sessions (id, project, title, cwd, created_at, updated_at) VALUES ('s1', 'github.com/me/demo', 'Naming sessions', '/r', 0, 0);
		INSERT INTO dreams (id, status, project, cwd, budget_usd, created_at) VALUES (1, 'running', 'github.com/me/demo', '/r', 1, 1);
		INSERT INTO episodes (id, session, conversation, entry, role, text, hash)
		VALUES (1, 's1', 'c', 'e1', 'user', 'Titles come from the first line: keep it that way.', 'h')`);
	const create: DreamOp = {
		op: "create",
		ref: "n1",
		subject: "Session titles",
		kind: "decision",
		scope: "project",
		statement: "A session's title comes from its first line.",
		evidence: [{ episode: 1, quote: "Titles come from the first line", polarity: "supports" }],
	};
	applyOps(store.db, [create], { dream: 1, project: "github.com/me/demo", promptVersion: "t", now: 86_400_000 });
	return store;
}

describe("rendering the wiki", () => {
	it("gives the same bytes for the same rows", () => {
		const store = memory();
		const once = renderWiki(wikiData(store), "makora");
		const twice = renderWiki(wikiData(store), "makora");
		assert.deepEqual([...once], [...twice]);
		assert.deepEqual([...once.keys()].sort(), [
			".makora-wiki",
			"bases/Sessions.base",
			"bases/Subjects.base",
			"demo/index.md",
			"demo/session-titles.md",
			"index.md",
			"sessions/s1.md",
		]);
	});

	it("writes a subject page with frontmatter, quotes and wikilinks into the folder", () => {
		const page = renderWiki(wikiData(memory()), "notes").get("demo/session-titles.md")!;
		assert.match(
			page,
			/^---\nmakora: subject\nid: "session-titles"\nproject: "demo"\ntitle: "Session titles"\naliases: \["Session titles"\]\nclaims: 1\n/,
		);
		assert.match(page, /- \*\*decision\*\* · confirmed — A session's title comes from its first line\./);
		assert.match(page, /"Titles come from the first line" — \[\[notes\/sessions\/s1\|Naming sessions\]\]/);
	});

	it("keeps a page's file name when its subject is retitled", () => {
		const store = memory();
		store.db.prepare("UPDATE subjects SET title = 'How sessions get names'").run();
		const pages = renderWiki(wikiData(store), "makora");
		assert.ok(pages.has("demo/session-titles.md"));
		assert.match(pages.get("demo/session-titles.md")!, /aliases: \["How sessions get names"\]/);
	});

	it("shows a superseded wording under History", () => {
		const store = memory();
		store.db.exec(`INSERT INTO claim_versions (claim, statement, status, recorded_at, retracted_at, prompt_version)
			VALUES (1, 'Titles were picked by hand.', 'confirmed', 0, 86400000, 't')`);
		const page = renderWiki(wikiData(store), "makora").get("demo/session-titles.md")!;
		assert.match(page, /## History\n\n- until 1970-01-02: Titles were picked by hand\./);
	});

	it("gives two projects with one name two folders", () => {
		const store = memory();
		store.db.exec("INSERT INTO projects VALUES ('github.com/other/demo', 'demo')");
		const pages = renderWiki(wikiData(store), "makora");
		assert.ok([...pages.keys()].some((path) => /^demo-[0-9a-f]{6}\/index\.md$/.test(path)));
	});
});

describe("writing the wiki", () => {
	it("writes only changed pages and deletes pages that are gone", () => {
		const store = memory();
		const root = mkdtempSync(join(tmpdir(), "makora-wiki-"));
		const first = writeWiki(store, root, renderWiki(wikiData(store), "makora"));
		assert.deepEqual(first, { written: 7, deleted: 0, unchanged: 0 });
		assert.deepEqual(writeWiki(store, root, renderWiki(wikiData(store), "makora")), {
			written: 0,
			deleted: 0,
			unchanged: 7,
		});

		// A new statement changes its subject page and the session page that links to it, nothing else.
		store.db.prepare("UPDATE claims SET statement = 'Titles come from the first line.'").run();
		assert.deepEqual(writeWiki(store, root, renderWiki(wikiData(store), "makora")), {
			written: 2,
			deleted: 0,
			unchanged: 5,
		});

		const pages = renderWiki(wikiData(store), "makora");
		pages.delete("sessions/s1.md");
		assert.deepEqual(writeWiki(store, root, pages), { written: 0, deleted: 1, unchanged: 6 });
		assert.equal(existsSync(join(root, "sessions", "s1.md")), false);
	});

	it("writes again a page someone changed by hand", () => {
		const store = memory();
		const root = mkdtempSync(join(tmpdir(), "makora-wiki-"));
		writeWiki(store, root, renderWiki(wikiData(store), "makora"));
		writeFileSync(join(root, "index.md"), "edited");
		assert.equal(writeWiki(store, root, renderWiki(wikiData(store), "makora")).written, 1);
		assert.match(readFileSync(join(root, "index.md"), "utf8"), /^# Memory/);
	});
});

describe("setting up the wiki", () => {
	const place = () => mkdtempSync(join(tmpdir(), "makora-vault-"));

	it("makes a missing path a new vault with the folder", () => {
		const vault = join(place(), "vault");
		const setup = setupWiki(vault, "makora");
		assert.equal(setup.kind, "ready");
		assert.ok(existsSync(join(vault, ".obsidian")));
		assert.ok(existsSync(join(vault, "makora", WIKI_MARKER)));
		assert.match(setup.kind === "ready" ? setup.notes[0]! : "", /Created a new vault/);
	});

	it("adds only the folder to an existing vault, and runs again safely", () => {
		const vault = place();
		mkdirSync(join(vault, ".obsidian"));
		writeFileSync(join(vault, "mine.md"), "my note");
		assert.equal(setupWiki(vault, "memory").kind, "ready");
		assert.equal(setupWiki(vault, "memory").kind, "ready");
		assert.equal(readFileSync(join(vault, "mine.md"), "utf8"), "my note");
		const again = setupWiki(vault, "memory");
		assert.deepEqual(again.kind === "ready" ? again.notes : ["refused"], []);
	});

	it("refuses a folder holding notes makora did not write", () => {
		const vault = place();
		mkdirSync(join(vault, "notes"));
		writeFileSync(join(vault, "notes", "mine.md"), "my note");
		const setup = setupWiki(vault, "notes");
		assert.equal(setup.kind, "refused");
		assert.match(setup.kind === "refused" ? setup.reason : "", /notes makora did not write/);
	});

	it("refuses a vault path that is a file", () => {
		const file = join(place(), "vault.md");
		writeFileSync(file, "");
		assert.equal(setupWiki(file, "makora").kind, "refused");
	});

	it("says when the vault has Bases turned off, without changing its config", () => {
		const vault = place();
		mkdirSync(join(vault, ".obsidian"));
		const config = join(vault, ".obsidian", "core-plugins.json");
		writeFileSync(config, '{"bases": false}');
		const setup = setupWiki(vault, "makora");
		assert.match(setup.kind === "ready" ? setup.notes.join("\n") : "", /Bases is turned off/);
		assert.equal(readFileSync(config, "utf8"), '{"bases": false}');
	});

	it("takes one plain folder name", () => {
		assert.equal(folderProblem("makora"), undefined);
		assert.equal(folderProblem("my memory"), undefined);
		assert.match(folderProblem("a/b")!, /is a path/);
		assert.match(folderProblem(".obsidian")!, /hidden/);
		assert.match(folderProblem(" ")!, /empty/);
	});
});
