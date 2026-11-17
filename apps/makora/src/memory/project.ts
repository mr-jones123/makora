// A session's project: the repository its folder belongs to, named so every clone and worktree of one repository
// shares one memory.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

/** A repository as memory knows it. */
export interface Project {
	/** The git remote as `host/owner/repo`, else `commit:<first commit>`, else `dir:<folder>`. */
	readonly id: string;
	readonly name: string;
}

const run = promisify(execFile);

/** The project of the folder `cwd`. */
export async function projectOf(cwd: string): Promise<Project> {
	const git = async (...args: string[]): Promise<string | undefined> => {
		try {
			return (await run("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	};
	const remote = await git("remote", "get-url", "origin");
	if (remote !== undefined) {
		const id = remoteId(remote);
		return { id, name: basename(id) };
	}
	const top = await git("rev-parse", "--show-toplevel");
	const roots = await git("rev-list", "--max-parents=0", "HEAD");
	const name = basename(top ?? cwd);
	if (roots !== undefined) return { id: `commit:${roots.split("\n").sort()[0]}`, name };
	return { id: `dir:${top ?? cwd}`, name };
}

/** A remote URL as `host/owner/repo`: the same repository over ssh, https or with a user gives one id. */
export function remoteId(url: string): string {
	const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
	const path = scp === null ? url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "") : `${scp[1]}/${scp[2]}`;
	return path
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}
