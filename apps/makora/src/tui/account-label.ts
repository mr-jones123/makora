// The status row's account label: which login pays for the current model's requests.
import type { AccountSummary, PlanUsage } from "../auth/types.ts";

/** The label and whether it shows in the warning color. */
export interface AccountLabel {
	readonly text: string;
	/** The grant ends within `GRANT_WARNING_MS`: the user has to log in again soon. */
	readonly warn: boolean;
}

/** How long before a grant ends the label turns to the warning color. */
export const GRANT_WARNING_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * The label of `providerId`'s active account among `accounts`: its email or label, then `subscription` (and `extra
 * usage` for Anthropic, which bills subscription use of other apps as extra usage) or `api key`, then the fullest plan
 * usage window. Undefined when the provider has no active account.
 */
export function accountLabel(
	accounts: readonly AccountSummary[],
	providerId: string,
	usage: PlanUsage | undefined,
	now: number,
): AccountLabel | undefined {
	const account = accounts.find((candidate) => candidate.providerId === providerId && candidate.active);
	if (account === undefined) return undefined;
	const parts = [account.identity?.email ?? account.label];
	if (account.type === "api_key") parts.push("api key");
	else if (account.subscription) {
		parts.push("subscription");
		if (providerId === "anthropic") parts.push("extra usage");
	}
	const fullest =
		usage?.providerId === providerId
			? usage.windows.reduce<PlanUsage["windows"][number] | undefined>(
					(best, window) => (best === undefined || window.usedPercent > best.usedPercent ? window : best),
					undefined,
				)
			: undefined;
	if (fullest !== undefined) parts.push(`${fullest.label} ${Math.round(fullest.usedPercent)}%`);
	const warn = account.grantExpiresAt !== undefined && account.grantExpiresAt - now < GRANT_WARNING_MS;
	return { text: parts.join(" · "), warn };
}
