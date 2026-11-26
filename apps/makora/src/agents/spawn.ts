// The `spawn` tool behind `await spawn(...)` in a cell: creates a child, its anchor and its record in one commit, or
// returns the child of that name when it exists, so calling it again (after a crash, or by mistake) never duplicates.
import { configure, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { type PstackConfig, spawnModel } from "../pstack.ts";
import type { AnchorTask } from "./anchor.ts";
import { AgentSelfDoc, AgentsDoc, SELF_KEY } from "./docs.ts";
import { identityOf, ROOT_NAME } from "./family.ts";
import type { AgentBudget, AgentMode, AgentRecord } from "./types.ts";
import { locateAgent, placeAgent, type WorktreeRoots } from "./worktree.ts";

/** A child of the root has depth 1; a child at this depth may not spawn. */
const MAX_DEPTH = 2;

const DEFAULT_TURNS = 50;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Names `send` reads as addresses, not as children.
const RESERVED = new Set(["parent", "all", ROOT_NAME]);

const SpawnParameters = obj({
	name: str({ description: "Lowercase letters, digits and dashes; unique among this conversation's children" }),
	task: str({ description: "What the child should do, as its first message" }),
	mode: oneOf(["write", "review"] as const),
	ref: opt(str({ description: "review: the commit to check out; default HEAD" })),
	base: opt(str({ description: "write: where the child's branch starts; default HEAD" })),
	model: opt(
		str({
			description:
				'"code" or "judge" for a pstack tier, or provider/modelId (at the thinking level of a pstack role seat on it); default: this conversation\'s model',
		}),
	),
	budget: opt(obj({ usd: opt(num()), minutes: opt(num()), turns: opt(int({ minimum: 1 })) })),
});

/** What `spawn` runs on. */
export type SpawnOptions = {
	readonly sessionId: string;
	readonly roots: () => WorktreeRoots;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
	readonly anchor: AnchorTask;
	/** The pstack tiers and role seats `model=` resolves to, read at each spawn. */
	readonly pstack: () => PstackConfig;
	/** Tell the user something about the session, such as a tier or role seat that fell back to the session model. */
	readonly notify: (message: string) => void;
};

/** The `spawn` tool; children below `MAX_DEPTH` get it too, the deepest ones do not. */
export function createSpawnTool(options: SpawnOptions): ToolRegistration<typeof SpawnParameters> {
	const tool: ToolRegistration<typeof SpawnParameters> = defineTool({
		name: "spawn",
		description: "Start a subagent in its own worktree and Python REPL, or return the existing one of that name.",
		parameters: SpawnParameters,
		structuredOutputSchema: unknown(),
		callers: ["tools"],
		async execute(args, api, context) {
			const self = await identityOf(api, api.conversationId, context);
			const depth = (self?.depth ?? 0) + 1;
			if (depth > MAX_DEPTH) {
				throw new Error(
					`${self?.name} is a subagent at depth ${depth - 1}; only depths below ${MAX_DEPTH} may spawn`,
				);
			}
			if (!NAME.test(args.name) || RESERVED.has(args.name)) {
				throw new Error(
					`Bad name ${JSON.stringify(args.name)}: use lowercase letters, digits and dashes, not ${[...RESERVED].join(", ")}`,
				);
			}
			const existing = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents[args.name];
			if (existing !== undefined) return result(existing);
			const mode: AgentMode = args.mode;
			const agent = await api.agent(context);
			const available = args.model === undefined ? [] : await api.models.getAvailable();
			const chosen = spawnModel(args.model, options.pstack(), {
				exists: (ref) => api.models.getModel(ref.provider, ref.modelId) !== undefined,
				usable: (ref) => available.some((each) => each.provider === ref.provider && each.id === ref.modelId),
			});
			if (chosen.kind === "refused") throw new Error(chosen.reason);
			if (chosen.kind === "parent" && chosen.notice !== undefined) options.notify(`${args.name}: ${chosen.notice}`);
			const model = chosen.kind === "model" ? chosen.model : undefined;
			const thinkingLevel = chosen.kind === "model" ? chosen.thinkingLevel : undefined;
			const placement = await placeAgent(
				agent.cwd ?? options.defaultCwd,
				mode,
				(mode === "review" ? args.ref : args.base) ?? "HEAD",
				options.roots(),
			);
			const budget: AgentBudget = {
				turns: args.budget?.turns ?? DEFAULT_TURNS,
				...(args.budget?.usd === undefined ? {} : { usd: args.budget.usd }),
				...(args.budget?.minutes === undefined ? {} : { minutes: args.budget.minutes }),
			};
			await api.commit(async (tx) => {
				const doc = await tx.doc(AgentsDoc, api.conversationId);
				// Two calls for one name (`asyncio.gather` in a cell) race here; the first commit's child stands.
				if (doc.agents[args.name] !== undefined) return;
				// Owned by the conversation, not by this call or the cell that made it: a crashed cell keeps its children.
				const anchor = await tx.createTask(
					options.anchor,
					{ name: args.name },
					{ ownership: { kind: "conversation" }, background: true },
				);
				// Starts as a copy of this conversation's agent: extensions, tools, model, thinking level.
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				const worktree = locateAgent(placement, mode, args.name, options.sessionId, child.id);
				await configure(tx, child.id, {
					cwd: worktree.cwd,
					maxTurns: budget.turns,
					...(model === undefined ? {} : { model }),
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
					...(depth < MAX_DEPTH ? {} : { tools: { remove: [tool] } }),
				});
				await tx.doc(AgentSelfDoc, child.id, SELF_KEY, {
					name: args.name,
					parentConversationId: api.conversationId,
					depth,
				});
				const created: AgentRecord = {
					name: args.name,
					conversationId: child.id,
					parentConversationId: api.conversationId,
					depth,
					mode,
					task: args.task,
					...(model === undefined ? {} : { model }),
					worktree,
					budget,
					createdAt: api.now(),
					state: { kind: "queued" },
				};
				doc.agents[args.name] = created;
				doc.runtime[args.name] = { anchor, round: 0 };
			}, context);
			return result((await api.snapshot(AgentsDoc, api.conversationId, context))!.agents[args.name]!);
		},
	});
	return tool;
}

function result(record: Readonly<AgentRecord>) {
	return {
		output: [{ type: "text" as const, text: `${record.name}: ${record.state.kind}` }],
		structuredOutput: record,
	};
}
