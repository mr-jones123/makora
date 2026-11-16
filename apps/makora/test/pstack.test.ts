import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
	applyBudget,
	type ModelLookup,
	type PstackConfig,
	parsePstack,
	pstackConfig,
	pstackSettings,
	renderPstackRoles,
	spawnModel,
} from "../src/pstack.ts";
import { openSettings } from "../src/settings.ts";

const FAUX_1: ModelRef = { provider: "faux", modelId: "faux-1" };
const FAUX_2: ModelRef = { provider: "faux", modelId: "faux-2" };

const faux = fauxProvider({
	models: [
		{ id: "thinks-to-high", reasoning: true },
		{ id: "plain", reasoning: false },
	],
});
// Thinks up to high by default; a `thinkingLevelMap` entry for xhigh adds that level.
const toHigh = faux.getModel("thinks-to-high")!;
const toXhigh = { ...toHigh, id: "thinks-to-xhigh", thinkingLevelMap: { xhigh: "xhigh" } };
const plain = faux.getModel("plain")!;

function settingsFile(contents: unknown): string {
	const file = join(mkdtempSync(join(tmpdir(), "makora-pstack-")), "settings.json");
	writeFileSync(file, JSON.stringify(contents));
	return file;
}

describe("pstack settings", () => {
	it("put both tiers on the session model and every role on pstack's split when nothing is set", () => {
		const config = pstackConfig(undefined);
		assert.equal(config.budget, "large");
		assert.deepEqual(config.models, { code: "session", judge: "session" });
		assert.deepEqual(config.roles["feature, refactoring"], ["code"]);
		assert.deepEqual(config.roles["swarm workers"], ["code"]);
		assert.deepEqual(config.roles["judgment and prose"], ["judge"]);
		assert.deepEqual(config.roles["reflect judgment, divergent, synthesizer"], ["judge"]);
		assert.deepEqual(config.roles["interrogate reviewers"], ["judge", "code"]);
		assert.equal(Object.keys(config.roles).length, 17);
	});

	it("merge a parsed block over the defaults, dropping unknown roles and malformed values with a warning each", () => {
		const { settings, warnings } = parsePstack({
			budget: "small",
			models: { judge: { model: "faux/faux-2", thinking: "high" }, code: { model: "no-slash", thinking: "high" } },
			roles: {
				"bug-fix": "judge",
				"arena runners": ["code", "code", "session"],
				"architect runners": "code",
				hillclimb: ["code"],
				"swarm workers": "everyone",
				"made up role": "code",
			},
		});
		const config = pstackConfig(settings);
		assert.equal(config.budget, "small");
		assert.deepEqual(config.models, { code: "session", judge: { model: FAUX_2, thinking: "high" } });
		assert.deepEqual(config.roles["bug-fix"], ["judge"]);
		assert.deepEqual(config.roles["arena runners"], ["code", "code", "session"]);
		assert.deepEqual(config.roles["architect runners"], ["code"], "one seat is a one-seat panel");
		assert.deepEqual(config.roles.hillclimb, ["code"], "a single role given a list keeps its default");
		assert.deepEqual(config.roles["swarm workers"], ["code"]);
		assert.equal(warnings.length, 4);
		for (const named of ['"made up role"', "pstack.models.code", '"hillclimb"', '"swarm workers"']) {
			assert.ok(
				warnings.some((warning) => warning.includes(named)),
				`a warning names ${named}: ${warnings.join(" | ")}`,
			);
		}
	});

	it("store only what differs from the defaults, and nothing when nothing does", () => {
		assert.equal(pstackSettings(pstackConfig(undefined)), undefined);
		const config: PstackConfig = {
			...pstackConfig(undefined),
			models: { code: { model: FAUX_1, thinking: "medium" }, judge: "session" },
			roles: { ...pstackConfig(undefined).roles, "perf-issue": ["session"], "arena runners": ["judge", "judge"] },
		};
		assert.deepEqual(pstackSettings(config), {
			models: { code: { model: "faux/faux-1", thinking: "medium" } },
			roles: { "perf-issue": "session", "arena runners": ["judge", "judge"] },
		});
	});

	it("write the pstack block into settings.json next to the other fields, and remove it on a reset", () => {
		const file = settingsFile({
			snapshots: false,
			pstack: { roles: { "how explorer": "judge", "old role": "code" } },
		});
		const settings = openSettings(file);
		assert.deepEqual(settings.pstack.roles["how explorer"], ["judge"]);
		assert.equal(settings.warnings.length, 1);
		settings.setPstack({
			...settings.pstack,
			budget: "medium",
			models: { code: "session", judge: { model: FAUX_2, thinking: "high" } },
		});
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
			snapshots: false,
			pstack: {
				budget: "medium",
				models: { judge: { model: "faux/faux-2", thinking: "high" } },
				roles: { "how explorer": "judge" },
			},
		});
		assert.deepEqual(openSettings(file).pstack.models.judge, { model: FAUX_2, thinking: "high" }, "it reads back");
		settings.setPstack(pstackConfig(undefined));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { snapshots: false });
	});
});

