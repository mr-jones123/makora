// The `memory` tool behind `await memory.search(...)` and `await memory.get(id)` in a cell: what earlier sessions of
// this project concluded, from memory.sqlite, with each read logged so a dream can tell what memory is used for.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, int, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import type { EmbedConfig } from "./embed.ts";
import { projectOf } from "./project.ts";
import { search } from "./search.ts";
import { memoryPath, openMemory, selectClaims } from "./store.ts";

/** Where the tool finds memory and embeddings. */
export interface MemoryToolOptions {
	readonly home: string;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
	/** Read at each call, so a settings change applies without a restart. */
	readonly embed: () => EmbedConfig;
}

const MemoryParameters = union([
	obj({
		action: lit("search"),
		query: str({ minLength: 1 }),
		limit: opt(int({ minimum: 1, maximum: 50 })),
		episodes: opt(bool()),
	}),
	obj({ action: lit("get"), id: int() }),
]);

// An episode is a raw turn; search shows its opening, and `get` is for claims.
const EPISODE_CHARS = 600;

/** The `memory` tool for one session, callable from cells only. */
export function createMemoryTool(options: MemoryToolOptions): ToolRegistration<typeof MemoryParameters> {
	return defineTool({
		name: "memory",
		description:
			"Search what earlier sessions of this project concluded, or read one claim with its history and evidence.",
		parameters: MemoryParameters,
		// Programs read the hits or the claim as data; their shape is this module's own.
		structuredOutputSchema: unknown(),
		callers: ["tools"],
		async execute(args, api, context) {
			const cwd = (await api.agent(context)).cwd ?? options.defaultCwd;
			const store = openMemory(memoryPath(options.home));
			try {
				if (args.action === "get") return result(claimDetail(store, args.id));
				const project = await projectOf(cwd);
				const found = await search(store, args.query, {
					project: project.id,
					limit: args.limit ?? 8,
					episodes: args.episodes ?? false,
					embed: options.embed(),
				});
				const now = api.now();
				const logRead = store.db.prepare("INSERT INTO reads (claim, at) VALUES (?, ?)");
				const hits = found.hits.map((hit) => {
					if (hit.kind === "episode")
						return {
							kind: "episode",
							id: hit.id,
							session: hit.session,
							role: hit.role,
							text: hit.text.slice(0, EPISODE_CHARS),
						};
					logRead.run(hit.claim.id, now);
					const { claim } = hit;
					return {
						kind: "claim",
						id: claim.id,
						subject: claim.subjectTitle,
						type: claim.kind,
						status: claim.status,
						statement: claim.statement,
					};
				});
				return result(found.note === undefined ? { hits } : { hits, note: found.note });
			} finally {
				store.close();
			}
		},
	});
}

// node:sqlite types a row's values as including bigint and bytes, which JSON has not; the columns read here are text
// and numbers, and the round trip makes the value plain JSON for the result.
function result(value: object) {
	const data = JSON.parse(JSON.stringify(value));
	return { output: [{ type: "text" as const, text: JSON.stringify(data) }], structuredOutput: data };
}

// One claim as `memory.get` returns it: what it says now, every earlier wording, its quotes, and its disputes.
function claimDetail(store: ReturnType<typeof openMemory>, id: number) {
	const [claim] = selectClaims(store.db, "c.id = ?", id);
	if (claim === undefined) throw new Error(`no claim ${id} in memory`);
	const versions = store.db
		.prepare(
			"SELECT statement, status, recorded_at AS recordedAt, retracted_at AS retractedAt FROM claim_versions WHERE claim = ? ORDER BY id",
		)
		.all(id);
	const evidence = store.db
		.prepare(
			`SELECT ev.quote, ev.polarity, e.session FROM evidence ev JOIN claim_versions v ON v.id = ev.version
			JOIN episodes e ON e.id = ev.episode WHERE v.claim = ? ORDER BY ev.id`,
		)
		.all(id);
	const conflicts = store.db
		.prepare("SELECT claim, other, reason, status FROM conflicts WHERE claim = ? OR other = ? ORDER BY id")
		.all(id, id);
	return {
		id: claim.id,
		subject: claim.subjectTitle,
		type: claim.kind,
		status: claim.status,
		statement: claim.statement,
		supersededBy: claim.supersededBy,
		versions: versions.map((row) => ({ ...row })),
		evidence: evidence.map((row) => ({ ...row })),
		conflicts: conflicts.map((row) => ({ ...row })),
	};
}
