import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { EmbedConfig } from "../src/memory/embed.ts";
import { embedPending, search } from "../src/memory/search.ts";
import { type MemoryStore, openMemory, vectorModel } from "../src/memory/store.ts";

// A stand-in for Ollama's /api/embed: storage words and their synonyms point one way, everything else another, so a
// query can match a claim by meaning with no word in common.
function fakeVector(text: string): number[] {
	return /cache|temporary|scratch/i.test(text) ? [1, 0, 0] : /title|name/i.test(text) ? [0, 1, 0] : [0, 0, 1];
}

let server: Server;
let embed: EmbedConfig;
before(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const { input } = JSON.parse(body) as { input: string[] };
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ embeddings: input.map(fakeVector) }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	embed = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: "fake-embed" };
});
after(() => server.close());

/** Claims in two projects, one superseded, and a global one. */
function memory(): MemoryStore {
	const store = openMemory(":memory:");
	store.db.exec(`INSERT INTO projects VALUES ('p', 'demo'), ('q', 'other');
		INSERT INTO subjects (id, project, key, title) VALUES (1, 'p', 'cache', 'Cache'), (2, 'q', 'cache', 'Cache'), (3, NULL, 'naming', 'Naming');
		INSERT INTO claims (id, project, subject, kind, statement, status, created_at, updated_at) VALUES
			(1, 'p', 1, 'decision', 'The cache lives in ~/.cache/demo.', 'confirmed', 1, 1),
			(2, 'p', 1, 'decision', 'The cache used to live in /tmp.', 'superseded', 1, 1),
			(3, 'q', 2, 'decision', 'The other project keeps its cache in the repo.', 'confirmed', 1, 1),
			(4, NULL, 3, 'preference', 'Session titles stay short.', 'confirmed', 1, 1);
		INSERT INTO sessions (id, project, cwd, created_at, updated_at) VALUES ('s', 'p', '/r', 1, 1);
		INSERT INTO episodes (session, conversation, entry, role, text, hash) VALUES ('s', 'c', 'e', 'user', 'where does the cache go', 'h')`);
	return store;
}

describe("memory search", () => {
	it("finds a project's live claims and global ones by words, and leaves out other projects and superseded claims", async () => {
		const store = memory();
		const found = await search(store, "cache", { project: "p", limit: 10, episodes: false });
		assert.deepEqual(
			found.hits.map((hit) => (hit.kind === "claim" ? hit.claim.id : hit.id)),
			[1],
		);
		assert.match(found.note!, /vector search is off/);
		const global = await search(store, "titles", { project: "p", limit: 10, episodes: false });
		assert.deepEqual(
			global.hits.map((hit) => (hit.kind === "claim" ? hit.claim.id : hit.id)),
			[4],
		);
	});

	it("reads punctuation and FTS operators in a query as words, not syntax", async () => {
		const store = memory();
		const found = await search(store, `"cache" OR) don't: NEAR(`, { project: "p", limit: 10, episodes: false });
		assert.equal(found.hits.length, 1);
	});

	it("finds a claim by meaning once claims are embedded, with no word in common", async () => {
		const store = memory();
		const words = await search(store, "where do temporary files go", {
			project: "p",
			limit: 5,
			episodes: false,
			embed,
		});
		assert.equal(words.hits.length, 0, "no claim shares a word");
		assert.match(words.note!, /nothing is embedded yet/);

		const result = await embedPending(store, embed, 100);
		assert.equal(result.embedded, 5, "four claims and one episode");
		assert.equal(vectorModel(store), "fake-embed:3");
		const meaning = await search(store, "where do temporary files go", {
			project: "p",
			limit: 5,
			episodes: false,
			embed,
		});
		assert.equal(meaning.note, undefined);
		assert.equal(meaning.hits[0]?.kind === "claim" && meaning.hits[0].claim.id, 1);
	});

	it("searches episodes when asked", async () => {
		const store = memory();
		const found = await search(store, "cache", { project: "p", limit: 10, episodes: true });
		assert.ok(found.hits.some((hit) => hit.kind === "episode" && hit.text === "where does the cache go"));
	});

	it("says why vectors did not take part when Ollama is down, and still ranks by words", async () => {
		const store = memory();
		await embedPending(store, embed, 100);
		const down = { url: "http://127.0.0.1:9", model: "fake-embed" };
		const found = await search(store, "cache", { project: "p", limit: 5, episodes: false, embed: down });
		assert.equal(found.hits.length, 1);
		assert.match(found.note!, /Ollama is not reachable/);
		assert.match((await embedPending(store, down, 10)).note ?? "nothing pending", /nothing pending|not reachable/);
	});

	it("embeds everything again under a new model, since vectors of two models cannot be compared", async () => {
		const store = memory();
		await embedPending(store, embed, 100);
		const again = await embedPending(store, { ...embed, model: "other-embed" }, 100);
		assert.equal(again.embedded, 5);
		assert.equal(vectorModel(store), "other-embed:3");
	});
});
