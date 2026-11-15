// The `python` tool: runs one cell in the conversation's kernel, answers the kernel's host requests through Durable,
// and returns the result with references to the cell's snapshot and worktree tree, which Durable commits with it.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineTool,
	type JsonObject,
	type NestedToolExecutionResult,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ReadToolDetails } from "@earendil-works/pi-durable/tools";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { describeExit, type Kernel } from "../kernel/kernel.ts";
import type { KernelManager } from "../kernel/manager.ts";
import type { ExecuteResult, HostRequest, SnapshotManifest } from "../kernel/protocol.ts";
import {
	type CellKernel,
	type CellSnapshot,
	MAX_RECORDED_CALLS,
	type NestedCall,
	type PythonDetails,
	variableCount,
} from "./details.ts";
import { captureTree, changedFiles } from "./git-tree.ts";
import { findRestorePoint, latestInput, type RestorePoint, recentEntries } from "./history.ts";

/** Whether and where cells are snapshotted. */
export type SnapshotPolicy =
	/** An ephemeral session: nothing outlives the process. */
	| { readonly kind: "off" }
	| {
			readonly kind: "session";
			readonly sessionId: string;
			readonly blobDir: string;
			/** Read at each cell, so a settings change applies to the next one. */
			readonly enabled: () => boolean;
	  };

/** What the python tool runs on: the session's kernels and its snapshot policy. */
export interface PythonToolOptions {
	readonly kernels: KernelManager;
	readonly snapshots: SnapshotPolicy;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
}

const PythonParameters = obj({
	code: str({
		description:
			"Python source of one cell. Variables persist between cells; top-level `await` works; the value of a final expression is shown.",
	}),
	timeout: opt(num({ description: "Seconds before the cell is interrupted; default 600" })),
});

const DEFAULT_TIMEOUT_S = 600;

/** A variable whose pickle is larger is dropped from the snapshot as `over_cap`. */
export const MAX_VARIABLE_BYTES = 64 * 1024 * 1024;

/** Cells numbered per conversation, counted when a cell starts, so numbers survive crashes and restarts. */
const CellCount = defineDoc<{ cells: number }>({
	kind: "makora.python-cells",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ cells: 0 }),
	checkpointWhen: () => true,
});

/** The `python` tool for one session. */
export function createPythonTool(options: PythonToolOptions): ToolRegistration<typeof PythonParameters, PythonDetails> {
	// The snapshot each conversation's kernel last saved or restored, the base its next snapshot compares against.
	const latest = new Map<ConversationId, CellSnapshot>();
	return defineTool({
		name: "python",
		description:
			"Run Python in this conversation's persistent REPL. Files and shell through `await read/write/edit/bash(...)`, one model call through `await llm(...)`.",
		parameters: PythonParameters,
		callers: ["model"],
		// One kernel runs one cell at a time.
		executionMode: "sequential",
		execute: (args, api, context) =>
			runCell(args.code, (args.timeout ?? DEFAULT_TIMEOUT_S) * 1000, options, latest, api, context),
	});
}

