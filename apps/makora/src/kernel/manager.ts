// The kernels of one session: one per conversation, started lazily; their status for the TUI; and the pid records that
// let a restarted makora kill a kernel a crashed makora left behind.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Kernel, type KernelExit, killGroup } from "./kernel.ts";
import { ensurePythonEnv, type PythonEnv } from "./python-env.ts";

/** Where a conversation's kernel is in its life, as the dock shows it. */
export type KernelState =
	/** No kernel started in this process. */
	| "none"
	| "starting"
	| "running"
	/** Running, with variables restored from a snapshot; becomes `running` after its next cell. */
	| "restored"
	/** Exited; the next cell starts a new one. */
	| "dead";

/** A conversation's kernel as the TUI shows it. */
export interface KernelStatus {
	readonly state: KernelState;
	/** Variables in the last snapshot or restore. */
	readonly variables: number;
	/** The cell the variables were saved after or restored from. */
	readonly snapshotCell?: number;
	readonly peakRssBytes?: number;
	readonly exit?: KernelExit;
}

/** A kernel ready for a cell; `fresh` when it was started for this call and holds no variables yet. */
export interface AcquiredKernel {
	readonly kernel: Kernel;
	readonly fresh: boolean;
}

const NO_KERNEL: KernelStatus = { state: "none", variables: 0 };

/** One session's kernels. */
export class KernelManager {
	readonly #home: string;
	readonly #pidDir: string | undefined;
	readonly #kernels = new Map<ConversationId, Promise<Kernel>>();
	readonly #status = new Map<ConversationId, KernelStatus>();
	readonly #listeners = new Set<() => void>();
	#env: Promise<PythonEnv> | undefined;

	/**
	 * Kernels for the makora home `home`. With `pidDir`, each kernel's pid is recorded there, and kernels recorded by
	 * an earlier process that are still alive are killed now, before any cell can restore.
	 */
	constructor(home: string, pidDir: string | undefined) {
		this.#home = home;
		this.#pidDir = pidDir;
		if (pidDir !== undefined) reapKernels(pidDir);
	}

	/** The status of `conversationId`'s kernel. */
	status(conversationId: ConversationId): KernelStatus {
		return this.#status.get(conversationId) ?? NO_KERNEL;
	}

	/** Call `listener` after each status change; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The conversation's running kernel, or a new one started in `cwd`. */
	async acquire(conversationId: ConversationId, cwd: string, context: Context): Promise<AcquiredKernel> {
		const existing = await this.#kernels.get(conversationId)?.catch(() => undefined);
		if (existing !== undefined && !existing.dead) return { kernel: existing, fresh: false };
		const starting = this.#start(conversationId, cwd, context);
		this.#kernels.set(conversationId, starting);
		try {
			return { kernel: await starting, fresh: true };
		} catch (error) {
			this.#kernels.delete(conversationId);
			this.report(conversationId, { state: "none" });
			throw error;
		}
	}

	/** Merge `change` into the conversation's status. */
	report(conversationId: ConversationId, change: Partial<KernelStatus>): void {
		this.#status.set(conversationId, { ...this.status(conversationId), ...change });
		for (const listener of this.#listeners) listener();
	}

	/** Stop the conversation's kernel, if one runs, and forget its status. */
	async stop(conversationId: ConversationId): Promise<void> {
		const kernel = await this.#kernels.get(conversationId)?.catch(() => undefined);
		this.#kernels.delete(conversationId);
		await kernel?.shutdown();
		this.#status.delete(conversationId);
		for (const listener of this.#listeners) listener();
	}

	/** Stop every kernel. */
	async close(): Promise<void> {
		const kernels = await Promise.all([...this.#kernels.values()].map((kernel) => kernel.catch(() => undefined)));
		this.#kernels.clear();
		await Promise.all(kernels.map((kernel) => kernel?.shutdown()));
	}

	async #start(conversationId: ConversationId, cwd: string, context: Context): Promise<Kernel> {
		this.report(conversationId, { state: "starting", variables: 0 });
		this.#env ??= ensurePythonEnv(this.#home);
		const env = await this.#env.catch((error: unknown) => {
			this.#env = undefined;
			throw error;
		});
		const kernel = await Kernel.start(env, cwd, context);
		const record = this.#pidDir === undefined ? undefined : pidFile(this.#pidDir, conversationId);
		if (record !== undefined) {
			mkdirSync(this.#pidDir!, { recursive: true });
			writeFileSync(record, String(kernel.pid));
		}
		void kernel.exited.then((exit) => {
			if (record !== undefined) rmSync(record, { force: true });
			this.report(conversationId, { state: "dead", exit });
		});
		this.report(conversationId, { state: "running" });
		return kernel;
	}
}

function pidFile(pidDir: string, conversationId: ConversationId): string {
	return join(pidDir, `${conversationId}.pid`);
}

/** Kill every kernel recorded in `pidDir` that still runs, and forget the records. */
function reapKernels(pidDir: string): void {
	let names: string[];
	try {
		names = readdirSync(pidDir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(pidDir, name);
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		// A recorded pid may since belong to another program; only a process running our kernel module is killed.
		if (Number.isSafeInteger(pid) && isKernelProcess(pid)) killGroup(pid);
		rmSync(file, { force: true });
	}
}

function isKernelProcess(pid: number): boolean {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(
			"makora_rlm.kernel",
		);
	} catch {
		return false;
	}
}
