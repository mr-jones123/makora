// A dream: an asynchronous job, as in Anthropic's Dreams API, that reads the sessions a project has had since its last
// dream and turns them into memory. Starting one records it as pending and returns; a detached worker runs it to
// completed, failed or canceled, and applies its changes only when it completes.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { listSessions, type SessionMeta } from "../sessions.ts";
import { applyOps, checkOps, organizerReply } from "./dream-ops.ts";
import {
	ANALYZER_PROMPT,
	type AnalyzerReply,
	analyzerReply,
	ORGANIZER_PROMPT,
	organizerInput,
	PROMPT_VERSION,
	type PromptEpisode,
	replyJson,
	sliceEpisodes,
} from "./dream-prompts.ts";
import type { EmbedConfig } from "./embed.ts";
import { ingestSession } from "./ingest.ts";
import { type Project, projectOf } from "./project.ts";
import { embedPending } from "./search.ts";
import { type MemoryStore, selectClaims } from "./store.ts";

/** Where a dream is in its life. */
export type DreamStatus = "pending" | "running" | "completed" | "failed" | "canceled";

/** A dream as `dreams` holds it. */
export interface DreamRow {
	readonly id: number;
	readonly status: DreamStatus;
	readonly project: string;
	readonly cwd: string;
	readonly sessions: string;
	readonly budget_usd: number;
	readonly cost_usd: number;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly report: string | null;
	readonly error: string | null;
	readonly created_at: number;
	readonly started_at: number | null;
	readonly ended_at: number | null;
}

/** What starting a dream came to. */
export type DreamStart =
	| { readonly kind: "started"; readonly id: number }
	| { readonly kind: "busy"; readonly id: number | undefined };

/** A dream model: the model and the thinking it runs with. */
export interface DreamModel {
	readonly model: Model<Api>;
	readonly reasoning?: ThinkingLevel;
}

/** What a dream's worker needs besides the store. */
export interface DreamDeps {
	readonly home: string;
	readonly sessionsDir: string;
	readonly models: MutableModels;
	/** Reads one slice of one session: the cheap tier. */
	readonly analyzer: DreamModel;
	/** Writes the operations: the judge tier. */
	readonly organizer: DreamModel;
	/** Embeds new episodes and claims after the dream; without it, or when Ollama is down, search uses words. */
	readonly embed: EmbedConfig | undefined;
	readonly log: (line: string) => void;
	/** Runs after the dream applied its changes, such as rendering the wiki; its failure is noted in the report. */
	readonly afterApply?: () => Promise<string | undefined>;
	readonly now?: () => number;
}

/** Sessions one dream reads at most, oldest first; the rest wait for the next. */
export const MAX_SESSIONS = 20;

/**
 * Record a pending dream for `project`, unless one is running. A dream left `running` or `pending` with no worker
 * holding the lock (the machine slept, the process died) is marked failed first.
 */
export function startDream(
	store: MemoryStore,
	home: string,
	request: { readonly project: Project; readonly cwd: string; readonly budgetUsd: number },
	now = Date.now(),
): DreamStart {
	const lock = takeDreamLock(home);
	if (lock === undefined) return { kind: "busy", id: activeDream(store)?.id };
	try {
		store.db
			.prepare(
				"UPDATE dreams SET status = 'failed', error = 'its worker stopped before it finished', ended_at = ? WHERE status IN ('pending', 'running')",
			)
			.run(now);
		store.db
			.prepare("INSERT INTO projects (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name")
			.run(request.project.id, request.project.name);
		const row = store.db
			.prepare(
				"INSERT INTO dreams (status, project, cwd, budget_usd, created_at) VALUES ('pending', ?, ?, ?, ?) RETURNING id",
			)
			.get(request.project.id, request.cwd, request.budgetUsd, now) as { id: number };
		return { kind: "started", id: row.id };
	} finally {
		lock.release();
	}
}

