// A second makora process for lock tests: takes the lock of session `<id>` under `<sessionsDir>`, prints the outcome
// as one JSON line, and holds the lock for `<holdMs>` before releasing it.
import { lockSession, SessionLockedError } from "../../src/sessions.ts";

const [sessionsDir, id, holdMs] = process.argv.slice(2);
try {
	const lock = lockSession(sessionsDir!, id!);
	process.stdout.write(`${JSON.stringify({ locked: true })}\n`);
	setTimeout(() => lock.release(), Number(holdMs));
} catch (error) {
	if (!(error instanceof SessionLockedError)) throw error;
	process.stdout.write(`${JSON.stringify({ locked: false, holder: error.pid })}\n`);
}
