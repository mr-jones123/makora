// One open session: its lock, its Durable harness over `session.sqlite` (or memory, when ephemeral), its root
// conversation, the Python kernels of its conversations, its git writes, and its quiz tool. An ephemeral session removes
// its worktrees when it closes.
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	type ModelRef,
	type Report,
	type Storage,
	type Submission,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type Agents, createAgents } from "./agents/extension.ts";
import { admitInput, identityOf } from "./agents/family.ts";
import type { SetupPolicy, SetupRequest } from "./agents/worktree.ts";
import { agentRoots, defaultModel, type MakoraApp, worktreeRoots } from "./app.ts";
import { makoraExtension } from "./extension.ts";
import { GitWrites } from "./git/writes.ts";
import { KernelManager } from "./kernel/manager.ts";
import { openInBrowser } from "./open.ts";
import { createQuizTool } from "./quiz/publish.ts";
import { createRepl, type Repl } from "./repl/extension.ts";
import type { SnapshotPolicy } from "./repl/python-tool.ts";
import { applyCleanup, planCleanup, sessionWorktrees } from "./session-delete.ts";
import {
	lockSession,
	type SessionLock,
	type SessionMeta,
	sessionDatabase,
	sessionDir,
	updateSession,
} from "./sessions.ts";

/**
 * A notice for the user about the session itself: `warning` for restored work and harness failures, `info` for news
 * such as a saved quiz.
 */
export interface SessionNotice {
	readonly at: number;
	readonly level: "info" | "warning";
	readonly message: string;
}

/** An open session; only one process holds a session open at a time. */
export interface MakoraSession {
	readonly harness: Harness;
	readonly root: Conversation;
	/** The session's current meta; an ephemeral session's is never written. */
	readonly meta: SessionMeta;
	/** The Python kernels of the session's conversations. */
	readonly kernels: KernelManager;
	/** The session's git writes (commits, merges, worktrees, branch deletes), one at a time per repository. */
	readonly git: GitWrites;
	/** Notices so far, oldest first. */
	readonly notices: readonly SessionNotice[];
	/** Call `listener` with each later notice; returns the unsubscribe. */
	onNotice(listener: (notice: SessionNotice) => void): () => void;
	/**
	 * Submit user input to `conversation`; the session's first input becomes its title. Returns the input's submission. A
	 * running subagent takes it as a steer. A finished one is woken by it: it queues for a running slot, and its anchor
	 * submits the input once it has one and records the run, so this returns undefined. A queued or removed one refuses it.
	 */
	submit(conversation: Conversation, text: string, context: Context): Promise<Submission | undefined>;
	/** Switch `conversation`'s model; the root's is recorded in the meta. */
	setModel(conversation: Conversation, model: ModelRef, context: Context): Promise<void>;
	/**
	 * Close the harness, stop the kernels, and release the lock. An ephemeral session then removes its worktrees, refs and
	 * the write branches without work, as `makora rm` does for a stored one.
	 */
	close(): Promise<void>;
}

/** What an open applies on top of the session's stored state. */
export interface OpenOptions {
	readonly model?: ModelRef;
	/**
	 * Ask the user whether a repository's worktree setup command may run; a yes is kept in the settings. Without it (print
	 * mode), a command the settings do not approve is skipped.
	 */
	readonly askSetup?: (request: SetupRequest) => Promise<boolean>;
	/** Open a saved quiz page; default the platform's browser opener. Tests pass their own. */
	readonly openBrowser?: (path: string) => Promise<boolean>;
}

/** Where a session's state lives. */
type SessionStore =
	| { readonly kind: "persistent"; readonly sessionsDir: string }
	/** Durable's `MemoryStorage`: no session directory, no meta, no snapshots. */
	| { readonly kind: "ephemeral" };

const TITLE_LENGTH = 80;

/**
 * Open the session `meta` for writing: take its lock, open its harness, make sure the root conversation exists with
 * the default model, apply `model` when given, and resume work an earlier process left unfinished.
 */
