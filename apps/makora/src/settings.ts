// User settings in `<home>/settings.json`: the default model, thinking level, REPL snapshots, subagent worktrees and
// limits, the worktree setup commands the user approved, the pstack model roles, and memory's vault, embeddings and dream
// budget. Read through getters at each use, so an edit by `/model`, `/thinking`, `/pstack`, `/wiki-setup`, or another
// process applies without a restart.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import { DEFAULT_EMBED, type EmbedConfig } from "./memory/embed.ts";
import { DEFAULT_WIKI_FOLDER, folderProblem } from "./memory/wiki-setup.ts";
import { type PstackConfig, type PstackSettings, parsePstack, pstackConfig, pstackSettings } from "./pstack.ts";

/** The contents of `settings.json`. */
export interface MakoraSettings {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	/** The model that names sessions; default the one the conversation runs on. */
	readonly titleModel?: ModelRef;
	/** Whether persistent sessions snapshot REPL variables after each cell; default true. */
	readonly snapshots?: boolean;
	/** Where subagent worktrees go; defaults are the temp folder (review) and `<home>/worktrees` (write). */
	readonly worktrees?: { readonly review?: string; readonly write?: string };
	readonly agents?: {
		/** Children running at once per session; further ones queue. Default 4. */
		readonly maxRunning?: number;
		/** How long a repository's worktree setup command may run before it is killed. Default 10. */
		readonly setupTimeoutMinutes?: number;
		/** The worktree setup commands the user let run, each for one repository. */
		readonly approvedSetups?: readonly SetupApproval[];
	};
	/** The pstack tiers, budget and roles that differ from the defaults. */
	readonly pstack?: PstackSettings;
	/** Memory: the wiki's vault and folder, embeddings, and the dream budget. */
	readonly memory?: MemorySettings;
}

/** The `memory` block of `settings.json`. */
export interface MemorySettings {
	/** The Obsidian vault `/wiki` renders into, set by `/wiki-setup`. */
	readonly vault?: string;
	/** The folder of the vault makora owns; default `makora`. */
	readonly folder?: string;
	/** Ollama's base URL; default `http://127.0.0.1:11434`. */
	readonly ollamaUrl?: string;
	/** The Ollama embedding model; default `embeddinggemma`. */
	readonly embedModel?: string;
	/** What one dream may spend, in US dollars; default 2. */
	readonly dreamBudgetUsd?: number;
}

/** The memory choices in effect, defaults filled in. */
export interface MemoryConfig {
	readonly vault: string | undefined;
	readonly folder: string;
	readonly embed: EmbedConfig;
	readonly dreamBudgetUsd: number;
}

/** A repository's worktree setup command the user approved: the repository's top level and the command's SHA-256. */
export type SetupApproval = { readonly repository: string; readonly sha256: string };

/** Live view of `settings.json`. */
export interface SettingsFile {
	readonly model: ModelRef | undefined;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	readonly titleModel: ModelRef | undefined;
	readonly snapshots: boolean;
	readonly worktrees: { readonly review?: string; readonly write?: string };
	readonly maxRunningAgents: number;
	readonly setupTimeoutMinutes: number;
	/** The pstack choices in effect, defaults filled in. */
	readonly pstack: PstackConfig;
	/** The memory choices in effect, defaults filled in. */
	readonly memory: MemoryConfig;
	/** What parsing the file dropped, one message each; empty when nothing was. */
	readonly warnings: readonly string[];
	/** Whether the user approved `approval`'s command for its repository. */
	setupApproved(approval: SetupApproval): boolean;
	/** Write `change` over the current file; `undefined` fields stay as they are. */
	update(change: MakoraSettings): void;
	/** Add `approval` to the approved setup commands, unless it is there. */
	approveSetup(approval: SetupApproval): void;
	/** Store `config` as the pstack choices: what differs from the defaults, or no `pstack` field when nothing does. */
	setPstack(config: PstackConfig): void;
	/** Write `change` over the memory block; `undefined` fields stay as they are. */
	setMemory(change: MemorySettings): void;
	/** Harness run policy, read live from this file. */
	readonly harness: HarnessSettings;
}

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_DREAM_BUDGET_USD = 2;
const DEFAULT_SETUP_TIMEOUT_MINUTES = 10;