async function runCell(
	code: string,
	timeoutMs: number,
	options: PythonToolOptions,
	latest: Map<ConversationId, CellSnapshot>,
	api: ToolExecutionApi<PythonDetails>,
	context: Context,
): Promise<ToolExecutionResult<PythonDetails>> {
	const cell = await api.commit(async (tx) => {
		const count = await tx.doc(CellCount, api.conversationId);
		count.cells += 1;
		return count.cells;
	}, context);
	const cwd = (await api.agent(context)).cwd ?? options.defaultCwd;
	const output = new CellOutput(api);
	let { kernel, fresh } = await options.kernels.acquire(api.conversationId, cwd, context);
	if (fresh) {
		const prepared = await prepareKernel(kernel, cwd, options, latest, api, context).catch(async (error: unknown) => {
			// Left running unrestored, the kernel would serve the next cell, whose snapshot would replace the restore
			// point with an empty namespace.
			kernel.kill();
			await kernel.exited;
			throw error;
		});
		kernel = prepared.kernel;
		if (prepared.notice !== undefined) output.notice(prepared.notice);
	}
	const base: CellKernel = { cell, python: kernel.python, dill: kernel.dill, cwd: kernel.cwd };
	await api.details({ kernel: base }, context);
	const calls = new CallLog();
	const outcome = await kernel.execute(
		code,
		timeoutMs,
		{
			stream: (_stream, text) => output.add(text),
			hostRequest: (request) => answerHost(request, calls, api, context),
		},
		context,
	);
	if (outcome.kind === "died") {
		const crash = outcome.stderr.trim();
		const text = `kernel died (${describeExit(outcome.exit)}) during cell ${cell}${crash ? `\n${tail(crash, 2_000)}` : ""}`;
		return { output: output.result(text), isError: true, details: { kernel: base, ...calls.details() } };
	}
	const result = outcome.value;
	options.kernels.report(api.conversationId, { peakRssBytes: result.maxRssBytes });
	const saved = await saveCell(kernel, cell, options, latest, api.conversationId);
	return {
		output: output.result(describeResult(cell, result, saved.problem)),
		isError: result.status !== "ok",
		details: {
			kernel: saved.tree === undefined ? base : { ...base, tree: saved.tree },
			...(saved.snapshot === undefined ? {} : { snapshot: saved.snapshot }),
			...calls.details(),
		},
	};
}

/**
 * Bring a new kernel to the state the transcript last committed: restore the newest snapshot on this branch, and say
 * what the model should know. A kernel that dies while restoring is replaced by an empty one.
 */
async function prepareKernel(
	kernel: Kernel,
	cwd: string,
	options: PythonToolOptions,
	latest: Map<ConversationId, CellSnapshot>,
	api: ToolExecutionApi<PythonDetails>,
	context: Context,
): Promise<{ readonly kernel: Kernel; readonly notice?: string }> {
	latest.delete(api.conversationId);
	const point = await findRestorePoint(api, context);
	const policy = options.snapshots;
	if (point.kind === "first") return { kernel };
	if (policy.kind === "off" || !policy.enabled()) {
		return { kernel, notice: "Kernel restarted empty: variables of earlier cells were lost (snapshots are off)." };
	}
	if (point.kind === "lost") {
		return {
			kernel,
			notice: "Kernel restarted empty: no earlier cell saved a snapshot, so their variables were lost.",
		};
	}
	const { snapshot, kernel: saved } = point.details;
	const outcome = await kernel.restore(policy.blobDir, snapshot);
	if (outcome.kind === "died") {
		const fresh = await options.kernels.acquire(api.conversationId, cwd, context);
		const why = `restoring the snapshot of cell ${saved.cell} killed the kernel (${describeExit(outcome.exit)})`;
		return { kernel: fresh.kernel, notice: `Kernel restarted empty: ${why}; variables were lost.` };
	}
	latest.set(api.conversationId, snapshot);
	options.kernels.report(api.conversationId, {
		state: "restored",
		variables: outcome.value.restored.length,
		snapshotCell: saved.cell,
	});
	// Which files changed is a hint for the model; failing to compare (an unreadable file) leaves it out.
	const files =
		saved.tree === undefined ? undefined : await changedFiles(kernel.cwd, saved.tree).catch(() => undefined);
	return { kernel, notice: restoreNotice(point, outcome.value.restored, outcome.value.failed, files) };
}

