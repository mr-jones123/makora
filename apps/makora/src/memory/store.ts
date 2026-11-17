// memory.sqlite: what makora remembers across sessions. Episodes are the raw turns copied out of sessions; claims are
// what dreams concluded from them, with every version, its evidence, and the conflicts between them. Search reads it
// through FTS5 and, when sqlite-vec loads, vector tables; the wiki is rendered from it and never read back.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadVec } from "./vec.ts";

/** An open memory database. */
export interface MemoryStore {
	readonly db: DatabaseSync;
	/** Whether sqlite-vec loaded, so the vector tables exist and vector search runs. */
	readonly vec: boolean;
	close(): void;
}

/** What a claim says it is. */
export type ClaimKind = "fact" | "decision" | "preference";

/** Where a claim is in its life. */
export type ClaimStatus = "proposed" | "confirmed" | "disputed" | "superseded";

/** How a quote bears on a claim. */
export type Polarity = "supports" | "contradicts" | "mentions";

/** The columns of `claims`, joined with its subject. */
export interface ClaimRow {
	readonly id: number;
	/** `null` for a claim about the user that holds in every project. */
	readonly project: string | null;
	readonly subject: number;
	readonly subjectKey: string;
	readonly subjectTitle: string;
	readonly kind: ClaimKind;
	readonly statement: string;
	readonly status: ClaimStatus;
	readonly supersededBy: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly checkedAt: number | null;
}

/** `<home>/memory/memory.sqlite`. */
export function memoryPath(home: string): string {
	return join(home, "memory", "memory.sqlite");
}

/** Open the memory at `file`, creating it and its tables as needed. Vector tables wait for the first embedding. */
export function openMemory(file: string): MemoryStore {
	if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
	const db = new DatabaseSync(file, { timeout: 5_000, allowExtension: true });
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL");
	db.exec(SCHEMA);
	return { db, vec: loadVec(db), close: () => db.close() };
}

/** The model and size of the stored vectors, as `<model>:<dimensions>`, or undefined before the first embedding. */
export function vectorModel(store: MemoryStore): string | undefined {
	const row = store.db.prepare("SELECT value FROM meta WHERE key = 'vectors'").get() as { value: string } | undefined;
	return row?.value;
}

/**
 * Make the vector tables hold `model`'s `dimensions`-sized vectors. Another model empties them: vec0 columns cannot
 * change size, and vectors from two models cannot be compared even at one size. The caller embeds again what it needs.
 */