/** Start the detached process that runs dream `id`; its output goes to `<home>/memory/dreams/<id>.log`. */
export function spawnDreamWorker(home: string, id: number, fake: boolean): string {
	const dir = join(home, "memory", "dreams");
	mkdirSync(dir, { recursive: true });
	const logFile = join(dir, `${id}.log`);
	const out = openSync(logFile, "a");
	// The same node and loader flags as this process, so a source checkout's worker resolves the workspace too.
	const child = spawn(
		process.execPath,
		[...process.execArgv, process.argv[1]!, "dream-worker", String(id), ...(fake ? ["--fake"] : [])],
		{ detached: true, stdio: ["ignore", out, out], env: { ...process.env, MAKORA_HOME: home } },
	);
	child.unref();
	return logFile;
}

/** Dream `id`, or the newest dream. */
export function dreamRow(store: MemoryStore, id?: number): DreamRow | undefined {
	const row =
		id === undefined
			? store.db.prepare("SELECT * FROM dreams ORDER BY id DESC LIMIT 1").get()
			: store.db.prepare("SELECT * FROM dreams WHERE id = ?").get(id);
	return row as DreamRow | undefined;
}

/** Ask dream `id` to stop: a pending one is canceled now, a running one at its worker's next step. */
export function cancelDream(store: MemoryStore, id: number, now = Date.now()): DreamRow | undefined {
	store.db
		.prepare("UPDATE dreams SET status = 'canceled', ended_at = ? WHERE id = ? AND status = 'pending'")
		.run(now, id);
	store.db.prepare("UPDATE dreams SET cancel_requested = 1 WHERE id = ? AND status = 'running'").run(id);
	return dreamRow(store, id);
}

class Canceled extends Error {}

/** Run dream `id` to its end. Called by the worker process; never throws for the dream's own failures. */
export async function runDream(store: MemoryStore, id: number, deps: DreamDeps): Promise<DreamStatus> {
	const now = deps.now ?? Date.now;
	const lock = takeDreamLock(deps.home);
	if (lock === undefined) {
		finish(store, id, "failed", { error: "another dream is running" }, now());
		return "failed";
	}
	const run: Run = { store, id, deps, usage: { cost: 0, input: 0, output: 0 }, budget: 0 };
	try {
		const dream = dreamRow(store, id);
		if (dream?.status !== "pending") return dream?.status ?? "failed";
		run.budget = dream.budget_usd;
		store.db
			.prepare("UPDATE dreams SET status = 'running', pid = ?, started_at = ? WHERE id = ?")
			.run(process.pid, now(), id);
		const status = await dreamPhases(run, dream, now);
		// Completed means the next dream may start: what follows only makes memory searchable and readable, and SQLite
		// orders its writes with the next dream's.
		lock.release();
		if (status === "completed") await afterDream(run);
		return status;
	} catch (error) {
		const status = error instanceof Canceled ? "canceled" : "failed";
		finish(store, id, status, status === "failed" ? { error: describe(error) } : {}, now(), run.usage);
		return status;
	} finally {
		lock.release();
	}
}

/** One running dream: its store, deps, what it has spent, and its budget. */
interface Run {
	readonly store: MemoryStore;
	readonly id: number;
	readonly deps: DreamDeps;
	readonly usage: { cost: number; input: number; output: number };
	budget: number;
}

