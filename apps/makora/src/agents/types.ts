// The subagent model the runtime keeps in Durable and the dashboard reads: one record per child of a conversation.
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";

/** `write`: a branch to merge back. `review`: a throwaway checkout of the commit under review. */
export type AgentMode = "write" | "review";

/** Limits a child runs under; turns always has a value, the others are optional. */
export type AgentBudget = {
	readonly turns: number;
	readonly usd?: number;
	readonly minutes?: number;
};

/** Where a child works. */
export type AgentWorktree =
	| {
			readonly kind: "worktree";
			/** The repository the worktree belongs to: the parent's top level, where git commands for it run. */
			readonly repository: string;
			/** Absolute path of the child's working directory (the worktree plus the parent's subdirectory). */
			readonly cwd: string;
			/** Absolute path of the worktree root. */
			readonly root: string;
			/** The commit the worktree started at. */
			readonly baseCommit: string;
			/** The ref the caller named (`HEAD`, `main`, a sha), as given. */
			readonly baseRef: string;
			/** Write mode only: the branch the child commits to. */
			readonly branch?: string;
	  }
	/** Outside a git repository the child shares the parent's folder. */
	| { readonly kind: "shared"; readonly cwd: string };

/** What a finished child hands back. */
export type AgentResult =
	| { readonly mode: "review"; readonly summary: string }
	| {
			readonly mode: "write";
			readonly summary: string;
			/** The branch head after the child's work was committed. */
			readonly headCommit: string;
			readonly diffStat: { readonly files: number; readonly added: number; readonly removed: number };
	  }
	/** A child that shared the parent's folder (outside git): its changes are already there, nothing to merge. */
	| { readonly mode: "shared"; readonly summary: string };

/** Why a child stopped before finishing. */
export type StopReason = "user" | "cost" | "time" | "turns" | "error" | "parent";

/** A child's lifecycle. */
export type AgentState =
	| { readonly kind: "queued" }
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly result: AgentResult; readonly at: number }
	| { readonly kind: "stopped"; readonly reason: StopReason; readonly detail?: string; readonly at: number }
	| { readonly kind: "merged"; readonly result: AgentResult; readonly mergeCommit: string; readonly at: number }
	| { readonly kind: "removed"; readonly at: number };

/** One child of a conversation, keyed by its name among its siblings. */
export type AgentRecord = {
	readonly name: string;
	readonly conversationId: ConversationId;
	readonly parentConversationId: ConversationId;
	/** 1 for a child of the root, 2 for a grandchild. */
	readonly depth: number;
	readonly mode: AgentMode;
	readonly task: string;
	readonly model?: ModelRef;
	readonly worktree: AgentWorktree;
	readonly budget: AgentBudget;
	readonly createdAt: number;
	readonly state: AgentState;
};

/** The `makora.agents` document of a conversation: its children, by name. */
export type AgentsDocument = {
	readonly agents: Readonly<Record<string, AgentRecord>>;
};

/** One message between agents, as the dashboard shows it. `from`/`to` are agent names, or `main` for the root. */
export type AgentMessage = {
	readonly from: string;
	readonly to: string;
	readonly fromConversationId: ConversationId;
	readonly toConversationId: ConversationId;
	readonly text: string;
	readonly at: number;
};

/** The `makora.agent-messages` session document: the newest messages between the session's agents, oldest first. */
export type AgentMessageLog = {
	readonly messages: AgentMessage[];
};
