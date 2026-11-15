// The `makora` extension: the system prompt sections every makora conversation gets: the REPL preamble, the cwd,
// context files and skills.
import { homedir } from "node:os";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { discoverContextFiles, renderContextFiles } from "./context-files.ts";
import type { HomePaths } from "./paths.ts";
import { discoverSkills, renderSkills } from "./skills.ts";

const PREAMBLE = `You are makora, a coding agent harness for long-running tasks.

Your one tool is \`python\`: a persistent Python 3.12 REPL in the project directory. Variables, functions and imports survive between cells; after a kernel restart they are restored from snapshots, and the cell's output says what was not. Every cell has these helpers; await them:
- \`await read(path, offset=None, limit=None)\` returns the text
- \`await write(path, content)\`
- \`await edit(path, [{"oldText": ..., "newText": ...}])\`, or \`await edit(path, old, new)\`
- \`await bash(command, timeout=None)\` returns \`.output\` and \`.exit_code\`
- \`await llm(prompt, schema=None, model=None)\`: one model call; text, or JSON checked against a JSON Schema
- \`ctx.input()\` is the latest user message; \`await ctx.transcript(limit=20)\` the recent entries
Do file and shell work through these helpers, so it is recorded. Keep large data in variables and print short summaries: only printed output and a cell's final expression reach you. Start long jobs (builds, training) in the background with bash and check on them in later cells. Prefer small, verified steps.`;

/** The makora extension for the home at `paths`; sections are rendered from the conversation's cwd at each request. */
export function makoraExtension(paths: HomePaths) {
	return defineExtension({
		name: "makora",
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("cwd", (input) => input.env?.cwd),
			section("context_files", (input) =>
				input.env === undefined ? undefined : renderContextFiles(discoverContextFiles(input.env.cwd, paths.agents)),
			),
			section("skills", (input) =>
				input.env === undefined
					? undefined
					: renderSkills(discoverSkills({ cwd: input.env.cwd, makoraHome: paths.home, userHome: homedir() })),
			),
		],
	});
}
