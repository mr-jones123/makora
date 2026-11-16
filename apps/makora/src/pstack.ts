// pstack model roles: the code and judge tiers, the roles pstack's skills name with where each runs, the `pstack`
// block of `settings.json`, budgets, what a spawn's `model="code"` or `model="judge"` runs on, and the role lines of
// the prompt.
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseModelRef } from "./models.ts";

/** The two model tiers pstack roles run on. */
export const TIERS = ["code", "judge"] as const;
export type Tier = (typeof TIERS)[number];

/** Where one seat of a role runs: a tier, or the session model (`spawn` without `model=`). */
export type Seat = Tier | "session";

/** The seats in the order the picker cycles them. */
export const SEATS: readonly Seat[] = ["code", "judge", "session"];

/** A tier's model: the session model, or a model with its thinking level. */
export type TierModel = "session" | { readonly model: ModelRef; readonly thinking: ModelThinkingLevel };

/** setup-pstack's budgets, each with the thinking level it gives both tiers. */
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

/** A tier's model as `settings.json` stores it: `"session"`, or the model as `provider/modelId` and its thinking level. */
export type StoredTierModel = "session" | { readonly model: string; readonly thinking: ModelThinkingLevel };

/** The `pstack` block of `settings.json`: only what differs from the defaults. */
export type PstackSettings = {
	readonly budget?: Budget;
	readonly models?: Readonly<Partial<Record<Tier, StoredTierModel>>>;
	readonly roles?: Readonly<Partial<Record<RoleLabel, Seat | readonly Seat[]>>>;
};

/** `settings` over the defaults: both tiers on the session model, every role on its pstack default, budget large. */
export function pstackConfig(settings: PstackSettings | undefined): PstackConfig {
	const tier = (stored: StoredTierModel | undefined): TierModel =>
		// `parsePstack` let only `provider/modelId` models through.
		stored === undefined || stored === "session"
			? "session"
			: { model: parseModelRef(stored.model)!, thinking: stored.thinking };
	const roles = Object.fromEntries(
		PSTACK_ROLES.map((role) => {
			const seats = settings?.roles?.[role.label] ?? role.seats;
			return [role.label, typeof seats === "string" ? [seats] : seats];
		}),
	);
	return {
		budget: settings?.budget ?? "large",
		models: { code: tier(settings?.models?.code), judge: tier(settings?.models?.judge) },
		// `fromEntries` widens the keys; the entries are one per role of PSTACK_ROLES.
		roles: roles as Record<RoleLabel, readonly Seat[]>,
	};
}

