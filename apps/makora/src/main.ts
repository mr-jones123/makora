// The makora command: parses the arguments and runs the session list, deleting a session, print mode, or the TUI.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { openApp } from "./app.ts";
import { parseCli, type SessionChoice, USAGE } from "./cli-args.ts";
import { describeBuild, INSTALL } from "./install.ts";
import { ensurePythonEnv } from "./kernel/python-env.ts";
import {
	dreamCancelCommand,
	dreamCommand,
	dreamStatusCommand,
	dreamWorkerCommand,
	wikiCommand,
	wikiSetupCommand,
} from "./memory/commands.ts";
import { homePaths, makoraHome, tildify } from "./paths.ts";
import { runPrint } from "./print.ts";
import { type MakoraSession, openEphemeralSession, openSession } from "./session.ts";
import { describeCleanup, prepareDeletion, type SessionDeletion } from "./session-delete.ts";
import {
	createSession,
	latestSession,
	listSessions,
	readSession,
	SessionLockedError,
	type SessionMeta,
	sessionDir,
} from "./sessions.ts";
import { runTui } from "./tui/run.ts";
import { updatePlan } from "./update.ts";

// pi-ai loads OAuth flows and bedrock through variable import specifiers resolved next to its own files, which a
// release bundle does not have; these loaders use literal imports, so the bundle carries them.
registerLazyOAuthFlows();
registerLazyBedrockProvider();

const command = parseCli(process.argv.slice(2), process.env.MAKORA_FAKE);
process.exit(await main());

async function main(): Promise<number> {
	switch (command.kind) {
		case "help":
			process.stdout.write(`${USAGE}\n`);
			return 0;
		case "version":
			process.stdout.write(`${describeBuild(INSTALL.build)}\n`);
			return 0;
		case "error":
			process.stderr.write(`makora: ${command.message}\n\n${USAGE}\n`);
			return 2;
		case "list":
			return listCommand();
		case "remove":
			return removeCommand(command.id);
		case "setup":
			return setupCommand();
		case "update":
			return updateCommand();
		case "dream":
			return memoryCommand(async (app) => {
				if (command.action === "start") return dreamCommand(app, process.cwd());
				return command.action === "status"
					? dreamStatusCommand(app, command.id)
					: dreamCancelCommand(app, command.id);
			}, command.fake);
		case "dreamWorker":
			return dreamWorkerCommand(openApp(makoraHome(), command.fake), command.id);
		case "wiki":
			return memoryCommand(async (app) => wikiCommand(app), false);
		case "wikiSetup":
			return memoryCommand(async (app) => wikiSetupCommand(app, command.vault, command.folder), false);
		case "run":
			break;
	}
	const app = openApp(makoraHome(), command.fake);
	const cwd = process.cwd();
	if (command.prompt === undefined) {
		return runTui(app, {
			cwd,
			session: command.session,
			ephemeral: command.ephemeral,
			...(command.model ? { model: command.model } : {}),
		});
	}
	const context = BACKGROUND_CONTEXT;
	const options = command.model ? { model: command.model } : {};
	let session: MakoraSession;
	try {
		if (command.ephemeral) session = await openEphemeralSession(app, cwd, options, context);
		else {
			const meta = chooseForPrint(app.paths.sessions, cwd, command.session);
			if (typeof meta === "string") {
				process.stderr.write(`makora: ${meta}\n`);
				return 1;
			}
			session = await openSession(app, meta, options, context);
		}
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

/** Run one of memory's commands and print what it says; exit 1 only when it throws. */
async function memoryCommand(
	run: (app: ReturnType<typeof openApp>) => Promise<string>,
	fake: boolean,
): Promise<number> {
	try {
		process.stdout.write(`${await run(openApp(makoraHome(), fake))}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`makora: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** `makora setup`: build the Python environment now, as install.sh does, so the first REPL cell does not wait. */
async function setupCommand(): Promise<number> {
	try {
		const env = await ensurePythonEnv(makoraHome());
		process.stdout.write(`Python environment ready: ${tildify(env.python)}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`makora: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** `makora update`: run the release's installer, which reports the version change or that makora is up to date. */
function updateCommand(): number {
	const plan = updatePlan(INSTALL);
	if (plan.kind === "refused") {
		process.stderr.write(`makora: ${plan.reason}\n`);
		return 1;
	}
	const result = spawnSync("sh", plan.args, { env: plan.env, stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

/** `makora rm <id>`: say what deleting the session removes and keeps, ask, then delete it. */
async function removeCommand(id: string): Promise<number> {
	const app = openApp(makoraHome(), false);
	const meta = readSession(app.paths.sessions, id);
	if (meta === undefined) {
		process.stderr.write(`makora: no session ${id}\n`);
		return 1;
	}
	let deletion: SessionDeletion;
	try {
		deletion = await prepareDeletion(app, meta, BACKGROUND_CONTEXT);
	} catch (error) {
		if (!(error instanceof SessionLockedError)) throw error;
		process.stderr.write(`makora: ${error.message}\n`);
		return 1;
	}
	try {
		const lines = [
			`Session ${meta.id} (${meta.title ?? "untitled"}, ${tildify(meta.cwd)}). Deleting it:`,
			...describeCleanup(deletion.plan, tildify),
			`  removes refs/makora/${meta.id}/ and ${tildify(sessionDir(app.paths.sessions, meta.id))}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
		if (!(await confirmed("Delete it? [y/N] "))) {
			process.stdout.write("Nothing deleted.\n");
			return 1;
		}
		await deletion.run();
		process.stdout.write(`Deleted session ${meta.id}.\n`);
		return 0;
	} finally {
		deletion.release();
	}
}

/** Ask `question` on stdin; only a line `y` or `yes` is a yes, and an input that ends first is a no. */
async function confirmed(question: string): Promise<boolean> {
	process.stdout.write(question);
	const lines = createInterface({ input: process.stdin });
	try {
		const [answer] = await Promise.race([
			once(lines, "line") as Promise<[string]>,
			once(lines, "close").then(() => [""] as const),
		]);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		lines.close();
	}
}
