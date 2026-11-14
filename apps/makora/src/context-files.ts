// Context files: the AGENTS.md files whose instructions go into every request's system prompt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirs } from "./project.ts";

/** One AGENTS.md file and its text. */
export interface ContextFile {
	readonly path: string;
	readonly content: string;
}

/**
 * The context files for `cwd`, in prompt order: the user's `<home>/AGENTS.md`, then every `AGENTS.md` from the git
 * repository root down to `cwd`, outermost first. Missing files are skipped.
 */
export function discoverContextFiles(cwd: string, userFile: string): ContextFile[] {
	const paths = [
		userFile,
		...projectDirs(cwd)
			.reverse()
			.map((dir) => join(dir, "AGENTS.md")),
	];
	return paths.flatMap((path) => {
		try {
			return [{ path, content: readFileSync(path, "utf8") }];
		} catch {
			return [];
		}
	});
}

/** The context files as one prompt section, each under its path; undefined when there are none. */
export function renderContextFiles(files: readonly ContextFile[]): string | undefined {
	if (files.length === 0) return undefined;
	const parts = files.map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`);
	return `Project instructions from AGENTS.md files. Inner directories refine outer ones.\n\n${parts.join("\n\n")}`;
}
