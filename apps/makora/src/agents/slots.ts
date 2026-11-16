// The session's running slots: the anchors whose children hold one, and the claims waiting for one. A child holds its
// anchor's slot through its run, except while it waits on its own children: then the slot goes to the next claim, so
// they can run, and the child claims one again, ahead of runs not started yet, before its run goes on.
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import { AgentSlot, type SlotClaim, SlotsDoc } from "./docs.ts";

/** Where a claim waits: `resuming` for a run that waited on its children, served before `queued`, for runs to start. */
export type SlotLane = "resuming" | "queued";

// Served in this order.
const LANES = ["resuming", "queued"] as const satisfies readonly SlotLane[];

/**
 * Give `claim`'s anchor a running slot when fewer than `limit` are held, or else keep the claim in line until a freed
 * slot is handed to it: a claim the anchor has already keeps its place and now wakes `claim`'s task and key, a new one
 * goes to the end of `lane`. Returns whether the anchor holds a slot. Running it again after a crash changes nothing.
 */
export async function claimSlot(tx: Tx, claim: SlotClaim, lane: SlotLane, limit: number): Promise<boolean> {
	const slots = await tx.doc(SlotsDoc);
	if (slots.running.includes(claim.anchor)) return true;
	let placed: { readonly lane: SlotLane; readonly at: number } | undefined;
	for (const each of LANES) {
		const at = slots[each].findIndex((queued) => queued.anchor === claim.anchor);
		if (at !== -1) placed = { lane: each, at };
	}
	if (slots.running.length < limit) {
		if (placed !== undefined) slots[placed.lane].splice(placed.at, 1);
		slots.running.push(claim.anchor);
		return true;
	}
	if (placed === undefined) slots[lane].push(claim);
	else slots[placed.lane][placed.at] = claim;
	return false;
}

/**
 * Drop `anchor`'s claims and give up its running slot, if it holds one, to the first claim waiting: in `resuming`, then
 * in `queued`. The grant is the commit's one signal, so the caller reads nothing after this.
 */
export async function freeSlot(tx: Tx, anchor: TaskId): Promise<void> {
	const slots = await tx.doc(SlotsDoc);
	const holds = slots.running.includes(anchor);
	slots.running = slots.running.filter((each) => each !== anchor);
	slots.resuming = slots.resuming.filter((each) => each.anchor !== anchor);
	slots.queued = slots.queued.filter((each) => each.anchor !== anchor);
	if (!holds) return;
	const lane = LANES.find((each) => slots[each].length > 0);
	if (lane === undefined) return;
	const next = slots[lane][0]!;
	// A task that ended meanwhile (a wait its run's abort cancelled) does not take the grant; its anchor holds the slot
	// and gives it back when the run ends, as for every run.
	await tx.signal(next.task, AgentSlot, next.key, {});
	slots[lane] = slots[lane].slice(1);
	slots.running.push(next.anchor);
}