/** A live view of the settings file at `file`; a missing or unreadable file reads as empty settings. */
export function openSettings(file: string): SettingsFile {
	let cached: ({ mtimeMs: number } & ParsedSettings) | undefined;
	const parsed = (): ParsedSettings => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return { value: {}, warnings: [] };
		}
		if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, ...parseSettings(readJson(file)) };
		return cached;
	};
	const current = (): MakoraSettings => parsed().value;
	const harness: HarnessSettings = {
		retry: { maxRetries: 3 },
		compaction: { enabled: true },
		toolExecution: "parallel",
	};
	const write = (next: MakoraSettings): void => {
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`);
		renameSync(temporary, file);
		cached = undefined;
	};
	const update = (change: MakoraSettings): void => {
		const defined = Object.entries(change).filter(([, value]) => value !== undefined);
		write({ ...current(), ...Object.fromEntries(defined) });
	};
	const setupApproved = ({ repository, sha256 }: SetupApproval): boolean =>
		(current().agents?.approvedSetups ?? []).some((each) => each.repository === repository && each.sha256 === sha256);
	return {
		get model() {
			return current().model;
		},
		get thinkingLevel() {
			return current().thinkingLevel;
		},
		get titleModel() {
			return current().titleModel;
		},
		get snapshots() {
			return current().snapshots ?? true;
		},
		get worktrees() {
			return current().worktrees ?? {};
		},
		get maxRunningAgents() {
			return current().agents?.maxRunning ?? DEFAULT_MAX_RUNNING;
		},
		get setupTimeoutMinutes() {
			return current().agents?.setupTimeoutMinutes ?? DEFAULT_SETUP_TIMEOUT_MINUTES;
		},
		get pstack() {
			return pstackConfig(current().pstack);
		},
		get memory() {
			const memory = current().memory ?? {};
			return {
				vault: memory.vault,
				folder: memory.folder ?? DEFAULT_WIKI_FOLDER,
				embed: { url: memory.ollamaUrl ?? DEFAULT_EMBED.url, model: memory.embedModel ?? DEFAULT_EMBED.model },
				dreamBudgetUsd: memory.dreamBudgetUsd ?? DEFAULT_DREAM_BUDGET_USD,
			};
		},
		get warnings() {
			return parsed().warnings;
		},
		setupApproved,
		update,
		approveSetup(approval) {
			if (setupApproved(approval)) return;
			const agents = current().agents;
			update({ agents: { ...agents, approvedSetups: [...(agents?.approvedSetups ?? []), approval] } });
		},
		setPstack(config) {
			const { pstack: _, ...rest } = current();
			const pstack = pstackSettings(config);
			write(pstack === undefined ? rest : { ...rest, pstack });
		},
		setMemory(change) {
			const defined = Object.entries(change).filter(([, value]) => value !== undefined);
			update({ memory: { ...current().memory, ...Object.fromEntries(defined) } });
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

/** The settings read from the file, and what parsing dropped. */
type ParsedSettings = { readonly value: MakoraSettings; readonly warnings: readonly string[] };

// `settings.json` is user-edited: the trust boundary of settings.
function parseSettings(raw: unknown): ParsedSettings {
	if (typeof raw !== "object" || raw === null) return { value: {}, warnings: [] };
	const { model, thinkingLevel, titleModel, snapshots, worktrees, agents, pstack, memory } = raw as Record<
		string,
		unknown
	>;
	const settings: {
		-readonly [Key in keyof MakoraSettings]: MakoraSettings[Key];
	} = {};
	for (const key of ["model", "titleModel"] as const) {
		const ref = key === "model" ? model : titleModel;
		if (typeof ref !== "object" || ref === null) continue;
		const { provider, modelId } = ref as Record<string, unknown>;
		if (typeof provider === "string" && typeof modelId === "string") settings[key] = { provider, modelId };
	}
	const level = MODEL_THINKING_LEVELS.find((candidate) => candidate === thinkingLevel);
	if (level !== undefined) settings.thinkingLevel = level;
	if (typeof snapshots === "boolean") settings.snapshots = snapshots;
	if (typeof worktrees === "object" && worktrees !== null) {
		const { review, write } = worktrees as Record<string, unknown>;
		settings.worktrees = {
			...(typeof review === "string" ? { review } : {}),
			...(typeof write === "string" ? { write } : {}),
		};
	}
	if (typeof agents === "object" && agents !== null) settings.agents = parseAgents(agents as Record<string, unknown>);
	if (typeof memory === "object" && memory !== null) settings.memory = parseMemory(memory as Record<string, unknown>);
	if (pstack === undefined) return { value: settings, warnings: [] };
	const parsedPstack = parsePstack(pstack);
	settings.pstack = parsedPstack.settings;
	return { value: settings, warnings: parsedPstack.warnings };
}

function parseMemory(raw: Record<string, unknown>): MemorySettings {
	const { vault, folder, ollamaUrl, embedModel, dreamBudgetUsd } = raw;
	const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
	return {
		...(text(vault) === undefined ? {} : { vault: text(vault) }),
		...(text(folder) === undefined || folderProblem(folder as string) !== undefined
			? {}
			: { folder: folder as string }),
		...(text(ollamaUrl) === undefined ? {} : { ollamaUrl: text(ollamaUrl) }),
		...(text(embedModel) === undefined ? {} : { embedModel: text(embedModel) }),
		...(typeof dreamBudgetUsd === "number" && dreamBudgetUsd > 0 ? { dreamBudgetUsd } : {}),
	};
}

function parseAgents(raw: Record<string, unknown>): NonNullable<MakoraSettings["agents"]> {
	const { maxRunning, setupTimeoutMinutes, approvedSetups } = raw;
	const approved = Array.isArray(approvedSetups)
		? approvedSetups.flatMap((each: unknown) => {
				if (typeof each !== "object" || each === null) return [];
				const { repository, sha256 } = each as Record<string, unknown>;
				return typeof repository === "string" && typeof sha256 === "string" ? [{ repository, sha256 }] : [];
			})
		: [];
	return {
		...(typeof maxRunning === "number" && Number.isInteger(maxRunning) && maxRunning >= 1 ? { maxRunning } : {}),
		...(typeof setupTimeoutMinutes === "number" && setupTimeoutMinutes > 0 ? { setupTimeoutMinutes } : {}),
		...(approved.length === 0 ? {} : { approvedSetups: approved }),
	};
}
