// The process-wide parts of makora shared by every session it opens: home paths, accounts, models, and settings.
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
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

/** Parse a `provider/modelId` reference, as `--model` and `meta.json` write it. */
export function parseModelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}