function restoreNotice(
	point: Extract<RestorePoint, { kind: "snapshot" }>,
	restored: readonly string[],
	failed: readonly { readonly name: string; readonly reason: string }[],
	files: readonly string[] | undefined,
): string {
	const { cell } = point.details.kernel;
	const lines = [
		`Kernel restarted. Variables restored to after cell ${cell}: ${restored.length === 0 ? "none" : restored.join(", ")}.`,
	];
	if (files !== undefined && files.length > 0) {
		lines.push(`Files changed since cell ${cell} (not restored): ${files.join(", ")}`);
	}
	const dropped = point.details.snapshot.dropped;
	if (dropped.length > 0) {
		lines.push(`Dropped: ${dropped.map((each) => `${each.name} (${each.reason.replace("_", " ")})`).join(", ")}`);
	}
	if (failed.length > 0) lines.push(`Failed: ${failed.map((each) => `${each.name} (${each.reason})`).join(", ")}`);
	return lines.join("\n");
}

/** What the end of a cell saved: its snapshot and tree when snapshots are on, or why not. */
type SavedCell = { readonly snapshot?: CellSnapshot; readonly tree?: string; readonly problem?: string };

async function saveCell(
	kernel: Kernel,
	cell: number,
	options: PythonToolOptions,
	latest: Map<ConversationId, CellSnapshot>,
	conversationId: ConversationId,
): Promise<SavedCell> {
	const policy = options.snapshots;
	if (policy.kind === "off" || !policy.enabled()) {
		options.kernels.report(conversationId, { state: "running" });
		return {};
	}
	const previous = latest.get(conversationId);
	const outcome = await kernel.snapshot(policy.blobDir, previous, MAX_VARIABLE_BYTES);
	if (outcome.kind === "died") {
		return { problem: `kernel died (${describeExit(outcome.exit)}) while saving the snapshot of cell ${cell}` };
	}
	// The kernel's manifest is parsed JSON; the protocol types it with readonly arrays, which are not JsonValue.
	const manifest = outcome.value as JsonRepresentation<SnapshotManifest>;
	// Blobs and the tree are written before the result that references them is committed.
	const snapshot: CellSnapshot = {
		id: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
		...(previous === undefined ? {} : { parent: previous.id }),
		...manifest,
	};
	latest.set(conversationId, snapshot);
	options.kernels.report(conversationId, {
		state: "running",
		variables: variableCount(manifest),
		snapshotCell: cell,
	});
	const tree = await captureTree(kernel.cwd, `refs/makora/${policy.sessionId}/${conversationId}`).catch(
		() => undefined,
	);
	return tree === undefined ? { snapshot } : { snapshot, tree };
}

function describeResult(cell: number, result: ExecuteResult, problem: string | undefined): string {
	const parts: string[] = [];
	if (result.value !== undefined) parts.push(`Out: ${tail(result.value, 4_000)}`);
	if (result.status === "interrupted") parts.push(`cell ${cell} ${result.error?.message ?? "interrupted"}`);
	if (result.error !== undefined) parts.push(tail(result.error.traceback.trimEnd(), 8_000));
	if (problem !== undefined) parts.push(problem);
	return parts.join("\n");
}

async function answerHost(
	request: HostRequest,
	calls: CallLog,
	api: ToolExecutionApi,
	context: Context,
): Promise<unknown> {
	switch (request.method) {
		// The kernel's params are wire input; executeTool validates them against the tool's schema.
		case "tool": {
			const { name } = request.params;
			const args = request.params.args as JsonObject;
			if (name === "read" && args.offset === undefined && args.limit === undefined) {
				return readWhole(args, request.requestId, calls, api, context);
			}
			return (await nestedTool(name, args, request.requestId, calls, api, context)).structuredOutput ?? "";
		}
		case "llm":
			return (
				(await nestedTool("llm", request.params as JsonObject, request.requestId, calls, api, context))
					.structuredOutput ?? ""
			);
		case "ctx":
			return request.params.what === "input"
				? latestInput(api, context)
				: recentEntries(api, request.params.limit, context);
	}
}

