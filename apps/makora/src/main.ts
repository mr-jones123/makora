// The makora command: parses the arguments and runs the session list, print mode, or the TUI.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "./app.ts";
import { parseCli, type SessionChoice, USAGE } from "./cli-args.ts";
import { homePaths, makoraHome, tildify } from "./paths.ts";
import { runPrint } from "./print.ts";
import { type MakoraSession, openSession } from "./session.ts";
import {
	createSession,
	latestSession,
	listSessions,
	readSession,
	SessionLockedError,
	type SessionMeta,
} from "./sessions.ts";
import { runTui } from "./tui/run.ts";

const command = parseCli(process.argv.slice(2), process.env.MAKORA_FAKE);
process.exit(await main());

async function main(): Promise<number> {
	switch (command.kind) {
		case "help":
			process.stdout.write(`${USAGE}\n`);
			return 0;
		case "error":
			process.stderr.write(`makora: ${command.message}\n\n${USAGE}\n`);
			return 2;
		case "list":
			return listCommand();
		case "run":
			break;
	}
	const app = openApp(makoraHome(), command.fake);
	const cwd = process.cwd();
	if (command.prompt === undefined) {
		return runTui(app, { cwd, session: command.session, ...(command.model ? { model: command.model } : {}) });
	}
	const meta = chooseForPrint(app.paths.sessions, cwd, command.session);
	if (typeof meta === "string") {
		process.stderr.write(`makora: ${meta}\n`);
		return 1;
	}
	const context = BACKGROUND_CONTEXT;
	let session: MakoraSession;
	try {
		session = await openSession(app, meta, command.model ? { model: command.model } : {}, context);
	} catch (error) {
		if (!(error instanceof SessionLockedError)) throw error;
		process.stderr.write(`makora: ${error.message}\n`);
		return 1;
	}
	process.once("SIGINT", () => void session.root.abort(context));
	try {
		return await runPrint(
			session,
			command.prompt,
			{ stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
			context,
		);
	} finally {
		await session.close();
	}
}

/** The session print mode opens, or why there is none. */
function chooseForPrint(sessionsDir: string, cwd: string, choice: SessionChoice): SessionMeta | string {
	switch (choice.kind) {
		case "new":
			return createSession(sessionsDir, cwd);
		case "continue":
			return latestSession(sessionsDir, cwd) ?? `no session for ${tildify(cwd)}; run without --continue`;
		case "resume":
			if (choice.id === undefined) return "print mode needs a session id: --resume <id>";
			return readSession(sessionsDir, choice.id) ?? `no session ${choice.id}`;
	}
}

function listCommand(): number {
	const sessions = listSessions(homePaths(makoraHome()).sessions);
	if (sessions.length === 0) {
		process.stdout.write("No sessions.\n");
		return 0;
	}
	for (const meta of sessions) {
		const updated = new Date(meta.updatedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
		process.stdout.write(`${meta.id}  ${updated}  ${tildify(meta.cwd)}  ${meta.title ?? "(untitled)"}\n`);
	}
	return 0;
}
