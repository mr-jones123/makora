// What a cell reads from its conversation's committed history: the restore point, the latest input, recent entries.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Cursor, EntryRecord, ToolExecutionApi } from "@earendil-works/pi-durable";
import { messageText } from "../transcript-rows.ts";
import { type CellSnapshot, type PythonDetails, pythonDetails } from "./details.ts";

/** Where a new kernel restores from. */
export type RestorePoint =
	/** No python cell ran in this conversation yet. */
	| { readonly kind: "first" }
	/** Cells ran, but none committed a snapshot (snapshots were off). */
	| { readonly kind: "lost" }
	| { readonly kind: "snapshot"; readonly details: PythonDetails & { readonly snapshot: CellSnapshot } };

/** The newest committed `python` result with a snapshot on this conversation's branch. */
export async function findRestorePoint(api: ToolExecutionApi, context: Context): Promise<RestorePoint> {
	let ranBefore = false;
	for await (const entry of newestFirst(api, context)) {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult" || message.toolName !== "python") continue;
		ranBefore = true;
		const details = pythonDetails(message.details);
		if (details?.snapshot !== undefined)
			return { kind: "snapshot", details: { ...details, snapshot: details.snapshot } };
	}
	return ranBefore ? { kind: "lost" } : { kind: "first" };
}

/** The text of the conversation's latest user input, or "" when there is none. */
export async function latestInput(api: ToolExecutionApi, context: Context): Promise<string> {
	for await (const entry of newestFirst(api, context)) {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message !== undefined) return messageText(message);
	}
	return "";
}

/** The newest `limit` transcript messages, oldest first, as plain JSON for a cell. */
export async function recentEntries(api: ToolExecutionApi, limit: number, context: Context): Promise<JsonValue[]> {
	const entries: JsonValue[] = [];
	for await (const entry of newestFirst(api, context)) {
		if (entries.length >= limit) break;
		const message = entry.model?.[0];
		if (message === undefined || message.role === "system") continue;
		const base = { id: entry.id, kind: entry.kind, role: message.role, text: messageText(message) };
		if (message.role === "toolResult")
			entries.push({ ...base, toolName: message.toolName, isError: message.isError });
		else if (message.role === "assistant") {
			const calls = message.content.flatMap((block) =>
				block.type === "toolCall" ? [{ name: block.name, arguments: block.arguments as JsonValue }] : [],
			);
			entries.push({ ...base, toolCalls: calls });
		} else entries.push(base);
	}
	return entries.reverse();
}

const PAGE = 100;

// Reads through a commit of the call's task: it writes nothing, so it is never stored.
async function* newestFirst(api: ToolExecutionApi, context: Context): AsyncGenerator<EntryRecord> {
	for (let cursor: Cursor | undefined; ; ) {
		const page = await api.commit(
			(tx) => tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, PAGE, cursor),
			context,
		);
		yield* page.items;
		if (page.next === undefined) return;
		cursor = page.next;
	}
}
