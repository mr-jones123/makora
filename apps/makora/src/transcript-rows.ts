// Transcript rows: a conversation's committed entries and live state turned into the rows a transcript shows.
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, ToolSlot } from "@earendil-works/pi-durable";
import type { ToolCell, ToolCellStatus } from "./tool-cell.ts";

/** One row of a transcript, in display order. */
export type TranscriptRow =
	| { readonly kind: "user"; readonly key: string; readonly text: string }
	| { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly streaming: boolean }
	| { readonly kind: "thinking"; readonly key: string; readonly text: string }
	| { readonly kind: "tool"; readonly key: string; readonly cell: ToolCell }
	/** Run failures, retries, compaction and restore notices. */
	| { readonly kind: "notice"; readonly key: string; readonly message: string };

/**
 * The rows of `entries` (in ID order) followed by the rows of the live generation and run state. `after` adds a
 * caller's own rows behind an entry's rows.
 */
export function transcriptRows<Extra = never>(
	entries: readonly EntryRecord[],
	live: LiveState | undefined,
	after?: (entry: EntryRecord) => readonly Extra[],
): (TranscriptRow | Extra)[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, message);
	}
	const slots = new Map<string, ToolSlot>((live?.tools ?? []).map((slot) => [slot.callId, slot]));
	const rows: (TranscriptRow | Extra)[] = [];
	for (const entry of entries) {
		rows.push(...entryRows(entry, results, slots));
		if (after !== undefined) rows.push(...after(entry));
	}
	rows.push(...liveRows(live, slots));
	return rows;
}

/** The text blocks of a message joined, or its string content. */
export function messageText(message: Message): string {
	if (message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** When an assistant message's response ended, which is when its tool calls start. */
export function responseEnd(message: AssistantMessage): number {
	return message.timestamp + (message.durationMs ?? 0);
}

/** A tool call's cell from its call, its result if committed, and its live slot if any. */
export function toolCellOf(
	call: { readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
	startedAt: number,
	result: ToolResultMessage | undefined,
	slot: ToolSlot | undefined,
): ToolCell {
	const base = { callId: call.id, name: call.name, args: call.arguments };
	if (result !== undefined) {
		const status: ToolCellStatus = {
			kind: "done",
			isError: result.isError,
			durationMs: result.timestamp - startedAt,
		};
		return { ...base, status, output: messageText(result) };
	}
	return {
		...base,
		status: slotStatus(slot, startedAt),
		...(slot?.output === undefined ? {} : { output: slot.output }),
	};
}

function entryRows(
	entry: EntryRecord,
	results: ReadonlyMap<string, ToolResultMessage>,
	slots: ReadonlyMap<string, ToolSlot>,
): TranscriptRow[] {
	const key = String(entry.id);
	switch (entry.kind) {
		case "pi.user": {
			const message = entry.model?.[0];
			return message === undefined ? [] : [{ kind: "user", key, text: messageText(message) }];
		}
		case "pi.assistant": {
			const message = entry.model?.[0];
			return message?.role === "assistant" ? assistantRows(message, key, false, results, slots) : [];
		}
		case "pi.compaction":
			return [{ kind: "notice", key, message: "Context compacted: earlier turns were summarized." }];
		case "pi.reset":
			return [{ kind: "notice", key, message: "A new context started here." }];
		default:
			return [];
	}
}

function assistantRows(
	message: AssistantMessage,
	key: string,
	streaming: boolean,
	results: ReadonlyMap<string, ToolResultMessage>,
	slots: ReadonlyMap<string, ToolSlot>,
): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const startedAt = responseEnd(message);
	message.content.forEach((block, index) => {
		const blockKey = `${key}:${index}`;
		if (block.type === "thinking") {
			if (block.thinking.trim()) rows.push({ kind: "thinking", key: blockKey, text: block.thinking });
		} else if (block.type === "text") {
			if (block.text.trim()) rows.push({ kind: "assistant", key: blockKey, text: block.text, streaming });
		} else if (streaming) {
			rows.push({
				kind: "tool",
				key: `tool:${block.id}`,
				cell: { callId: block.id, name: block.name, args: block.arguments, status: { kind: "pending" } },
			});
		} else {
			rows.push({
				kind: "tool",
				key: `tool:${block.id}`,
				cell: toolCellOf(block, startedAt, results.get(block.id), slots.get(block.id)),
			});
		}
	});
	if ((message.stopReason === "error" || message.stopReason === "aborted") && !streaming) {
		const reason = message.stopReason === "aborted" ? "Aborted" : "The model request failed";
		rows.push({
			kind: "notice",
			key: `${key}:stop`,
			message: `${reason}${message.errorMessage ? `: ${message.errorMessage}` : "."}`,
		});
	}
	return rows;
}

function liveRows(live: LiveState | undefined, slots: ReadonlyMap<string, ToolSlot>): TranscriptRow[] {
	if (live === undefined) return [];
	const rows: TranscriptRow[] = [];
	const partial = live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) rows.push(...assistantRows(partial, "live", true, new Map(), slots));
	const retry = live.generation?.retry;
	if (retry !== undefined) {
		rows.push({ kind: "notice", key: "live:retry", message: `Retrying after an error: ${retry.error}` });
	}
	for (const compaction of live.compactions ?? []) {
		rows.push({
			kind: "notice",
			key: `live:compaction:${compaction.taskId}`,
			message: `Compacting the context (${compaction.trigger})${compaction.retry ? `; retrying after: ${compaction.retry.error}` : ""}.`,
		});
	}
	if (live.compactionFailure !== undefined) {
		rows.push({
			kind: "notice",
			key: "live:compaction-failure",
			message: `Compaction failed: ${live.compactionFailure.error}`,
		});
	}
	if (live.runFailure !== undefined && live.run === undefined) {
		const { reason, detail } = live.runFailure;
		rows.push({
			kind: "notice",
			key: `live:run-failure:${live.runFailure.taskId}`,
			message: describeRunFailure(reason, detail),
		});
	}
	return rows;
}

/** A run failure as a sentence for the user. */
export function describeRunFailure(reason: string, detail: string | undefined): string {
	const text = RUN_FAILURES[reason] ?? `The run ended without an answer (${reason})`;
	return detail ? `${text}: ${detail}` : `${text}.`;
}

const RUN_FAILURES: Readonly<Record<string, string>> = {
	model_error: "The model request failed",
	no_model: "No model is available; use /login and /model",
	aborted: "Aborted",
	reset: "The context was reset before an answer",
	faulted: "The run failed",
	orphaned: "The run could not continue",
	interrupted: "The run was interrupted by restarts",
	restart_limit: "The run was cut off by restarts too often",
	nothing_to_answer: "Nothing to answer",
	turn_limit: "The run reached its turn limit",
};

function slotStatus(slot: ToolSlot | undefined, startedAt: number): ToolCellStatus {
	switch (slot?.status) {
		case "running":
			return { kind: "running", startedAt };
		case "sleeping":
		case "waiting":
			return { kind: "parked" };
		case "done":
			return { kind: "running", startedAt };
		default:
			return { kind: "pending" };
	}
}