export function ensureVectorTables(store: MemoryStore, model: string, dimensions: number): void {
	const wanted = `${model}:${dimensions}`;
	if (!store.vec || vectorModel(store) === wanted) return;
	const { db } = store;
	db.exec(`DROP TABLE IF EXISTS episodes_vec; DROP TABLE IF EXISTS claims_vec;
		CREATE VIRTUAL TABLE episodes_vec USING vec0(episode INTEGER PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine);
		CREATE VIRTUAL TABLE claims_vec USING vec0(claim INTEGER PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('vectors', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	).run(wanted);
}

/** The claims matching `where` (an SQL condition over `c` and `s`), joined with their subjects. */
export function selectClaims(db: DatabaseSync, where: string, ...params: (string | number | null)[]): ClaimRow[] {
	const rows = db
		.prepare(
			`SELECT c.id, c.project, c.subject, s.key AS subjectKey, s.title AS subjectTitle, c.kind, c.statement, c.status,
				c.superseded_by AS supersededBy, c.created_at AS createdAt, c.updated_at AS updatedAt, c.checked_at AS checkedAt
			FROM claims c JOIN subjects s ON s.id = c.subject WHERE ${where} ORDER BY s.key, c.id`,
		)
		.all(...params);
	// The columns are this module's own schema.
	return rows as unknown as ClaimRow[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- A project is a repository, by its git remote, else its first commit, so every clone and worktree shares one memory.
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	project TEXT REFERENCES projects (id),
	title TEXT,
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	-- The session's updated_at when a completed dream last read it, and the last episode it read: a later update makes
	-- the session due again, and the next dream reads only the episodes after that one.
	dreamed_through INTEGER,
	dreamed_episode INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS episodes (
	id INTEGER PRIMARY KEY,
	session TEXT NOT NULL REFERENCES sessions (id),
	conversation TEXT NOT NULL,
	entry TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
	text TEXT NOT NULL,
	hash TEXT NOT NULL,
	UNIQUE (conversation, entry)
);
CREATE INDEX IF NOT EXISTS episodes_session ON episodes (session, id);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5 (text, content = 'episodes', content_rowid = 'id');
CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
	INSERT INTO episodes_fts (rowid, text) VALUES (new.id, new.text);
END;

-- A subject is what a wiki page is about. Its key never changes, so a page keeps its file name across retitles.
CREATE TABLE IF NOT EXISTS subjects (
	id INTEGER PRIMARY KEY,
	project TEXT REFERENCES projects (id),
	key TEXT NOT NULL,
	title TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_key ON subjects (coalesce(project, ''), key);

CREATE TABLE IF NOT EXISTS claims (
	id INTEGER PRIMARY KEY,
	project TEXT REFERENCES projects (id),
	subject INTEGER NOT NULL REFERENCES subjects (id),
	kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'preference')),
	statement TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'disputed', 'superseded')),
	superseded_by INTEGER REFERENCES claims (id),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	checked_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5 (statement, content = 'claims', content_rowid = 'id');
CREATE TRIGGER IF NOT EXISTS claims_fts_insert AFTER INSERT ON claims BEGIN
	INSERT INTO claims_fts (rowid, statement) VALUES (new.id, new.statement);
END;
CREATE TRIGGER IF NOT EXISTS claims_fts_update AFTER UPDATE OF statement ON claims BEGIN
	INSERT INTO claims_fts (claims_fts, rowid, statement) VALUES ('delete', old.id, old.statement);
	INSERT INTO claims_fts (rowid, statement) VALUES (new.id, new.statement);
END;

-- Every version a claim had: valid_* is when it held in the world, recorded_at and retracted_at when memory took it
-- in and let it go. The dream and prompt version that wrote it find a bad prompt's output later.
CREATE TABLE IF NOT EXISTS claim_versions (
	id INTEGER PRIMARY KEY,
	claim INTEGER NOT NULL REFERENCES claims (id),
	statement TEXT NOT NULL,
	status TEXT NOT NULL,
	valid_from INTEGER,
	valid_to INTEGER,
	recorded_at INTEGER NOT NULL,
	retracted_at INTEGER,
	dream INTEGER REFERENCES dreams (id),
	prompt_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
	id INTEGER PRIMARY KEY,
	version INTEGER NOT NULL REFERENCES claim_versions (id),
	episode INTEGER NOT NULL REFERENCES episodes (id),
	quote TEXT NOT NULL,
	polarity TEXT NOT NULL CHECK (polarity IN ('supports', 'contradicts', 'mentions'))
);

CREATE TABLE IF NOT EXISTS conflicts (
	id INTEGER PRIMARY KEY,
	claim INTEGER NOT NULL REFERENCES claims (id),
	other INTEGER NOT NULL REFERENCES claims (id),
	reason TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS links (
	from_claim INTEGER NOT NULL REFERENCES claims (id),
	to_claim INTEGER NOT NULL REFERENCES claims (id),
	relation TEXT NOT NULL,
	PRIMARY KEY (from_claim, to_claim, relation)
);

-- One dream: the lifecycle of Anthropic's Dreams API (pending, running, then completed, failed or canceled). Its
-- changes wait in staged until it completes, and are applied then in one transaction.
CREATE TABLE IF NOT EXISTS dreams (
	id INTEGER PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
	project TEXT NOT NULL,
	cwd TEXT NOT NULL,
	sessions TEXT NOT NULL DEFAULT '[]',
	budget_usd REAL NOT NULL,
	cost_usd REAL NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	staged TEXT,
	report TEXT,
	error TEXT,
	pid INTEGER,
	cancel_requested INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	ended_at INTEGER
);

-- Which claims sessions read, to find what nothing uses.
CREATE TABLE IF NOT EXISTS reads (
	claim INTEGER NOT NULL REFERENCES claims (id),
	at INTEGER NOT NULL
);

-- Each wiki page as last written, so a render writes only what changed and deletes what is gone.
CREATE TABLE IF NOT EXISTS wiki_pages (
	root TEXT NOT NULL,
	path TEXT NOT NULL,
	hash TEXT NOT NULL,
	PRIMARY KEY (root, path)
);
`;
