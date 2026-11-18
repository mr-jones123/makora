// The status row's account label: how much of the current login's plan is used, and a warning when it must log in again.
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
 * The label of `providerId`'s active account among `accounts`: its fullest plan usage window, such as `7d 59%`, and
 * `login expires soon · /login` when its grant ends within `GRANT_WARNING_MS`. Undefined when the provider has no active
 * account. Which account it is stays out of the row, where it crowded out the context gauge; `/accounts` shows it.
 */
export function accountLabel(
	accounts: readonly AccountSummary[],
	providerId: string,
	usage: PlanUsage | undefined,
	now: number,
): AccountLabel | undefined {
	const account = accounts.find((candidate) => candidate.providerId === providerId && candidate.active);
	if (account === undefined) return undefined;
	const fullest =
		usage?.providerId === providerId
			? usage.windows.reduce<PlanUsage["windows"][number] | undefined>(
					(best, window) => (best === undefined || window.usedPercent > best.usedPercent ? window : best),
					undefined,
				)
			: undefined;
	const warn = account.grantExpiresAt !== undefined && account.grantExpiresAt - now < GRANT_WARNING_MS;
	const parts = [
		...(fullest === undefined ? [] : [`${fullest.label} ${Math.round(fullest.usedPercent)}%`]),
		...(warn ? ["login expires soon · /login"] : []),
	];
	return { text: parts.join(" · "), warn };
}
