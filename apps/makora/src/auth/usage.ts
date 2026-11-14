// Subscription plan usage of the active account, for the status line.
import type { Models } from "@earendil-works/pi-ai";
import { arr, compile, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { AuthStore, PlanUsage, PlanUsageWindow } from "./types.ts";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 15_000;

/**
 * The active account's plan usage. Only Anthropic subscription logins report one; anything else, and any failure
 * (refresh, network, non-2xx, unexpected body), resolves undefined so the status line shows nothing.
 */
export async function fetchPlanUsage(
	models: Models,
	store: AuthStore,
	providerId: string,
): Promise<PlanUsage | undefined> {
	if (providerId !== "anthropic") return undefined;
	if ((await store.read(providerId))?.type !== "oauth") return undefined;
	let body: unknown;
	try {
		const token = (await models.getAuth(providerId))?.auth.apiKey;
		if (!token) return undefined;
		const response = await fetch(ANTHROPIC_USAGE_URL, {
			headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		body = await response.json();
	} catch {
		return undefined;
	}
	const windows = parseAnthropicWindows(body);
	return windows.length > 0 ? { providerId, windows } : undefined;
}

// Wire input: fields may be missing or null, and numbers may arrive as strings.
const bucketValidator = compile(obj({ utilization: opt(unknown()), resets_at: opt(nullable(str())) }, { open: true }));
const limitsValidator = compile(
	arr(
		obj(
			{
				kind: str(),
				percent: opt(unknown()),
				resets_at: opt(nullable(str())),
				scope: opt(
					nullable(
						obj(
							{ model: opt(nullable(obj({ display_name: opt(nullable(str())) }, { open: true }))) },
							{ open: true },
						),
					),
				),
			},
			{ open: true },
		),
	),
);
const payloadValidator = compile(obj({ limits: opt(unknown()) }, { open: true }));

const BUCKET_LABELS: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" };

/**
 * Windows of an `/api/oauth/usage` body: `five_hour`, `seven_day` and the `seven_day_<scope>` buckets, plus
 * model-scoped weekly caps from `limits[]`, which Anthropic reports there since the per-model buckets went null
 * (oh-my-pi usage/claude.ts).
 */
function parseAnthropicWindows(body: unknown): PlanUsageWindow[] {
	if (!payloadValidator.check(body)) return [];
	const windows: PlanUsageWindow[] = [];
	for (const [key, bucket] of Object.entries(body)) {
		const label =
			BUCKET_LABELS[key] ?? (key.startsWith("seven_day_") ? `7d ${key.slice("seven_day_".length)}` : undefined);
		if (label === undefined || !bucketValidator.check(bucket)) continue;
		const window = toWindow(label, bucket.utilization, bucket.resets_at);
		if (window) windows.push(window);
	}
	const limits = body.limits;
	if (limitsValidator.check(limits)) {
		for (const limit of limits) {
			const name = limit.scope?.model?.display_name?.trim();
			if (limit.kind !== "weekly_scoped" || !name) continue;
			const window = toWindow(`7d ${name}`, limit.percent, limit.resets_at);
			if (window) windows.push(window);
		}
	}
	return windows;
}

function toWindow(label: string, percent: unknown, resetsAt: string | null | undefined): PlanUsageWindow | undefined {
	const usedPercent = typeof percent === "string" && percent.trim() !== "" ? Number(percent) : percent;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
	return { label, usedPercent, ...(Number.isFinite(resetMs) && { resetsAt: resetMs }) };
}