describe("pstack budgets", () => {
	it("set both tiers' thinking level to the budget's, clamped to the highest each model supports below it", () => {
		const models = new Map<string, Model<string>>([
			["faux/faux-1", toXhigh],
			["faux/faux-2", toHigh],
		]);
		const lookup = (ref: ModelRef) => models.get(`${ref.provider}/${ref.modelId}`);
		const config: PstackConfig = {
			...pstackConfig(undefined),
			models: { code: { model: FAUX_1, thinking: "low" }, judge: { model: FAUX_2, thinking: "low" } },
		};
		const unlimited = applyBudget(config, "unlimited", lookup);
		assert.equal(unlimited.budget, "unlimited");
		assert.deepEqual(unlimited.models, {
			code: { model: FAUX_1, thinking: "xhigh" },
			judge: { model: FAUX_2, thinking: "high" },
		});
		assert.deepEqual(applyBudget(config, "small", lookup).models, {
			code: { model: FAUX_1, thinking: "medium" },
			judge: { model: FAUX_2, thinking: "medium" },
		});
		models.set("faux/faux-2", plain);
		assert.deepEqual(applyBudget(config, "large", lookup).models.judge, { model: FAUX_2, thinking: "off" });
		const session = applyBudget(pstackConfig(undefined), "unlimited", lookup);
		assert.deepEqual(session.models, { code: "session", judge: "session" }, "a session tier has no level to set");
	});
});

describe("pstack model aliases", () => {
	const config: PstackConfig = {
		...pstackConfig(undefined),
		models: { code: "session", judge: { model: FAUX_2, thinking: "high" } },
	};
	const lookup = (usable: boolean): ModelLookup => ({
		exists: (ref) => ref.provider === "faux",
		usable: () => usable,
	});

	it("resolve a set tier to its model and thinking level", () => {
		assert.deepEqual(spawnModel("judge", config, lookup(true)), {
			kind: "model",
			model: FAUX_2,
			thinkingLevel: "high",
		});
	});

	it("resolve a session tier, and a tier whose model has no credentials, to the parent's model", () => {
		assert.deepEqual(spawnModel("code", config, lookup(true)), { kind: "parent" });
		const fallback = spawnModel("judge", config, lookup(false));
		assert.equal(fallback.kind, "parent");
		assert.ok(fallback.kind === "parent" && fallback.notice?.includes("faux/faux-2"), "the notice names the model");
	});

	it("take a real provider/modelId as that model, and refuse unknown models and aliases", () => {
		assert.deepEqual(spawnModel("faux/faux-1", config, lookup(true)), { kind: "model", model: FAUX_1 });
		assert.deepEqual(spawnModel(undefined, config, lookup(true)), { kind: "parent" });
		assert.equal(spawnModel("reviewer", config, lookup(true)).kind, "refused");
		assert.equal(spawnModel("other/model", config, lookup(true)).kind, "refused");
		assert.equal(spawnModel("faux/", config, lookup(true)).kind, "refused");
	});
});

describe("pstack role lines", () => {
	it("list the roles of each tier and the panels, and warn when both tiers are one model", () => {
		assert.equal(
			renderPstackRoles(pstackConfig(undefined)),
			[
				"pstack roles: when a pstack skill names a role's model, spawn its subagents with",
				'- `model="code"`: feature, refactoring; bug-fix; perf-issue; hillclimb; how explorer; why investigators; reflect tooling; swarm workers',
				'- `model="judge"`: judgment and prose; hardest tasks; how explainer; why synthesizer; reflect judgment, divergent, synthesizer',
				"- panels, one child per seat (a session seat passes no `model=`): arena runners [judge, code]; arena cross-judge pool [judge, code]; architect runners [judge, code]; interrogate reviewers [judge, code]",
				"code and judge are one model, so panel seats are not multi-model evidence; say so.",
			].join("\n"),
		);
	});

	it("add a line for roles on the session model, and drop the warning when the tiers differ", () => {
		const defaults = pstackConfig(undefined);
		const text = renderPstackRoles({
			...defaults,
			models: { code: { model: FAUX_1, thinking: "high" }, judge: { model: FAUX_2, thinking: "high" } },
			roles: { ...defaults.roles, "bug-fix": ["session"], "hardest tasks": ["code"], "architect runners": ["code"] },
		});
		const lines = text.split("\n");
		assert.equal(
			lines[1],
			'- `model="code"`: feature, refactoring; perf-issue; hillclimb; hardest tasks; how explorer; why investigators; reflect tooling; swarm workers',
		);
		assert.equal(lines[3], "- no `model=`: bug-fix");
		assert.match(lines[4]!, /architect runners \[code\];/);
		assert.equal(lines.length, 5, "no one-model warning");
	});
});
