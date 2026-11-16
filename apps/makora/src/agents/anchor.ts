// The anchor: a background task of the parent conversation that owns one child conversation and drives its life. It
// waits for a running slot, prepares the worktree, starts the child's run, parks until the run settles or something
// stops it, records the result, wakes the parent, and then rests until a message wakes the child again or it is
// removed. A failure in git or in the setup command stops the child with that error rather than failing the anchor,
// which would keep its slot and leave the parent's waits on the child parked for good. Every step that touches other tasks or conversations is a phase of its own: a Durable commit holds at most
// one table write (one signal or one submission), and each phase commits its effect with the next checkpoint, so a
// crash reruns at most the side effects that converge (git, kernel stops, conversation aborts).
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import {
	defineTask,
	type EntryId,
	type NextTaskState,
	type RunningTask,
	type SettledSubmissionRecord,
	SubmissionSettled,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import type { KernelManager } from "../kernel/manager.ts";
import { messageText } from "../transcript-rows.ts";
import {
	AgentControl,
	AgentSlot,
	AgentsDoc,
	type AgentsState,
	AgentWake,
	roundKeys,
	SlotsDoc,
	WaitersDoc,
} from "./docs.ts";
import { AgentUnreachable, admitInput, identityOf, ROOT_NAME } from "./family.ts";
import { AGENT_RESULT_ENTRY, type AgentResultData, agentBrief, agentResultText, setupNotice } from "./prompts.ts";
import type { AgentRecord, AgentState, StopReason } from "./types.ts";
import { commitWork, finishedResult, type Preparation, prepareAgent, type SetupPolicy } from "./worktree.ts";

/** What the anchor needs from the session. */
export type AnchorOptions = {
	readonly kernels: KernelManager;
	/** Children running at once in the session, read at each use. */
	readonly maxRunning: () => number;
	readonly setup: SetupPolicy;
	/** The user's settings file, where a notice says setup approvals go. */
	readonly settingsFile: string;
};

/** The anchor's input: the child's name among its parent's children. */
export type AnchorInput = { readonly name: string };

/** How a round ended for the child. */
type Final =
	| { readonly kind: "done"; readonly answer: EntryId }
	| { readonly kind: "stopped"; readonly reason: StopReason; readonly detail?: string }
	/** A tool (stop, remove) already took the child out of the round and recorded why; only the bookkeeping is left. */
	| { readonly kind: "taken" };

type AnchorState =
	| { readonly phase: "queue" }
	/** Woken while queued: by its slot, or by a stop or remove. */
	| { readonly phase: "dequeued" }
	| { readonly phase: "prepare" }
	/** Writes how preparing went into the child's transcript; a failure stops the child. */
	| { readonly phase: "notice"; readonly prepared: Noted }
	/** Tells the parent's transcript that the child's setup command was not approved. */
	| { readonly phase: "tell"; readonly prepared: Skipped }
	| { readonly phase: "start" }
	/** Woken from round `round`'s sleep. */
	| { readonly phase: "woke"; readonly round: number }
	| { readonly phase: "settle"; readonly round: number; readonly final: Final }
	/** Wakes the parent's waits on this child, one per commit. */
	| { readonly phase: "notify"; readonly round: number; readonly notified: boolean }
	/** Tells a parent that was not waiting. */
	| { readonly phase: "report"; readonly round: number }
	/** Gives back the running slot, if the anchor holds one, then rests or ends. */
	| { readonly phase: "release" };

/** A preparation the child's transcript hears about. */
type Noted = Exclude<Preparation, { readonly kind: "ready" }>;
type Skipped = Extract<Preparation, { readonly kind: "skipped" }>;

type Runtime = TaskRuntime<AnchorInput, AnchorState, null, object>;
type Next = NextTaskState<AnchorState, null>;

const SLOT_KEY = "slot";

/** The anchor task over the session's kernels and slot limit. */
export function createAnchor(options: AnchorOptions) {
	return defineTask<AnchorInput, AnchorState, null>({
		name: "makora.agent-anchor",
		version: 1,
		initial: () => ({ phase: "queue" }),
		phases: {
			queue: (task, runtime, context) => queue(task, runtime, options, context),
			dequeued: (_task, runtime, context) => dequeued(runtime, context),
			prepare: (task, runtime, context) => prepare(task, runtime, options, context),
			notice: (task, runtime, context) => notice(task, runtime, task.state.checkpoint.prepared, options, context),
			tell: (task, runtime, context) => tell(task, runtime, task.state.checkpoint.prepared, options, context),
			start: (task, runtime, context) => start(task, runtime, context),
			woke: (task, runtime, context) => woke(task, runtime, task.state.checkpoint.round, context),
			settle: (task, runtime, context) => settle(task, runtime, task.state.checkpoint, options, context),
			notify: (task, runtime, context) => notify(task, runtime, task.state.checkpoint, context),
			report: (task, runtime, context) => report(task, runtime, task.state.checkpoint.round, context),
			release: (task, runtime, context) => release(task, runtime, context),
		},
		// Stopping everything (`abort({ background: true })`) ends the anchor; its slot goes to the next in line.
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				await freeSlot(tx, task.id);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}

/** The anchor task definition. */
export type AnchorTask = ReturnType<typeof createAnchor>;

type Task = RunningTask<AnchorInput, AnchorState, null>;

function running(checkpoint: AnchorState): Next {
	return { status: "running", checkpoint };
}

async function queue(task: Task, runtime: Runtime, options: AnchorOptions, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const slots = await tx.doc(SlotsDoc);
		if (slots.running.length < options.maxRunning()) {
			slots.running.push(task.id);
			return running({ phase: "prepare" });
		}
		slots.queued.push(task.id);
		return {
			status: "sleeping",
			signals: [AgentSlot.key(SLOT_KEY), AgentControl.key(roundKeys(0).control)],
			checkpoint: { phase: "dequeued" },
		};
	}, context);
}

async function dequeued(runtime: Runtime, context: Context): Promise<void> {
	const control = await runtime.readSignal(AgentControl, roundKeys(0).control, context);
	// Without a stop, the slot woke it: the anchor that released the slot already moved this one into `running`.
	// With one, `release` leaves the queue, and gives back the slot if it came too.
	await runtime.commit(() => running({ phase: control === undefined ? "prepare" : "release" }), context);
}

async function prepare(task: Task, runtime: Runtime, options: AnchorOptions, context: Context): Promise<void> {
	const record = await recordOf(task, runtime, context);
	// Stopped or removed while it waited for a slot: give the slot back.
	if (record.state.kind !== "queued") {
		await runtime.commit(() => running({ phase: "release" }), context);
		return;
	}
	// Memoized, so a crash after the setup command ran does not run it again.
	const prepared =
		(await runtime.memo<Preparation>("prepared", context)) ??
		(await runtime.memo("prepared", await prepareWatched(task, runtime, record, options.setup, context), context));
	await runtime.commit(
		() => running(prepared.kind === "ready" ? { phase: "start" } : { phase: "notice", prepared }),
		context,
	);
}

/** Prepare `record`'s worktree, killing its setup command once the child is stopped or removed meanwhile. */
async function prepareWatched(
	task: Task,
	runtime: Runtime,
	record: AgentRecord,
	policy: SetupPolicy,
	context: Context,
): Promise<Preparation> {
	const stop = new AbortController();
	const check = (doc: Readonly<AgentsState>): void => {
		if (doc.agents[task.input.name]?.state.kind !== "queued") stop.abort();
	};
	const watch = await runtime.watchDoc(AgentsDoc, runtime.conversationId, context);
	if (watch !== undefined) {
		check(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") check(call.value);
		});
	}
	const closing = context.abortSignal;
	try {
		const prepared = await prepareAgent(
			record.worktree,
			policy,
			closing === undefined ? stop.signal : AbortSignal.any([stop.signal, closing]),
		);
		// Cut off by the session closing, not by a stop: prepare again when the session resumes.
		closing?.throwIfAborted();
		return prepared;
	} finally {
		await watch?.stop();
	}
}

