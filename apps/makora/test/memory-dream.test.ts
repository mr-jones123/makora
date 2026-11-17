import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { calculateCost, createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { cancelDream, type DreamDeps, dreamRow, runDream, startDream } from "../src/memory/dream.ts";
import { projectOf } from "../src/memory/project.ts";
import { type MemoryStore, memoryPath, openMemory, selectClaims } from "../src/memory/store.ts";
import { openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";

/** A home with one finished session in a git repository whose remote names the project. */
async function workspace(): Promise<{ home: string; repo: string; sessions: string }> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-dream-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "git@github.com:me/demo.git"], { cwd: repo });
	writeFileSync(join(repo, "README.md"), "# demo\n");
	const app = openApp(home, true);
	const session = await openSession(app, createSession(app.paths.sessions, repo), {}, BACKGROUND_CONTEXT);
	const submission = await session.submit(
		session.root,
		"We decided that session titles come from the first line of the first message.",
		BACKGROUND_CONTEXT,
	);
	await submission?.wait(BACKGROUND_CONTEXT);
	await session.close();
	return { home, repo, sessions: app.paths.sessions };
}

/** The user episode the analyzer is shown: `[E<id> user]` and its first line. */
function userEpisode(text: string): { id: number; line: string } {
	const match = /\[E(\d+) user\]\n(.+)/.exec(text)!;
	return { id: Number(match[1]), line: match[2]! };
}

function lastUserText(messages: readonly Message[]): string {
	const message = messages.findLast((each) => each.role === "user")!;
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** A dream's models: a priced faux provider whose replies depend on which prompt asked. */
function scriptedDeps(home: string, sessions: string, organizer: (input: string) => object): DreamDeps {
	const models = createModels();
	const faux = fauxProvider({
		api: "dream-faux",
		provider: "dream",
		models: [{ id: "cheap", name: "Cheap", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
	});
	models.setProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			faux.appendResponses([
				(transcript) => {
					const system = transcript.messages.find((each) => each.role === "system");
					const input = lastUserText(transcript.messages);
					const analyzing =
						typeof system?.content === "string" && system.content.includes("one part of a coding session");
					if (analyzing) {
						const episode = userEpisode(input);
						const note = {
							subject: "Session titles",
							kind: "decision",
							scope: "project",
							statement: "A session's title comes from the first line of its first message.",
							evidence: [
								{ episode: episode.id, quote: "session titles come from the first line", polarity: "supports" },
							],
						};
						return fauxAssistantMessage([fauxText(`\`\`\`json\n${JSON.stringify({ notes: [note] })}\n\`\`\``)]);
					}
					return fauxAssistantMessage([fauxText(JSON.stringify(organizer(input)))]);
				},
			]);
			// Real providers price their usage; the faux one does not, so the test prices it as makora's fake provider does.
			const source = faux.provider.streamSimple(model, context, options);
			const priced = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done") calculateCost(model, event.message.usage);
					priced.push(event);
				}
				priced.end(await source.result());
			})();
			return priced;
		},
	});
	const model = models.getModel("dream", "cheap")!;
	return {
		home,
		sessionsDir: sessions,
		models,
		analyzer: { model },
		organizer: { model },
		embed: undefined,
		log: () => {},
	};
}

/** The organizer turning the one note into a create, plus two operations the checks must drop. */
function organize(input: string): object {
	const quote = /E(\d+) supports: "([^"]+)"/.exec(input)!;
	const episode = Number(quote[1]);
	return {
		ops: [
			{
				op: "create",
				ref: "n1",
				subject: "Session titles",
				kind: "decision",
				scope: "project",
				statement: "A session's title comes from the first line of its first message.",
				evidence: [{ episode, quote: quote[2], polarity: "supports" }],
			},
			{
				op: "create",
				ref: "n2",
				subject: "Invented",
				kind: "fact",
				scope: "project",
				statement: "Something no transcript says.",
				evidence: [{ episode, quote: "words that are not in the episode", polarity: "supports" }],
			},
			{ op: "supersede", claim: 999, by: "n1" },
		],
		report: "Recorded how sessions are titled.",
		agentsMd: ["Commit only when asked."],
	};
}