/** What `config` changes from the defaults, as `settings.json` stores it; undefined when nothing differs. */
export function pstackSettings(config: PstackConfig): PstackSettings | undefined {
	const models = Object.fromEntries(
		TIERS.flatMap((tier) => {
			const chosen = config.models[tier];
			if (chosen === "session") return [];
			return [[tier, { model: `${chosen.model.provider}/${chosen.model.modelId}`, thinking: chosen.thinking }]];
		}),
	);
	const roles = Object.fromEntries(
		PSTACK_ROLES.flatMap((role) => {
			const seats = config.roles[role.label];
			if (seats.join() === role.seats.join()) return [];
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
	const parsedRoles: Partial<Record<RoleLabel, Seat | readonly Seat[]>> = {};
	if (!isObject(roles)) warn("pstack.roles is not an object; every role uses its default");
	for (const [label, value] of Object.entries(isObject(roles) ? roles : {})) {
		const role: KnownRole | undefined = PSTACK_ROLES.find((each) => each.label === label);
		const seats = role === undefined ? undefined : parseSeats(value, role.kind);
		if (role === undefined) warn(`pstack.roles has an unknown role ${JSON.stringify(label)}; dropped`);
		else if (seats === undefined)
			warn(
				`pstack.roles[${JSON.stringify(label)}] is not ${role.kind === "panel" ? "a list of" : "one of"} code, judge, session; using its default`,
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
	if (value === "session") return "session";
	if (!isObject(value)) return undefined;
	const { model } = value;
	const thinking = MODEL_THINKING_LEVELS.find((each) => each === value.thinking);
	if (typeof model !== "string" || parseModelRef(model) === undefined || thinking === undefined) return undefined;
	return { model, thinking };
}

// A panel takes a non-empty list, or one seat as a one-seat panel; a single role takes one seat.
function parseSeats(value: unknown, kind: PstackRole["kind"]): Seat | readonly Seat[] | undefined {
	const seat = (each: unknown) => SEATS.find((candidate) => candidate === each);
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

/** `config` on `budget`: each tier with a model gets the budget's thinking level, clamped to what its model supports. */
export function applyBudget(
	config: PstackConfig,
	budget: Budget,
	lookup: (model: ModelRef) => Model<Api> | undefined,
): PstackConfig {
	const level = BUDGETS[budget];
	const tier = (current: TierModel): TierModel => {
		if (current === "session") return current;
		const model = lookup(current.model);
		return { ...current, thinking: model === undefined ? level : clampThinking(model, level) };
	};
	return { ...config, budget, models: { code: tier(config.models.code), judge: tier(config.models.judge) } };
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
 * when the tier is the session model or its model has no credentials; `provider/modelId` is that model.
 */
export function spawnModel(arg: string | undefined, config: PstackConfig, models: ModelLookup): SpawnModel {
	if (arg === undefined) return { kind: "parent" };
	const tier = TIERS.find((each) => each === arg);
	if (tier !== undefined) {
		const chosen = config.models[tier];
		if (chosen === "session") return { kind: "parent" };
		if (!models.usable(chosen.model)) {
			const name = `${chosen.model.provider}/${chosen.model.modelId}`;
			return {
				kind: "parent",
				notice: `the ${tier} tier's model ${name} has no credentials, so it runs on the session model; /login or change the tier in /pstack`,
			};
		}
		return { kind: "model", model: chosen.model, thinkingLevel: chosen.thinking };
	}
	if (!arg.includes("/")) {
		return { kind: "refused", reason: `Unknown model alias ${arg}: use "code", "judge" or provider/modelId` };
	}
	const model = parseModelRef(arg);
	if (model === undefined) return { kind: "refused", reason: `Bad model ${arg}: use provider/modelId` };
	if (!models.exists(model)) return { kind: "refused", reason: `Unknown model ${arg}` };
	return { kind: "model", model };
}

/**
 * The prompt's pstack lines: one per group of single roles on the same seat, one for the panels with their seats, and a
 * warning when both tiers are one model.
 */
export function renderPstackRoles(config: PstackConfig): string {
	const groups: readonly (readonly [Seat, string])[] = [
		["code", '`model="code"`'],
		["judge", '`model="judge"`'],
		["session", "no `model=`"],
	];
	const singles = PSTACK_ROLES.filter((role) => role.kind === "single");
	const lines = groups.flatMap(([seat, how]) => {
		const labels = singles.filter((role) => config.roles[role.label][0] === seat).map((role) => role.label);
		return labels.length === 0 ? [] : [`- ${how}: ${labels.join("; ")}`];
	});
	const panels = PSTACK_ROLES.filter((role) => role.kind === "panel")
		.map((role) => `${role.label} [${config.roles[role.label].join(", ")}]`)
		.join("; ");
	const { code, judge } = config.models;
	const oneModel =
		code === "session" || judge === "session"
			? code === judge
			: code.model.provider === judge.model.provider && code.model.modelId === judge.model.modelId;
	return [
		"pstack roles: when a pstack skill names a role's model, spawn its subagents with",
		...lines,
		`- panels, one child per seat (a session seat passes no \`model=\`): ${panels}`,
		...(oneModel ? ["code and judge are one model, so panel seats are not multi-model evidence; say so."] : []),
	].join("\n");
}
