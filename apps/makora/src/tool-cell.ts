// Tool cells: one tool call as the transcript and print mode show it, and its fixed one-line summary.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Where a tool call is in its life. */
export type ToolCellStatus =
	/** Announced by the model, not started yet. */
	| { readonly kind: "pending" }
	/** Parked: sleeping or waiting without holding a process. */
	| { readonly kind: "parked" }
	| { readonly kind: "running"; readonly startedAt: number }
	| { readonly kind: "done"; readonly isError: boolean; readonly durationMs?: number };

/** One tool call of a conversation. */
export interface ToolCell {
	readonly callId: string;
	readonly name: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly status: ToolCellStatus;
	/** Running output while it runs, the result text once done. */
	readonly output?: string;
}

/** How a summary's marker is colored. */
export type ToolTone = "success" | "error" | "running" | "pending";

/** A tool cell's summary line: its marker and the text after it, together at most the given width. */
export interface ToolSummary {
	readonly marker: string;
	readonly tone: ToolTone;
	readonly text: string;
}

/** Spinner frames of a running call's marker. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * The summary line `<marker> <tool> · <argument preview> · <duration>` fitted to `width` columns. The argument
 * preview is truncated first, so the line stays one row whatever state the call is in.
 */
export function toolSummary(cell: ToolCell, width: number, now: number, frame = 0): ToolSummary {
	const { marker, tone } = markerOf(cell.status, frame);
	const duration = durationOf(cell.status, now);
	const preview = argumentPreview(cell.name, cell.args);
	const fixed = [cell.name, ...(duration === undefined ? [] : [duration])];
	const room = width - visibleWidth(marker) - 1 - visibleWidth(fixed.join(" · ")) - (preview ? 3 : 0);
	const parts = preview && room >= 2 ? [cell.name, truncateToWidth(preview, room, "…"), ...fixed.slice(1)] : fixed;
	return {
		marker,
		tone,
		text: truncateToWidth(parts.join(" · "), Math.max(0, width - visibleWidth(marker) - 1), "…"),
	};
}

/** A one-line preview of a call's arguments: the command, the path, or compact JSON. */
export function argumentPreview(name: string, args: Readonly<Record<string, unknown>>): string {
	const key = PREVIEW_KEYS[name];
	const value = key === undefined ? undefined : args[key];
	const text = typeof value === "string" ? value : Object.keys(args).length === 0 ? "" : JSON.stringify(args);
	return text.replace(/\s*\n\s*/g, " ⏎ ").trim();
}

const PREVIEW_KEYS: Readonly<Record<string, string>> = { bash: "command", read: "path", write: "path", edit: "path" };

/** A duration as `0.4s`, `12.0s`, or `3m05s`. */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function markerOf(status: ToolCellStatus, frame: number): { marker: string; tone: ToolTone } {
	switch (status.kind) {
		case "pending":
		case "parked":
			return { marker: "◌", tone: "pending" };
		case "running":
			return { marker: SPINNER[frame % SPINNER.length]!, tone: "running" };
		case "done":
			return status.isError ? { marker: "✗", tone: "error" } : { marker: "✓", tone: "success" };
	}
}

function durationOf(status: ToolCellStatus, now: number): string | undefined {
	switch (status.kind) {
		case "running":
			return formatDuration(now - status.startedAt);
		case "done":
			return status.durationMs === undefined ? undefined : formatDuration(status.durationMs);
		default:
			return undefined;
	}
}