describe("a dream", () => {
	let place: { home: string; repo: string; sessions: string };
	let store: MemoryStore;
	before(async () => {
		place = await workspace();
		store = openMemory(memoryPath(place.home));
	});
	after(() => {
		store.close();
		rmSync(join(place.home, ".."), { recursive: true, force: true });
	});

	it("turns a finished session into a claim with its evidence, and drops what no transcript shows", async () => {
		const project = await projectOf(place.repo);
		assert.equal(project.id, "github.com/me/demo");
		const start = startDream(store, place.home, { project, cwd: place.repo, budgetUsd: 5 });
		assert.equal(start.kind, "started");
		const id = start.kind === "started" ? start.id : 0;
		assert.equal(dreamRow(store, id)?.status, "pending");

		const status = await runDream(store, id, scriptedDeps(place.home, place.sessions, organize));
		const dream = dreamRow(store, id)!;
		assert.equal(status, "completed", dream.error ?? "");
		const claims = selectClaims(store.db, "1");
		assert.deepEqual(
			claims.map((claim) => [claim.subjectTitle, claim.status, claim.statement]),
			[["Session titles", "confirmed", "A session's title comes from the first line of its first message."]],
		);
		const evidence = store.db.prepare("SELECT quote, polarity FROM evidence").all();
		assert.deepEqual(
			evidence.map((row) => ({ ...row })),
			[{ quote: "session titles come from the first line", polarity: "supports" }],
		);
		assert.match(dream.report!, /Created 1/);
		assert.match(dream.report!, /quote not found in episode/);
		assert.match(dream.report!, /no claim 999/);
		assert.match(dream.report!, /Suggested for AGENTS.md:\n- Commit only when asked/);
		assert.ok(dream.cost_usd > 0, "the dream records what it spent");
	});

	it("finds nothing to do when no session changed since", async () => {
		const project = await projectOf(place.repo);
		const start = startDream(store, place.home, { project, cwd: place.repo, budgetUsd: 5 });
		const id = start.kind === "started" ? start.id : 0;
		assert.equal(await runDream(store, id, scriptedDeps(place.home, place.sessions, organize)), "completed");
		assert.match(dreamRow(store, id)!.report!, /No session has changed/);
		assert.equal(selectClaims(store.db, "1").length, 1);
	});

	it("is canceled before its worker starts it", async () => {
		const project = await projectOf(place.repo);
		const start = startDream(store, place.home, { project, cwd: place.repo, budgetUsd: 5 });
		const id = start.kind === "started" ? start.id : 0;
		assert.equal(cancelDream(store, id)?.status, "canceled");
		assert.equal(await runDream(store, id, scriptedDeps(place.home, place.sessions, organize)), "canceled");
	});

	it("marks a dream whose worker died as failed when the next one starts", async () => {
		const project = await projectOf(place.repo);
		store.db.prepare("UPDATE dreams SET status = 'running' WHERE id = (SELECT max(id) FROM dreams)").run();
		const stuck = dreamRow(store)!.id;
		const start = startDream(store, place.home, { project, cwd: place.repo, budgetUsd: 5 });
		assert.equal(start.kind, "started");
		assert.equal(dreamRow(store, stuck)?.status, "failed");
		assert.match(dreamRow(store, stuck)!.error!, /worker stopped/);
	});
});

describe("a dream over its budget", () => {
	it("fails on its estimate before any model call, and applies nothing", async () => {
		const place = await workspace();
		const store = openMemory(memoryPath(place.home));
		const start = startDream(store, place.home, {
			project: await projectOf(place.repo),
			cwd: place.repo,
			budgetUsd: 0,
		});
		const id = start.kind === "started" ? start.id : 0;
		let calls = 0;
		const deps = scriptedDeps(place.home, place.sessions, (input) => {
			calls++;
			return organize(input);
		});
		assert.equal(await runDream(store, id, deps), "failed");
		assert.match(dreamRow(store, id)!.error!, /estimated cost .* over the budget \$0\.00/);
		assert.equal(calls, 0);
		assert.equal(selectClaims(store.db, "1").length, 0);
		store.close();
		rmSync(join(place.home, ".."), { recursive: true, force: true });
	});
});