export function openSession(
	app: MakoraApp,
	meta: SessionMeta,
	options: OpenOptions,
	context: Context,
): Promise<MakoraSession> {
	return open(app, meta, { kind: "persistent", sessionsDir: app.paths.sessions }, options, context);
}

/** Open a new session for `cwd` that lives in memory only and leaves nothing on disk but what its tools write. */
export function openEphemeralSession(
	app: MakoraApp,
	cwd: string,
	options: OpenOptions,
	context: Context,
): Promise<MakoraSession> {
	const now = Date.now();
	return open(app, { id: uuidv7(now), cwd, createdAt: now, updatedAt: now }, { kind: "ephemeral" }, options, context);
}

async function open(
	app: MakoraApp,
	meta: SessionMeta,
	store: SessionStore,
	options: OpenOptions,
	context: Context,
): Promise<MakoraSession> {
	const lock: SessionLock | undefined =
		store.kind === "persistent" ? lockSession(store.sessionsDir, meta.id) : undefined;
	const notices: SessionNotice[] = [];
	const listeners = new Set<(notice: SessionNotice) => void>();
	const announce = (level: SessionNotice["level"], message: string): void => {
		const notice = { at: Date.now(), level, message };
		notices.push(notice);
		for (const listener of listeners) listener(notice);
	};
	const notify = (message: string): void => announce("warning", message);
	for (const warning of app.settings.warnings) notify(warning);
	const dir = store.kind === "persistent" ? sessionDir(store.sessionsDir, meta.id) : undefined;
	const gitWrites = new GitWrites();
	let kernels: KernelManager;
	let repl: Repl;
	let agents: Agents;
	let harness: Harness;
	try {
		// Under the lock, so the kernels it kills can only be ones a crashed holder left.
		kernels = new KernelManager(app.paths.home, dir === undefined ? undefined : join(dir, "kernels"));
		repl = createRepl({ kernels, snapshots: snapshotPolicy(app, meta, dir), defaultCwd: meta.cwd });
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(makoraExtension(app.paths, () => app.settings.pstack));
		registry.install(repl.extension);
		agents = createAgents({
			kernels,
			git: gitWrites,
			sessionId: meta.id,
			defaultCwd: meta.cwd,
			roots: () => agentRoots(app),
			maxRunning: () => app.settings.maxRunningAgents,
			setup: setupPolicy(app, options),
			settingsFile: app.paths.settings,
			pstack: () => app.settings.pstack,
			notify,
		});
		registry.install(agents.extension);
		const quiz = createQuizTool({
			quizzes: app.paths.quizzes,
			defaultCwd: meta.cwd,
			open: options.openBrowser ?? openInBrowser,
			inform: (message) => announce("info", message),
		});
		registry.install(defineExtension({ name: "makora-quiz", tools: [quiz] }));
		const storage: Storage =
			store.kind === "persistent"
				? await openNodeSqliteStorage(sessionDatabase(store.sessionsDir, meta.id))
				: new MemoryStorage();
		harness = await Harness.open(
			storage,
			{
				models: app.models,
				registry,
				settings: app.settings.harness,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? meta.cwd }),
				identity: {
					attribution: { name: "makora", url: "https://github.com/mr-jones123/makora", categories: ["cli-agent"] },
				},
				onReport: (report) => notify(describeReport(report)),
			},
			context,
		);
	} catch (error) {
		lock?.release();
		throw error;
	}
	const update = (current: SessionMeta, change: Partial<Pick<SessionMeta, "title" | "model">>): SessionMeta =>
		store.kind === "persistent"
			? updateSession(store.sessionsDir, current, change)
			: { ...current, ...change, updatedAt: Date.now() };
	let root: Conversation;
	let current = meta;
	try {
		const initial = await defaultModel(app);
		root = await harness.root(context, {
			agent: {
				cwd: meta.cwd,
				modelTools: [repl.python, agents.waitAgents],
				...(initial === undefined ? {} : { model: initial }),
				...(app.settings.thinkingLevel === undefined ? {} : { thinkingLevel: app.settings.thinkingLevel }),
			},
		});
		// Sessions from before the REPL offered the coding tools, and those from before subagents `python` alone; the
		// model now gets `python` and `wait_agents`.
		const offered = (await root.agent(context)).tools.map((tool) => tool.name);
		if (offered.join() !== [repl.python.name, agents.waitAgents.name].join()) {
			await root.configure({ modelTools: [repl.python, agents.waitAgents] }, context);
		}
		if (options.model !== undefined) await root.configure({ model: options.model }, context);
		const unfinished = (await harness.inspect(context)).tasks.filter(
			(task) => task.record.conversationId === root.id,
		);
		if (unfinished.length > 0) notify(`Restored the session; resuming ${unfinished.length} unfinished task(s).`);
		harness.resume();

		const model = (await root.agent(context)).model;
		if (model !== undefined) current = update(current, { model: `${model.provider}/${model.modelId}` });
	} catch (error) {
		// The open failure is the error to report; a failing close must not replace it.
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await kernels.close();
		lock?.release();
		throw error;
	}

	return {
		harness,
		root,
		get meta() {
			return current;
		},
		kernels,
		git: gitWrites,
		notices,
		onNotice(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async submit(conversation, text, submitContext) {
			const self = await identityOf(harness, conversation.id, submitContext);
			let submission: Submission | undefined;
			if (self === undefined)
				submission = await conversation.submit({ type: "input", content: text }, submitContext);
			else {
				// A subagent's input is admitted through its anchor, so the run it starts is watched and recorded.
				const id = await harness.commit(
					(tx) =>
						admitInput(
							tx,
							{ handle: conversation, self },
							{ content: text, requestId: `user-input:${uuidv7()}`, from: "user" },
							"followUp",
						),
					submitContext,
				);
				submission = id === undefined ? undefined : await harness.submission(id, submitContext);
				if (id !== undefined && submission === undefined)
					throw new Error(`The input to ${self.name} was not admitted`);
			}
			const title = current.title ?? (text.trim().split("\n")[0]?.slice(0, TITLE_LENGTH) || undefined);
			current = update(current, title === undefined ? {} : { title });
			return submission;
		},
		async setModel(conversation, next, modelContext) {
			await conversation.configure({ model: next }, modelContext);
			if (conversation.id === root.id) current = update(current, { model: `${next.provider}/${next.modelId}` });
		},
		async close() {
			// An ephemeral session leaves nothing behind but a write branch with work; its records are read before its
			// storage goes with the harness.
			const worktrees =
				store.kind === "ephemeral" ? await sessionWorktrees(harness, meta.cwd, BACKGROUND_CONTEXT) : undefined;
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} finally {
				await kernels.close();
				lock?.release();
			}
			if (worktrees !== undefined) {
				await applyCleanup(await planCleanup(worktrees, meta.cwd, meta.id, worktreeRoots(app)), gitWrites);
			}
		},
	};
}

