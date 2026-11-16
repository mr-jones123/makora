// The process-wide parts of makora shared by every session it opens: home paths, accounts, models, and settings.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { WorktreeRoots } from "./agents/worktree.ts";
import { openAuthStore } from "./auth/store.ts";
import type { AuthStore } from "./auth/types.ts";
import { createMakoraModels, FAKE_MODEL } from "./models.ts";
import { type HomePaths, homePaths } from "./paths.ts";
import { openSettings, type SettingsFile } from "./settings.ts";

/** One makora process's shared state. */
export interface MakoraApp {
	readonly paths: HomePaths;
	readonly auth: AuthStore;
	readonly models: MutableModels;
	readonly settings: SettingsFile;
	readonly fake: boolean;
}

/** Open makora's shared state for `home`; `fake` adds the scripted fake provider and makes it the default model. */
export function openApp(home: string, fake: boolean): MakoraApp {
	const paths = homePaths(home);
	const auth = openAuthStore(paths.auth);
	return { paths, auth, models: createMakoraModels(auth, fake), settings: openSettings(paths.settings), fake };
}

/** Where subagent worktrees go, read from the settings at each call: the temp folder and `<home>/worktrees` by default. */
export function agentRoots(app: MakoraApp): WorktreeRoots {
	return {
		review: app.settings.worktrees.review ?? join(tmpdir(), "makora-worktrees"),
		write: app.settings.worktrees.write ?? app.paths.worktrees,
	};
}

/** Every folder makora puts worktrees under: the subagent roots, and `<home>/worktrees` for forks. */
export function worktreeRoots(app: MakoraApp): string[] {
	const { review, write } = agentRoots(app);
	return [...new Set([review, write, app.paths.worktrees])];
}

/**
 * The model a new conversation starts with: the fake model in fake mode, else the settings' model, else the first
 * model of a provider with credentials, Anthropic first. Undefined when no provider has credentials.
 */
export async function defaultModel(app: MakoraApp): Promise<ModelRef | undefined> {
	if (app.fake) return FAKE_MODEL;
	if (app.settings.model !== undefined) return app.settings.model;
	const available = await app.models.getAvailable();
	const model = available.find((candidate) => candidate.provider === "anthropic") ?? available[0];
	return model === undefined ? undefined : { provider: model.provider, modelId: model.id };
}
