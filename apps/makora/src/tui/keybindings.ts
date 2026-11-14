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
	"app.exit": { defaultKeys: "ctrl+d", description: "exit" },
	"app.cancel": { defaultKeys: "ctrl+c", description: "cancel" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "expand cells" },
	"app.agents": { defaultKeys: "ctrl+a", description: "agents" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "model" },
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
