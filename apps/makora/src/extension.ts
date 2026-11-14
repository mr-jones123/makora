// The `makora` extension: the system prompt sections every makora conversation gets next to the coding tools.
import { homedir } from "node:os";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { discoverContextFiles, renderContextFiles } from "./context-files.ts";
import type { HomePaths } from "./paths.ts";
import { discoverSkills, renderSkills } from "./skills.ts";

const PREAMBLE = [
	"You are makora, a coding agent harness for long-running tasks.",
	"Your tools in this phase are read, write, edit and bash. Use them to inspect and change the project; prefer small, verified steps.",
].join("\n");

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