// The dream's phases in order: read the due sessions, check the budget, analyze, organize, check, and apply with the
// dream recorded as completed in the same transaction.
async function dreamPhases(run: Run, dream: DreamRow, now: () => number): Promise<DreamStatus> {
	const { store, id } = run;
	step(run, "finding sessions");
	const sessions = await dueSessions(store, run.deps.sessionsDir, dream.project);
	if (sessions.length === 0) {
		finish(store, id, "completed", { report: "No session has changed since the last dream." }, now());
		return "completed";
	}
	store.db
		.prepare("UPDATE dreams SET sessions = ? WHERE id = ?")
		.run(JSON.stringify(sessions.map((meta) => meta.id)), id);
	const project: Project = { id: dream.project, name: projectName(store, dream.project) };
	const reading = await readSessions(run, sessions, project);
	const claims = selectClaims(
		store.db,
		"c.status != 'superseded' AND (c.project IS NULL OR c.project = ?)",
		dream.project,
	);
	const estimate = estimateCost(reading.slices, claims.length, run.deps);
	if (estimate > run.budget) {
		const error = `the estimated cost $${estimate.toFixed(2)} is over the budget $${run.budget.toFixed(2)}`;
		finish(store, id, "failed", { error }, now());
		return "failed";
	}
	const analysis = await analyze(run, reading.slices);
	step(run, `organizing ${analysis.notes.length} notes`);
	const answer = await ask(
		run,
		run.deps.organizer,
		ORGANIZER_PROMPT,
		organizerInput(project.name, claims, analysis.notes),
	);
	const parsed = organizerReply.validate(replyJson(answer));
	if (!parsed.ok) {
		const why = parsed.errors
			.slice(0, 3)
			.map((error) => `${error.path || "/"} ${error.message}`)
			.join("; ");
		finish(store, id, "failed", { error: `the organizer's reply was not the asked JSON: ${why}` }, now(), run.usage);
		return "failed";
	}
	const subjects = store.db
		.prepare("SELECT key FROM subjects WHERE project IS NULL OR project = ?")
		.all(dream.project) as {
		key: string;
	}[];
	const checked = checkOps(parsed.value.ops, {
		project: dream.project,
		episodes: reading.episodes,
		claims: new Set(claims.map((claim) => claim.id)),
		subjects: new Set(subjects.map((row) => row.key)),
	});
	const staged = {
		ops: checked.ops,
		dropped: [...analysis.skipped, ...checked.dropped],
		report: parsed.value.report,
		agentsMd: parsed.value.agentsMd ?? [],
	};
	store.db.prepare("UPDATE dreams SET staged = ? WHERE id = ?").run(JSON.stringify(staged), id);

	step(run, `applying ${checked.ops.length} operations`);
	const at = now();
	applyOps(
		store.db,
		checked.ops,
		{ dream: id, project: dream.project, promptVersion: PROMPT_VERSION, now: at },
		(applied) => {
			markRead(store, sessions);
			const report = [
				`Read ${sessions.length} session(s) in ${reading.slices.length} slice(s); ${analysis.notes.length} notes.`,
				`Created ${applied.created}, revised ${applied.revised}, confirmed ${applied.confirmed}, superseded ${applied.superseded}, disputed ${applied.disputed}, linked ${applied.linked}, retitled ${applied.retitled}.`,
				staged.report,
				...listed("Suggested for AGENTS.md:", staged.agentsMd),
				...listed(`Dropped (${staged.dropped.length}):`, staged.dropped),
			];
			finish(store, id, "completed", { report: report.join("\n") }, at, run.usage);
		},
	);
	return "completed";
}

/** Throw `Canceled` when the dream was asked to stop, else log `what` as the step it takes next. */
function step(run: Run, what: string): void {
	const row = run.store.db.prepare("SELECT cancel_requested FROM dreams WHERE id = ?").get(run.id) as {
		cancel_requested: number;
	};
	if (row.cancel_requested === 1) throw new Canceled();
	run.deps.log(`dream ${run.id}: ${what}`);
}

// Copy each session's turns, then cut the episodes no dream has read yet into the analyzer's slices.
async function readSessions(
	run: Run,
	sessions: readonly SessionMeta[],
	project: Project,
): Promise<{ readonly episodes: Map<number, string>; readonly slices: { session: string; text: string }[] }> {
	const { store } = run;
	const episodes = new Map<number, string>();
	const slices: { session: string; text: string }[] = [];
	for (const meta of sessions) {
		step(run, `copying session ${meta.id}`);
		await ingestSession(store, run.deps.sessionsDir, meta, project);
		const { dreamed_episode: since } = store.db
			.prepare("SELECT dreamed_episode FROM sessions WHERE id = ?")
			.get(meta.id) as {
			dreamed_episode: number;
		};
		const unread = store.db
			.prepare("SELECT id, role, text FROM episodes WHERE session = ? AND id > ? ORDER BY id")
			.all(meta.id, since) as unknown as PromptEpisode[];
		for (const episode of unread) episodes.set(episode.id, episode.text);
		for (const text of sliceEpisodes(unread)) slices.push({ session: meta.id, text });
	}
	return { episodes, slices };
}

