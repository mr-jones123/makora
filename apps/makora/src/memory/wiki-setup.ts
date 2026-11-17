// /wiki-setup: pointing makora at an Obsidian vault, and making the folder of it that makora owns. Every starting
// state has one outcome, so running it twice is safe.
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { WIKI_LAYOUT, WIKI_MARKER } from "./wiki.ts";

/** The folder makora writes into when the user names none. */
export const DEFAULT_WIKI_FOLDER = "makora";

/** What setup did, or why it refused. */
export type WikiSetup =
	| {
			readonly kind: "ready";
			/** The wiki folder: `<vault>/<folder>`. */
			readonly root: string;
			readonly vault: string;
			readonly folder: string;
			/** One line per thing the user should know: a new vault, Bases off. */
			readonly notes: readonly string[];
	  }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * Make `<vault>/<folder>` a wiki folder makora owns. A missing `vault` becomes a new vault; an existing vault is left
 * as it is apart from that folder; a folder makora did not make is refused, since it holds someone's notes.
 */
export function setupWiki(vaultPath: string, folder: string): WikiSetup {
	const problem = folderProblem(folder);
	if (problem !== undefined) return { kind: "refused", reason: problem };
	const vault = resolve(vaultPath);
	const notes: string[] = [];
	if (!existsSync(vault)) {
		mkdirSync(vault, { recursive: true });
		// An empty .obsidian makes the folder a vault; Obsidian fills it in on first open. Its core plugins, Bases
		// among them, default to on for keys the vault's config does not set.
		mkdirSync(join(vault, ".obsidian"));
		notes.push(`Created a new vault at ${vault}; open it in Obsidian with "Open folder as vault".`);
	} else if (!statSync(vault).isDirectory()) {
		return { kind: "refused", reason: `${vault} is a file, not a folder` };
	}
	try {
		accessSync(vault, constants.W_OK);
	} catch {
		return { kind: "refused", reason: `${vault} is not writable` };
	}
	if (!existsSync(join(vault, ".obsidian")))
		notes.push(`${vault} has no .obsidian folder yet; Obsidian makes one when you open it as a vault.`);
	if (basesOff(vault))
		notes.push(
			"Bases is turned off in this vault; turn it on in Settings > Core plugins to use the tables in bases/.",
		);
	const root = join(vault, folder);
	if (existsSync(root)) {
		if (!statSync(root).isDirectory()) return { kind: "refused", reason: `${root} is a file, not a folder` };
		if (!existsSync(join(root, WIKI_MARKER)) && readdirSync(root).length > 0)
			return { kind: "refused", reason: `${root} has notes makora did not write; pick another folder name` };
	}
	mkdirSync(join(root, "sessions"), { recursive: true });
	mkdirSync(join(root, "bases"), { recursive: true });
	if (!existsSync(join(root, WIKI_MARKER)))
		writeFileSync(join(root, WIKI_MARKER), `${JSON.stringify({ layout: WIKI_LAYOUT })}\n`);
	return { kind: "ready", root, vault, folder, notes };
}

/** Why `folder` cannot be a wiki folder, or undefined: one plain folder name, not hidden, not `.obsidian`. */
export function folderProblem(folder: string): string | undefined {
	if (folder.trim() === "") return "the folder name is empty";
	if (/[/\\]/.test(folder)) return `"${folder}" is a path; the folder must be one name inside the vault`;
	if (folder.startsWith(".")) return `"${folder}" is hidden; Obsidian does not index hidden folders`;
	return undefined;
}

// The vault's own config is the user's: read to warn, never written.
function basesOff(vault: string): boolean {
	try {
		const plugins = JSON.parse(readFileSync(join(vault, ".obsidian", "core-plugins.json"), "utf8")) as Record<
			string,
			unknown
		>;
		return plugins.bases === false;
	} catch {
		return false;
	}
}
