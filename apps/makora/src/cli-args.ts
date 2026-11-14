// The makora command line, parsed into one tagged command.
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseModelRef } from "./app.ts";

/** Which session a run opens. */
export type SessionChoice =
	| { readonly kind: "new" }
	| { readonly kind: "continue" }
	/** `id` absent: let the user pick. */
	| { readonly kind: "resume"; readonly id?: string };

/** What the command line asks for. */
export type CliCommand =
	| { readonly kind: "help" }
	| { readonly kind: "list" }
	| {
			readonly kind: "run";
			readonly session: SessionChoice;
			/** Print mode's prompt; absent for the TUI. */
			readonly prompt?: string;
			readonly fake: boolean;
			readonly model?: ModelRef;
	  }
	| { readonly kind: "error"; readonly message: string };

/** Usage text for `makora --help`. */
export const USAGE = `Usage:
  makora                       new session in this directory
  makora --continue            latest session of this directory
  makora --resume [id]         resume a session (pick one when no id)
  makora ls                    list sessions
  makora -p "<prompt>"         print mode: answer one prompt and exit

Options:
  --fake                       scripted fake model (also MAKORA_FAKE=1)
  --model <provider/id>        model for this session
  -h, --help                   show this help`;

/** Parse makora's arguments (without `node` and the script); `fakeEnv` is the value of `MAKORA_FAKE`. */
export function parseCli(argv: readonly string[], fakeEnv: string | undefined): CliCommand {
	let session: SessionChoice = { kind: "new" };
	let prompt: string | undefined;
	let fake = fakeEnv === "1";
	let model: ModelRef | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "-h":
			case "--help":
				return { kind: "help" };
			case "ls":
				return index === 0 && argv.length === 1
					? { kind: "list" }
					: { kind: "error", message: "`ls` takes no options" };
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
	return {
		kind: "run",
		session,
		fake,
		...(prompt === undefined ? {} : { prompt }),
		...(model === undefined ? {} : { model }),
	};
}