async function notice(
	task: Task,
	runtime: Runtime,
	prepared: Noted,
	options: AnchorOptions,
	context: Context,
): Promise<void> {
	const record = await recordOf(task, runtime, context);
	const child = (await runtime.conversation(record.conversationId, context))!;
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, runtime.conversationId);
		// Stopped or removed while it was prepared: its record says so already, and a removed child stays removed.
		if (doc.agents[task.input.name]!.state.kind !== "queued") return running({ phase: "release" });
		await child.submit(tx, {
			type: "write",
			entry: { kind: "makora.notice", data: { text: setupNotice(prepared, options.settingsFile) } },
			requestId: `agent-setup:${task.id}`,
		});
		switch (prepared.kind) {
			case "ran":
				return running({ phase: "start" });
			case "skipped":
				return running({ phase: "tell", prepared });
			case "failed": {
				// The child never ran: it is stopped here, and the round its first run would have had is spent.
				const failed: AgentState = { kind: "stopped", reason: "error", detail: prepared.detail, at: runtime.now() };
				setState(doc, task.input.name, failed, 1);
				return running({ phase: "notify", round: 0, notified: false });
			}
		}
	}, context);
}

async function tell(
	task: Task,
	runtime: Runtime,
	prepared: Skipped,
	options: AnchorOptions,
	context: Context,
): Promise<void> {
	const parent = (await runtime.conversation(runtime.conversationId, context))!;
	const text = `${task.input.name}: ${setupNotice(prepared, options.settingsFile)}`;
	await runtime.commit(async (tx) => {
		await parent.submit(tx, {
			type: "write",
			entry: { kind: "makora.notice", data: { text } },
			requestId: `agent-setup-skipped:${task.id}`,
		});
		return running({ phase: "start" });
	}, context);
}