function setupPolicy(app: MakoraApp, options: OpenOptions): SetupPolicy {
	return {
		async approve(request) {
			const approval = { repository: request.repository, sha256: request.sha256 };
			if (app.settings.setupApproved(approval)) return true;
			if (options.askSetup === undefined || !(await options.askSetup(request))) return false;
			app.settings.approveSetup(approval);
			return true;
		},
		timeoutMinutes: () => app.settings.setupTimeoutMinutes,
	};
}

function snapshotPolicy(app: MakoraApp, meta: SessionMeta, dir: string | undefined): SnapshotPolicy {
	if (dir === undefined) return { kind: "off" };
	return {
		kind: "session",
		sessionId: meta.id,
		blobDir: join(dir, "blobs"),
		enabled: () => app.settings.snapshots,
	};
}

function describeReport(report: Report): string {
	const error = report.error instanceof Error ? report.error.message : String(report.error);
	switch (report.kind) {
		case "task_interrupted":
			return `A ${report.task.kind} task was cut off by restarts ${report.restarts} time(s) and ended: ${error}`;
		case "task_faulted":
			return `A ${report.task.kind} task failed: ${error}`;
		case "storage_failed":
			return `Session storage failed: ${error}`;
		default:
			return `${report.kind}: ${error}`;
	}
}
