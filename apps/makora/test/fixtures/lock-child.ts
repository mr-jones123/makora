// Spawns `lock-session.ts` as a second makora process so tests can see a session lock from outside.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** What the second process saw: the lock, or the pid `SessionLockedError` named. */
export interface LockAttempt {
	readonly locked: boolean;
	readonly holder?: number;
}

const SOURCE = fileURLToPath(new URL("../../src/source.ts", import.meta.url));
const LOCK_SESSION = fileURLToPath(new URL("./lock-session.ts", import.meta.url));

/** Another process trying to lock session `id` and holding it for `holdMs`; `outcome` is what it saw. */
export function lockInChild(
	sessionsDir: string,
	id: string,
	holdMs: number,
): { child: ChildProcess; outcome: Promise<LockAttempt> } {
	const child = spawn(process.execPath, ["--import", SOURCE, LOCK_SESSION, sessionsDir, id, String(holdMs)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const outcome = new Promise<LockAttempt>((resolve, reject) => {
		createInterface({ input: child.stdout! }).once("line", (line) => resolve(JSON.parse(line) as LockAttempt));
		child.once("exit", (code) => reject(new Error(`lock-session exited with ${code} before reporting`)));
	});
	return { child, outcome };
}