async function start(task: Task, runtime: Runtime, context: Context): Promise<void> {
	const record = await recordOf(task, runtime, context);
	const child = (await runtime.conversation(record.conversationId, context))!;
	const parentName = (await identityOf(runtime, runtime.conversationId, context))?.name ?? ROOT_NAME;
	const prepared = await runtime.memo<Preparation>("prepared", context);
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, runtime.conversationId);
		const current = doc.agents[task.input.name]!;
		if (current.state.kind !== "queued") return running({ phase: "release" });
		const siblings = Object.values(doc.agents)
			.filter((each) => each.name !== current.name && each.state.kind !== "removed")
			.map((each) => each.name);
		const keys = roundKeys(1);
		await child.submit(tx, {
			type: "input",
			content: agentBrief(current, parentName, siblings, prepared),
			requestId: `agent-task:${task.id}`,
			notify: { taskId: task.id, key: keys.settled },
		});
		setState(doc, current.name, { kind: "running" }, 1);
		const minutes = current.budget.minutes;
		return {
			status: "sleeping",
			signals: [SubmissionSettled.key(keys.settled), AgentControl.key(keys.control)],
			...(minutes === undefined ? {} : { until: runtime.now() + minutes * 60_000 }),
			checkpoint: { phase: "woke", round: 1 },
		};
	}, context);
}

