// Memory search: FTS5 words and sqlite-vec meaning over claims and episodes, fused by rank, and embedding what has no
// vector yet.
import { type EmbedConfig, embed, vectorBytes } from "./embed.ts";
import { type ClaimRow, type MemoryStore, selectClaims, vectorModel } from "./store.ts";

/** One search result. */
export type SearchHit =
	| { readonly kind: "claim"; readonly score: number; readonly claim: ClaimRow }
	| {
			readonly kind: "episode";
			readonly score: number;
			readonly id: number;
			readonly session: string;
			readonly role: string;
			readonly text: string;
	  };

/** What to search and how. */
export interface SearchOptions {
	/** The project whose claims and episodes count, besides global claims. */
	readonly project: string | undefined;
	readonly limit: number;
	/** Episodes are raw turns: searched only when asked, since claims answer most questions. */
	readonly episodes: boolean;
	/** Embeds the query for the vector channel; without it, or when Ollama is down, words alone rank. */
	readonly embed?: EmbedConfig;
}

/** The results for `query`, best first, and why vectors did not take part when they did not. */
export async function search(
	store: MemoryStore,
	query: string,
	options: SearchOptions,
): Promise<{ readonly hits: SearchHit[]; readonly note?: string }> {
	const pool = options.limit * 4;
	const vector = await queryVector(store, query, options.embed);
	const claimRanks = fuse(
		claimWords(store, query, pool),
		vector.kind === "vector" ? nearest(store, "claims_vec", "claim", vector.bytes, pool) : [],
	);
	const claims = rankedClaims(store, claimRanks, options.project);
	const episodes = options.episodes
		? rankedEpisodes(
				store,
				fuse(
					episodeWords(store, query, pool),
					vector.kind === "vector" ? nearest(store, "episodes_vec", "episode", vector.bytes, pool) : [],
				),
				options.project,
			)
		: [];
	const hits = [...claims, ...episodes].sort((a, b) => b.score - a.score).slice(0, options.limit);
	return vector.kind === "none" ? { hits, note: vector.reason } : { hits };
}

/**
 * Embed the episodes and claims that have no vector for the current model, at most `limit` of each. Returns how
 * many it embedded, or why none.
 */
export async function embedPending(
	store: MemoryStore,
	config: EmbedConfig,
	limit: number,
): Promise<{ readonly embedded: number; readonly note?: string }> {
	if (!store.vec) return { embedded: 0, note: "sqlite-vec is not available on this platform" };
	let embedded = 0;
	for (const [table, column, source, text] of [
		["episodes_vec", "episode", "episodes", "text"],
		["claims_vec", "claim", "claims", "statement"],
	] as const) {
		const current = vectorModel(store)?.startsWith(`${config.model}:`) === true;
		const missing = store.db
			.prepare(
				current
					? `SELECT id, ${text} AS text FROM ${source} WHERE id NOT IN (SELECT ${column} FROM ${table}) ORDER BY id LIMIT ?`
					: `SELECT id, ${text} AS text FROM ${source} ORDER BY id LIMIT ?`,
			)
			.all(limit) as { id: number; text: string }[];
		if (missing.length === 0) continue;
		const result = await embed(
			missing.map((row) => row.text),
			config,
			store,
		);
		if (result.kind === "unavailable") return { embedded, note: result.reason };
		const insert = store.db.prepare(`INSERT OR REPLACE INTO ${table} (${column}, embedding) VALUES (?, ?)`);
		missing.forEach((row, index) => {
			// vec0 refuses a primary key bound as a float, which is how node:sqlite binds a JS number.
			insert.run(BigInt(row.id), vectorBytes(result.vectors[index]!));
		});
		embedded += missing.length;
	}
	return { embedded };
}

type QueryVector =
	| { readonly kind: "vector"; readonly bytes: Uint8Array }
	| { readonly kind: "none"; readonly reason: string };

async function queryVector(store: MemoryStore, query: string, config: EmbedConfig | undefined): Promise<QueryVector> {
	if (config === undefined) return { kind: "none", reason: "vector search is off" };
	if (!store.vec) return { kind: "none", reason: "sqlite-vec is not available on this platform; words alone ranked" };
	const stored = vectorModel(store);
	if (stored === undefined) return { kind: "none", reason: "nothing is embedded yet; words alone ranked" };
	if (!stored.startsWith(`${config.model}:`))
		return { kind: "none", reason: `vectors are from ${stored}, not ${config.model}; words alone ranked` };
	const result = await embed([query], config, store);
	if (result.kind === "unavailable") return { kind: "none", reason: `${result.reason}; words alone ranked` };
	return { kind: "vector", bytes: vectorBytes(result.vectors[0]!) };
}

// FTS5 reads its own query language; the user's words become quoted terms joined by OR, so `don't` or `a:b` search
// as words instead of failing as syntax.
function ftsQuery(query: string): string | undefined {
	const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms.length === 0 ? undefined : terms.map((term) => `"${term}"`).join(" OR ");
}

function claimWords(store: MemoryStore, query: string, limit: number): number[] {
	const match = ftsQuery(query);
	if (match === undefined) return [];
	const rows = store.db
		.prepare("SELECT rowid AS id FROM claims_fts WHERE claims_fts MATCH ? ORDER BY bm25(claims_fts) LIMIT ?")
		.all(match, limit) as { id: number }[];
	return rows.map((row) => row.id);
}

function episodeWords(store: MemoryStore, query: string, limit: number): number[] {
	const match = ftsQuery(query);
	if (match === undefined) return [];
	const rows = store.db
		.prepare("SELECT rowid AS id FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts) LIMIT ?")
		.all(match, limit) as { id: number }[];
	return rows.map((row) => row.id);
}

function nearest(store: MemoryStore, table: string, column: string, bytes: Uint8Array, limit: number): number[] {
	const rows = store.db
		.prepare(`SELECT ${column} AS id FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
		.all(bytes, limit) as { id: number }[];
	return rows.map((row) => Number(row.id));
}

// Reciprocal rank fusion: each list gives 1 / (60 + rank), so a result high in either list ranks well and one high in
// both ranks best, without comparing BM25 scores to cosine distances.
const RRF_K = 60;

function fuse(...lists: readonly (readonly number[])[]): Map<number, number> {
	const scores = new Map<number, number>();
	for (const list of lists) {
		for (const [rank, id] of list.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
	}
	return scores;
}

function rankedClaims(store: MemoryStore, scores: Map<number, number>, project: string | undefined): SearchHit[] {
	if (scores.size === 0) return [];
	const ids = [...scores.keys()];
	const claims = selectClaims(
		store.db,
		`c.id IN (${ids.map(() => "?").join(",")}) AND c.status != 'superseded' AND (c.project IS NULL OR c.project = ?)`,
		...ids,
		project ?? null,
	);
	return claims.map((claim) => ({ kind: "claim", score: scores.get(claim.id)!, claim }));
}

function rankedEpisodes(store: MemoryStore, scores: Map<number, number>, project: string | undefined): SearchHit[] {
	if (scores.size === 0) return [];
	const ids = [...scores.keys()];
	const rows = store.db
		.prepare(
			`SELECT e.id, e.session, e.role, e.text FROM episodes e JOIN sessions s ON s.id = e.session
			WHERE e.id IN (${ids.map(() => "?").join(",")}) AND (? IS NULL OR s.project = ?)`,
		)
		.all(...ids, project ?? null, project ?? null) as { id: number; session: string; role: string; text: string }[];
	return rows.map((row) => ({ kind: "episode", score: scores.get(row.id)!, ...row }));
}