// One analyzer call per slice; a slice whose reply is not the asked JSON is skipped and named in the report.
async function analyze(
	run: Run,
	slices: readonly { session: string; text: string }[],
): Promise<{ readonly notes: AnalyzerReply["notes"]; readonly skipped: string[] }> {
	const notes: AnalyzerReply["notes"] = [];
	const skipped: string[] = [];
	for (const [index, slice] of slices.entries()) {
		step(run, `analyzing slice ${index + 1} of ${slices.length}`);
		const parsed = analyzerReply.validate(replyJson(await ask(run, run.deps.analyzer, ANALYZER_PROMPT, slice.text)));
		if (parsed.ok) notes.push(...parsed.value.notes);
		else skipped.push(`slice ${index + 1} of session ${slice.session}: the analyzer's reply was not the asked JSON`);
	}
	return { notes, skipped };
}

// A session is read up to its last episode and its current updated_at: the next dream reads only what comes after.
function markRead(store: MemoryStore, sessions: readonly SessionMeta[]): void {
	const mark = store.db.prepare(
		"UPDATE sessions SET dreamed_through = ?, dreamed_episode = coalesce((SELECT max(id) FROM episodes WHERE session = ?), 0) WHERE id = ?",
	);
	for (const meta of sessions) mark.run(meta.updatedAt, meta.id, meta.id);
}

function listed(title: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : [title, ...lines.map((line) => `- ${line}`)];
}

// After a completed dream: the memory is already right, and these only make it searchable and readable.
async function afterDream(run: Run): Promise<void> {
	const { store, id, deps } = run;
	const after: string[] = [];
	if (deps.embed !== undefined) {
		deps.log(`dream ${id}: embedding`);
		for (;;) {
			const result = await embedPending(store, deps.embed, 200);
			if (result.note !== undefined) after.push(`Not embedded: ${result.note}.`);
			if (result.embedded === 0 || result.note !== undefined) break;
		}
	}
	const rendered = await deps
		.afterApply?.()
		.catch((error: unknown) => `The wiki was not rendered: ${describe(error)}`);
	if (rendered !== undefined) after.push(rendered);
	if (after.length > 0)
		store.db.prepare("UPDATE dreams SET report = report || ? WHERE id = ?").run(`\n${after.join("\n")}`, id);
}

