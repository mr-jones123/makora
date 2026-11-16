// One Python kernel process: spawning it, NDJSON framing, request and reply correlation, interrupt, and exit detection.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { Context } from "@earendil-works/chord/context";
import {
	type ExecuteResult,
	type HostMessage,
	type HostRequest,
	KERNEL_PROTOCOL_VERSION,
	type KernelMessage,
	type ReadyMessage,
	type RestoreResult,
	type SnapshotManifest,
	type SnapshotResult,
} from "./protocol.ts";
import type { PythonEnv } from "./python-env.ts";

/** How a kernel process ended. */
export interface KernelExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** What a request to the kernel came to: its reply, or the kernel's death before one. */
export type KernelOutcome<T> =
	| { readonly kind: "reply"; readonly value: T }
	| { readonly kind: "died"; readonly exit: KernelExit; readonly stderr: string };

/** Where a running cell's output and host requests go. */
export interface CellHandlers {
	stream(stream: "stdout" | "stderr", text: string): void;
	/** Answer one host request; a throw becomes an error reply the cell sees as `HostError`. */
	hostRequest(request: HostRequest): Promise<unknown>;
}

/** Seconds a cell gets to react to an interrupt before the kernel is killed. */
export const INTERRUPT_GRACE_MS = 3_000;

// Node fires a timer set past 2^31-1 ms after 1 ms instead.
const MAX_CELL_TIMEOUT_MS = 2 ** 31 - 1 - INTERRUPT_GRACE_MS;

const READY_TIMEOUT_MS = 30_000;

const STDERR_TAIL = 8_192;

type Pending = { readonly settle: (outcome: KernelOutcome<KernelMessage>) => void };

/** The tail of the kernel's own stderr (startup errors, native crash dumps), for death reports. */
type StderrTail = { text: string };

/** A running kernel; `start()` resolves once it reported `ready` with a matching protocol version. */
export class Kernel {
	readonly pid: number;
	readonly python: string;
	readonly dill: string;
	readonly cwd: string;
	/** Resolves when the process has exited, however it ended. */
	readonly exited: Promise<KernelExit>;
	readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
	readonly #pending = new Map<string, Pending>();
	readonly #cells = new Map<string, CellHandlers>();
	readonly #stderr: StderrTail;
	#exit: KernelExit | undefined;
	#nextId = 0;

	private constructor(
		child: ChildProcessByStdio<Writable, Readable, Readable>,
		ready: ReadyMessage,
		cwd: string,
		exited: Promise<KernelExit>,
		stderr: StderrTail,
	) {
		this.#child = child;
		this.pid = ready.pid;
		this.python = ready.python;
		this.dill = ready.dill;
		this.cwd = cwd;
		this.exited = exited;
		this.#stderr = stderr;
	}

	/** Start a kernel in `cwd` with `env`'s interpreter. */
	static async start(env: PythonEnv, cwd: string, context: Context): Promise<Kernel> {
		// `-P`: the cwd, the user's project, is not put first on `sys.path`, where its `json.py` or `signal.py` would
		// shadow the kernel's imports; the kernel puts it there once its own imports are done.
		const child = spawn(env.python, ["-P", "-m", "makora_rlm.kernel"], {
			cwd,
			env: { ...process.env, PYTHONPATH: env.packagePath, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group: a terminal's Ctrl+C reaches makora only, and a kill reaches the cell's children.
			detached: true,
		});
		const stderr: StderrTail = { text: "" };
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			stderr.text = (stderr.text + text).slice(-STDERR_TAIL);
		});
		const exit = Promise.withResolvers<KernelExit>();
		child.once("exit", (code, signal) => exit.resolve({ code, signal }));
		// A failed spawn (missing interpreter) emits `error` and then `exit`; the exit settles the start.
		child.once("error", (error) => {
			stderr.text += `${error.message}\n`;
		});
		// A kernel that dies before its `exit` event is handled fails the next write with EPIPE. The exit settles every
		// request with `died`, so the write error says nothing more, and unhandled it would crash makora.
		child.stdin.on("error", () => {});
		const exited = exit.promise;
		const lines = splitLines(child.stdout);
		const first = await Promise.race([
			lines.next().then((next) => (next.done ? undefined : next.value)),
			exited.then(() => undefined),
			delay(READY_TIMEOUT_MS, context),
		]);
		const ready = first === undefined ? undefined : (JSON.parse(first) as KernelMessage);
		if (ready?.type !== "ready" || ready.protocol !== KERNEL_PROTOCOL_VERSION) {
			killGroup(child.pid);
			const why =
				ready?.type === "ready"
					? `speaks protocol ${ready.protocol}, makora ${KERNEL_PROTOCOL_VERSION}`
					: "did not start";
			throw new Error(`The Python kernel ${why}.${stderr.text ? `\n${stderr.text.trim()}` : ""}`);
		}
		const kernel = new Kernel(child, ready, cwd, exited, stderr);
		void kernel.#read(lines);
		void exited.then((exit) => kernel.#died(exit));
		return kernel;
	}

	/** Whether the process has exited. */
	get dead(): boolean {
		return this.#exit !== undefined;
	}

