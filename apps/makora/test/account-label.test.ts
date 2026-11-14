import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountSummary } from "../src/auth/types.ts";
import { accountLabel, GRANT_WARNING_MS } from "../src/tui/account-label.ts";

const NOW = 1_800_000_000_000;

const account = (fields: Partial<AccountSummary>): AccountSummary => ({
	providerId: "anthropic",
	id: "a1",
	label: "Claude Max",
	type: "oauth",
	active: true,
	subscription: true,
	loginAt: NOW - 1000,
	...fields,
});

describe("account label", () => {
	it("names an Anthropic subscription by email and says it bills extra usage", () => {
		const label = accountLabel([account({ identity: { email: "me@example.com" } })], "anthropic", undefined, NOW);
		assert.deepEqual(label, { text: "me@example.com · subscription · extra usage", warn: false });
	});

	it("uses the label without an email, and marks API keys and other subscriptions", () => {
		assert.equal(accountLabel([account({ subscription: false })], "anthropic", undefined, NOW)?.text, "Claude Max");
		assert.equal(
			accountLabel(
				[account({ providerId: "openai", type: "api_key", subscription: false, label: "work key" })],
				"openai",
				undefined,
				NOW,
			)?.text,
			"work key · api key",
		);
		assert.equal(
			accountLabel([account({ providerId: "openai-codex", label: "ChatGPT" })], "openai-codex", undefined, NOW)
				?.text,
			"ChatGPT · subscription",
		);
	});

	it("labels only the active account of the model's provider", () => {
		const accounts = [
			account({ id: "old", active: false, label: "Old" }),
			account({ id: "new", label: "New" }),
			account({ providerId: "openai", id: "o", label: "OpenAI" }),
		];
		assert.equal(accountLabel(accounts, "anthropic", undefined, NOW)?.text.startsWith("New"), true);
		assert.equal(accountLabel(accounts, "google", undefined, NOW), undefined);
	});

	it("appends the fullest plan usage window", () => {
		const usage = {
			providerId: "anthropic",
			windows: [
				{ label: "5h", usedPercent: 42.4 },
				{ label: "7d", usedPercent: 12 },
			],
		};
		assert.equal(
			accountLabel([account({ label: "Max" })], "anthropic", usage, NOW)?.text,
			"Max · subscription · extra usage · 5h 42%",
		);
		assert.equal(
			accountLabel([account({ label: "Max" })], "anthropic", { ...usage, providerId: "openai" }, NOW)?.text,
			"Max · subscription · extra usage",
		);
	});

	it("warns when the grant ends within five days", () => {
		assert.equal(
			accountLabel([account({ grantExpiresAt: NOW + GRANT_WARNING_MS - 1 })], "anthropic", undefined, NOW)?.warn,
			true,
		);
		assert.equal(
			accountLabel([account({ grantExpiresAt: NOW + GRANT_WARNING_MS + 1 })], "anthropic", undefined, NOW)?.warn,
			false,
		);
	});
});
