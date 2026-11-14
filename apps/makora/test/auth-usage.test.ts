import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openAuthStore } from "../src/auth/store.ts";
import type { AuthStore } from "../src/auth/types.ts";
import { fetchPlanUsage } from "../src/auth/usage.ts";

// Shape of a `GET /api/oauth/usage` response as oh-my-pi's usage/claude.ts parses it: legacy per-model buckets are
// null and model-scoped weekly caps arrive in `limits`.
const usageResponse = {
	five_hour: { utilization: 42, resets_at: "2026-11-14T18:00:00.000000+00:00" },
	seven_day: { utilization: 17.5, resets_at: "2026-11-19T09:00:00.000000+00:00" },
	seven_day_opus: null,
	seven_day_sonnet: { utilization: 3, resets_at: null },
	extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0 },
	limits: [
		{ kind: "session", percent: 42, resets_at: "2026-11-14T18:00:00Z", is_active: true },
		{
			kind: "weekly_scoped",
			percent: "100",
			resets_at: "2026-11-18T00:00:00Z",
			scope: { model: { display_name: "Fable" } },
			is_active: false,
		},
	],
};

describe("plan usage", () => {
	let dir: string;
	let store: AuthStore;
	const requests: { url: string; headers: Headers }[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "makora-usage-"));
		store = openAuthStore(join(dir, "auth.json"));
		await store.saveLogin("anthropic", {
			credential: { type: "oauth", access: "sk-ant-oat-test", refresh: "refresh", expires: Date.now() + 3_600_000 },
			subscription: true,
		});
		requests.length = 0;
	});

	afterEach(async () => {
		mock.restoreAll();
		await rm(dir, { recursive: true, force: true });
	});

	function respond(response: Response): void {
		mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers) });
			return response;
		});
	}

	function models() {
		const result = createModels({ credentials: store });
		result.setProvider(anthropicProvider());
		return result;
	}

	it("parses the usage windows of the active Anthropic account", async () => {
		respond(Response.json(usageResponse));

		const usage = await fetchPlanUsage(models(), store, "anthropic");

		assert.deepEqual(usage, {
			providerId: "anthropic",
			windows: [
				{ label: "5h", usedPercent: 42, resetsAt: Date.parse("2026-11-14T18:00:00Z") },
				{ label: "7d", usedPercent: 17.5, resetsAt: Date.parse("2026-11-19T09:00:00Z") },
				{ label: "7d sonnet", usedPercent: 3 },
				{ label: "7d Fable", usedPercent: 100, resetsAt: Date.parse("2026-11-18T00:00:00Z") },
			],
		});
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.url, "https://api.anthropic.com/api/oauth/usage");
		assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-ant-oat-test");
		assert.equal(requests[0]!.headers.get("anthropic-beta"), "oauth-2025-04-20");
	});

	it("resolves undefined when the endpoint rejects the token", async () => {
		respond(Response.json({ error: { type: "authentication_error" } }, { status: 401 }));
		assert.equal(await fetchPlanUsage(models(), store, "anthropic"), undefined);
	});

	it("resolves undefined for a body without usage windows", async () => {
		respond(Response.json({ five_hour: "soon", limits: "none" }));
		assert.equal(await fetchPlanUsage(models(), store, "anthropic"), undefined);
	});

	it("does not ask other providers or api-key logins", async () => {
		respond(Response.json(usageResponse));
		assert.equal(await fetchPlanUsage(models(), store, "openai"), undefined);
		await store.saveLogin("anthropic", { credential: { type: "api_key", key: "sk-ant-api" }, subscription: false });
		assert.equal(await fetchPlanUsage(models(), store, "anthropic"), undefined);
		assert.equal(requests.length, 0);
	});
});
