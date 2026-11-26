// pstack model roles: the code and judge tiers, the roles pstack's skills name with where each runs (a tier, the
// session model, or a model of its own), the `pstack` block of `settings.json`, budgets, what a spawn's `model=` runs
// on, and the role lines of the prompt.
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseModelRef } from "./models.ts";

/** The two model tiers pstack roles run on. */
export const TIERS = ["code", "judge"] as const;
export type Tier = (typeof TIERS)[number];

/** A model with its thinking level: a tier's chosen model, or a seat of a role on a model of its own. */
export type ModelSeat = { readonly model: ModelRef; readonly thinking: ModelThinkingLevel };

/** A seat named by a word: a tier, or the session model. */
export type NamedSeat = Tier | "session";

/** Where one seat of a role runs: a tier, the session model (`spawn` without `model=`), or a model of its own. */
export type Seat = NamedSeat | ModelSeat;

/** The named seats in the order the picker cycles them. */
export const SEATS: readonly NamedSeat[] = ["code", "judge", "session"];

/** A tier's model: the session model, or a model with its thinking level. */
export type TierModel = "session" | ModelSeat;

/** setup-pstack's budgets, each with the thinking level it gives both tiers and every model seat. */
export const BUDGETS = {
	unlimited: "max",
	large: "xhigh",
	medium: "high",
	small: "medium",
} as const satisfies Record<string, ModelThinkingLevel>;
export type Budget = keyof typeof BUDGETS;

/** One pstack role, by the label setup-pstack and poteto-mode give it, with its default seats. */
export type PstackRole = {
	readonly label: string;
	/** A panel runs one subagent per seat, so its seat list may grow or shrink; a single role has one seat. */
	readonly kind: "single" | "panel";
	readonly seats: readonly Seat[];
};

// setup-pstack's role list: its grok defaults are the code tier, its Claude defaults the judge tier, and its
// two-family panels one seat of each.
export const PSTACK_ROLES = [
	{ label: "feature, refactoring", kind: "single", seats: ["code"] },
	{ label: "bug-fix", kind: "single", seats: ["code"] },
	{ label: "perf-issue", kind: "single", seats: ["code"] },
	{ label: "hillclimb", kind: "single", seats: ["code"] },
	{ label: "judgment and prose", kind: "single", seats: ["judge"] },
	{ label: "hardest tasks", kind: "single", seats: ["judge"] },
	{ label: "how explorer", kind: "single", seats: ["code"] },
	{ label: "how explainer", kind: "single", seats: ["judge"] },
	{ label: "why investigators", kind: "single", seats: ["code"] },
	{ label: "why synthesizer", kind: "single", seats: ["judge"] },
	{ label: "reflect tooling", kind: "single", seats: ["code"] },
	{ label: "reflect judgment, divergent, synthesizer", kind: "single", seats: ["judge"] },
	{ label: "arena runners", kind: "panel", seats: ["judge", "code"] },
	{ label: "arena cross-judge pool", kind: "panel", seats: ["judge", "code"] },
	{ label: "swarm workers", kind: "single", seats: ["code"] },
	{ label: "architect runners", kind: "panel", seats: ["judge", "code"] },
	{ label: "interrogate reviewers", kind: "panel", seats: ["judge", "code"] },
] as const satisfies readonly PstackRole[];

/** One role of `PSTACK_ROLES`, its label typed. */
export type KnownRole = (typeof PSTACK_ROLES)[number];
export type RoleLabel = KnownRole["label"];

/** The pstack choices in effect: both tiers and every role, defaults filled in. */
export type PstackConfig = {
	readonly budget: Budget;
	readonly models: Readonly<Record<Tier, TierModel>>;
	/** Each role's seats; a single role's list has one seat. */
	readonly roles: Readonly<Record<RoleLabel, readonly Seat[]>>;
};

/** A model seat as `settings.json` stores it: the model as `provider/modelId` and its thinking level. */
export type StoredModelSeat = { readonly model: string; readonly thinking: ModelThinkingLevel };

/** A tier's model as `settings.json` stores it: `"session"`, or a stored model seat. */
export type StoredTierModel = "session" | StoredModelSeat;

/** A role's seat as `settings.json` stores it. */
export type StoredSeat = NamedSeat | StoredModelSeat;

/** The `pstack` block of `settings.json`: only what differs from the defaults. */
export type PstackSettings = {
	readonly budget?: Budget;
	readonly models?: Readonly<Partial<Record<Tier, StoredTierModel>>>;
	readonly roles?: Readonly<Partial<Record<RoleLabel, StoredSeat | readonly StoredSeat[]>>>;
};

