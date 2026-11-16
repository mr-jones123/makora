// The cost limit: a task the child's generation runs after a tool round that went past the budget. It tells the
// child's anchor to stop it for cost and ends the run there, so no further request is spent.
import { type AfterToolsDecision, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { AgentControl, roundKeys } from "./docs.ts";

/** Which anchor to tell, under which round, and what was spent. */
export type CostStopInput = { readonly anchor: TaskId; readonly round: number; readonly detail: string };

/** Signals the anchor, then ends the run after this round. */
export const CostStop = defineTask<CostStopInput, { readonly phase: "signal" }, AfterToolsDecision>({
	name: "makora.agent-cost-stop",
	version: 1,
	initial: () => ({ phase: "signal" }),
	phases: {
		signal: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const { anchor, round, detail } = task.input;
				await tx.signal(anchor, AgentControl, roundKeys(round).control, { kind: "stop", reason: "cost", detail });
				return { status: "terminal", outcome: { status: "completed", result: { terminate: true } } };
			}, context),
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
