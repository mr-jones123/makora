// The `makora-agents` extension: the subagent tools cells call, the anchor task that drives each child, and the hooks
// that keep a child's worktree in place and its spend under its budget.
import {
	defineExtension,
	type Extension,
	GenerationTask,
	hook,
	hookTask,
	type ToolRegistration,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { KernelManager } from "../kernel/manager.ts";
import { totalCost } from "../usage.ts";
import { createAnchor } from "./anchor.ts";
import { CostStop } from "./budget.ts";
import { createControlTools } from "./control.ts";
import { AgentsDoc } from "./docs.ts";
import { identityOf } from "./family.ts";
import { sendTool } from "./messaging.ts";
import { agentsTool } from "./read.ts";
import { createSpawnTool } from "./spawn.ts";
import { collectTool, waitAgentsTool } from "./wait.ts";
import { ensureAgentWorktree, type SetupPolicy, type WorktreeRoots } from "./worktree.ts";

/** What the subagents of one session run on. */
export type AgentsOptions = {
	readonly kernels: KernelManager;
	readonly sessionId: string;
	/** The cwd of a conversation whose agent sets none. */
	readonly defaultCwd: string;
	/** Read at each spawn, so a settings change applies to the next child. */
	readonly roots: () => WorktreeRoots;
	readonly maxRunning: () => number;
	readonly setup: SetupPolicy;
	/** The user's settings file, where setup approvals go. */
	readonly settingsFile: string;
};

/** The subagents of one session: their extension, and `wait_agents`, which the model is offered next to `python`. */
export type Agents = { readonly extension: Extension; readonly waitAgents: ToolRegistration };

/** The subagent tools, tasks and hooks over `options`. */
export function createAgents(options: AgentsOptions): Agents {
	const anchor = createAnchor({
		kernels: options.kernels,
		maxRunning: options.maxRunning,
		setup: options.setup,
		settingsFile: options.settingsFile,
	});
	const spawn = createSpawnTool({
		sessionId: options.sessionId,
		roots: options.roots,
		defaultCwd: options.defaultCwd,
		anchor,
	});
	const extension = defineExtension({
		name: "makora-agents",
		tools: [
			spawn,
			collectTool,
			sendTool,
			...createControlTools({ kernels: options.kernels, defaultCwd: options.defaultCwd }),
			agentsTool,
			waitAgentsTool,
		],
		tasks: [anchor, CostStop],
		hooks: [
			hook(ToolTask, {
				// A review checkout in a cleaned temp folder, or a worktree deleted by hand, comes back before the child's
				// next cell runs in it.
				beforeTool: async (call, api, context) => {
					if (call.name !== "python") return undefined;
					const self = await identityOf(api, api.conversationId, context);
					if (self === undefined) return undefined;
					const record = (await api.snapshot(AgentsDoc, self.parentConversationId, context))?.agents[self.name];
					if (record !== undefined) await ensureAgentWorktree(record.worktree);
					return undefined;
				},
			}),
			hook(GenerationTask, {
				// Spend is checked after each tool round; past the budget the child's anchor stops it.
				afterTools: async (_assistant, _results, api, context) => {
					const self = await identityOf(api, api.conversationId, context);
					if (self === undefined) return undefined;
					const doc = await api.snapshot(AgentsDoc, self.parentConversationId, context);
					const record = doc?.agents[self.name];
					const usd = record?.budget.usd;
					if (usd === undefined || record?.state.kind !== "running") return undefined;
					const spent = totalCost(await api.snapshot(UsageDoc, api.conversationId, context));
					if (spent <= usd) return undefined;
					const { anchor: anchorId, round } = doc!.runtime[self.name]!;
					const detail = `spent $${spent.toFixed(4)} of $${usd}`;
					return { tasks: [hookTask(CostStop, { anchor: anchorId, round, detail })] };
				},
			}),
		],
	});
	return { extension, waitAgents: waitAgentsTool };
}
