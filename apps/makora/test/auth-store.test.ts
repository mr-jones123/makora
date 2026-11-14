import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { openAuthStore } from "../src/auth/store.ts";

function oauth(access: string, extra: Record<string, unknown> = {}): OAuthCredential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 3_600_000, ...extra };
}

function accessOf(credential: Credential | undefined): string | undefined {
	return credential?.type === "oauth" ? credential.access : undefined;
}

describe("auth store", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "makora-auth-"));
		file = join(dir, "nested", "auth.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("keeps two accounts for one provider and reads the active one", async () => {
		const store = openAuthStore(file);
		const first = await store.saveLogin("anthropic", {
			credential: oauth("a"),
			identity: { email: "a@example.com", accountUuid: "uuid-a" },
			subscription: true,
		});
		const second = await store.saveLogin("anthropic", {
			credential: oauth("b"),
			identity: { email: "b@example.com", accountUuid: "uuid-b" },
			subscription: true,
		});

		const accounts = await store.accounts("anthropic");
		assert.deepEqual(
			accounts.map((account) => [account.label, account.active]),
			[
				["a@example.com", false],
				["b@example.com", true],
			],
		);
		assert.equal(accounts[0]!.grantExpiresAt, accounts[0]!.loginAt + 30 * 24 * 60 * 60 * 1000);
		assert.equal(accessOf(await store.read("anthropic")), "b");

		await store.activate("anthropic", first.id);
		assert.equal(accessOf(await store.read("anthropic")), "a");
		assert.equal((await store.accounts("anthropic")).find((account) => account.active)?.id, first.id);
		assert.notEqual(first.id, second.id);
	});

	it("replaces the credential of a login whose identity is already stored", async () => {
		const store = openAuthStore(file);
		const first = await store.saveLogin("anthropic", {
			credential: oauth("old"),
			identity: { email: "a@example.com", accountUuid: "uuid-a" },
			subscription: true,
		});
		await store.saveLogin("anthropic", {
			credential: oauth("other"),
			identity: { accountUuid: "uuid-b" },
			subscription: true,
		});
		const again = await store.saveLogin("anthropic", {
			credential: oauth("new"),
			identity: { email: "a@example.com", accountUuid: "uuid-a" },
			subscription: true,
		});

		assert.equal(again.id, first.id);
		assert.equal(again.active, true);
		assert.equal((await store.accounts("anthropic")).length, 2);
		assert.equal(accessOf(await store.read("anthropic")), "new");
	});

	it("keeps one person's logins in two organizations as two accounts", async () => {
		const store = openAuthStore(file);
		const person = { email: "a@example.com", accountUuid: "uuid-a" };
		await store.saveLogin("anthropic", {
			credential: oauth("team"),
			identity: { ...person, organizationUuid: "org-team", organizationName: "Team" },
			subscription: true,
		});
		await store.saveLogin("anthropic", {
			credential: oauth("personal"),
			identity: { ...person, organizationUuid: "org-personal", organizationName: "Personal" },
			subscription: true,
		});

		assert.deepEqual(
			(await store.accounts("anthropic")).map((account) => account.label),
			["a@example.com (Team)", "a@example.com (Personal)"],
		);
	});

	it("labels accounts without an email by provider and number", async () => {
		const store = openAuthStore(file);
		const key = (value: string): Credential => ({ type: "api_key", key: value });
		await store.saveLogin("openai", { credential: key("k1"), subscription: false });
		await store.saveLogin("openai", { credential: key("k2"), subscription: false });
		const accounts = await store.accounts("openai");
		assert.deepEqual(
			accounts.map((account) => [account.label, account.type, account.grantExpiresAt]),
			[
				["openai 1", "api_key", undefined],
				["openai 2", "api_key", undefined],
			],
		);
	});

	it("falls back to the newest remaining account when the active one is removed", async () => {
		const store = openAuthStore(file);
		const oldest = await store.saveLogin("anthropic", {
			credential: oauth("a"),
			identity: { accountUuid: "a" },
			subscription: true,
		});
		const newest = await store.saveLogin("anthropic", {
			credential: oauth("b"),
			identity: { accountUuid: "b" },
			subscription: true,
		});
		const active = await store.saveLogin("anthropic", {
			credential: oauth("c"),
			identity: { accountUuid: "c" },
			subscription: true,
		});
		await store.activate("anthropic", oldest.id);
		await store.activate("anthropic", active.id);

		await store.remove("anthropic", active.id);

		const accounts = await store.accounts("anthropic");
		assert.deepEqual(accounts.map((account) => account.id).sort(), [oldest.id, newest.id].sort());
		assert.equal(accounts.find((account) => account.active)?.id, newest.id);

		await store.remove("anthropic", newest.id);
		await store.remove("anthropic", oldest.id);
		assert.deepEqual(await store.accounts("anthropic"), []);
		assert.equal(await store.read("anthropic"), undefined);
		assert.deepEqual(await store.list(), []);
	});

	it("writes a refresh through modify to the active account only", async () => {
		const store = openAuthStore(file);
		await store.saveLogin("anthropic", {
			credential: oauth("a"),
			identity: { accountUuid: "a" },
			subscription: true,
		});
		await store.saveLogin("anthropic", {
			credential: oauth("b"),
			identity: { accountUuid: "b" },
			subscription: true,
		});

		const seen: (Credential | undefined)[] = [];
		await store.modify("anthropic", async (current) => {
			seen.push(current);
			return oauth("b2");
		});

		assert.equal(accessOf(seen[0]), "b");
		const file_ = JSON.parse(await readFile(file, "utf8")) as {
			providers: { anthropic: { accounts: { credential: OAuthCredential; identity: { accountUuid: string } }[] } };
		};
		assert.deepEqual(
			file_.providers.anthropic.accounts.map((account) => [account.identity.accountUuid, account.credential.access]),
			[
				["a", "a"],
				["b", "b2"],
			],
		);
		assert.deepEqual(await store.list(), [{ providerId: "anthropic", type: "oauth" }]);
	});

	it("creates the first account when modify runs on an empty provider", async () => {
		const store = openAuthStore(file);
		await store.modify("anthropic", async () => oauth("first"));
		const [account] = await store.accounts("anthropic");
		assert.equal(account?.label, "anthropic 1");
		assert.equal(account?.active, true);
	});

	it("serializes concurrent modify calls on one provider without losing updates", async () => {
		const store = openAuthStore(file);
		const other = openAuthStore(file);
		await store.modify("counter", async () => ({ type: "api_key", key: "0" }));

		const increment = (target: typeof store) =>
			target.modify("counter", async (current) => {
				const value = Number(current?.type === "api_key" ? current.key : Number.NaN);
				// Yield between the read and the write so an unserialized store would interleave and lose updates.
				await yieldToEventLoop();
				return { type: "api_key", key: String(value + 1) };
			});
		// Two store instances on one file stand in for two processes: they share only the lock file.
		await Promise.all(Array.from({ length: 20 }, (_, index) => increment(index % 2 === 0 ? store : other)));

		const final = await store.read("counter");
		assert.equal(final?.type === "api_key" && final.key, "20");
	});

	it("creates the file with mode 0600", async () => {
		const store = openAuthStore(file);
		await store.saveLogin("anthropic", { credential: oauth("a"), subscription: true });
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	});

	it("rejects a corrupt file with its path and leaves it untouched", async () => {
		const store = openAuthStore(file);
		await store.saveLogin("anthropic", { credential: oauth("a"), subscription: true });
		await writeFile(file, "{ not json");

		await assert.rejects(store.read("anthropic"), (error: Error) => error.message.includes(file));
		await assert.rejects(
			store.modify("anthropic", async () => oauth("b")),
			(error: Error) => error.message.includes(file),
		);
		await writeFile(file, JSON.stringify({ version: 1, providers: { anthropic: { active: "x", accounts: [] } } }));
		await assert.rejects(store.accounts(), (error: Error) => error.message.includes(file));
		assert.equal(
			await readFile(file, "utf8"),
			JSON.stringify({ version: 1, providers: { anthropic: { active: "x", accounts: [] } } }),
		);
	});
});
