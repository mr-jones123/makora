// Makora's one dark theme: the colors the TUI uses and the component themes built from them.
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/** A function that colors text. */
export type Paint = (text: string) => string;

function rgb(hex: string): Paint {
	const value = Number.parseInt(hex.slice(1), 16);
	const open = `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
	return (text) => `${open}${text}\x1b[39m`;
}

/** The theme's colors and text styles. */
export const theme = {
	accent: rgb("#7aa2f7"),
	muted: rgb("#8b93a7"),
	dim: rgb("#5c6370"),
	text: rgb("#c0caf5"),
	success: rgb("#9ece6a"),
	warning: rgb("#e0af68"),
	error: rgb("#f7768e"),
	/** The dharma wheel's gold on the splash. */
	brass: rgb("#c9b77e"),
	border: rgb("#3b4261"),
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	/** The selected row's band in lists. */
	band: (text: string) => `\x1b[48;2;36;40;59m${text}\x1b[49m`,
} as const;

/** Markdown styles for assistant text. */
export const markdownTheme: MarkdownTheme = {
	heading: (text) => theme.bold(theme.accent(text)),
	link: theme.accent,
	linkUrl: theme.dim,
	code: rgb("#bb9af7"),
	codeBlock: theme.text,
	codeBlockBorder: theme.border,
	quote: theme.muted,
	quoteBorder: theme.border,
	hr: theme.border,
	listBullet: theme.accent,
	bold: theme.bold,
	italic: theme.italic,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	underline: (text) => `\x1b[4m${text}\x1b[24m`,
};

/** Select list styles for selectors and autocomplete. */
export const selectListTheme: SelectListTheme = {
	selectedPrefix: theme.accent,
	selectedText: (text) => theme.bold(theme.accent(text)),
	description: theme.muted,
	scrollInfo: theme.dim,
	noMatch: theme.muted,
};

/** The editor's border and autocomplete styles. */
export const editorTheme: EditorTheme = { borderColor: theme.border, selectList: selectListTheme };
