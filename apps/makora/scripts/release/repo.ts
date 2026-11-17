// What the release scripts read from the repository: the paths whose changes ship in makora, makora's release tags,
// and commits from git.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Commit, compareVersions } from "./plan.ts";

/** Tags of makora releases; the repository also holds upstream pi's `v*` tags. */
export const TAG_PREFIX = "makora-v";

/**
 * The directories (each ending in `/`) whose changes ship in makora: `apps/makora/` and every workspace package it
 * depends on, directly or through another workspace package. scripts/build-release.mjs checks the bundle against it.
 */
export function shippedPaths(root: string): string[] {
	const packages = new Map<string, { dir: string; dependencies: string[] }>();
	for (const dir of readdirSync(join(root, "packages"))) {
		const manifest = readManifest(join(root, "packages", dir));
		if (manifest !== undefined)
			packages.set(manifest.name, { dir: `packages/${dir}/`, dependencies: manifest.dependencies });
	}
	const shipped = new Set<string>(["apps/makora/"]);
	const queue = [...(readManifest(join(root, "apps", "makora"))?.dependencies ?? [])];
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		const workspace = packages.get(name);
		if (workspace === undefined || shipped.has(workspace.dir)) continue;
		shipped.add(workspace.dir);
		queue.push(...workspace.dependencies);
	}
	return [...shipped].sort();
}

// The dependencies that end up in a bundle; dev dependencies do not.
function readManifest(dir: string): { name: string; dependencies: string[] } | undefined {
	let text: string;
	try {
		text = readFileSync(join(dir, "package.json"), "utf8");
	} catch {
		return undefined;
	}
	const manifest = JSON.parse(text) as {
		name: string;
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
	return { name: manifest.name, dependencies: Object.keys(dependencies) };
}

/** The versions of the `makora-v*` tags reachable from HEAD, newest first by version. */
export function releasedVersions(root: string): string[] {
	return git(root, ["tag", "--merged", "HEAD", "--list", `${TAG_PREFIX}*`])
		.split("\n")
		.map((tag) => tag.slice(TAG_PREFIX.length))
		.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
		.sort((left, right) => compareVersions(right, left));
}

/**
 * The commits in `base..HEAD`, newest first: first-parent commits and the ones merges brought in, each with the files
 * it changed. Merge commits are left out; the commits they merge carry the changes.
 */
export function commitsSince(root: string, base: string): Commit[] {
	const log = git(root, [
		"log",
		"--no-merges",
		"--name-only",
		`--format=${RECORD}%H${FIELD}%aI${FIELD}%B${FIELD}`,
		`${base}..HEAD`,
	]);
	return log
		.split(RECORD)
		.slice(1)
		.map((record) => {
			const [sha = "", date = "", message = "", files = ""] = record.split(FIELD);
			return { sha, date, message: message.trim(), files: files.split("\n").filter((file) => file !== "") };
		});
}

const RECORD = "\x1e";
const FIELD = "\x1f";

/** A commit on the first-parent line of a range, as the commit check reads it. */
export interface LineCommit {
	readonly sha: string;
	readonly merge: boolean;
	readonly message: string;
}

/**
 * The first-parent commits in `base..head`, newest first, or `head` alone when `base` is missing (a new branch, a
 * force push): commits a merge brought in through its second parent are never listed.
 */
export function firstParentCommits(root: string, base: string | undefined, head: string): LineCommit[] {
	const known = base !== undefined && !/^0+$/.test(base) && isCommit(root, base);
	const range = known ? [`${base}..${head}`] : ["-1", head];
	return git(root, ["log", "--first-parent", `--format=${RECORD}%H${FIELD}%P${FIELD}%B`, ...range])
		.split(RECORD)
		.slice(1)
		.map((record) => {
			const [sha = "", parents = "", message = ""] = record.split(FIELD);
			return { sha, merge: parents.trim().includes(" "), message: message.trim() };
		});
}

function isCommit(root: string, ref: string): boolean {
	try {
		git(root, ["cat-file", "-e", `${ref}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: "pipe" });
}
