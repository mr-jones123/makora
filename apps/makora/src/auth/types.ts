// The account model makora's login, status line and account commands share.
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** Who an OAuth account belongs to, as the provider reported it at login. */
export interface AccountIdentity {
	readonly email?: string;
	readonly accountUuid?: string;
	readonly organizationUuid?: string;
	readonly organizationName?: string;
}

/** One stored login, without its secrets. */
export interface AccountSummary {
	readonly providerId: string;
	readonly id: string;
	readonly label: string;
	readonly type: "oauth" | "api_key";
	readonly active: boolean;
	/** A subscription login (for example Claude Pro/Max), billed by the provider's subscription rules. */
	readonly subscription: boolean;
	readonly identity?: AccountIdentity;
	/** Epoch milliseconds of the login that created this account. */
	readonly loginAt: number;
	/** Epoch milliseconds after which the provider ends the grant regardless of refreshes, when it has such a limit. */
	readonly grantExpiresAt?: number;
}

/** The result of one finished login, ready to be stored as an account. */
export interface AccountLogin {
	readonly credential: Credential;
	readonly identity?: AccountIdentity;
	readonly subscription: boolean;
}

/**
 * Credentials for every provider, with several accounts per provider and one active account. The `CredentialStore`
 * methods act on the active account, so `Models` refreshes and reads it like a single credential.
 */
export interface AuthStore extends CredentialStore {
	/** Accounts of one provider, or of every provider when `providerId` is omitted. */
	accounts(providerId?: string): Promise<readonly AccountSummary[]>;
	/** Make `accountId` the provider's active account. */
	activate(providerId: string, accountId: string): Promise<void>;
	/** Delete one account; the provider's most recent remaining account becomes active. */
	remove(providerId: string, accountId: string): Promise<void>;
	/**
	 * Store a finished login and make its account active. A login whose identity matches an existing account (account
	 * uuid, else email) replaces that account's credential; any other login adds a new account.
	 */
	saveLogin(providerId: string, login: AccountLogin): Promise<AccountSummary>;
}

/** One rate-limit window of a subscription plan, as the provider reports it. */
export interface PlanUsageWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetsAt?: number;
}

/** The active account's plan usage. */
export interface PlanUsage {
	readonly providerId: string;
	readonly windows: readonly PlanUsageWindow[];
}
