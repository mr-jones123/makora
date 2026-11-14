import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type AuthInteraction, createModels, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loginAccount } from "../src/auth/login.ts";
import { openAuthStore } from "../src/auth/store.ts";

/** A subscription provider whose login hands out the queued token responses in order. */
function subscriptionProvider(logins: OAuthCredential[]): Provider {
	return {
		...fauxProvider().provider,
		id: "sub",
		name: "Sub",
		auth: {
			oauth: {
				name: "Sub (Plan)",
				isSubscription: true,
				login: async () => logins.shift()!,
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [],
	};
}

function token(access: string, account: string, organization: string): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: `${access}-refresh`,
		expires: Date.now() + 3_600_000,
		account: { uuid: `uuid-${account}`, email_address: `${account}@example.com` },
		organization: { uuid: `org-${organization}`, name: organization },
	};
}

const interaction: AuthInteraction = { prompt: async () => "", notify: () => {} };

describe("loginAccount", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "makora-login-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("adds new identities as accounts, replaces a returning one, and serves its token to Models", async () => {
		const store = openAuthStore(join(dir, "auth.json"));
		const models = createModels({ credentials: store });
		models.setProvider(
			subscriptionProvider([token("a1", "a", "Team"), token("b1", "b", "Team"), token("a2", "a", "Team")]),
		);

		const first = await loginAccount(models, store, "sub", "oauth", interaction);
		await loginAccount(models, store, "sub", "oauth", interaction);
		const again = await loginAccount(models, store, "sub", "oauth", interaction);

		assert.equal(again.id, first.id);
		assert.deepEqual(
			(await store.accounts("sub")).map((account) => [account.label, account.active, account.subscription]),
			[
				["a@example.com (Team)", true, true],
				["b@example.com (Team)", false, true],
			],
		);
		assert.deepEqual(again.identity, {
			email: "a@example.com",
			accountUuid: "uuid-a",
			organizationUuid: "org-Team",
			organizationName: "Team",
		});
		assert.equal((await models.getAuth("sub"))?.auth.apiKey, "a2");
	});

	it("rejects a login type the provider does not offer", async () => {
		const store = openAuthStore(join(dir, "auth.json"));
		const models = createModels({ credentials: store });
		models.setProvider(subscriptionProvider([]));
		await assert.rejects(
			loginAccount(models, store, "sub", "api_key", interaction),
			/does not support api_key login/,
		);
	});
});