	/**
	 * Run `code` as one cell. The kernel interrupts it after `timeoutMs`, clamped to what a Node timer can wait; when
	 * the cell ignores that, or `context` is aborted and it ignores the interrupt, the kernel is killed and the outcome
	 * is `died`.
	 */
	async execute(
		code: string,
		timeoutMs: number,
		handlers: CellHandlers,
		context: Context,
	): Promise<KernelOutcome<ExecuteResult>> {
		const id = this.#id("cell");
		this.#cells.set(id, handlers);
		const limit = Math.min(Math.max(timeoutMs, 0), MAX_CELL_TIMEOUT_MS);
		const backstop = setTimeout(() => this.kill(), limit + INTERRUPT_GRACE_MS);
		let grace: NodeJS.Timeout | undefined;
		const onAbort = (): void => {
			this.#send({ type: "interrupt", id });
			grace ??= setTimeout(() => this.kill(), INTERRUPT_GRACE_MS);
		};
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		if (context.abortSignal?.aborted) onAbort();
		try {
			return await this.#request<ExecuteResult>({ type: "execute", id, code, timeoutMs: limit });
		} finally {
			clearTimeout(backstop);
			clearTimeout(grace);
			context.abortSignal?.removeEventListener("abort", onAbort);
			this.#cells.delete(id);
		}
	}

	/** Pickle the variables changed since `previous` into `blobDir`. */
	snapshot(
		blobDir: string,
		previous: SnapshotManifest | undefined,
		maxVariableBytes: number,
	): Promise<KernelOutcome<SnapshotManifest>> {
		const request = this.#request<SnapshotResult>({
			type: "snapshot",
			id: this.#id("snapshot"),
			blobDir,
			previous,
			maxVariableBytes,
		});
		return request.then((outcome) =>
			outcome.kind === "reply" ? { kind: "reply", value: outcome.value.manifest } : outcome,
		);
	}

	/** Load `manifest` into the namespace. */
	restore(blobDir: string, manifest: SnapshotManifest): Promise<KernelOutcome<RestoreResult>> {
		return this.#request<RestoreResult>({ type: "restore", id: this.#id("restore"), blobDir, manifest });
	}

	/** Ask the kernel to exit, and kill it if it has not after a grace period. */
	async shutdown(): Promise<KernelExit> {
		if (this.#exit !== undefined) return this.#exit;
		this.#send({ type: "shutdown" });
		const timer = setTimeout(() => this.kill(), INTERRUPT_GRACE_MS);
		const exit = await this.exited;
		clearTimeout(timer);
		return exit;
	}

	/** Kill the kernel and everything its cells started. */
	kill(): void {
		if (this.#exit === undefined) killGroup(this.#child.pid);
	}

	#id(kind: string): string {
		return `${kind}-${++this.#nextId}`;
	}

	#request<T extends KernelMessage>(message: HostMessage & { readonly id: string }): Promise<KernelOutcome<T>> {
		if (this.#exit !== undefined) return Promise.resolve(this.#deathOutcome(this.#exit));
		const { promise, resolve } = Promise.withResolvers<KernelOutcome<T>>();
		this.#pending.set(message.id, { settle: resolve as (outcome: KernelOutcome<KernelMessage>) => void });
		this.#send(message);
		return promise;
	}

	#send(message: HostMessage): void {
		if (this.#exit !== undefined) return;
		this.#child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async #read(lines: AsyncGenerator<string>): Promise<void> {
		for await (const line of lines) {
			// The kernel is makora's own code; its lines are trusted protocol messages.
			const message = JSON.parse(line) as KernelMessage;
			switch (message.type) {
				case "stream":
					this.#cells.get(message.id)?.stream(message.stream, message.text);
					break;
				case "host_request":
					void this.#answer(message);
					break;
				case "result":
				case "snapshot_result":
				case "restore_result": {
					const pending = this.#pending.get(message.id);
					this.#pending.delete(message.id);
					pending?.settle({ kind: "reply", value: message });
					break;
				}
				case "ready":
					break;
			}
		}
	}

	async #answer(request: HostRequest): Promise<void> {
		const handlers = this.#cells.get(request.cellId);
		try {
			if (handlers === undefined) throw new Error("no cell is running");
			const value = await handlers.hostRequest(request);
			this.#send({ type: "host_reply", requestId: request.requestId, ok: true, value });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.#send({ type: "host_reply", requestId: request.requestId, ok: false, error: text });
		}
	}

	#died(exit: KernelExit): void {
		this.#exit = exit;
		const outcome = this.#deathOutcome(exit);
		for (const pending of this.#pending.values()) pending.settle(outcome);
		this.#pending.clear();
	}

	#deathOutcome(exit: KernelExit): KernelOutcome<never> {
		return { kind: "died", exit, stderr: this.#stderr.text };
	}
}

/** An exit as people read it: `exit 3`, or `SIGKILL, exit 137` for a signal. */
export function describeExit(exit: KernelExit): string {
	if (exit.signal === null) return `exit ${exit.code ?? "?"}`;
	return `${exit.signal}, exit ${128 + (constants.signals[exit.signal] ?? 0)}`;
}

/** Kill process group `pid` (a kernel and its children) with SIGKILL; a group already gone is fine. */
export function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

async function* splitLines(stream: Readable): AsyncGenerator<string> {
	stream.setEncoding("utf8");
	let buffer = "";
	for await (const chunk of stream as AsyncIterable<string>) {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) yield line;
			newline = buffer.indexOf("\n");
		}
	}
}

function delay(ms: number, context: Context): Promise<undefined> {
	const { promise, resolve } = Promise.withResolvers<undefined>();
	setTimeout(resolve, ms, undefined).unref();
	context.abortSignal?.addEventListener("abort", () => resolve(undefined), { once: true });
	return promise;
}
