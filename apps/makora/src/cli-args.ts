// The makora command line, parsed into one tagged command.
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseModelRef } from "./models.ts";

/** Which session a run opens. */
export type SessionChoice =
	| { readonly kind: "new" }
	| { readonly kind: "continue" }
	/** `id` absent: let the user pick. */
	| { readonly kind: "resume"; readonly id?: string };

/** What the command line asks for. */
export type CliCommand =
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "list" }
	/** Delete a stored session with its worktrees. */
	| { readonly kind: "remove"; readonly id: string }
	/** Build the Python environment kernels run in, so the first session does not wait for it. */
	| { readonly kind: "setup" }
	/** Install the latest release over this one. */
	| { readonly kind: "update" }
	/** Start a dream for this directory's project, show one, or cancel one. */
	| {
			readonly kind: "dream";
			readonly action: "start" | "status" | "cancel";
			readonly id?: number;
			readonly fake: boolean;
	  }
	/** The detached process that runs dream `id`; `makora dream` starts it. */
	| { readonly kind: "dreamWorker"; readonly id: number; readonly fake: boolean }
	/** Render memory into the wiki folder of the vault. */
	| { readonly kind: "wiki" }
	/** Point makora at an Obsidian vault and make its wiki folder. */
	| { readonly kind: "wikiSetup"; readonly vault: string; readonly folder?: string }
	| {
			readonly kind: "run";
			readonly session: SessionChoice;
			/** Print mode's prompt; absent for the TUI. */
			readonly prompt?: string;
			readonly fake: boolean;
			/** Keep the session in memory: no session directory, no snapshots. */
			readonly ephemeral: boolean;
			readonly model?: ModelRef;
	  }
	| { readonly kind: "error"; readonly message: string };

/** Usage text for `makora --help`. */
export const USAGE = `Usage:
  makora                       new session in this directory
  makora --continue            latest session of this directory
  makora --resume [id]         resume a session (pick one when no id)
  makora ls                    list sessions
  makora rm <id>               delete a session, its worktrees, and its branches without work
  makora -p "<prompt>"         print mode: answer one prompt and exit
  makora update                update to the latest release
  makora setup                 build the Python environment REPL cells run in
  makora dream                 turn this project's recent sessions into memory, in the background
  makora dream status [id]     show the newest dream, or dream <id>
  makora dream cancel [id]     stop the newest dream, or dream <id>
  makora wiki-setup <vault> [folder]
                               render memory into <vault>/<folder> (default makora); a new path becomes a vault
  makora wiki                  render memory into the vault again

Options:
  --fake                       scripted fake model (also MAKORA_FAKE=1)
  --ephemeral                  keep the session in memory only
  --model <provider/id>        model for this session
  -v, --version                show the version
  -h, --help                   show this help`;

/** Parse makora's arguments (without `node` and the script); `fakeEnv` is the value of `MAKORA_FAKE`. */
export function parseCli(argv: readonly string[], fakeEnv: string | undefined): CliCommand {
	const memory = parseMemoryCommand(argv, fakeEnv === "1");
	if (memory !== undefined) return memory;
	let session: SessionChoice = { kind: "new" };
	let prompt: string | undefined;
	let fake = fakeEnv === "1";
	let ephemeral = false;
	let model: ModelRef | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "-h":
			case "--help":
				return { kind: "help" };
			case "-v":
			case "--version":
				return { kind: "version" };
			case "ls":
			case "setup":
			case "update":
				return index === 0 && argv.length === 1
					? { kind: arg === "ls" ? "list" : arg }
					: { kind: "error", message: `\`${arg}\` takes no options` };
			case "rm":
				return index === 0 && argv.length === 2 && !argv[1]!.startsWith("-")
					? { kind: "remove", id: argv[1]! }
					: { kind: "error", message: "`rm` takes one session id" };
			case "-c":
			case "--continue":
				session = { kind: "continue" };
				break;
			case "-r":
			case "--resume": {
				const next = argv[index + 1];
				if (next !== undefined && !next.startsWith("-")) {
					session = { kind: "resume", id: next };
					index++;
				} else session = { kind: "resume" };
				break;
			}
			case "-p":
			case "--print": {
				const next = argv[index + 1];
				if (next === undefined) return { kind: "error", message: `${arg} needs a prompt` };
				prompt = next;
				index++;
				break;
			}
			case "--fake":
				fake = true;
				break;
			case "--ephemeral":
				ephemeral = true;
				break;
			case "--model": {
				const next = argv[index + 1];
				const parsed = next === undefined ? undefined : parseModelRef(next);
				if (parsed === undefined) return { kind: "error", message: "--model needs provider/modelId" };
				model = parsed;
				index++;
				break;
			}
			default:
				return { kind: "error", message: `Unknown argument: ${arg}` };
		}
	}
	if (ephemeral && session.kind !== "new") {
		return { kind: "error", message: "--ephemeral starts a new session; it cannot continue or resume one" };
	}
	return {
		kind: "run",
		session,
		fake,
		ephemeral,
		...(prompt === undefined ? {} : { prompt }),
		...(model === undefined ? {} : { model }),
	};
}

const MEMORY_COMMANDS = new Set(["dream", "dream-worker", "wiki", "wiki-setup"]);

// Memory's subcommands take positional arguments and only `--fake`, so they are parsed apart from a run's options.
function parseMemoryCommand(argv: readonly string[], fakeEnv: boolean): CliCommand | undefined {
	const [name, ...rest] = argv;
	if (name === undefined || !MEMORY_COMMANDS.has(name)) return undefined;
	const fake = fakeEnv || rest.includes("--fake");
	const args = rest.filter((arg) => arg !== "--fake");
	const id = (text: string | undefined): number | undefined | "bad" =>
		text === undefined ? undefined : /^\d+$/.test(text) ? Number(text) : "bad";
	switch (name) {
		case "dream": {
			const [action = "start", which, ...extra] = args;
			if (action !== "start" && action !== "status" && action !== "cancel")
				return {
					kind: "error",
					message: `\`dream ${action}\`: use \`dream\`, \`dream status [id]\` or \`dream cancel [id]\``,
				};
			const parsed = id(which);
			if (parsed === "bad" || extra.length > 0 || (action === "start" && which !== undefined))
				return { kind: "error", message: `\`dream ${action}\` takes at most one dream id` };
			return { kind: "dream", action, fake, ...(parsed === undefined ? {} : { id: parsed }) };
		}
		case "dream-worker": {
			const parsed = id(args[0]);
			return typeof parsed === "number" && args.length === 1
				? { kind: "dreamWorker", id: parsed, fake }
				: { kind: "error", message: "`dream-worker` takes one dream id" };
		}
		case "wiki":
			return args.length === 0 ? { kind: "wiki" } : { kind: "error", message: "`wiki` takes no arguments" };
		default:
			return args.length === 1 || args.length === 2
				? { kind: "wikiSetup", vault: args[0]!, ...(args[1] === undefined ? {} : { folder: args[1] }) }
				: { kind: "error", message: "`wiki-setup` takes a vault path and an optional folder name" };
	}
}
