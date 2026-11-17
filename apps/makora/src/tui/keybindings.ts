// Makora's key bindings: its app actions merged over pi-tui's table, with the user's overrides from keybindings.json.
import { readFileSync } from "node:fs";
import {
	type KeybindingDefinitions,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

/** Makora's app actions; each description is the label the hint rows show. */
export const MAKORA_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape", description: "interrupt" },
	// Checked before `app.interrupt`: on another agent's conversation, the key goes back to the main one.
	"app.back": { defaultKeys: "escape", description: "back to main" },
	"app.exit": { defaultKeys: "ctrl+d", description: "exit" },
	"app.cancel": { defaultKeys: "ctrl+c", description: "cancel" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "expand cells" },
	"app.agents": { defaultKeys: "ctrl+a", description: "agents" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "model" },
	"app.diff": { defaultKeys: "ctrl+g", description: "diff" },
	// As in pi: Windows terminals take ctrl+v for their own paste, so alt+v is there too.
	"app.clipboard.pasteImage": {
		defaultKeys: process.platform === "win32" ? ["alt+v", "ctrl+v"] : "ctrl+v",
		description: "paste image",
	},
	// The agents dashboard's own keys; only that view reads them.
	"app.agents.diff": { defaultKeys: "d", description: "diff" },
	"app.agents.merge": { defaultKeys: "m", description: "merge" },
	"app.agents.stop": { defaultKeys: "s", description: "stop" },
	"app.agents.remove": { defaultKeys: "x", description: "remove" },
	// The diff view's own keys; only that view reads them, so they may share keys with the editor's.
	"app.diff.up": { defaultKeys: ["up", "k"], description: "up" },
	"app.diff.down": { defaultKeys: ["down", "j"], description: "down" },
	"app.diff.focusDiff": { defaultKeys: ["right", "enter"], description: "diff" },
	"app.diff.focusList": { defaultKeys: "left", description: "list" },
	"app.diff.pageUp": { defaultKeys: "pageUp", description: "page up" },
	"app.diff.pageDown": { defaultKeys: "pageDown", description: "page down" },
	"app.diff.nextHunk": { defaultKeys: "]", description: "next hunk" },
	"app.diff.previousHunk": { defaultKeys: "[", description: "previous hunk" },
	"app.diff.nextTab": { defaultKeys: "tab", description: "next tab" },
	"app.diff.previousTab": { defaultKeys: "shift+tab", description: "previous tab" },
	"app.diff.stage": { defaultKeys: "s", description: "stage" },
	"app.diff.unstage": { defaultKeys: "u", description: "unstage" },
	"app.diff.revert": { defaultKeys: "r", description: "revert" },
	"app.diff.split": { defaultKeys: "v", description: "side by side" },
	"app.diff.ask": { defaultKeys: "a", description: "ask" },
	"app.diff.close": { defaultKeys: "escape", description: "back" },
	// The /pstack picker's own keys; only the picker reads them. It moves, changes and closes with `tui.select.*`.
	"app.pstack.budget": { defaultKeys: "b", description: "budget" },
	"app.pstack.reset": { defaultKeys: "r", description: "reset defaults" },
	"app.pstack.previousSeat": { defaultKeys: "left", description: "previous seat" },
	"app.pstack.nextSeat": { defaultKeys: "right", description: "next seat" },
	"app.pstack.addSeat": { defaultKeys: "a", description: "add seat" },
	"app.pstack.removeSeat": { defaultKeys: "x", description: "remove seat" },
} as const satisfies KeybindingDefinitions;

export type MakoraKeybinding = keyof typeof MAKORA_KEYBINDINGS;
type MakoraBindings = { [K in MakoraKeybinding]: true };
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends MakoraBindings {}
}

/** pi-tui's table with makora's actions; ctrl+a belongs to the agents view, so line start keeps only `home`. */
export const KEYBINDINGS: KeybindingDefinitions = {
	...TUI_KEYBINDINGS,
	"tui.editor.cursorLineStart": { ...TUI_KEYBINDINGS["tui.editor.cursorLineStart"], defaultKeys: "home" },
	...MAKORA_KEYBINDINGS,
};

/** Install the global key bindings with the user's overrides from `file`; returns the manager. */
export function installKeybindings(file: string): KeybindingsManager {
	const manager = new KeybindingsManager(KEYBINDINGS, readUserBindings(file));
	setKeybindings(manager);
	return manager;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
	escape: "esc",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	enter: "enter",
	return: "enter",
	pageUp: "PgUp",
	pageDown: "PgDn",
};

/** How a key is shown in a hint: `esc`, `ctrl+o`, `↑`. */
export function keyName(key: string): string {
	return KEY_NAMES[key] ?? key;
}

// keybindings.json is user-edited: the trust boundary of key bindings. Malformed entries are skipped.
function readUserBindings(file: string): KeybindingsConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const config: KeybindingsConfig = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		const keys = Array.isArray(value) ? value : [value];
		if (!keys.every((key): key is string => typeof key === "string")) continue;
		// A key id the parser does not know never matches; that is the user's typo to see, not a crash.
		config[id] = keys as KeyId[];
	}
	return config;
}
