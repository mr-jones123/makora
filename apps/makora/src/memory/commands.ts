// Memory's commands, shared by the command line and the TUI: starting, watching and canceling a dream, running one as
// the worker process, setting up the wiki and rendering it. Each returns the text to show.
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { defaultModel, type MakoraApp } from "../app.ts";
import { tildify } from "../paths.ts";
import { clampThinking, type Tier } from "../pstack.ts";
import {
	cancelDream,
	type DreamModel,
	type DreamRow,
	dreamRow,
	runDream,
	spawnDreamWorker,
	startDream,
} from "./dream.ts";
import { projectOf } from "./project.ts";
import { memoryPath, openMemory } from "./store.ts";
import { renderWiki, wikiData, writeWiki } from "./wiki.ts";
import { setupWiki } from "./wiki-setup.ts";

/** `/dream`: start a dream for the project of `cwd` and its detached worker. */
export async function dreamCommand(app: MakoraApp, cwd: string): Promise<string> {
	const project = await projectOf(cwd);
	const store = openMemory(memoryPath(app.paths.home));
	try {
		const start = startDream(store, app.paths.home, { project, cwd, budgetUsd: app.settings.memory.dreamBudgetUsd });
		if (start.kind === "busy")
			return `Dream ${start.id ?? "?"} is still running; /dream status shows it, /dream cancel stops it.`;
		const log = spawnDreamWorker(app.paths.home, start.id, app.fake);
		return `Dream ${start.id} started for ${project.name}, budget $${app.settings.memory.dreamBudgetUsd.toFixed(2)}. /dream status shows how it goes; its log is ${tildify(log)}.`;
	} finally {
		store.close();
	}
}

/** `/dream status [id]`: dream `id`, or the newest. */
export function dreamStatusCommand(app: MakoraApp, id: number | undefined): string {
	const store = openMemory(memoryPath(app.paths.home));
	try {
		const dream = dreamRow(store, id);
		return dream === undefined
			? id === undefined
				? "No dream yet; /dream starts one."
				: `No dream ${id}.`
			: describeDream(dream);
	} finally {
		store.close();
	}
}

/** `/dream cancel [id]`: stop dream `id`, or the newest. */
export function dreamCancelCommand(app: MakoraApp, id: number | undefined): string {
	const store = openMemory(memoryPath(app.paths.home));
	try {
		const target = id ?? dreamRow(store)?.id;
		if (target === undefined) return "No dream to cancel.";
		const dream = cancelDream(store, target);
		if (dream === undefined) return `No dream ${target}.`;
		return dream.status === "running" ? `Dream ${target} stops at its next step.` : describeDream(dream);
	} finally {
		store.close();
	}
}

/** The worker process: run dream `id` and render the wiki after it, if one is set up. Returns the exit code. */
export async function dreamWorkerCommand(app: MakoraApp, id: number): Promise<number> {
	const store = openMemory(memoryPath(app.paths.home));
	try {
		const analyzer = await tierModel(app, "code");
		const organizer = await tierModel(app, "judge");
		if (analyzer === undefined || organizer === undefined) {
			store.db
				.prepare("UPDATE dreams SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status = 'pending'")
				.run("no model is available; log in to a provider or set one with /model", Date.now(), id);
			return 1;
		}
		const status = await runDream(store, id, {
			home: app.paths.home,
			sessionsDir: app.paths.sessions,
			models: app.models,
			analyzer,
			organizer,
			embed: app.settings.memory.embed,
			log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
			afterApply: async () => (app.settings.memory.vault === undefined ? undefined : wikiCommand(app)),
		});
		process.stdout.write(`${new Date().toISOString()} dream ${id}: ${status}\n`);
		return status === "completed" ? 0 : 1;
	} finally {
		store.close();
	}
}

/** `/wiki-setup <vault> [folder]`: make the wiki folder, remember it, and render once. */
export function wikiSetupCommand(app: MakoraApp, vault: string, folder: string | undefined): string {
	const previous = app.settings.memory;
	const chosen = folder ?? previous.folder;
	const setup = setupWiki(vault, chosen);
	if (setup.kind === "refused") return `Wiki not set up: ${setup.reason}.`;
	app.settings.setMemory({ vault: setup.vault, folder: setup.folder });
	const lines = [`Wiki set up at ${tildify(setup.root)}.`, ...setup.notes];
	if (previous.vault !== undefined && join(previous.vault, previous.folder) !== setup.root)
		lines.push(
			`The old wiki folder ${tildify(join(previous.vault, previous.folder))} is left as it was; delete it if you no longer want it.`,
		);
	lines.push(wikiCommand(app));
	return lines.join("\n");
}

/** `/wiki`: render memory into the vault set up by `/wiki-setup`. */
export function wikiCommand(app: MakoraApp): string {
	const { vault, folder } = app.settings.memory;
	if (vault === undefined) return "No wiki yet; /wiki-setup <vault> [folder] sets one up.";
	const setup = setupWiki(vault, folder);
	if (setup.kind === "refused") return `Wiki not rendered: ${setup.reason}.`;
	const store = openMemory(memoryPath(app.paths.home));
	try {
		const result = writeWiki(store, setup.root, renderWiki(wikiData(store), folder));
		return `Wiki rendered at ${tildify(setup.root)}: ${result.written} written, ${result.deleted} deleted, ${result.unchanged} unchanged.`;
	} finally {
		store.close();
	}
}

/** A dream as `/dream status` shows it. */
export function describeDream(dream: DreamRow): string {
	const sessions = (JSON.parse(dream.sessions) as string[]).length;
	const spent = `$${dream.cost_usd.toFixed(2)} of $${dream.budget_usd.toFixed(2)}`;
	const ended = dream.ended_at === null ? "" : `, ended ${new Date(dream.ended_at).toLocaleString()}`;
	const lines = [`Dream ${dream.id}: ${dream.status}, ${sessions} session(s), ${spent} spent${ended}.`];
	if (dream.error !== null) lines.push(`Why: ${dream.error}`);
	if (dream.report !== null) lines.push(dream.report);
	return lines.join("\n");
}

// A pstack tier on "session" runs on makora's default model, which is what a new conversation would get.
async function tierModel(app: MakoraApp, tier: Tier): Promise<DreamModel | undefined> {
	const choice = app.settings.pstack.models[tier];
	const ref: ModelRef | undefined = choice === "session" ? await defaultModel(app) : choice.model;
	const model = ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);
	if (model === undefined) return undefined;
	const wanted = choice === "session" ? app.settings.thinkingLevel : choice.thinking;
	const level = wanted === undefined ? "off" : clampThinking(model, wanted);
	return level === "off" ? { model } : { model, reasoning: level };
}