// Durable's read stops at its line and byte limits and says so only in a diagnostic, which a program never sees, so
// `await read(path)` follows the continuation offsets to the end of the file. A line over the byte limit cannot be
// continued, and is refused rather than cut.
async function readWhole(
	args: JsonObject,
	key: string,
	calls: CallLog,
	api: ToolExecutionApi,
	context: Context,
): Promise<unknown> {
	let text = "";
	for (let offset: number | undefined; ; ) {
		const page =
			offset === undefined
				? await nestedTool("read", args, key, calls, api, context)
				: await nestedTool("read", { ...args, offset }, `${key}@${offset}`, calls, api, context);
		// An image comes back as it is.
		if (typeof page.structuredOutput !== "string") return page.structuredOutput ?? "";
		// Written by Durable's read tool.
		const truncation = (page.details as ReadToolDetails | undefined)?.truncation;
		if (truncation?.firstLineExceedsLimit) {
			throw new Error(`${String(args.path)}: line ${offset ?? 1} is over read's ${truncation.maxBytes}-byte limit`);
		}
		if (truncation?.truncated !== true) return text + page.structuredOutput;
		// A cut page ends at a line break, which it leaves out.
		text += `${page.structuredOutput}\n`;
		offset = (offset ?? 1) + truncation.outputLines;
	}
}

// A tool error without a value for programs becomes a `HostError` in the cell; one with a value (bash's exit code)
// is the program's to read.
async function nestedTool(
	name: string,
	args: JsonObject,
	key: string,
	calls: CallLog,
	api: ToolExecutionApi,
	context: Context,
): Promise<NestedToolExecutionResult> {
	const result = await api.executeTool(name, args, context, { key });
	calls.add({
		name,
		args: preview(args),
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
	});
	if (result.isError && result.structuredOutput === undefined) {
		throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") || `${name} failed`);
	}
	return result;
}

/** The nested calls of one cell, for its result's details. */
class CallLog {
	readonly #calls: NestedCall[] = [];
	#more = 0;

	add(call: NestedCall): void {
		if (this.#calls.length < MAX_RECORDED_CALLS) this.#calls.push(call);
		else this.#more++;
	}

	details(): Pick<PythonDetails, "calls" | "moreCalls"> {
		if (this.#calls.length === 0) return {};
		return this.#more === 0 ? { calls: this.#calls } : { calls: this.#calls, moreCalls: this.#more };
	}
}

const PREVIEW_CHARS = 200;

function preview(args: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(args).map(([key, value]) => [
			key,
			typeof value === "string" && value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value,
		]),
	);
}

const STREAM_TAIL = 16_000;

/** A cell's output: streamed live through `api.output`, and kept as a bounded tail for the model. */
class CellOutput {
	readonly #api: ToolExecutionApi<PythonDetails>;
	#notice: string | undefined;
	#text = "";
	#omitted = 0;

	constructor(api: ToolExecutionApi<PythonDetails>) {
		this.#api = api;
	}

	notice(text: string): void {
		this.#notice = text;
		this.#api.output(`${text}\n`);
	}

	add(text: string): void {
		this.#api.output(text);
		this.#text += text;
		if (this.#text.length > STREAM_TAIL * 2) {
			this.#omitted += this.#text.length - STREAM_TAIL;
			this.#text = this.#text.slice(-STREAM_TAIL);
		}
	}

	/** The model's view: the notice, the output tail, then `ending`. */
	result(ending: string): ToolResultMessage["content"] {
		let stream = this.#text.length > STREAM_TAIL ? this.#text.slice(-STREAM_TAIL) : this.#text;
		const omitted = this.#omitted + (this.#text.length - stream.length);
		if (omitted > 0) stream = `[${omitted} earlier characters of output omitted]\n${stream}`;
		const text = [this.#notice, stream.trimEnd(), ending]
			.filter((part) => part !== undefined && part !== "")
			.join("\n");
		return [{ type: "text", text: text || "(no output)" }];
	}
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : `[${text.length - max} characters omitted]${text.slice(-max)}`;
}
