// Copying a session's turns into memory as episodes: a consistent snapshot of its session.sqlite, read with Durable,
// one episode per message, so evidence still resolves after the session is deleted.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationRecord, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type SessionMeta, sessionDatabase } from "../sessions.ts";
import { messageText } from "../transcript-rows.ts";
import type { Project } from "./project.ts";
import type { MemoryStore } from "./store.ts";

/** One message of a session, as an episode holds it. */
export interface EpisodeDraft {
	readonly conversation: string;
	readonly entry: string;
	readonly role: "user" | "assistant" | "tool";
	readonly text: string;
}

/**
 * Copy the turns of session `meta` that memory does not have yet, and record the session under `project`. Returns
 * the new episodes' ids. Reads a snapshot, so a session open in another makora is read as it stood.
 */
export async function ingestSession(
	store: MemoryStore,
	sessionsDir: string,
	meta: SessionMeta,
	project: Project,
): Promise<number[]> {
	const drafts = await readSession(sessionDatabase(sessionsDir, meta.id));
	const { db } = store;
	db.prepare("INSERT INTO projects (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name").run(
		project.id,
		project.name,
	);
	db.prepare(
		`INSERT INTO sessions (id, project, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET project = excluded.project, title = excluded.title, updated_at = excluded.updated_at`,
	).run(meta.id, project.id, meta.title ?? null, meta.cwd, meta.createdAt, meta.updatedAt);
	const insert = db.prepare(
		"INSERT INTO episodes (session, conversation, entry, role, text, hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
	);
	const added: number[] = [];
	db.exec("BEGIN");
	try {
		for (const draft of drafts) {
			const hash = createHash("sha256").update(draft.text).digest("hex");
			const row = insert.get(meta.id, draft.conversation, draft.entry, draft.role, draft.text, hash) as
				| { id: number }
				| undefined;
			if (row !== undefined) added.push(row.id);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return added;
}

/** The episodes of the session database at `file`, every conversation, oldest message first. */
export async function readSession(file: string): Promise<EpisodeDraft[]> {
	// Durable's storage migrates on open, which a read-only open refuses, and the session may be open in another
	// makora: VACUUM INTO copies a consistent snapshot from a live WAL database, and the copy is opened instead.
	const dir = mkdtempSync(join(tmpdir(), "makora-memory-"));
	const copy = join(dir, "session.sqlite");
	try {
		const source = new DatabaseSync(file, { readOnly: true });
		try {
			source.prepare("VACUUM INTO ?").run(copy);
		} finally {
			source.close();
		}
		const storage = await openNodeSqliteStorage(copy);
		try {
			const drafts: EpisodeDraft[] = [];
			for (const conversation of await all((cursor) =>
				storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT),
			)) {
				drafts.push(
					...(await conversationEpisodes(conversation, (cursor) =>
						storage.scanEntries(
							{ conversationId: conversation.id, order: "ascending" },
							500,
							cursor,
							BACKGROUND_CONTEXT,
						),
					)),
				);
			}
			return drafts;
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type PageOf<T> = { readonly items: readonly T[]; readonly next?: Cursor };

async function all<T>(page: (cursor: Cursor | undefined) => Promise<PageOf<T>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const next = await page(cursor);
		items.push(...next.items);
		cursor = next.next;
	} while (cursor !== undefined);
	return items;
}

async function conversationEpisodes(
	conversation: ConversationRecord,
	page: (cursor: Cursor | undefined) => Promise<PageOf<EntryRecord>>,
): Promise<EpisodeDraft[]> {
	const entries = await all(page);
	return entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) => {
			const episode = episodeOf(message);
			return episode === undefined
				? []
				: [{ conversation: String(conversation.id), entry: String(entry.id), ...episode }];
		}),
	);
}

// A tool result past this is cut in the middle: its head says what ran, its tail how it ended, and the dream reads
// many sessions at once.
const TOOL_HEAD = 3_000;
const TOOL_TAIL = 1_000;

/** The episode a message makes: what the user said, the assistant's text and calls, or a tool's result. */
export function episodeOf(message: Message): Pick<EpisodeDraft, "role" | "text"> | undefined {
	switch (message.role) {
		case "user": {
			const text = messageText(message).trim();
			return text === "" ? undefined : { role: "user", text };
		}
		case "assistant": {
			const parts = message.content.flatMap((part) => {
				if (part.type === "text") return part.text.trim() === "" ? [] : [part.text.trim()];
				if (part.type === "toolCall") return [`→ ${part.name}\n${callText(part.arguments)}`];
				return [];
			});
			return parts.length === 0 ? undefined : { role: "assistant", text: parts.join("\n\n") };
		}
		case "toolResult": {
			const text = messageText(message).trim();
			if (text === "") return undefined;
			const cut =
				text.length <= TOOL_HEAD + TOOL_TAIL
					? text
					: `${text.slice(0, TOOL_HEAD)}\n[${text.length - TOOL_HEAD - TOOL_TAIL} characters left out]\n${text.slice(-TOOL_TAIL)}`;
			return { role: "tool", text: `← ${message.toolName}${message.isError ? " (error)" : ""}\n${cut}` };
		}
		default:
			return undefined;
	}
}

// A python call's code is its argument; other tools show their arguments as JSON.
function callText(args: Readonly<Record<string, unknown>>): string {
	const code = args.code;
	return typeof code === "string" ? code : JSON.stringify(args);
}
