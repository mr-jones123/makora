// The empty-transcript splash: the dharma wheel beside the MAKORA wordmark, or the wheel alone when narrow.
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./theme.ts";

// Rendered from the eight-spoked wheel (ring, hub, eight knobs) as braille dots, which are square in a terminal cell.
const WHEEL = [
	"             ⣠⣶⣶⣄",
	"             ⠹⢿⡿⠏",
	"    ⣴⣿⣷⡆      ⢸⡇      ⢰⣾⣿⣦",
	"    ⠹⠿⠿⣧⡀  ⣀⣤⣴⣾⣷⣦⣤⣀  ⢀⣼⠿⠿⠏",
	"       ⠈⢻⣶⡿⠋⠉ ⢸⡇ ⠉⠙⢿⣶⡟⠁",
	"       ⢠⡿⠋⠻⣦⡀ ⢸⡇ ⢀⣴⠟⠙⢿⡄",
	" ⣠⣄⡀  ⢀⣿⠃  ⠈⠻⣦⣸⣇⣴⠟⠁  ⠘⣿⡀  ⢀⣠⣄",
	"⢸⣿⣿⡷⠶⠶⢾⣿⠶⠶⠶⠶⠶⢾⣿⣿⡷⠶⠶⠶⠶⠶⣿⡷⠶⠶⢾⣿⣿⡇",
	" ⠙⠋⠁  ⠈⣿⡄  ⢀⣴⠟⢹⡏⠻⣦⡀  ⢠⣿⠁  ⠈⠙⠋",
	"       ⠘⣷⣄⣴⠟⠁ ⢸⡇ ⠈⠻⣦⣠⣾⠃",
	"       ⢀⣼⠿⣷⣄⣀ ⢸⡇ ⣀⣠⣾⠿⣧⡀",
	"    ⣰⣶⣶⡟⠁  ⠉⠛⠻⢿⡿⠟⠛⠉  ⠈⢻⣶⣶⣆",
	"    ⠻⣿⡿⠇      ⢸⡇      ⠸⢿⣿⠟",
	"             ⣰⣾⣷⣆",
	"             ⠙⠿⠿⠋",
];

const WORDMARK = [
	"███╗   ███╗ █████╗ ██╗  ██╗ ██████╗ ██████╗  █████╗",
	"████╗ ████║██╔══██╗██║ ██╔╝██╔═══██╗██╔══██╗██╔══██╗",
	"██╔████╔██║███████║█████╔╝ ██║   ██║██████╔╝███████║",
	"██║╚██╔╝██║██╔══██║██╔═██╗ ██║   ██║██╔══██╗██╔══██║",
	"██║ ╚═╝ ██║██║  ██║██║  ██╗╚██████╔╝██║  ██║██║  ██║",
	"╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
];

const TAGLINE = "a self-evolving harness for long-running work";
const WHEEL_WIDTH = Math.max(...WHEEL.map(visibleWidth));
const GAP = "    ";
/** Rows of the right column where the wordmark, the tagline and the hint start, aligned to the wheel's middle. */
const WORDMARK_ROW = 3;
const TAGLINE_ROW = 10;
const HINT_ROW = 12;
const NOTE_ROW = 14;

// The same wheel at 11 rows, for screens too short for the full one.
const COMPACT_WHEEL = [
	"         ⢠⣾⣷⡄",
	"   ⣠⣤⡀    ⢹⡏    ⢀⣤⣄",
	"   ⠻⠿⣧⡀ ⣀⣤⣼⣧⣤⣀ ⢀⣼⠿⠟",
	"     ⠈⣿⣿⡉ ⢸⡇ ⢉⣿⣿⠁",
	" ⣀   ⣼⠃⠈⠻⣦⣸⣇⣴⠟⠁⠘⣧   ⣀",
	"⢾⣿⡷⠶⠶⣿⠶⠶⠶⢾⣿⣿⡷⠶⠶⠶⣿⠶⠶⢾⣿⡷",
	" ⠉   ⢻⡄⢀⣴⠟⢹⡏⠻⣦⡀⢠⡟   ⠉",
	"     ⢀⣿⣿⣁ ⢸⡇ ⣈⣿⣿⡀",
	"   ⣴⣶⡟⠁ ⠉⠛⢻⡟⠛⠉ ⠈⢻⣶⣦",
	"   ⠙⠛⠁    ⣸⣇    ⠈⠛⠋",
	"         ⠘⢿⡿⠃",
];

/** Rows each splash needs; the layout picks the one that fits rather than cropping a wheel. */
export const SPLASH_HEIGHT = WHEEL.length;
export const COMPACT_SPLASH_HEIGHT = COMPACT_WHEEL.length;

/**
 * `full`: the wheel beside the wordmark, or the wheel alone when narrow; `note` is an optional warning under the hint.
 * `compact`: the small wheel alone.
 */
export type SplashVariant =
	| { readonly kind: "full"; readonly hint: () => string; readonly note: () => string | undefined }
	| { readonly kind: "compact" };

/** Draws a splash centered in the given width. */
export class Splash implements Component {
	readonly #variant: SplashVariant;

	constructor(variant: SplashVariant) {
		this.#variant = variant;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.#variant.kind === "compact") return centeredWheel(COMPACT_WHEEL, width);
		const hint = this.#variant.hint();
		const rightWidth = Math.max(...WORDMARK.map(visibleWidth), visibleWidth(TAGLINE), visibleWidth(hint));
		const sideBySide = WHEEL_WIDTH + GAP.length + rightWidth;
		// Wheel alone when the block does not fit (a zoomed-in or narrow terminal).
		if (width < sideBySide) return centeredWheel(WHEEL, width);
		const right: string[] = WHEEL.map(() => "");
		WORDMARK.forEach((line, index) => {
			right[WORDMARK_ROW + index] = theme.bold(theme.accent(line));
		});
		right[TAGLINE_ROW] = theme.muted(TAGLINE);
		right[HINT_ROW] = theme.dim(hint);
		const note = this.#variant.note();
		if (note !== undefined) right[NOTE_ROW] = theme.warning(truncateToWidth(note, rightWidth, "…"));
		const indent = " ".repeat(Math.floor((width - sideBySide) / 2));
		return WHEEL.map((line, index) => {
			const wheel = theme.brass(line) + " ".repeat(WHEEL_WIDTH - visibleWidth(line));
			return `${indent}${wheel}${GAP}${right[index]}`;
		});
	}
}

function centeredWheel(wheel: readonly string[], width: number): string[] {
	const indent = " ".repeat(Math.max(0, Math.floor((width - Math.max(...wheel.map(visibleWidth))) / 2)));
	return wheel.map((line) => indent + theme.brass(line));
}
