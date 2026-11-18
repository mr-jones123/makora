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

const usage = {
	providerId: "anthropic",
	windows: [
		{ label: "5h", usedPercent: 42.4 },
		{ label: "7d", usedPercent: 12 },
	],
};

describe("account label", () => {
	it("is the fullest plan usage window, without the account's name or kind", () => {
		const label = accountLabel([account({ identity: { email: "me@example.com" } })], "anthropic", usage, NOW);
		assert.deepEqual(label, { text: "5h 42%", warn: false });
	});

	it("is empty for an active account without plan usage, such as an API key", () => {
		assert.deepEqual(
			accountLabel(
				[account({ providerId: "openai", type: "api_key", subscription: false })],
				"openai",
				undefined,
				NOW,
			),
			{ text: "", warn: false },
		);
		assert.equal(accountLabel([account({})], "anthropic", { ...usage, providerId: "openai" }, NOW)?.text, "");
	});

	it("labels only the active account of the model's provider", () => {
		const accounts = [
			account({ id: "old", active: false, grantExpiresAt: NOW }),
			account({ id: "new" }),
			account({ providerId: "openai", id: "o" }),
		];
		assert.deepEqual(accountLabel(accounts, "anthropic", undefined, NOW), { text: "", warn: false });
		assert.equal(accountLabel(accounts, "google", undefined, NOW), undefined);
	});

	it("says to log in again when the grant ends within five days", () => {
		assert.deepEqual(
			accountLabel([account({ grantExpiresAt: NOW + GRANT_WARNING_MS - 1 })], "anthropic", usage, NOW),
			{
				text: "5h 42% · login expires soon · /login",
				warn: true,
			},
		);
		assert.equal(
			accountLabel([account({ grantExpiresAt: NOW + GRANT_WARNING_MS + 1 })], "anthropic", undefined, NOW)?.warn,
			false,
		);
	});
});