async function woke(task: Task, runtime: Runtime, round: number, context: Context): Promise<void> {
	const keys = roundKeys(round);
	const control = await runtime.readSignal(AgentControl, keys.control, context);
	const settled = await runtime.readSignal(SubmissionSettled, keys.settled, context);
	const doc = (await runtime.snapshot(AgentsDoc, runtime.conversationId, context))!;
	const record = doc.agents[task.input.name]!;
	let final: Final;
	if (doc.runtime[task.input.name]!.round !== round || record.state.kind !== "running") {
		final = { kind: "taken" };
	} else if (control !== undefined && "value" in control && control.value.kind === "stop") {
		final = { kind: "stopped", reason: control.value.reason, detail: control.value.detail };
	} else if (settled !== undefined && "value" in settled) {
		final = finalOf(settled.value);
	} else {
		const minutes = record.budget.minutes ?? 0;
		final = { kind: "stopped", reason: "time", detail: `${minutes} minute${minutes === 1 ? "" : "s"} passed` };
	}
	if (final.kind === "stopped") await (await runtime.conversation(record.conversationId, context))?.abort(context);
	await runtime.commit(() => running({ phase: "settle", round, final }), context);
}

function finalOf(settled: SettledSubmissionRecord): Final {
	if (settled.status === "done" && settled.type === "input") return { kind: "done", answer: settled.answer };
	const reason = settled.status === "unanswered" ? settled.reason : "unanswered";
	if (reason === "turn_limit") return { kind: "stopped", reason: "turns", detail: "the turn budget ran out" };
	if (reason === "aborted") return { kind: "stopped", reason: "user", detail: "aborted" };
	return { kind: "stopped", reason: "error", detail: reason };
}

async function settle(
	task: Task,
	runtime: Runtime,
	checkpoint: { readonly round: number; readonly final: Final },
	options: AnchorOptions,
	context: Context,
): Promise<void> {
	const { round, final } = checkpoint;
	const record = await recordOf(task, runtime, context);
	const summary = final.kind === "done" ? await answerText(runtime, final.answer, context) : "";
	const state = await settledState(record, final, summary, options.kernels, runtime.now());
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, runtime.conversationId);
		const name = task.input.name;
		// Whoever moves the child out of `running` advances its round in the same commit.
		if (state !== undefined && doc.runtime[name]!.round === round && doc.agents[name]!.state.kind === "running") {
			setState(doc, name, state, round + 1);
		}
		return running({ phase: "notify", round, notified: false });
	}, context);
}

/**
 * The state `final` records, or undefined when a tool recorded it already, once the child's kernel is stopped and a
 * write child's work is committed to its branch (a stopped one's too, so removing it later loses nothing). A failure
 * there stops the child with the error instead.
 */
async function settledState(
	record: AgentRecord,
	final: Final,
	summary: string,
	kernels: KernelManager,
	now: number,
): Promise<AgentState | undefined> {
	try {
		// The child's kernel holds no state worth keeping: a later message restores it from its last snapshot.
		await kernels.stop(record.conversationId);
		switch (final.kind) {
			case "taken":
				if (record.state.kind === "stopped") {
					await commitWork(record, `${record.name}: unfinished work (stopped: ${record.state.reason})`, "");
				}
				return undefined;
			case "done":
				return { kind: "done", result: await finishedResult(record, summary), at: now };
			case "stopped":
				await commitWork(record, `${record.name}: unfinished work (stopped: ${final.reason})`, final.detail ?? "");
				return {
					kind: "stopped",
					reason: final.reason,
					...(final.detail === undefined ? {} : { detail: final.detail }),
					at: now,
				};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "stopped", reason: "error", detail: `could not record its result: ${message}`, at: now };
	}
}

// The answer entry belongs to the child, which the anchor's own entry reads cannot see; a commit can read any entry.
async function answerText(runtime: Runtime, answer: EntryId, context: Context): Promise<string> {
	let text = "";
	await runtime.commit(async (tx) => {
		const message = (await tx.entry(answer))?.model?.[0];
		text = message === undefined ? "" : messageText(message);
		return undefined;
	}, context);
	return text;
}

