// Embeddings from a local Ollama server: memory's vectors for episodes, claims and search queries.
import type { MemoryStore } from "./store.ts";
import { ensureVectorTables } from "./store.ts";

/** Where embeddings come from. */
export interface EmbedConfig {
	/** Ollama's base URL, such as `http://127.0.0.1:11434`. */
	readonly url: string;
	/** The embedding model's Ollama name, such as `embeddinggemma`. */
	readonly model: string;
}

/** The default: Ollama on this machine with Google's EmbeddingGemma. */
export const DEFAULT_EMBED: EmbedConfig = { url: "http://127.0.0.1:11434", model: "embeddinggemma" };

/** What an embedding call came to: one vector per text, or why there are none. */
export type Embedded =
	| { readonly kind: "vectors"; readonly vectors: readonly Float32Array[] }
	| { readonly kind: "unavailable"; readonly reason: string };

// EmbeddingGemma reads 2,048 tokens; longer text is cut by Ollama (`truncate`), and this keeps requests small.
const MAX_CHARS = 6_000;
const BATCH = 32;
const TIMEOUT_MS = 60_000;

/**
 * Embed `texts` with `config`'s model, in batches, and make the store's vector tables match it. Unavailable when
 * Ollama is not running, lacks the model, or answers with something other than vectors; callers then skip vectors.
 */
export async function embed(texts: readonly string[], config: EmbedConfig, store: MemoryStore): Promise<Embedded> {
	const vectors: Float32Array[] = [];
	for (let start = 0; start < texts.length; start += BATCH) {
		const batch = texts.slice(start, start + BATCH).map((text) => text.slice(0, MAX_CHARS) || " ");
		const answer = await request(config, batch);
		if (answer.kind === "unavailable") return answer;
		vectors.push(...answer.vectors);
	}
	if (vectors.length > 0) ensureVectorTables(store, config.model, vectors[0]!.length);
	return { kind: "vectors", vectors };
}

/** `vector` as the bytes vec0 stores. */
export function vectorBytes(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

// Ollama's reply is wire input: checked for the one shape used, a list of number lists, one per input.
async function request(config: EmbedConfig, input: readonly string[]): Promise<Embedded> {
	let response: Response;
	try {
		response = await fetch(new URL("/api/embed", config.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: config.model, input, truncate: true }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		return { kind: "unavailable", reason: `Ollama is not reachable at ${config.url} (${describe(error)})` };
	}
	const body = (await response.json().catch(() => undefined)) as { embeddings?: unknown; error?: unknown } | undefined;
	if (!response.ok) {
		const why = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
		return { kind: "unavailable", reason: `Ollama could not embed with ${config.model}: ${why}` };
	}
	const embeddings = body?.embeddings;
	if (
		!Array.isArray(embeddings) ||
		embeddings.length !== input.length ||
		!embeddings.every((each) => Array.isArray(each) && each.length > 0 && each.every((n) => typeof n === "number"))
	) {
		return { kind: "unavailable", reason: `Ollama answered ${config.model} with no usable embeddings` };
	}
	return { kind: "vectors", vectors: (embeddings as number[][]).map((each) => Float32Array.from(each)) };
}

function describe(error: unknown): string {
	return error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
}
