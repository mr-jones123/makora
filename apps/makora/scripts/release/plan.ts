// makora's next release from conventional commits: which commits change what ships, the version bump, the changelog
// section, and the release a merged release PR asks for. Pure functions; repo.ts reads git and the files.
import { type CommitType, parseCommitMessage } from "./commits.ts";

/** One commit as git reports it. */
export interface Commit {
	readonly sha: string;
	/** Author date, ISO 8601. */
	readonly date: string;
	readonly message: string;
	/** Paths the commit changed, relative to the repository root. */
	readonly files: readonly string[];
}

export type Bump = "major" | "minor" | "patch" | "none";

/** A commit that changes what ships, as the plan counts it; `type` is null for a message that is not conventional. */
export interface PlannedCommit {
	readonly sha: string;
	readonly date: string;
	readonly type: CommitType | null;
	readonly scope?: string;
	readonly subject: string;
	readonly breaking: boolean;
	readonly breakingNote?: string;
	readonly bump: Bump;
}

/** What release-plan prints: the last release, the next one (null when nothing ships), and its changelog section. */
export interface ReleasePlan {
	readonly current: string | null;
	readonly next: string | null;
	readonly bump: Bump;
	readonly commits: readonly PlannedCommit[];
	/** The markdown section for `next`; empty when `next` is null. */
	readonly changelog: string;
}

/** The plan for `commits` (newest first) since release `current`, null before the first release, made on `date`. */
export function planRelease(
	commits: readonly Commit[],
	current: string | null,
	shipped: readonly string[],
	date: string,
): ReleasePlan {
	const planned = commits.filter((commit) => touchesShipped(commit.files, shipped)).map(planCommit);
	const bump = planned.reduce<Bump>(
		(highest, commit) => (BUMP_ORDER.indexOf(commit.bump) > BUMP_ORDER.indexOf(highest) ? commit.bump : highest),
		"none",
	);
	const next = nextVersion(current, bump);
	return {
		current,
		next,
		bump,
		commits: planned,
		changelog: next === null ? "" : renderChangelog(next, date, planned),
	};
}

/** Whether any of `files` is under one of the `shipped` directory prefixes (each ends in `/`). */
export function touchesShipped(files: readonly string[], shipped: readonly string[]): boolean {
	return files.some((file) => shipped.some((prefix) => file.startsWith(prefix)));
}

function planCommit(commit: Commit): PlannedCommit {
	const parsed = parseCommitMessage(commit.message);
	const base = { sha: commit.sha, date: commit.date };
	if (parsed.kind !== "conventional") {
		return { ...base, type: null, subject: commit.message.split("\n")[0] ?? "", breaking: false, bump: "none" };
	}
	return {
		...base,
		type: parsed.type,
		...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
		subject: parsed.subject,
		breaking: parsed.breaking,
		...(parsed.breakingNote === undefined ? {} : { breakingNote: parsed.breakingNote }),
		bump: parsed.breaking ? "major" : TYPE_BUMPS[parsed.type],
	};
}

// A revert changes what ships, like a fix; the other types never cut a release by themselves.
const TYPE_BUMPS: Readonly<Record<CommitType, Bump>> = {
	feat: "minor",
	fix: "patch",
	revert: "patch",
	docs: "none",
	ci: "none",
	test: "none",
	chore: "none",
	refactor: "none",
	perf: "none",
	style: "none",
	build: "none",
};

const BUMP_ORDER: readonly Bump[] = ["none", "patch", "minor", "major"];

/** The version after `current` for `bump`: the first release is 0.1.0, and below 1.0 a breaking change bumps minor. */
export function nextVersion(current: string | null, bump: Bump): string | null {
	if (bump === "none") return null;
	if (current === null) return "0.1.0";
	const [major = 0, minor = 0, patch = 0] = parseVersion(current);
	const effective = bump === "major" && major === 0 ? "minor" : bump;
	if (effective === "major") return `${major + 1}.0.0`;
	if (effective === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** Order of two `x.y.z` versions: negative when `left` is older. */
export function compareVersions(left: string, right: string): number {
	const [a, b] = [parseVersion(left), parseVersion(right)];
	return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

function parseVersion(version: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (match === null) throw new Error(`not a makora version: ${version}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The GitHub repository the changelog links to. */
export const REPOSITORY_URL = "https://github.com/mr-jones123/pi";

/** The changelog section of release `version` on `date` (YYYY-MM-DD): breaking changes, features, fixes, reverts. */
export function renderChangelog(version: string, date: string, commits: readonly PlannedCommit[]): string {
	const groups: [string, (commit: PlannedCommit) => boolean][] = [
		["Breaking changes", (commit) => commit.breaking],
		["Features", (commit) => !commit.breaking && commit.type === "feat"],
		["Fixes", (commit) => !commit.breaking && commit.type === "fix"],
		["Reverts", (commit) => !commit.breaking && commit.type === "revert"],
	];
	const lines = [`## [${version}](${REPOSITORY_URL}/releases/tag/makora-v${version}) - ${date}`];
	for (const [title, belongs] of groups) {
		const entries = commits.filter(belongs);
		if (entries.length === 0) continue;
		lines.push("", `### ${title}`, "", ...entries.map(entry));
	}
	return `${lines.join("\n")}\n`;
}

function entry(commit: PlannedCommit): string {
	const scope = commit.scope === undefined ? "" : `**${commit.scope}:** `;
	const link = `([${commit.sha.slice(0, 7)}](${REPOSITORY_URL}/commit/${commit.sha}))`;
	const note = commit.breakingNote === undefined ? "" : `\n  ${commit.breakingNote}`;
	return `- ${scope}${commit.subject} ${link}${note}`;
}

const CHANGELOG_HEADER = `# makora changelog

Generated from conventional commits by \`scripts/release-plan.mjs\` in the release PR; do not edit by hand.
`;

/** `CHANGELOG.md` with `section` as its newest release; `existing` is the current file, undefined when there is none. */
export function prependChangelog(existing: string | undefined, section: string): string {
	const releases = existing === undefined ? "" : existing.slice(existing.indexOf("\n## ") + 1);
	return `${CHANGELOG_HEADER}\n${section}${releases === "" ? "" : `\n${releases}`}`;
}

/** The section of release `version` in `changelog`, without its heading, or undefined when it has none. */
export function changelogSection(changelog: string, version: string): string | undefined {
	const start = changelog.indexOf(`\n## [${version}]`);
	if (start === -1) return undefined;
	const body = changelog.slice(changelog.indexOf("\n", start + 1) + 1);
	const end = body.indexOf("\n## [");
	return (end === -1 ? body : body.slice(0, end + 1)).trim();
}

/** A version the merged release PR asks to publish, with its release notes. */
export interface PendingRelease {
	readonly version: string;
	readonly notes: string;
}

/**
 * The release to publish: package.json's `version` when it is newer than every `released` version (so untagged) and
 * the changelog has its section, which only a release PR writes.
 */
export function pendingRelease(
	version: string,
	released: readonly string[],
	changelog: string | undefined,
): PendingRelease | null {
	if (released.some((tag) => compareVersions(tag, version) >= 0)) return null;
	const notes = changelog === undefined ? undefined : changelogSection(changelog, version);
	return notes === undefined ? null : { version, notes };
}
