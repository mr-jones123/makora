// Interactive login that adds an account to the auth store, or refreshes the matching one.
import type { AuthInteraction, Credential, Models, OAuthCredential } from "@earendil-works/pi-ai";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { AccountIdentity, AccountSummary, AuthStore } from "./types.ts";

/**
 * Run the provider's login flow and store the result as an account, made active. A login for an account that is
 * already stored replaces its credential; `Models.login` is not used because it overwrites the single credential.
 */
export async function loginAccount(
	models: Models,
	store: AuthStore,
	providerId: string,
	type: "oauth" | "api_key",
	interaction: AuthInteraction,
): Promise<AccountSummary> {
	const signal = interaction.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const provider = models.getProviders().find((candidate) => candidate.id === providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
	if (!method?.login) throw new Error(`${provider.name} does not support ${type} login`);
	const credential: Credential = await method.login({ ...interaction, signal });
	signal.throwIfAborted();
	return store.saveLogin(providerId, {
		credential,
		...(credential.type === "oauth" && { identity: identityOf(credential) }),
		subscription: type === "oauth" && provider.auth.oauth?.isSubscription === true,
	});
}

// The provider's token response, kept in the credential's extra fields (Anthropic: `account`, `organization`).
const accountValidator = compile(obj({ uuid: opt(str()), email_address: opt(str()) }, { open: true }));
const organizationValidator = compile(obj({ uuid: opt(str()), name: opt(str()) }, { open: true }));

function identityOf(credential: OAuthCredential): AccountIdentity | undefined {
	const account = accountValidator.check(credential.account) ? credential.account : undefined;
	const organization = organizationValidator.check(credential.organization) ? credential.organization : undefined;
	const identity: AccountIdentity = {
		...(account?.email_address && { email: account.email_address }),
		...(account?.uuid && { accountUuid: account.uuid }),
		...(organization?.uuid && { organizationUuid: organization.uuid }),
		...(organization?.name && { organizationName: organization.name }),
	};
	return Object.keys(identity).length > 0 ? identity : undefined;
}
