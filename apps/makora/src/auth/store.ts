// File-backed multi-account credential store: several logins per provider, one active, shared across processes.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, CredentialInfo } from "@earendil-works/pi-ai";
import { arr, bool, compile, lit, map, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import lockfile from "proper-lockfile";
import type { AccountIdentity, AccountLogin, AccountSummary, AuthStore } from "./types.ts";

const ProviderEnvSchema = map(str());

const CredentialSchema = union([
	obj({ type: lit("api_key"), key: opt(str()), env: opt(ProviderEnvSchema) }),
	// OAuth credentials carry provider-specific extra fields (for example Anthropic's account and organization).
	obj({ type: lit("oauth"), refresh: str(), access: str(), expires: num() }, { open: true }),
]);

const IdentitySchema = obj({
	email: opt(str()),
	accountUuid: opt(str()),
	organizationUuid: opt(str()),
	organizationName: opt(str()),
});

const StoredAccountSchema = obj({
	id: str(),
	label: str(),
	credential: CredentialSchema,
	identity: opt(IdentitySchema),
	subscription: bool(),
	loginAt: num(),
});

const AuthFileSchema = obj({
	version: lit(1),
	providers: map(obj({ active: str(), accounts: arr(StoredAccountSchema, { minItems: 1 }) })),
});

type AuthFile = Static<typeof AuthFileSchema>;
type ProviderAccounts = AuthFile["providers"][string];
type StoredAccount = ProviderAccounts["accounts"][number];

const authFileValidator = compile(AuthFileSchema);

const DAY_MS = 24 * 60 * 60 * 1000;

// Providers whose OAuth grant ends a fixed time after the interactive login, however often it is refreshed. Anthropic
// ends it about 30 days after login (observed by oh-my-pi, anthropic-constants.ts); only a new login recovers it.
const OAUTH_GRANT_TTL_MS: Readonly<Record<string, number>> = { anthropic: 30 * DAY_MS };

const LOCK_OPTIONS = {
	// The file may not exist yet; the lock is the sibling directory `<file>.lock`.
	realpath: false,
	stale: 30_000,
	retries: { retries: 60, factor: 1.5, minTimeout: 10, maxTimeout: 1_000, randomize: true },
} as const;

/** Open the auth store at `file`. The file is created with mode 0600 on the first write. */
export function openAuthStore(file: string): AuthStore {
	// Every write rewrites the whole file, so the file is the unit of exclusion: one chain per store in this process,
	// one lock file across processes.
	let chain: Promise<unknown> = Promise.resolve();

	/** Run `change` on the current file contents under the lock; write the file when `change` altered them. */
	function update<T>(change: (data: AuthFile) => Promise<T> | T, options?: AuthOperationOptions): Promise<T> {
		const run = chain.then(() => withFileLock(file, change, options));
		chain = run.catch(() => {});
		return run;
	}

	return {
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			const data = await loadAuthFile(file);
			return activeAccount(data.providers[providerId])?.credential;
		},

		async list(options) {
			options?.signal?.throwIfAborted();
			const data = await loadAuthFile(file);
			return Object.entries(data.providers).map(
				([providerId, entry]): CredentialInfo => ({ providerId, type: activeAccount(entry)!.credential.type }),
			);
		},

		modify(providerId, fn, options) {
			return update(async (data) => {
				const entry = data.providers[providerId];
				const account = activeAccount(entry);
				const next = await fn(account?.credential);
				if (next === undefined) return account?.credential;
				if (account) account.credential = next;
				else addAccount(data, providerId, { credential: next, subscription: false });
				return next;
			}, options);
		},

		delete(providerId, options) {
			return update((data) => {
				const active = data.providers[providerId]?.active;
				if (active !== undefined) removeAccount(data, providerId, active);
			}, options);
		},

		async accounts(providerId) {
			const data = await loadAuthFile(file);
			const providerIds = providerId === undefined ? Object.keys(data.providers) : [providerId];
			return providerIds.flatMap((id) => {
				const entry = data.providers[id];
				return entry ? entry.accounts.map((account) => summarize(id, entry, account)) : [];
			});
		},

		activate(providerId, accountId) {
			return update((data) => {
				const entry = data.providers[providerId];
				if (!entry?.accounts.some((account) => account.id === accountId)) {
					throw new Error(`No ${providerId} account ${accountId} in ${file}`);
				}
				entry.active = accountId;
			});
		},

		remove(providerId, accountId) {
			return update((data) => removeAccount(data, providerId, accountId));
		},

		saveLogin(providerId, login) {
			return update((data) => {
				const entry = data.providers[providerId];
				const existing = entry?.accounts.find((account) => sameIdentity(account.identity, login.identity));
				if (!entry || !existing) {
					const account = addAccount(data, providerId, login);
					return summarize(providerId, data.providers[providerId]!, account);
				}
				existing.credential = login.credential;
				existing.subscription = login.subscription;
				// A new interactive login starts a new grant.
				existing.loginAt = Date.now();
				if (login.identity) existing.identity = { ...login.identity };
				entry.active = existing.id;
				return summarize(providerId, entry, existing);
			});
		},
	};
}

