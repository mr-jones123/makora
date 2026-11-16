// Print mode (`makora -p`): submit one prompt, stream the answer to stdout and one line per tool call to stderr.
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { type Cursor, type EntryId, type EntryRecord, LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { AGENT_MESSAGE_ENTRY, AGENT_RESULT_ENTRY } from "./agents/prompts.ts";
import type { MakoraSession } from "./session.ts";
import { toolSummary } from "./tool-cell.ts";
import { describeRunFailure, messageText, responseEnd, toolCellOf, transcriptRows } from "./transcript-rows.ts";

/** Where print mode writes. */
export interface PrintOutput {
	stdout(text: string): void;
	stderr(text: string): void;
}

const TOOL_LINE_WIDTH = 120;

/**
 * Run print mode on `session` and return the exit code: 0 when the prompt was answered, 1 when it was not, with the
 * reason on stderr. An empty prompt submits nothing: it shows the transcript so far, waits for work an earlier process
 * left unfinished, and reports how the last run ended.
 */
export async function runPrint(
	session: MakoraSession,
	prompt: string,
	output: PrintOutput,
	context: Context,
): Promise<number> {
	const replay = prompt.length === 0;
	const printer = new TranscriptPrinter(output, replay);
	const watch = await session.root.watch(context);
	for (const entry of watch.value.entries) printer.entry(entry, replay);
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		for (const entry of call.value.entries) printer.entry(entry, true);
		printer.partial(call.value.docs["pi.live"] as LiveState | undefined);
	});
	for (const notice of session.notices) output.stderr(`⚠ ${notice.message}\n`);
	const unsubscribe = session.onNotice((notice) => output.stderr(`⚠ ${notice.message}\n`));
	try {
		if (replay) {
			await session.root.waitForIdle(context);
			await watch.stop();
			await printer.catchUp(session, context);
			const failure = (await session.harness.snapshot(LiveDoc, session.root.id, context))?.runFailure;
			return printer.finish(failure === undefined ? undefined : describeRunFailure(failure.reason, failure.detail));
		}
		const settled = await (await session.submit(session.root, prompt, context)).wait(context);
		await watch.stop();
		await printer.catchUp(session, context);
		if (settled.status === "done") return printer.finish(undefined);
		const detail =
			settled.detail === undefined || typeof settled.detail === "string"
				? settled.detail
				: JSON.stringify(settled.detail);
		return printer.finish(describeRunFailure(settled.reason ?? "unanswered", detail));
	} finally {
		unsubscribe();
	}
}

/** Prints each entry once, in order, and the live partial of the answer being generated. */
class TranscriptPrinter {
	readonly #output: PrintOutput;
	/** Whether user inputs are echoed: when showing a transcript, not when answering a prompt. */
	readonly #echoUsers: boolean;
	#newest: EntryId | undefined;
	/** Request start times of answers already committed, so a stale partial of one is not printed again. */
	readonly #committed = new Set<number>();
	readonly #calls = new Map<string, { call: ToolCall; startedAt: number }>();
	/** Text of the in-flight answer already written. */
	#printed = "";
	#lineOpen = false;

	constructor(output: PrintOutput, echoUsers: boolean) {
		this.#output = output;
		this.#echoUsers = echoUsers;
	}

	entry(entry: EntryRecord, show: boolean): void {
		if (this.#newest !== undefined && entry.id <= this.#newest) return;
		this.#newest = entry.id;
		if (show && entry.kind === "makora.notice") {
			// A child's setup command that was skipped: the notice says how to approve it.
			for (const row of transcriptRows([entry], undefined)) {
				if (row.kind === "notice") this.#output.stderr(`⚠ ${row.message}\n`);
			}
			return;
		}
		const message = entry.model?.[0];
		if (message === undefined) return;
		if (message.role === "assistant") {
			for (const block of message.content)
				if (block.type === "toolCall") this.#calls.set(block.id, { call: block, startedAt: responseEnd(message) });
			if (show) this.#answer(message);
			this.#committed.add(message.timestamp);
			this.#printed = "";
		} else if (message.role === "toolResult" && show) {
			const known = this.#calls.get(message.toolCallId);
			const call = known?.call ?? {
				type: "toolCall",
				id: message.toolCallId,
				name: message.toolName,
				arguments: {},
			};
			const summary = toolSummary(
				toolCellOf(call, known?.startedAt ?? message.timestamp, message, undefined),
				TOOL_LINE_WIDTH,
				Date.now(),
			);
			this.#output.stderr(`${summary.marker} ${summary.text}\n`);
		} else if (show && (entry.kind === AGENT_RESULT_ENTRY || entry.kind === AGENT_MESSAGE_ENTRY)) {
			for (const row of transcriptRows([entry], undefined)) {
				if (row.kind === "agent") this.#output.stderr(`↩ ${row.title}\n`);
			}
		} else if (message.role === "user" && show && this.#echoUsers && entry.kind === "pi.user") {
			this.#closeLine();
			this.#output.stdout(`› ${messageText(message)}\n\n`);
		}
	}

	partial(live: LiveState | undefined): void {
		const partial = live?.generation?.message as AssistantMessage | undefined;
		if (partial === undefined || this.#committed.has(partial.timestamp)) return;
		this.#write(messageText(partial));
	}

	/** Print the entries committed after the watch's last value. */
	async catchUp(session: MakoraSession, context: Context): Promise<void> {
		const after = this.#newest === undefined ? {} : { minEntryId: (this.#newest + 1) as EntryId };
		const query = { ...after, order: "ascending" as const };
		for (let cursor: Cursor | undefined; ; ) {
			const page = await session.root.entries(query, 100, cursor, context);
			for (const entry of page.items) this.entry(entry, true);
			if (page.next === undefined) return;
			cursor = page.next;
		}
	}

	finish(failure: string | undefined): number {
		this.#closeLine();
		if (failure === undefined) return 0;
		this.#output.stderr(`unanswered: ${failure}\n`);
		return 1;
	}

	#answer(message: AssistantMessage): void {
		this.#write(messageText(message));
		this.#closeLine();
	}

	// Writes only what `text` adds to the text already printed; a partial that does not continue it is skipped.
	#write(text: string): void {
		if (text.length <= this.#printed.length || !text.startsWith(this.#printed)) return;
		this.#output.stdout(text.slice(this.#printed.length));
		this.#printed = text;
		this.#lineOpen = !text.endsWith("\n");
	}

	#closeLine(): void {
		if (this.#lineOpen) this.#output.stdout("\n");
		this.#lineOpen = false;
	}
}
