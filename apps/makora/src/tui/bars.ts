// The one-row bars around the transcript: top bar, activity dock, status row, hint rows, and rules.
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeExit } from "../kernel/kernel.ts";
import type { KernelStatus } from "../kernel/manager.ts";
import type { AccountLabel } from "./account-label.ts";
import { keyName } from "./keybindings.ts";
import { theme } from "./theme.ts";

/** A component of one row computed at each render from `line(width)`. */
export class Line implements Component {
	readonly #line: (width: number) => string;

	constructor(line: (width: number) => string) {
		this.#line = line;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [truncateToWidth(this.#line(width), width, "…")];
	}
}

/** A horizontal rule in the border color. */
export function rule(): Line {
	return new Line((width) => theme.border("─".repeat(width)));
}

/** `left` and `right` on one row, `left` truncated so `right` always fits. */
export function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const room = width - rightWidth - 1;
	if (room < 8) return truncateToWidth(left, width, "…");
	const shown = truncateToWidth(left, room, "…");
	return `${shown}${" ".repeat(Math.max(1, width - visibleWidth(shown) - rightWidth))}${right}`;
}

/** The top bar's data. */
export interface TopBar {
	/** On a conversation other than the main one: `viewing <name> · <mode> · <branch> · esc back to main`. */
	readonly viewing: string | undefined;
	readonly title: string | undefined;
	readonly cwd: string;
	readonly costUsd: number;
	readonly elapsedMs: number;
}

/** `makora · [viewing … · ]<title> · <cwd>` with `$<cost> · <elapsed>` on the right. */
export function topBar(bar: TopBar, width: number): string {
	const viewing = bar.viewing === undefined ? "" : theme.dim(" · ") + theme.bold(theme.warning(bar.viewing));
	const title = bar.title ? ` · ${bar.title}` : "";
	const left = `${theme.bold(theme.accent("makora"))}${viewing}${theme.muted(`${title} · ${bar.cwd}`)}`;
	return spread(left, theme.muted(`${formatCost(bar.costUsd)} · ${formatElapsed(bar.elapsedMs)}`), width);
}

/** The activity dock's data. */
export interface Dock {
	readonly running: number;
	readonly waiting: number;
	readonly worktrees: number;
	/** Context and compaction state, such as `auto-compact on` or `compacting`. */
	readonly context: string;
	/** The active conversation's Python kernel; shown once one started. */
	readonly kernel?: KernelStatus;
}

/** `◆ N running · ◌ N waiting · N worktrees · <kernel> · <context>`. */
export function dockLine(dock: Dock): string {
	const running = `◆ ${dock.running} running`;
	const kernel = dock.kernel === undefined ? undefined : kernelLabel(dock.kernel);
	return [
		dock.running > 0 ? theme.success(running) : theme.muted(running),
		theme.muted(`◌ ${dock.waiting} waiting`),
		theme.muted(`${dock.worktrees} worktrees`),
		...(kernel === undefined ? [] : [dock.kernel?.state === "dead" ? theme.warning(kernel) : theme.muted(kernel)]),
		theme.muted(dock.context),
	].join(theme.dim(" · "));
}

/** `py running 3 vars @ cell 7 45 MB`, `py dead (exit 137)`, or undefined before a kernel started. */
export function kernelLabel(status: KernelStatus): string | undefined {
	switch (status.state) {
		case "none":
			return undefined;
		case "starting":
			return "py starting";
		case "dead":
			return `py dead${status.exit === undefined ? "" : ` (${describeExit(status.exit)})`}`;
		case "running":
		case "restored": {
			const saved = status.snapshotCell === undefined ? "" : ` @ cell ${status.snapshotCell}`;
			const memory = status.peakRssBytes === undefined ? "" : ` ${Math.round(status.peakRssBytes / 1e6)} MB`;
			return `py ${status.state} ${status.variables} vars${saved}${memory}`;
		}
	}
}

/** The status row's data. */
export interface StatusRow {
	readonly model: string;
	readonly thinking: string;
	readonly cwd: string;
	readonly branch: string | undefined;
	readonly contextTokens: number | undefined;
	readonly contextWindow: number | undefined;
	readonly account: AccountLabel | undefined;
}

const GAUGE_CELLS = 20;

/** `<model> · <thinking> · <cwd> (<branch>) · ctx <gauge> NN% of <window>` with the account label on the right. */
export function statusLine(row: StatusRow, width: number): string {
	const ratio =
		row.contextTokens !== undefined && row.contextWindow ? Math.min(1, row.contextTokens / row.contextWindow) : 0;
	const filled = Math.round(ratio * GAUGE_CELLS);
	const gauge = `${theme.accent("━".repeat(filled))}${theme.border("━".repeat(GAUGE_CELLS - filled))}`;
	const window = row.contextWindow === undefined ? "?" : formatTokens(row.contextWindow);
	const where = row.branch === undefined ? row.cwd : `${row.cwd} (${row.branch})`;
	const left = `${theme.accent(`${row.model} · ${row.thinking}`)}${theme.muted(` · ${where} · ctx `)}${gauge}${theme.muted(` ${Math.round(ratio * 100)}% of ${window}`)}`;
	const right =
		row.account === undefined
			? ""
			: row.account.warn
				? theme.warning(row.account.text)
				: theme.muted(row.account.text);
	return spread(left, right, width);
}

/** A hint row: `<key> <label>` pairs joined by ` · `. */
export function hintLine(hints: readonly (readonly [keys: readonly string[], label: string])[]): string {
	return theme.muted(
		hints
			.filter(([keys]) => keys.length > 0)
			.map(([keys, label]) => `${keys.map(keyName).join("")} ${label}`)
			.join(" · "),
	);
}

/** A cost as `$0.00`, with more digits below a cent. */
export function formatCost(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** A token count as `950`, `12k`, `1.2M`. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

/** Elapsed time as `12s`, `3m05s`, `2h04m`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** `text` cut from the start to `width` columns, so a path keeps its file name. */
export function fitStart(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	while (chars.length > 0 && visibleWidth(chars.join("")) > width - 1) chars.shift();
	return `…${chars.join("")}`;
}
