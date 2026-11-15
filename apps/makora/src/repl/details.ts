// The `details` of a `python` result: the kernel that ran the cell, and the snapshot and worktree tree it left.
import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { SnapshotManifest } from "../kernel/protocol.ts";

/** The kernel a cell ran in. */
export type CellKernel = {
	readonly cell: number;
	readonly python: string;
	readonly dill: string;
	readonly cwd: string;
	/** `git:<tree>` of the worktree after the cell, when its cwd is in a git repository. */
	readonly tree?: string;
};

/** A cell's snapshot: the manifest, its own ID, and the ID of the snapshot it was taken after. */
export type CellSnapshot = JsonRepresentation<SnapshotManifest> & { readonly id: string; readonly parent?: string };

/** A tool call a cell made through a helper (`await bash(...)`), as the TUI lists it under the cell. */
export type NestedCall = {
	readonly name: string;
	/** The arguments, long strings cut to a preview. */
	readonly args: JsonObject;
	readonly isError: boolean;
	readonly durationMs?: number;
};

/**
 * What a `python` result's `details` hold, as `docs/architecture/repl.md` shows, plus the cell's nested calls: Durable
 * keeps nested results only in their own task records, so the transcript would not show them otherwise.
 */
export type PythonDetails = {
	readonly kernel: CellKernel;
	readonly snapshot?: CellSnapshot;
	readonly calls?: NestedCall[];
	/** Calls past the first `MAX_RECORDED_CALLS`, counted but not listed. */
	readonly moreCalls?: number;
};

/** How many nested calls a result lists. */
export const MAX_RECORDED_CALLS = 50;

/**
 * The python details of a committed result's `details`, or undefined when there are none (a call cut off by a
 * restart, or a result from before details existed).
 */
export function pythonDetails(details: unknown): PythonDetails | undefined {
	if (typeof details !== "object" || details === null || !("kernel" in details)) return undefined;
	const { kernel } = details;
	if (typeof kernel !== "object" || kernel === null || !("cell" in kernel) || typeof kernel.cell !== "number") {
		return undefined;
	}
	// Only the python tool writes these details; past the shape check they are its own JSON.
	return details as PythonDetails;
}

/** How many variables a snapshot holds, counting every name of a group. */
export function variableCount(snapshot: SnapshotManifest): number {
	let count = 0;
	for (const variable of Object.values(snapshot.vars)) count += 1 + (variable.group?.length ?? 0);
	return count;
}
