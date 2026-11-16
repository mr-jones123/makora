// Spend read from a conversation's `pi.usage` document.
import type { UsageState } from "@earendil-works/pi-durable";

/** Every model and tool cost of `usage`, in USD. */
export function totalCost(usage: UsageState | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const bucket of [usage.models, usage.tools])
		for (const entry of Object.values(bucket)) total += entry.cost.total;
	return total;
}
