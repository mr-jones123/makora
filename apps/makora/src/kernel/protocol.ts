// The wire protocol between makora and a Python kernel: one JSON object per line on the kernel's stdin and stdout.
// `apps/makora/python/makora_rlm/protocol.py` mirrors these shapes; change both together.

/** Kernel protocol version; the kernel reports it in `ready` and the host refuses a mismatch. */
export const KERNEL_PROTOCOL_VERSION = 1;

/** A request id the host assigns; replies carry it back. */
export type RequestId = string;

/** Messages makora writes to the kernel. */
export type HostMessage =
	| ExecuteRequest
	| { readonly type: "interrupt"; readonly id: RequestId }
	| SnapshotRequest
	| RestoreRequest
	| HostReply
	| { readonly type: "shutdown" };

/** Run one cell in the kernel's persistent namespace; top-level `await` is allowed. */
export interface ExecuteRequest {
	readonly type: "execute";
	readonly id: RequestId;
	readonly code: string;
	/** The cell is interrupted (KeyboardInterrupt) after this long; the kernel is restarted if it ignores that. */
	readonly timeoutMs: number;
}

/**
 * Pickle the namespace's variables that changed since `previous` into `blobDir` (content-addressed:
 * `<blobDir>/sha256/<first two hex>/<rest>`), and report every variable's blob. Unchanged variables keep their blob.
 */
export interface SnapshotRequest {
	readonly type: "snapshot";
	readonly id: RequestId;
	readonly blobDir: string;
	readonly previous: SnapshotManifest | undefined;
	/** Variables larger than this are dropped with reason `over_cap`. */
	readonly maxVariableBytes: number;
}

/** Load a snapshot into a fresh namespace: imports first, then each variable's blob. */
export interface RestoreRequest {
	readonly type: "restore";
	readonly id: RequestId;
	readonly blobDir: string;
	readonly manifest: SnapshotManifest;
}

/** The host's answer to a kernel's `host_request`. */
export type HostReply =
	| { readonly type: "host_reply"; readonly requestId: RequestId; readonly ok: true; readonly value: unknown }
	| { readonly type: "host_reply"; readonly requestId: RequestId; readonly ok: false; readonly error: string };

/** Messages the kernel writes to makora. */
export type KernelMessage =
	| ReadyMessage
	| { readonly type: "stream"; readonly id: RequestId; readonly stream: "stdout" | "stderr"; readonly text: string }
	| HostRequest
	| ExecuteResult
	| SnapshotResult
	| RestoreResult;

/** First line the kernel prints once it accepts requests. */
export interface ReadyMessage {
	readonly type: "ready";
	readonly protocol: number;
	readonly pid: number;
	readonly python: string;
	readonly dill: string;
}

/**
 * A call from Python into makora while cell `cellId` runs: `tool` runs a Durable tool (`read`, `write`, `edit`,
 * `bash`) as a nested call; `llm` runs one model call; `ctx` reads conversation context.
 */
export type HostRequest = {
	readonly type: "host_request";
	readonly requestId: RequestId;
	readonly cellId: RequestId;
} & (
	| {
			readonly method: "tool";
			readonly params: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
	  }
	| {
			readonly method: "llm";
			readonly params: { readonly prompt: string; readonly schema?: unknown; readonly model?: string };
	  }
	| {
			readonly method: "ctx";
			readonly params: { readonly what: "input" } | { readonly what: "transcript"; readonly limit: number };
	  }
);

/** How a cell ended. */
export interface ExecuteResult {
	readonly type: "result";
	readonly id: RequestId;
	readonly status: "ok" | "error" | "interrupted";
	/** `repr` of the cell's last expression, when it had one and it was not None. */
	readonly value?: string;
	readonly error?: { readonly name: string; readonly message: string; readonly traceback: string };
	readonly durationMs: number;
	/** The kernel process's peak resident memory, for the status line. */
	readonly maxRssBytes: number;
}

/** What one cell's snapshot holds: enough to rebuild the namespace in a new kernel. */
export interface SnapshotManifest {
	readonly python: string;
	readonly dill: string;
	/** Import statements to replay before loading variables, e.g. `import pandas as pd`. */
	readonly imports: readonly string[];
	readonly vars: Readonly<Record<string, SnapshotVar>>;
	readonly dropped: readonly DroppedVar[];
}

/** One saved variable, or a group of variables that share objects and are saved as one blob. */
export interface SnapshotVar {
	/** `sha256:<hex>` of the pickled bytes. */
	readonly blob: string;
	readonly bytes: number;
	readonly type: string;
	/** Other names restored from the same blob (they refer to the same objects). */
	readonly group?: readonly string[];
}

/** A variable the snapshot could not keep. */
export interface DroppedVar {
	readonly name: string;
	readonly type: string;
	readonly reason: "unpicklable" | "over_cap";
	readonly bytes?: number;
}

export interface SnapshotResult {
	readonly type: "snapshot_result";
	readonly id: RequestId;
	readonly manifest: SnapshotManifest;
}

export interface RestoreResult {
	readonly type: "restore_result";
	readonly id: RequestId;
	readonly restored: readonly string[];
	/** Variables whose blob would not load (missing, corrupt, or bytecode from another Python), with the reason. */
	readonly failed: readonly { readonly name: string; readonly reason: string }[];
}
