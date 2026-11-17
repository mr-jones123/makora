// The wiki: memory rendered as Obsidian pages (one per subject, one per session, an index per project, and Bases), as
// a pure function of the rows, then written into the vault, touching only pages whose content changed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClaimKind, ClaimStatus, MemoryStore, Polarity } from "./store.ts";

/** The version of the page layout and frontmatter; a render with a newer one rewrites the Bases. */
export const WIKI_LAYOUT = 1;

/** The marker file that says makora owns a folder of the vault. */
export const WIKI_MARKER = ".makora-wiki";

/** Everything a render reads, taken from the store at one moment. */
export interface WikiData {
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	readonly subjects: readonly {
		readonly id: number;
		readonly project: string | null;
		readonly key: string;
		readonly title: string;
	}[];
	readonly claims: readonly WikiClaim[];
	readonly sessions: readonly {
		readonly id: string;
		readonly project: string | null;
		readonly title: string | null;
		readonly createdAt: number;
	}[];
	readonly conflicts: readonly {
		readonly claim: number;
		readonly other: number;
		readonly reason: string;
		readonly status: string;
	}[];
	readonly links: readonly { readonly from: number; readonly to: number; readonly relation: string }[];
}

/** A claim with what its page shows of it. */
export interface WikiClaim {
	readonly id: number;
	readonly subject: number;
	readonly kind: ClaimKind;
	readonly statement: string;
	readonly status: ClaimStatus;
	readonly supersededBy: number | null;
	readonly updatedAt: number;
	readonly evidence: readonly { readonly session: string; readonly quote: string; readonly polarity: Polarity }[];
	/** Earlier wordings, oldest first, with when each was let go. */
	readonly history: readonly { readonly statement: string; readonly until: number }[];
}

/** The rows a render needs. */
export function wikiData(store: MemoryStore): WikiData {
	const { db } = store;
	const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
	const evidence = all<{ claim: number; session: string; quote: string; polarity: Polarity }>(
		`SELECT v.claim, e.session, ev.quote, ev.polarity FROM evidence ev
		JOIN claim_versions v ON v.id = ev.version JOIN episodes e ON e.id = ev.episode ORDER BY ev.id`,
	);
	const history = all<{ claim: number; statement: string; until: number }>(
		"SELECT claim, statement, retracted_at AS until FROM claim_versions WHERE retracted_at IS NOT NULL ORDER BY id",
	);
	const claims = all<Omit<WikiClaim, "evidence" | "history">>(
		"SELECT id, subject, kind, statement, status, superseded_by AS supersededBy, updated_at AS updatedAt FROM claims ORDER BY id",
	);
	return {
		projects: all("SELECT id, name FROM projects ORDER BY id"),
		subjects: all("SELECT id, project, key, title FROM subjects ORDER BY id"),
		claims: claims.map((claim) => ({
			...claim,
			evidence: evidence.filter((each) => each.claim === claim.id),
			history: history.filter((each) => each.claim === claim.id && each.statement !== claim.statement),
		})),
		sessions: all("SELECT id, project, title, created_at AS createdAt FROM sessions ORDER BY created_at, id"),
		conflicts: all("SELECT claim, other, reason, status FROM conflicts ORDER BY id"),
		links: all("SELECT from_claim AS 'from', to_claim AS 'to', relation FROM links ORDER BY from_claim, to_claim"),
	};
}

/**
 * The pages of the wiki in folder `folder` of the vault, by path relative to that folder. The same data always gives
 * the same pages, byte for byte.
 */
export function renderWiki(data: WikiData, folder: string): Map<string, string> {
	const links = wikiLinks(data, folder);
	const pages = new Map<string, string>();
	pages.set(WIKI_MARKER, `${JSON.stringify({ layout: WIKI_LAYOUT })}\n`);
	pages.set("bases/Subjects.base", SUBJECTS_BASE(folder));
	pages.set("bases/Sessions.base", SESSIONS_BASE(folder));
	for (const subject of data.subjects) {
		const claims = data.claims.filter((claim) => claim.subject === subject.id);
		if (claims.length > 0)
			pages.set(`${links.subjectPath.get(subject.id)}.md`, subjectPage(data, links, subject, claims));
	}
	for (const session of data.sessions) pages.set(`sessions/${session.id}.md`, sessionPage(data, links, session));
	for (const scope of [null, ...data.projects.map((project) => project.id)]) {
		const page = scopeIndex(data, links, scope);
		if (page !== undefined) pages.set(`${links.dirOf(scope)}/index.md`, page);
	}
	pages.set("index.md", topIndex(data, links, pages.has("global/index.md")));
	return pages;
}

/** Where each page is, and how a page links to another. */
interface WikiLinks {
	/** The folder of a project's pages, or `global`. */
	dirOf(project: string | null): string;
	/** Each subject's page, by subject id, without `.md`. */
	readonly subjectPath: ReadonlyMap<number, string>;
	/** A wikilink to `path` (relative to the wiki folder, without `.md`) reading `text`. */
	link(path: string, text: string): string;
	/** A wikilink to claim `id`'s subject page, reading its statement. */
	claimLink(id: number): string;
	sessionTitle(id: string): string;
	projectName(id: string): string;
}