async function notify(
	task: Task,
	runtime: Runtime,
	checkpoint: { readonly round: number; readonly notified: boolean },
	context: Context,
): Promise<void> {
	const { round, notified } = checkpoint;
	const name = task.input.name;
	await runtime.commit(async (tx) => {
		const waiters = await tx.doc(WaitersDoc, runtime.conversationId);
		const target = Object.values(waiters.waiters).find((waiter) => !waiter.fired && waiter.names.includes(name));
		if (target === undefined) {
			return running(notified ? { phase: "release" } : { phase: "report", round });
		}
		const result = await tx.signal(target.task, AgentWake, target.key, { kind: "finished", name });
		// A wait that ended meanwhile is forgotten; it was not told.
		if (result === "delivered" || result === "duplicate") {
			waiters.waiters[String(target.task)] = { ...target, fired: true };
			return running({ phase: "notify", round, notified: true });
		}
		delete waiters.waiters[String(target.task)];
		return running({ phase: "notify", round, notified });
	}, context);
}

async function report(task: Task, runtime: Runtime, round: number, context: Context): Promise<void> {
	const parent = (await runtime.conversation(runtime.conversationId, context))!;
	// The parent may itself be a child, which a result reaches as it would a message.
	const parentSelf = await identityOf(runtime, runtime.conversationId, context);
	const name = task.input.name;
	await runtime.commit(async (tx) => {
		const record = (await tx.doc(AgentsDoc, runtime.conversationId)).agents[name]!;
		if (record.state.kind === "removed") return running({ phase: "release" });
		const data: AgentResultData = { name, state: record.state };
		try {
			await admitInput(
				tx,
				{ handle: parent, self: parentSelf },
				{
					content: agentResultText(name, record.state),
					entry: { kind: AGENT_RESULT_ENTRY, data },
					requestId: `agent-result:${task.id}:${round}`,
					from: "child",
				},
				"followUp",
			);
		} catch (error) {
			// A parent that is finishing or gone keeps the result in its record, where `collect` and `agents.get` read it.
			if (!(error instanceof AgentUnreachable)) throw error;
		}
		return running({ phase: "release" });
	}, context);
}

async function release(task: Task, runtime: Runtime, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(AgentsDoc, runtime.conversationId);
		await freeSlot(tx, task.id);
		return rest(doc, task.input.name);
	}, context);
}

/** Give up `id`'s running slot, if it holds one, to the first anchor in the queue; leave the queue too. */
async function freeSlot(tx: Tx, id: Task["id"]): Promise<void> {
	const slots = await tx.doc(SlotsDoc);
	const queued = slots.queued.filter((each) => each !== id);
	const holds = slots.running.includes(id);
	const next = holds ? queued[0] : undefined;
	if (next !== undefined) await tx.signal(next, AgentSlot, SLOT_KEY, {});
	slots.running = slots.running.filter((each) => each !== id);
	slots.queued = next === undefined ? queued : queued.slice(1);
	if (next !== undefined) slots.running.push(next);
}

/** After a round: sleep until the child is woken under its current round or stopped, or end once it is removed. */
function rest(doc: Readonly<AgentsState>, name: string): Next {
	if (doc.agents[name]!.state.kind === "removed") {
		return { status: "terminal", outcome: { status: "completed", result: null } };
	}
	const round = doc.runtime[name]!.round;
	const keys = roundKeys(round);
	return {
		status: "sleeping",
		signals: [SubmissionSettled.key(keys.settled), AgentControl.key(keys.control)],
		checkpoint: { phase: "woke", round },
	};
}

function setState(doc: Draft<AgentsState>, name: string, state: AgentState, round: number): void {
	doc.agents[name] = { ...doc.agents[name]!, state };
	doc.runtime[name] = { ...doc.runtime[name]!, round };
}

async function recordOf(task: Task, runtime: Runtime, context: Context): Promise<AgentRecord> {
	const doc = await runtime.snapshot(AgentsDoc, runtime.conversationId, context);
	return doc!.agents[task.input.name]!;
}