/** The dream holding the lock now, if one is running or waiting to. */
function activeDream(store: MemoryStore): DreamRow | undefined {
	return store.db
		.prepare("SELECT * FROM dreams WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
		.get() as DreamRow | undefined;
}

function finish(
	store: MemoryStore,
	id: number,
	status: DreamStatus,
	fields: { readonly report?: string; readonly error?: string },
	now: number,
	usage?: { readonly cost: number; readonly input: number; readonly output: number },
): void {
	store.db
		.prepare(
			`UPDATE dreams SET status = ?, report = coalesce(?, report), error = ?, ended_at = ?,
			cost_usd = coalesce(?, cost_usd), input_tokens = coalesce(?, input_tokens), output_tokens = coalesce(?, output_tokens)
			WHERE id = ?`,
		)
		.run(
			status,
			fields.report ?? null,
			fields.error ?? null,
			now,
			usage?.cost ?? null,
			usage?.input ?? null,
			usage?.output ?? null,
			id,
		);
}

// A session is due when it belongs to the project and changed since the dream that last read it.
async function dueSessions(store: MemoryStore, sessionsDir: string, project: string): Promise<SessionMeta[]> {
	const byCwd = new Map<string, Promise<Project>>();
	const due: SessionMeta[] = [];
	const metas = listSessions(sessionsDir).sort((a, b) => a.updatedAt - b.updatedAt);
	for (const meta of metas) {
		const read = store.db.prepare("SELECT dreamed_through FROM sessions WHERE id = ?").get(meta.id) as
			| { dreamed_through: number | null }
			| undefined;
		if (read?.dreamed_through != null && read.dreamed_through >= meta.updatedAt) continue;
		if (!byCwd.has(meta.cwd)) byCwd.set(meta.cwd, projectOf(meta.cwd));
		if ((await byCwd.get(meta.cwd)!).id !== project) continue;
		due.push(meta);
		if (due.length === MAX_SESSIONS) break;
	}
	return due;
}

function projectName(store: MemoryStore, project: string): string {
	const row = store.db.prepare("SELECT name FROM projects WHERE id = ?").get(project) as { name: string } | undefined;
	return row?.name ?? project;
}

// The estimate counts four characters a token and a full reply per call: high on purpose, as a ceiling's check.
const OUTPUT_TOKENS_PER_CALL = 4_000;
const ORGANIZER_TOKENS_PER_CLAIM = 80;

function estimateCost(slices: readonly { text: string }[], claims: number, deps: DreamDeps): number {
	const price = (model: Model<Api>, input: number, output: number) =>
		(input * model.cost.input + output * model.cost.output) / 1_000_000;
	const sliceTokens = slices.reduce((sum, slice) => sum + slice.text.length / 4, 0);
	const analyzer = price(deps.analyzer.model, sliceTokens, slices.length * OUTPUT_TOKENS_PER_CALL);
	const organizer = price(
		deps.organizer.model,
		claims * ORGANIZER_TOKENS_PER_CLAIM + slices.length * OUTPUT_TOKENS_PER_CALL,
		OUTPUT_TOKENS_PER_CALL * 2,
	);
	return analyzer + organizer;
}

// One model call, counted against the budget; a call that pushes the dream over it fails the dream. An error reply is
// tried once more, since providers fail transiently.
async function ask(run: Run, which: DreamModel, system: string, input: string): Promise<string> {
	const now = Date.now();
	let message: AssistantMessage | undefined;
	for (let attempt = 1; attempt <= 2; attempt++) {
		message = await run.deps.models.completeSimple(
			which.model,
			{
				messages: [
					{ role: "system", content: system, timestamp: now },
					{ role: "user", content: [{ type: "text", text: input }], timestamp: now },
				],
			},
			{ cacheRetention: "none", ...(which.reasoning === undefined ? {} : { reasoning: which.reasoning }) },
		);
		run.usage.cost += message.usage.cost.total;
		run.usage.input += message.usage.input;
		run.usage.output += message.usage.output;
		run.store.db
			.prepare("UPDATE dreams SET cost_usd = ?, input_tokens = ?, output_tokens = ? WHERE id = ?")
			.run(run.usage.cost, run.usage.input, run.usage.output, run.id);
		if (run.usage.cost > run.budget)
			throw new Error(`spent $${run.usage.cost.toFixed(2)}, over the budget $${run.budget.toFixed(2)}`);
		if (message.stopReason !== "error") break;
	}
	if (message!.stopReason === "error")
		throw new Error(`${which.model.id} failed: ${message!.errorMessage ?? "error"}`);
	return contentText(message!.content);
}

/** Take the dream lock: an exclusive SQLite lock on `<home>/memory/dream.lock`, dropped by the OS when the process ends. */
function takeDreamLock(home: string): { release(): void } | undefined {
	const dir = join(home, "memory");
	mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, "dream.lock"), { timeout: 0 });
	try {
		db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
	} catch {
		db.close();
		return undefined;
	}
	return {
		release: () => {
			if (db.isOpen) db.close();
		},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