/** `settings` over the defaults: both tiers on the session model, every role on its pstack default, budget large. */
export function pstackConfig(settings: PstackSettings | undefined): PstackConfig {
	const tier = (stored: StoredTierModel | undefined): TierModel =>
		stored === undefined || stored === "session" ? "session" : loadModelSeat(stored);
	return {
		budget: settings?.budget ?? "large",
		models: { code: tier(settings?.models?.code), judge: tier(settings?.models?.judge) },
		roles: mapRoles((role) => {
			const stored = settings?.roles?.[role.label];
			if (stored === undefined) return role.seats;
			return (Array.isArray(stored) ? stored : [stored]).map(loadSeat);
		}),
	};
}

function mapRoles(seats: (role: KnownRole) => readonly Seat[]): Record<RoleLabel, readonly Seat[]> {
	const roles: Partial<Record<RoleLabel, readonly Seat[]>> = {};
	for (const role of PSTACK_ROLES) roles[role.label] = seats(role);
	// The loop set every role of PSTACK_ROLES.
	return roles as Record<RoleLabel, readonly Seat[]>;
}

function loadSeat(stored: StoredSeat): Seat {
	return typeof stored === "string" ? stored : loadModelSeat(stored);
}

function loadModelSeat(stored: StoredModelSeat): ModelSeat {
	// `parsePstack` let only `provider/modelId` models through.
	return { model: parseModelRef(stored.model)!, thinking: stored.thinking };
}

/** What `config` changes from the defaults, as `settings.json` stores it; undefined when nothing differs. */
export function pstackSettings(config: PstackConfig): PstackSettings | undefined {
	const models = Object.fromEntries(
		TIERS.flatMap((tier) => {
			const chosen = config.models[tier];
			return chosen === "session" ? [] : [[tier, storeSeat(chosen)]];
		}),
	);
	const roles = Object.fromEntries(
		PSTACK_ROLES.flatMap((role) => {
			const seats = config.roles[role.label].map(storeSeat);
			if (seats.length === role.seats.length && seats.every((seat, index) => seat === role.seats[index])) return [];
			return [[role.label, role.kind === "single" ? seats[0]! : seats]];
		}),
	);
	const settings: PstackSettings = {
		...(config.budget === "large" ? {} : { budget: config.budget }),
		...(Object.keys(models).length === 0 ? {} : { models }),
		...(Object.keys(roles).length === 0 ? {} : { roles }),
	};
	return Object.keys(settings).length === 0 ? undefined : settings;
}

function storeSeat(seat: Seat): StoredSeat {
	return typeof seat === "string" ? seat : { model: modelName(seat.model), thinking: seat.thinking };
}

/** `model` as `provider/modelId`. */
export function modelName(model: ModelRef): string {
	return `${model.provider}/${model.modelId}`;
}

/** The parsed `pstack` block and a warning for each part of it that was dropped. */
export type ParsedPstack = { readonly settings: PstackSettings; readonly warnings: readonly string[] };