async function withFileLock<T>(
	file: string,
	change: (data: AuthFile) => Promise<T> | T,
	options: AuthOperationOptions | undefined,
): Promise<T> {
	options?.signal?.throwIfAborted();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	let compromised: Error | undefined;
	const release = await lockfile.lock(file, {
		...LOCK_OPTIONS,
		onCompromised: (error) => {
			compromised = error;
		},
	});
	try {
		const data = await loadAuthFile(file);
		const before = JSON.stringify(data);
		const result = await change(data);
		options?.signal?.throwIfAborted();
		if (JSON.stringify(data) !== before) {
			if (compromised) throw new Error(`Lost the lock on ${file}: ${compromised.message}`);
			await writeFileAtomic(file, `${JSON.stringify(data, null, "\t")}\n`);
		}
		return result;
	} finally {
		await release().catch(() => {});
	}
}

/** Read and validate the auth file; a missing file is an empty store. */
async function loadAuthFile(file: string): Promise<AuthFile> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
		throw error;
	}
	// The file is a trust boundary: other processes and people edit it.
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Corrupt auth file ${file}: ${(error as Error).message}`);
	}
	if (!authFileValidator.check(value)) {
		const [first] = authFileValidator.errors(value);
		throw new Error(`Corrupt auth file ${file}: ${first?.path || "/"} ${first?.message ?? "invalid"}`);
	}
	for (const [providerId, entry] of Object.entries(value.providers)) {
		if (!activeAccount(entry)) {
			throw new Error(`Corrupt auth file ${file}: active account ${entry.active} of ${providerId} does not exist`);
		}
	}
	return value;
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function activeAccount(entry: ProviderAccounts | undefined): StoredAccount | undefined {
	return entry?.accounts.find((account) => account.id === entry.active);
}

/** Add an account and make it active. */
function addAccount(data: AuthFile, providerId: string, login: AccountLogin): StoredAccount {
	const entry = data.providers[providerId];
	const account: StoredAccount = {
		id: randomUUID(),
		label: identityLabel(login.identity) ?? freeLabel(providerId, entry),
		credential: login.credential,
		...(login.identity && { identity: { ...login.identity } }),
		subscription: login.subscription,
		loginAt: Date.now(),
	};
	if (entry) {
		entry.accounts.push(account);
		entry.active = account.id;
	} else {
		data.providers[providerId] = { active: account.id, accounts: [account] };
	}
	return account;
}

/** `email (organization)` so one person's accounts in two organizations read apart; undefined without an email. */
function identityLabel(identity: AccountIdentity | undefined): string | undefined {
	if (identity?.email === undefined) return undefined;
	return identity.organizationName === undefined ? identity.email : `${identity.email} (${identity.organizationName})`;
}

function freeLabel(providerId: string, entry: ProviderAccounts | undefined): string {
	const taken = new Set(entry?.accounts.map((account) => account.label));
	let n = 1;
	while (taken.has(`${providerId} ${n}`)) n++;
	return `${providerId} ${n}`;
}

function removeAccount(data: AuthFile, providerId: string, accountId: string): void {
	const entry = data.providers[providerId];
	if (!entry) return;
	entry.accounts = entry.accounts.filter((account) => account.id !== accountId);
	if (entry.accounts.length === 0) {
		delete data.providers[providerId];
		return;
	}
	if (entry.active === accountId) {
		// Accounts are appended in login order, so on a millisecond tie the later one is the newer login.
		entry.active = entry.accounts.reduce((newest, account) =>
			account.loginAt >= newest.loginAt ? account : newest,
		).id;
	}
}

/**
 * Two logins are the same account when their account uuids (else emails) match and they belong to the same
 * organization. A token is scoped to one organization, so a Team seat and a personal plan of one person stay two
 * accounts.
 */
function sameIdentity(a: AccountIdentity | undefined, b: AccountIdentity | undefined): boolean {
	if (a?.organizationUuid !== b?.organizationUuid) return false;
	if (a?.accountUuid !== undefined && b?.accountUuid !== undefined) return a.accountUuid === b.accountUuid;
	return a?.email !== undefined && a.email === b?.email;
}

function summarize(providerId: string, entry: ProviderAccounts, account: StoredAccount): AccountSummary {
	const grantTtl = account.credential.type === "oauth" ? OAUTH_GRANT_TTL_MS[providerId] : undefined;
	return {
		providerId,
		id: account.id,
		label: account.label,
		type: account.credential.type,
		active: entry.active === account.id,
		subscription: account.subscription,
		...(account.identity && { identity: account.identity }),
		loginAt: account.loginAt,
		...(grantTtl !== undefined && { grantExpiresAt: account.loginAt + grantTtl }),
	};
}
