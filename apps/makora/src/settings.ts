// User settings in `<home>/settings.json`: the default model, thinking level, and REPL snapshots. Read through getters
// at each use, so an edit by `/model`, `/thinking`, or another process applies without a restart.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";

/** The contents of `settings.json`. */
export interface MakoraSettings {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	/** Whether persistent sessions snapshot REPL variables after each cell; default true. */
	readonly snapshots?: boolean;
}

/** Live view of `settings.json`. */
export interface SettingsFile {
	readonly model: ModelRef | undefined;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	readonly snapshots: boolean;
	/** Write `change` over the current file; `undefined` fields stay as they are. */
	update(change: MakoraSettings): void;
	/** Harness run policy, read live from this file. */
	readonly harness: HarnessSettings;
}

/** A live view of the settings file at `file`; a missing or unreadable file reads as empty settings. */
export function openSettings(file: string): SettingsFile {
	let cached: { mtimeMs: number; value: MakoraSettings } | undefined;
	const current = (): MakoraSettings => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return {};
		}
		if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, value: parseSettings(readJson(file)) };
		return cached.value;
	};
	const harness: HarnessSettings = {
		retry: { maxRetries: 3 },
		compaction: { enabled: true },
		toolExecution: "parallel",
	};
	return {
		get model() {
			return current().model;
		},
		get thinkingLevel() {
			return current().thinkingLevel;
		},
		get snapshots() {
			return current().snapshots ?? true;
		},
		update(change) {
			const defined = Object.entries(change).filter(([, value]) => value !== undefined);
			const next = { ...current(), ...Object.fromEntries(defined) };
			const temporary = `${file}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`);
			renameSync(temporary, file);
			cached = undefined;
		},
		harness,
	};
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

// `settings.json` is user-edited: the trust boundary of settings.
function parseSettings(raw: unknown): MakoraSettings {
	if (typeof raw !== "object" || raw === null) return {};
	const { model, thinkingLevel, snapshots } = raw as Record<string, unknown>;
	const settings: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel; snapshots?: boolean } = {};
	if (typeof model === "object" && model !== null) {
		const { provider, modelId } = model as Record<string, unknown>;
		if (typeof provider === "string" && typeof modelId === "string") settings.model = { provider, modelId };
	}
	const level = MODEL_THINKING_LEVELS.find((candidate) => candidate === thinkingLevel);
	if (level !== undefined) settings.thinkingLevel = level;
	if (typeof snapshots === "boolean") settings.snapshots = snapshots;
	return settings;
}
