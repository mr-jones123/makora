// Session directories: one per session under `<home>/sessions/<id>`, holding Durable's `session.sqlite`, the
// `meta.json` the session list reads, and the lock that keeps one writer per session.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "@earendil-works/pi-ai";

/** What the session list shows of one session; Durable owns everything else. */
export interface SessionMeta {
	readonly id: string;
	readonly cwd: string;
	readonly title?: string;
	/** Where the title came from: the first line of the first input, or the model asked to name the session. */
	readonly titleSource?: TitleSource;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** `provider/modelId` of the root conversation's model when last used. */
	readonly model?: string;
}

/** What wrote a session's title. */
export type TitleSource = "first-line" | "model";

/** The fields of `SessionMeta` a session itself writes. */
type WritableMeta = Pick<SessionMeta, "title" | "titleSource" | "model">;

/** A held session lock; `release()` gives it up. */
export interface SessionLock {
	release(): void;
}

/** Another holder writes this session; `pid` is its process when it recorded one. */
export class SessionLockedError extends Error {
	readonly pid: number | undefined;

	constructor(id: string, pid: number | undefined) {
		const holder = pid === undefined ? "another makora process" : `another makora process (pid ${pid})`;
		super(`Session ${id} is open in ${holder}. Close it there first.`);
		this.name = "SessionLockedError";
		this.pid = pid;
	}
}

/** The directory of session `id`. */
export function sessionDir(sessionsDir: string, id: string): string {
	return join(sessionsDir, id);
}

/** Durable's SQLite file of session `id`. */
export function sessionDatabase(sessionsDir: string, id: string): string {
	return join(sessionsDir, id, "session.sqlite");
}

/** Create a new session directory for `cwd` with a time-sortable ID. */
export function createSession(sessionsDir: string, cwd: string, now = Date.now()): SessionMeta {
	const meta: SessionMeta = { id: uuidv7(now), cwd, createdAt: now, updatedAt: now };
	mkdirSync(sessionDir(sessionsDir, meta.id), { recursive: true });
	writeMeta(sessionsDir, meta);
	return meta;
}

/** The meta of session `id`, or undefined when it has no readable `meta.json`. */
export function readSession(sessionsDir: string, id: string): SessionMeta | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(sessionDir(sessionsDir, id), "meta.json"), "utf8"));
	} catch {
		return undefined;
	}
	return parseMeta(raw);
}

/** Every session with a readable `meta.json`, newest `updatedAt` first. */
export function listSessions(sessionsDir: string): SessionMeta[] {
	let names: string[];
	try {
		names = readdirSync(sessionsDir);
	} catch {
		return [];
	}
	return names
		.flatMap((name) => {
			const meta = readSession(sessionsDir, name);
			return meta?.id === name ? [meta] : [];
		})
		.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
}

/** The most recently updated session whose cwd is `cwd`. */
export function latestSession(sessionsDir: string, cwd: string): SessionMeta | undefined {
	return listSessions(sessionsDir).find((meta) => meta.cwd === cwd);
}

/** Apply `change` to the stored meta, stamp `updatedAt`, and return the result. */
export function updateSession(
	sessionsDir: string,
	meta: SessionMeta,
	change: Partial<WritableMeta>,
	now = Date.now(),
): SessionMeta {
	const next: SessionMeta = { ...meta, ...change, updatedAt: now };
	writeMeta(sessionsDir, next);
	return next;
}

/**
 * Take the session's writer lock: an exclusive SQLite lock on `lock.sqlite`. The OS drops it when the holder's
 * process ends however it ends, so a crash never leaves a stale lock to take over and a reused pid cannot keep one.
 * Throws `SessionLockedError` while another holder has it, also when that holder is this process.
 */
export function lockSession(sessionsDir: string, id: string): SessionLock {
	const dir = sessionDir(sessionsDir, id);
	const database = new DatabaseSync(join(dir, "lock.sqlite"));
	try {
		database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
	} catch (error) {
		database.close();
		// node:sqlite types its errors as plain `Error`; `errcode` carries SQLite's result code.
		if (error instanceof Error && "errcode" in error && error.errcode === SQLITE_BUSY) {
			throw new SessionLockedError(id, readHolder(dir));
		}
		throw error;
	}
	// Only the error message reads the pid; whether the session is locked is the OS lock's answer alone.
	writeAtomically(join(dir, "lock.pid"), String(process.pid));
	return { release: () => database.close() };
}

const SQLITE_BUSY = 5;

function readHolder(dir: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(join(dir, "lock.pid"), "utf8");
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(text, 10);
	return Number.isSafeInteger(pid) ? pid : undefined;
}

function writeMeta(sessionsDir: string, meta: SessionMeta): void {
	writeAtomically(join(sessionDir(sessionsDir, meta.id), "meta.json"), `${JSON.stringify(meta, null, "\t")}\n`);
}

function writeAtomically(file: string, text: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, file);
}

// `meta.json` is a file on disk: the trust boundary of the session list.
function parseMeta(raw: unknown): SessionMeta | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	const { id, cwd, title, titleSource, createdAt, updatedAt, model } = value;
	if (typeof id !== "string" || typeof cwd !== "string") return undefined;
	if (typeof createdAt !== "number" || typeof updatedAt !== "number") return undefined;
	return {
		id,
		cwd,
		createdAt,
		updatedAt,
		...(typeof title === "string" ? { title } : {}),
		...(titleSource === "first-line" || titleSource === "model" ? { titleSource } : {}),
		...(typeof model === "string" ? { model } : {}),
	};
}