function wikiLinks(data: WikiData, folder: string): WikiLinks {
	const projectDir = projectFolders(data.projects);
	const dirOf = (project: string | null): string => (project === null ? "global" : projectDir.get(project)!);
	const subjectPath = new Map(
		data.subjects.map((subject) => [subject.id, `${dirOf(subject.project)}/${subject.key}`]),
	);
	const claims = new Map(data.claims.map((claim) => [claim.id, claim]));
	const titles = new Map(data.sessions.map((session) => [session.id, session.title ?? session.id]));
	// Links name the page by its path in the vault, so they resolve whatever else the vault holds.
	const link = (path: string, text: string): string => `[[${folder}/${path}|${text.replace(/[[\]|]/g, " ")}]]`;
	return {
		dirOf,
		subjectPath,
		link,
		claimLink: (id) => {
			const claim = claims.get(id);
			return claim === undefined ? `claim ${id}` : link(subjectPath.get(claim.subject)!, clip(claim.statement, 60));
		},
		sessionTitle: (id) => titles.get(id) ?? id,
		projectName: (id) => data.projects.find((project) => project.id === id)?.name ?? id,
	};
}

// A subject's page: its live claims with their quotes, links and disputes, then the wordings it no longer holds.
function subjectPage(
	data: WikiData,
	links: WikiLinks,
	subject: WikiData["subjects"][number],
	claims: readonly WikiClaim[],
): string {
	const live = claims.filter((claim) => claim.status !== "superseded");
	const project = subject.project === null ? "global" : links.projectName(subject.project);
	const lines = [
		"---",
		"makora: subject",
		`id: ${yaml(subject.key)}`,
		`project: ${yaml(project)}`,
		`title: ${yaml(subject.title)}`,
		`aliases: [${yaml(subject.title)}]`,
		`claims: ${live.length}`,
		`disputed: ${live.filter((claim) => claim.status === "disputed").length}`,
		`proposed: ${live.filter((claim) => claim.status === "proposed").length}`,
		`updated: ${day(Math.max(...claims.map((claim) => claim.updatedAt)))}`,
		"---",
		"",
		`# ${subject.title}`,
		"",
		links.link(`${links.dirOf(subject.project)}/index`, project),
		"",
	];
	for (const claim of live) {
		lines.push(`- **${claim.kind}** · ${claim.status} — ${claim.statement}`);
		for (const each of claim.evidence) {
			const mark = each.polarity === "supports" ? "" : ` (${each.polarity})`;
			lines.push(
				`  - "${oneLine(each.quote)}"${mark} — ${links.link(`sessions/${each.session}`, links.sessionTitle(each.session))}`,
			);
		}
		for (const each of data.links.filter((one) => one.from === claim.id))
			lines.push(`  - ${each.relation}: ${links.claimLink(each.to)}`);
		for (const each of data.links.filter((one) => one.to === claim.id))
			lines.push(`  - ${links.claimLink(each.from)} ${each.relation} this`);
		for (const each of data.conflicts.filter(
			(one) => one.status === "open" && (one.claim === claim.id || one.other === claim.id),
		))
			lines.push(
				`  - disputed with ${links.claimLink(each.claim === claim.id ? each.other : each.claim)}: ${oneLine(each.reason)}`,
			);
	}
	const history = [
		...claims.flatMap((claim) =>
			claim.history.map((each) => ({ ...each, replacedBy: undefined as number | undefined })),
		),
		...claims
			.filter((claim) => claim.status === "superseded")
			.map((claim) => ({
				statement: claim.statement,
				until: claim.updatedAt,
				replacedBy: claim.supersededBy ?? undefined,
			})),
	].sort((a, b) => a.until - b.until || a.statement.localeCompare(b.statement));
	if (history.length > 0) {
		lines.push("", "## History", "");
		for (const each of history) {
			const by = each.replacedBy === undefined ? "" : `, replaced by ${links.claimLink(each.replacedBy)}`;
			lines.push(`- until ${day(each.until)}: ${each.statement}${by}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

// A session's page: when it was, and the claims its turns are evidence for. Never the transcript itself.
function sessionPage(data: WikiData, links: WikiLinks, session: WikiData["sessions"][number]): string {
	const produced = data.claims.filter((claim) => claim.evidence.some((each) => each.session === session.id));
	const project = session.project === null ? "global" : links.projectName(session.project);
	const title = session.title ?? session.id;
	const where = session.project === null ? project : links.link(`${links.dirOf(session.project)}/index`, project);
	return [
		"---",
		"makora: session",
		`id: ${yaml(session.id)}`,
		`project: ${yaml(project)}`,
		`title: ${yaml(title)}`,
		`date: ${day(session.createdAt)}`,
		`claims: ${produced.length}`,
		"---",
		"",
		`# ${title}`,
		"",
		`${day(session.createdAt)} · ${where}`,
		"",
		...(produced.length === 0
			? ["No claims came from this session."]
			: produced.map((claim) => `- ${links.claimLink(claim.id)}`)),
		"",
	].join("\n");
}

// A project's index, or the global one: its subjects with live claims. The global index exists only when one does.
function scopeIndex(data: WikiData, links: WikiLinks, scope: string | null): string | undefined {
	const subjects = data.subjects.filter(
		(subject) =>
			subject.project === scope &&
			data.claims.some((claim) => claim.subject === subject.id && claim.status !== "superseded"),
	);
	if (subjects.length === 0 && scope === null) return undefined;
	const lines = [
		`# ${scope === null ? "Global" : links.projectName(scope)}`,
		"",
		links.link("index", "All memory"),
		"",
	];
	if (scope !== null) lines.push(`Repository: \`${scope}\``, "");
	lines.push(
		...(subjects.length === 0
			? ["Nothing remembered yet."]
			: subjects.map((subject) => `- ${links.link(links.subjectPath.get(subject.id)!, subject.title)}`)),
		"",
	);
	return lines.join("\n");
}

// The wiki's front page: every project, and the claims a person should look at.
function topIndex(data: WikiData, links: WikiLinks, global: boolean): string {
	const lines = ["# Memory", ""];
	if (data.projects.length === 0) lines.push("No memories yet. Run /dream in a project to make some.", "");
	for (const project of data.projects) lines.push(`- ${links.link(`${links.dirOf(project.id)}/index`, project.name)}`);
	if (global) lines.push(`- ${links.link("global/index", "Global")}`);
	const needsLook = data.claims.filter((claim) => claim.status === "disputed" || claim.status === "proposed");
	if (needsLook.length > 0) {
		lines.push("", "## Needs a look", "");
		for (const claim of needsLook) lines.push(`- ${links.claimLink(claim.id)} (${claim.status})`);
	}
	lines.push("");
	return lines.join("\n");
}

/** What writing a wiki changed. */
export interface WikiWrite {
	readonly written: number;
	readonly deleted: number;
	readonly unchanged: number;
}

/**
 * Write `pages` under `root`, the wiki folder of the vault: only pages whose content changed since the last write,
 * and delete the pages that are gone. Obsidian re-indexes only what changed, and open tabs stay.
 */
export function writeWiki(store: MemoryStore, root: string, pages: ReadonlyMap<string, string>): WikiWrite {
	const { db } = store;
	const before = new Map(
		(
			db.prepare("SELECT path, hash FROM wiki_pages WHERE root = ?").all(root) as { path: string; hash: string }[]
		).map((row) => [row.path, row.hash]),
	);
	let written = 0;
	let unchanged = 0;
	const record = db.prepare(
		"INSERT INTO wiki_pages (root, path, hash) VALUES (?, ?, ?) ON CONFLICT (root, path) DO UPDATE SET hash = excluded.hash",
	);
	for (const [path, content] of pages) {
		const hash = createHash("sha256").update(content).digest("hex");
		const file = join(root, path);
		if (before.get(path) === hash && readIfExists(file) === content) {
			unchanged++;
			continue;
		}
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
		record.run(root, path, hash);
		written++;
	}
	let deleted = 0;
	const forget = db.prepare("DELETE FROM wiki_pages WHERE root = ? AND path = ?");
	for (const path of before.keys()) {
		if (pages.has(path)) continue;
		rmSync(join(root, path), { force: true });
		forget.run(root, path);
		deleted++;
	}
	return { written, deleted, unchanged };
}

function readIfExists(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

// Two repositories with one name get the first by id the plain name and the others a suffix from their id, so a
// folder keeps its name as long as the projects do.
function projectFolders(projects: WikiData["projects"]): Map<string, string> {
	const folders = new Map<string, string>();
	const taken = new Set(["global", "sessions", "bases"]);
	for (const project of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
		const base = slug(project.name);
		const name = taken.has(base)
			? `${base}-${createHash("sha256").update(project.id).digest("hex").slice(0, 6)}`
			: base;
		taken.add(name);
		folders.set(project.id, name);
	}
	return folders;
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

// Frontmatter strings are quoted, so a title holding `: ` or `#` stays one YAML string.
function yaml(text: string): string {
	return JSON.stringify(text);
}

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, length: number): string {
	const line = oneLine(text);
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
}

const SUBJECTS_BASE = (folder: string): string => `filters:
  and:
    - file.inFolder(${JSON.stringify(folder)})
    - makora == "subject"
properties:
  file.name:
    displayName: Page
  note.title:
    displayName: Subject
views:
  - type: table
    name: By project
    groupBy:
      property: project
      direction: ASC
    order:
      - title
      - claims
      - disputed
      - updated
  - type: table
    name: Needs a look
    filters:
      or:
        - disputed > 0
        - proposed > 0
    order:
      - title
      - project
      - disputed
      - proposed
  - type: table
    name: Recently changed
    order:
      - title
      - project
      - updated
    sort:
      - property: updated
        direction: DESC
`;

const SESSIONS_BASE = (folder: string): string => `filters:
  and:
    - file.inFolder(${JSON.stringify(folder)})
    - makora == "session"
views:
  - type: table
    name: By date
    groupBy:
      property: project
      direction: ASC
    order:
      - title
      - date
      - claims
    sort:
      - property: date
        direction: DESC
`;
