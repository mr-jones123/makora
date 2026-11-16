// Where makora keeps its state: the home directory and the files and directories under it.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The files and directories of one makora home. */
export interface HomePaths {
	readonly home: string;
	readonly sessions: string;
	readonly auth: string;
	readonly settings: string;
	readonly keybindings: string;
	readonly agents: string;
	readonly skills: string;
	/** Fork worktrees, and write subagents' by default: `<repo>-<hash>/<session>/<conversation>`. */
	readonly worktrees: string;
	/** Quiz pages: `<repo>-<hash>/<YYYY-MM-DD>-<n>.html`. */
	readonly quizzes: string;
}

/** Makora's home directory, absolute: `MAKORA_HOME` resolved against the cwd, or `~/.makora`. */
export function makoraHome(): string {
	// Kernels run in the conversation's cwd, so a relative blob directory under the home would point elsewhere.
	return process.env.MAKORA_HOME === undefined ? join(homedir(), ".makora") : resolve(process.env.MAKORA_HOME);
}

/** The files and directories under `home`. */
export function homePaths(home: string): HomePaths {
	return {
		home,
		sessions: join(home, "sessions"),
		auth: join(home, "auth.json"),
		settings: join(home, "settings.json"),
		keybindings: join(home, "keybindings.json"),
		agents: join(home, "AGENTS.md"),
		skills: join(home, "skills"),
		worktrees: join(home, "worktrees"),
		quizzes: join(home, "quizzes"),
	};
}

/** `path` with the user's home directory shown as `~`. */
export function tildify(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