// `settings.json` is user-edited: the trust boundary of the pstack block.
/** Parse the `pstack` block of `settings.json`; unknown roles and malformed values are dropped with a warning. */
export function parsePstack(raw: unknown): ParsedPstack {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(`settings.json: ${message}`);
	if (!isObject(raw)) {
		warn('"pstack" is not an object; using the pstack defaults');
		return { settings: {}, warnings };
	}
	const { budget, models = {}, roles = {} } = raw;
	const parsedBudget = Object.keys(BUDGETS).find((each): each is Budget => each === budget);
	if (budget !== undefined && parsedBudget === undefined) {
		warn(`pstack.budget ${JSON.stringify(budget)} is not one of ${Object.keys(BUDGETS).join(", ")}; using large`);
	}
	const parsedModels: Partial<Record<Tier, StoredTierModel>> = {};
	if (!isObject(models)) warn("pstack.models is not an object; both tiers use the session model");
	for (const [key, value] of Object.entries(isObject(models) ? models : {})) {
		const tier = TIERS.find((each) => each === key);
		const parsed = parseTierModel(value);
		if (tier === undefined) warn(`pstack.models.${key} is not a tier (code, judge); dropped`);
		else if (parsed === undefined)
			warn(`pstack.models.${key} is not "session" or { "model": "provider/id", "thinking": "<level>" }; dropped`);
		else parsedModels[tier] = parsed;
	}
	const parsedRoles: Partial<Record<RoleLabel, StoredSeat | readonly StoredSeat[]>> = {};
	if (!isObject(roles)) warn("pstack.roles is not an object; every role uses its default");
	for (const [label, value] of Object.entries(isObject(roles) ? roles : {})) {
		const role: KnownRole | undefined = PSTACK_ROLES.find((each) => each.label === label);
		const seats = role === undefined ? undefined : parseSeats(value, role.kind);
		if (role === undefined) warn(`pstack.roles has an unknown role ${JSON.stringify(label)}; dropped`);
		else if (seats === undefined)
			warn(
				`pstack.roles[${JSON.stringify(label)}] is not ${role.kind === "panel" ? "a list of" : "one of"} code, judge, session, { "model": "provider/id", "thinking": "<level>" }; using its default`,
			);
		else parsedRoles[role.label] = seats;
	}
	return {
		settings: {
			...(parsedBudget === undefined ? {} : { budget: parsedBudget }),
			...(Object.keys(parsedModels).length === 0 ? {} : { models: parsedModels }),
			...(Object.keys(parsedRoles).length === 0 ? {} : { roles: parsedRoles }),
		},
		warnings,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTierModel(value: unknown): StoredTierModel | undefined {
	return value === "session" ? "session" : parseModelSeat(value);
}

function parseModelSeat(value: unknown): StoredModelSeat | undefined {
	if (!isObject(value)) return undefined;
	const { model } = value;
	const thinking = MODEL_THINKING_LEVELS.find((each) => each === value.thinking);
	if (typeof model !== "string" || parseModelRef(model) === undefined || thinking === undefined) return undefined;
	return { model, thinking };
}

// A panel takes a non-empty list, or one seat as a one-seat panel; a single role takes one seat.
function parseSeats(value: unknown, kind: PstackRole["kind"]): StoredSeat | readonly StoredSeat[] | undefined {
	const seat = (each: unknown): StoredSeat | undefined =>
		SEATS.find((candidate) => candidate === each) ?? parseModelSeat(each);
	if (!Array.isArray(value)) return seat(value);
	if (kind === "single" || value.length === 0) return undefined;
	const seats = value.map(seat);
	return seats.every((each) => each !== undefined) ? seats : undefined;
}

/** The thinking level of `model` nearest `target` from below: the highest it supports up to `target`, else its lowest. */
export function clampThinking(model: Model<Api>, target: ModelThinkingLevel): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	const ceiling = MODEL_THINKING_LEVELS.indexOf(target);
	return supported.findLast((level) => MODEL_THINKING_LEVELS.indexOf(level) <= ceiling) ?? supported[0] ?? "off";
}

/**
 * `config` on `budget`: each tier with a model and each model seat gets the budget's thinking level, clamped to what its
 * model supports.
 */
export function applyBudget(
	config: PstackConfig,
	budget: Budget,
	lookup: (model: ModelRef) => Model<Api> | undefined,
): PstackConfig {
	const level = BUDGETS[budget];
	const budgeted = (current: ModelSeat): ModelSeat => {
		const model = lookup(current.model);
		return { ...current, thinking: model === undefined ? level : clampThinking(model, level) };
	};
	const tier = (current: TierModel): TierModel => (current === "session" ? current : budgeted(current));
	const seat = (current: Seat): Seat => (typeof current === "string" ? current : budgeted(current));
	return {
		budget,
		models: { code: tier(config.models.code), judge: tier(config.models.judge) },
		roles: mapRoles((role) => config.roles[role.label].map(seat)),
	};
}

/** What a spawn's `model` argument runs the child on. */
export type SpawnModel =
	/** A copy of the parent's model and thinking level; `notice` says why a tier fell back to it. */
	| { readonly kind: "parent"; readonly notice?: string }
	| { readonly kind: "model"; readonly model: ModelRef; readonly thinkingLevel?: ModelThinkingLevel }
	| { readonly kind: "refused"; readonly reason: string };

/** How `spawnModel` checks a model. */
export interface ModelLookup {
	/** Whether the model catalog has `model`. */
	exists(model: ModelRef): boolean;
	/** Whether a provider with credentials serves `model`. */
	usable(model: ModelRef): boolean;
}

/**
 * The model of a spawn given `model`: `"code"` and `"judge"` are their tier's model and thinking level, or the parent's
 * when the tier is the session model or its model has no credentials; `provider/modelId` is that model, with the
 * thinking level of the first model seat on it (in role order) and the parent's model when that seat's model has no
 * credentials.
 */
export function spawnModel(arg: string | undefined, config: PstackConfig, models: ModelLookup): SpawnModel {
	if (arg === undefined) return { kind: "parent" };
	const tier = TIERS.find((each) => each === arg);
	if (tier !== undefined) {
		const chosen = config.models[tier];
		return chosen === "session" ? { kind: "parent" } : chosenModel(chosen, `the ${tier} tier`, "tier", models);
	}
	if (!arg.includes("/")) {
		return { kind: "refused", reason: `Unknown model alias ${arg}: use "code", "judge" or provider/modelId` };
	}
	const model = parseModelRef(arg);
	if (model === undefined) return { kind: "refused", reason: `Bad model ${arg}: use provider/modelId` };
	if (!models.exists(model)) return { kind: "refused", reason: `Unknown model ${arg}` };
	const seat = modelSeats(config).find((each) => modelName(each.model) === arg);
	return seat === undefined ? { kind: "model", model } : chosenModel(seat, "a pstack role seat", "role", models);
}

/** Every model seat of `config`'s roles, in role order. */
function modelSeats(config: PstackConfig): readonly ModelSeat[] {
	return PSTACK_ROLES.flatMap((role) => config.roles[role.label].filter((seat) => typeof seat !== "string"));
}

function chosenModel(chosen: ModelSeat, owner: string, what: "tier" | "role", models: ModelLookup): SpawnModel {
	if (models.usable(chosen.model)) return { kind: "model", model: chosen.model, thinkingLevel: chosen.thinking };
	return {
		kind: "parent",
		notice: `${owner}'s model ${modelName(chosen.model)} has no credentials, so it runs on the session model; /login or change the ${what} in /pstack`,
	};
}

/**
 * The prompt's pstack lines: one per group of single roles on the same seat (model seats grouped by model), one for
 * the panels with their seats, and a warning when the panels' seats all run on one model.
 */
export function renderPstackRoles(config: PstackConfig): string {
	const singles = PSTACK_ROLES.filter((role) => role.kind === "single");
	const seatOf = (role: KnownRole) => config.roles[role.label][0]!;
	const models = [
		...new Set(singles.flatMap((role) => (typeof seatOf(role) === "string" ? [] : [seatName(seatOf(role))]))),
	];
	const groups: readonly (readonly [string, string])[] = [
		["code", '`model="code"`'],
		["judge", '`model="judge"`'],
		...models.map((name) => [name, `\`model="${name}"\``] as const),
		["session", "no `model=`"],
	];
	const lines = groups.flatMap(([name, how]) => {
		const labels = singles.filter((role) => seatName(seatOf(role)) === name).map((role) => role.label);
		return labels.length === 0 ? [] : [`- ${how}: ${labels.join("; ")}`];
	});
	const panels = PSTACK_ROLES.filter((role) => role.kind === "panel");
	const panelText = panels.map((role) => `${role.label} [${config.roles[role.label].map(seatName).join(", ")}]`);
	return [
		"pstack roles: when a pstack skill names a role's model, spawn its subagents with",
		...lines,
		`- panels, one child per seat (a session seat passes no \`model=\`): ${panelText.join("; ")}`,
		...oneModelWarning(config, panels),
	].join("\n");
}

/** A seat as the prompt and the picker name it: `code`, `judge`, `session`, or `provider/modelId`. */
export function seatName(seat: Seat): string {
	return typeof seat === "string" ? seat : modelName(seat.model);
}

// Seats resolve to the model they run on, the session model as "session"; panels whose seats all resolve to one model
// give no multi-model evidence.
function oneModelWarning(config: PstackConfig, panels: readonly KnownRole[]): readonly string[] {
	const resolve = (seat: Seat): string => {
		const chosen = seat === "code" || seat === "judge" ? config.models[seat] : seat;
		return chosen === "session" ? "session" : modelName(chosen.model);
	};
	const seats = panels.flatMap((role) => config.roles[role.label]);
	if (new Set(seats.map(resolve)).size > 1) return [];
	if (seats.every((seat) => typeof seat === "string") && resolve("code") === resolve("judge")) {
		return ["code and judge are one model, so panel seats are not multi-model evidence; say so."];
	}
	return ["every panel seat runs on one model, so panel seats are not multi-model evidence; say so."];
}
