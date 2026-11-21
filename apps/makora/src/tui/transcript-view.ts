// The transcript component: draws the feed's rows, with one fixed summary line per tool call unless cells are expanded.
import { type Component, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ToolCell, type ToolTone, toolSummary } from "../tool-cell.ts";
import type { FeedRow } from "./session-feed.ts";
import { markdownTheme, type Paint, theme } from "./theme.ts";

/** What the transcript draws; read at each render. */
export interface TranscriptSource {
	readonly rows: readonly FeedRow[];
	readonly hasEarlier: boolean;
	readonly expanded: boolean;
	/** Animation frame of running markers. */
	readonly frame: number;
}

const OUTPUT_TAIL_LINES = 20;

const TONES: Readonly<Record<ToolTone, Paint>> = {
	success: theme.success,
	error: theme.error,
	running: theme.accent,
	pending: theme.muted,
};

/** Renders the rows of a `TranscriptSource`; Markdown components are kept per row so streaming re-renders little. */
export class TranscriptView implements Component {
	readonly #source: () => TranscriptSource;
	#markdown = new Map<string, Markdown>();
	/** Lines of the last render, so a load of earlier entries can keep the viewport where it was. */
	lastHeight = 0;

	constructor(source: () => TranscriptSource) {
		this.#source = source;
	}

	invalidate(): void {
		for (const markdown of this.#markdown.values()) markdown.invalidate();
	}

	render(width: number): string[] {
		const { rows, hasEarlier, expanded, frame } = this.#source();
		const now = Date.now();
		const lines: string[] = [];
		if (hasEarlier)
			lines.push(theme.dim(truncateToWidth("  ↑ earlier messages load when you scroll to the top", width)));
		const used = new Map<string, Markdown>();
		let previous: FeedRow["kind"] | undefined;
		for (const row of rows) {
			if (previous !== undefined && !(row.kind === "tool" && (previous === "tool" || previous === "thinking"))) {
				lines.push("");
			}
			previous = row.kind;
			switch (row.kind) {
				case "user":
					lines.push(...prefixed(theme.accent("› "), "  ", userText(row.text, row.images), width, (line) => line));
					break;
				case "assistant": {
					const markdown = this.#markdown.get(row.key) ?? new Markdown("", 0, 0, markdownTheme);
					markdown.setText(row.text);
					used.set(row.key, markdown);
					lines.push(...markdown.render(width));
					break;
				}
				case "thinking":
					if (expanded) lines.push(...prefixed(theme.dim("∴ "), "  ", row.text, width, theme.muted));
					else {
						const first = row.text.trim().split("\n")[0] ?? "";
						lines.push(theme.muted(truncateToWidth(`∴ thinking · ${first}`, width, "…")));
					}
					break;
				case "tool": {
					const summary = toolSummary(row.cell, width, now, frame);
					lines.push(`${TONES[summary.tone](summary.marker)} ${theme.text(summary.text)}`);
					if (expanded) lines.push(...expandedCell(row.cell, width, now, frame));
					break;
				}
				case "agent": {
					lines.push(truncateToWidth(`${theme.accent("↩ ")}${theme.bold(theme.text(row.title))}`, width, "…"));
					const text = row.text.split("\n");
					const shown = expanded ? text : text.slice(0, AGENT_LINES);
					lines.push(...prefixed("  ", "  ", shown.join("\n"), width, theme.muted));
					if (shown.length < text.length) lines.push(theme.dim(`  … ${text.length - shown.length} more lines`));
					break;
				}
				case "notice":
					lines.push(...warningBox(row.message, width));
					break;
				case "info":
					lines.push(...prefixed(theme.muted("· "), "  ", row.message, width, theme.muted));
					break;
				case "queued":
					lines.push(...prefixed(theme.muted("› "), "  ", `${row.text} (${row.mode === "steer" ? "steering" : "queued"})`, width, theme.muted));
					break;
			}
		}
		this.#markdown = used;
		this.lastHeight = lines.length;
		return lines;
	}
}

/** Lines of an agent's result or message shown before the transcript is expanded. */
const AGENT_LINES = 6;

function prefixed(first: string, rest: string, text: string, width: number, paint: Paint): string[] {
	const inner = Math.max(1, width - visibleWidth(first));
	return wrapTextWithAnsi(text, inner).map((line, index) => `${index === 0 ? first : rest}${paint(line)}`);
}

const IMAGE_TOKEN = /\[image #(\d+)\]/g;

/**
 * A user message's text, with each `[image #N]` naming one of its images muted as `[image #N · png · 1280×800]`;
 * images no token names follow on a line of their own.
 */
function userText(text: string, images: readonly string[]): string {
	const named = new Set<number>();
	const label = (n: number) => theme.muted(`[image #${n} · ${images[n - 1]}]`);
	// Painted line by line, so each wrapped line starts in its color.
	const painted = text.split("\n").map((line) => {
		let out = "";
		let from = 0;
		for (const match of line.matchAll(IMAGE_TOKEN)) {
			const n = Number(match[1]);
			if (images[n - 1] === undefined) continue;
			named.add(n);
			out += theme.text(line.slice(from, match.index)) + label(n);
			from = match.index + match[0].length;
		}
		return out + theme.text(line.slice(from));
	});
	const unnamed = images.flatMap((_, index) => (named.has(index + 1) ? [] : [label(index + 1)]));
	return [...painted, ...(unnamed.length === 0 ? [] : [unnamed.join(" ")])].join("\n");
}

// A python cell shows its code where other calls show their arguments, and the calls it made after its output.
function expandedCell(cell: ToolCell, width: number, now: number, frame: number): string[] {
	const { args, output } = cell;
	const source = cell.name === "python" && typeof args.code === "string" ? args.code : JSON.stringify(args, null, 2);
	const lines = source
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 4)))
		.map((line) => `  ${theme.dim("│")} ${theme.muted(line)}`);
	const tail = (output ?? "").replace(/\s+$/, "").split("\n");
	if (tail.length > 0 && tail[0] !== "") {
		const shown = tail.slice(-OUTPUT_TAIL_LINES);
		if (tail.length > shown.length) lines.push(`  ${theme.dim(`┆ … ${tail.length - shown.length} earlier lines`)}`);
		for (const line of shown) lines.push(`  ${theme.dim("┆")} ${truncateToWidth(line, Math.max(1, width - 4), "…")}`);
	}
	for (const nested of cell.nested ?? []) {
		const summary = toolSummary(nested, Math.max(1, width - 4), now, frame);
		lines.push(`  ${theme.dim("↳")} ${TONES[summary.tone](summary.marker)} ${theme.muted(summary.text)}`);
	}
	return lines;
}

function warningBox(message: string, width: number): string[] {
	const inner = Math.max(1, width - 4);
	const body = wrapTextWithAnsi(`⚠ ${message}`, inner).map(
		(line) =>
			`${theme.warning("│")} ${theme.warning(line)}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${theme.warning("│")}`,
	);
	const rule = "─".repeat(Math.max(0, width - 2));
	return [theme.warning(`╭${rule}╮`), ...body, theme.warning(`╰${rule}╯`)];
}
