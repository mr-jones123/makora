// One open session: its lock, its Durable harness over `session.sqlite`, and the root conversation the user talks to.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	createRegistry,
	Harness,
	type ModelRef,
	type Report,
	type Submission,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defaultModel, type MakoraApp } from "./app.ts";
import { makoraExtension } from "./extension.ts";
import { lockSession, type SessionMeta, sessionDatabase, updateSession } from "./sessions.ts";

/** A notice for the user about the session itself: restored work and harness failures. */
export interface SessionNotice {
	readonly at: number;
	readonly message: string;
}

/** An open session; only one process holds a session open at a time. */
export interface MakoraSession {
	readonly harness: Harness;
	readonly root: Conversation;
	/** The session's current meta. */
	readonly meta: SessionMeta;
	/** Notices so far, oldest first. */
	readonly notices: readonly SessionNotice[];
	/** Call `listener` with each later notice; returns the unsubscribe. */
	onNotice(listener: (notice: SessionNotice) => void): () => void;
	/** Submit user input to the root conversation; the first input becomes the session title. */
	submit(text: string, context: Context): Promise<Submission>;
	/** Switch the root conversation's model, and record it in the meta. */
	setModel(model: ModelRef, context: Context): Promise<void>;
	/** Close the harness and release the lock. */
	close(): Promise<void>;
}

const TITLE_LENGTH = 80;

/**
 * Open the session `meta` for writing: take its lock, open its harness, make sure the root conversation exists with
 * the default model, apply `model` when given, and resume work an earlier process left unfinished.
 */
export async function openSession(
	app: MakoraApp,
	meta: SessionMeta,
	options: { readonly model?: ModelRef },
	context: Context,
): Promise<MakoraSession> {
	const sessions = app.paths.sessions;
	const lock = lockSession(sessions, meta.id);
	const notices: SessionNotice[] = [];
	const listeners = new Set<(notice: SessionNotice) => void>();
	const notify = (message: string): void => {
		const notice = { at: Date.now(), message };
		notices.push(notice);
		for (const listener of listeners) listener(notice);
	};
	let harness: Harness;
	try {
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(makoraExtension(app.paths));
		harness = await Harness.open(
			await openNodeSqliteStorage(sessionDatabase(sessions, meta.id)),
			{
				models: app.models,
				registry,
				settings: app.settings.harness,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? meta.cwd }),
				identity: {
					attribution: { name: "makora", url: "https://github.com/mr-jones123/pi", categories: ["cli-agent"] },
				},
				onReport: (report) => notify(describeReport(report)),
			},
			context,
		);
	} catch (error) {
		lock.release();
		throw error;
	}
	let root: Conversation;
	let current = meta;
	try {
		const initial = await defaultModel(app);
		root = await harness.root(context, {
			agent: {
				cwd: meta.cwd,
				...(initial === undefined ? {} : { model: initial }),
				...(app.settings.thinkingLevel === undefined ? {} : { thinkingLevel: app.settings.thinkingLevel }),
			},
		});
		if (options.model !== undefined) await root.configure({ model: options.model }, context);
		const unfinished = (await harness.inspect(context)).tasks.filter(
			(task) => task.record.conversationId === root.id,
		);
		if (unfinished.length > 0) notify(`Restored the session; resuming ${unfinished.length} unfinished task(s).`);
		harness.resume();

		const model = (await root.agent(context)).model;
		if (model !== undefined)
			current = updateSession(sessions, current, { model: `${model.provider}/${model.modelId}` });
	} catch (error) {
		// The open failure is the error to report; a failing close must not replace it.
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		lock.release();
		throw error;
	}

	return {
		harness,
		root,
		get meta() {
			return current;
		},
		notices,
		onNotice(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async submit(text, submitContext) {
			const submission = await root.submit({ type: "input", content: text }, submitContext);
			const title = current.title ?? (text.trim().split("\n")[0]?.slice(0, TITLE_LENGTH) || undefined);
			current = updateSession(sessions, current, title === undefined ? {} : { title });
			return submission;
		},
		async setModel(next, modelContext) {
			await root.configure({ model: next }, modelContext);
			current = updateSession(sessions, current, { model: `${next.provider}/${next.modelId}` });
		},
		async close() {
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} finally {
				lock.release();
			}
		},
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
