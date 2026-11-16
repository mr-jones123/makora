// A subagent's files: where its worktree goes (review checkouts under the review root, write branches under the write
// root), adding it again when it went missing, the project's setup command once the user approved it, committing a
// write child's work, and removing the worktree.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { git, MAKORA_AUTHOR } from "../repl/git-tree.ts";
import { addWorktree, findRepo, type RepoPlace, removeWorktree, worktreePath } from "../worktrees.ts";
import type { AgentMode, AgentRecord, AgentResult, AgentWorktree } from "./types.ts";

/** The worktree roots, resolved from the settings and their defaults. */
export type WorktreeRoots = { readonly review: string; readonly write: string };

/** Where a new child's files come from, decided before its conversation id is known. */
export type AgentPlacement =
	| {
			readonly kind: "worktree";
			readonly repo: RepoPlace;
			readonly root: string;
			readonly baseRef: string;
			readonly baseCommit: string;
	  }
	| { readonly kind: "shared"; readonly cwd: string };

/**
 * Place a `mode` child of the conversation working in `cwd`: a worktree of its repository at `ref` (review) or on a
 * branch from `ref` (write), or the shared folder outside git. Throws when `ref` names no commit.
 */
export async function placeAgent(
	cwd: string,
	mode: AgentMode,
	ref: string,
	roots: WorktreeRoots,
): Promise<AgentPlacement> {
	const repo = await findRepo(cwd);
	if (repo === undefined) return { kind: "shared", cwd };
	const baseCommit = await git(repo.top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => {
		throw new Error(`${ref} names no commit in ${repo.top}`);
	});
	return { kind: "worktree", repo, root: mode === "review" ? roots.review : roots.write, baseRef: ref, baseCommit };
}

/** The child's worktree once its conversation id is known; a write child's branch is unique per session and child. */
export function locateAgent(
	placement: AgentPlacement,
	mode: AgentMode,
	name: string,
	sessionId: string,
	id: ConversationId,
): AgentWorktree {
	if (placement.kind === "shared") return { kind: "shared", cwd: placement.cwd };
	const root = worktreePath(placement.root, placement.repo, sessionId, id);
	return {
		kind: "worktree",
		repository: placement.repo.top,
		cwd: join(root, placement.repo.relative),
		root,
		baseCommit: placement.baseCommit,
		baseRef: placement.baseRef,
		...(mode === "write" ? { branch: `makora/${name}-${sessionId.slice(-6)}-${id}` } : {}),
	};
}

/**
 * Give the child its worktree when it has none: before it first runs, and when the folder went missing (a review
 * checkout in a cleaned temp folder) before its next cell. A review checkout comes back at the same commit, a write
 * worktree on its branch. Returns whether it was added now.
 */
export async function ensureAgentWorktree(worktree: AgentWorktree): Promise<boolean> {
	if (worktree.kind === "shared" || existsSync(worktree.root)) return false;
	await addWorktree(
		worktree.repository,
		worktree.root,
		worktree.branch === undefined
			? { kind: "detached", commit: worktree.baseCommit }
			: { kind: "branch", branch: worktree.branch, base: worktree.baseCommit },
	);
	// The parent's folder may be one git does not track, such as an empty or ignored one.
	mkdirSync(worktree.cwd, { recursive: true });
	return true;
}

/** A repository's setup command a new worktree needs, and its SHA-256, which an approval names. */
export type SetupRequest = { readonly repository: string; readonly command: string; readonly sha256: string };

/** What a setup command needs from the user: their approval, and how long it may run. */
export type SetupPolicy = {
	/** Whether the user approved `request`, asking them when the session can; false when it cannot ask. */
	readonly approve: (request: SetupRequest) => Promise<boolean>;
	/** Read at each run. */
	readonly timeoutMinutes: () => number;
};

/** How preparing a new child's worktree ended. */
export type Preparation =
	| { readonly kind: "ready" }
	/** The setup command ran and exited 0. */
	| { readonly kind: "ran"; readonly output: string }
	/** The user has not approved the setup command: the child starts without it. */
	| { readonly kind: "skipped"; readonly request: SetupRequest }
	/** The worktree could not be added, or the setup command failed, ran too long or was stopped. */
	| { readonly kind: "failed"; readonly detail: string; readonly output: string };

const READY: Preparation = { kind: "ready" };
const STOPPED = { kind: "failed", detail: "worktree setup was stopped", output: "" } as const satisfies Preparation;

/**
 * Give a new child its worktree, then run `<repository>/.makora/settings.json`'s `worktreeSetup` in it when the user
 * approved that command for that repository. The command is killed with what it started past its time limit or once
 * `signal` aborts. Never throws: a failure is a `failed` preparation, so the anchor can stop the child and go on.
 */
export async function prepareAgent(
	worktree: AgentWorktree,
	policy: SetupPolicy,
	signal: AbortSignal,
): Promise<Preparation> {
	if (worktree.kind === "shared") return READY;
	try {
		await ensureAgentWorktree(worktree);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "failed", detail: `could not add its worktree: ${message}`, output: message };
	}
	const command = projectSetupCommand(worktree.repository);
	if (command === undefined) return READY;
	const sha256 = createHash("sha256").update(command).digest("hex");
	const request: SetupRequest = { repository: worktree.repository, command, sha256 };
	let approved: boolean;
	try {
		approved = await Promise.race([policy.approve(request), aborted(signal)]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "failed", detail: `could not ask to approve its worktree setup: ${message}`, output: message };
	}
	if (signal.aborted) return STOPPED;
	if (!approved) return { kind: "skipped", request };
	return runSetup(command, worktree.root, policy.timeoutMinutes(), signal);
}

/** Resolves false once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<false> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve(false);
		else signal.addEventListener("abort", () => resolve(false), { once: true });
	});
}

// `.makora/settings.json` is the project's own file: the trust boundary of the setup command, which runs only once the
// user approved it.
function projectSetupCommand(repository: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(repository, ".makora", "settings.json"), "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const { worktreeSetup } = raw as Record<string, unknown>;
		return typeof worktreeSetup === "string" && worktreeSetup.trim() !== "" ? worktreeSetup : undefined;
	} catch {
		return undefined;
	}
}

/** The setup output a notice keeps: its end, where the error is. */
const OUTPUT_LIMIT = 64 * 1024;

/**
 * Run `command` with `sh -c` in `cwd` and the trimmed environment, in a process group of its own so a kill reaches what
 * it started: after `minutes`, or once `signal` aborts.
 */
function runSetup(command: string, cwd: string, minutes: number, signal: AbortSignal): Promise<Preparation> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], { cwd, env: setupEnv(), detached: true, stdio: "pipe" });
		child.stdin.end();
		let output = "";
		const append = (chunk: Buffer): void => {
			output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		let killed: string | undefined;
		const kill = (why: string): void => {
			if (killed !== undefined || child.pid === undefined) return;
			killed = why;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group exited already.
			}
		};
		const timer = setTimeout(
			() => kill(`worktree setup timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`),
			minutes * 60_000,
		);
		const onAbort = (): void => kill(STOPPED.detail);
		signal.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null, error?: Error): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			const text = `$ ${command}\n${output}${error === undefined ? "" : error.message}`.trimEnd();
			if (killed !== undefined) resolve({ kind: "failed", detail: killed, output: `${text}\n${killed}` });
			else if (code === 0) resolve({ kind: "ran", output: text });
			else resolve({ kind: "failed", detail: "worktree setup failed", output: text });
		};
		child.on("error", (error) => finish(null, error));
		child.on("close", (code) => finish(code));
		// A killed command's own children may hold its output open; its exit is the end then.
		child.on("exit", (code) => {
			if (killed !== undefined) finish(code);
		});
		if (signal.aborted) onAbort();
	});
}

// Credentials a setup command has no use for: anything named like a key, token or secret, and what pi-ai reads for
// provider auth under other names.
const SECRET_NAME = /(_API_KEY|_TOKEN|_SECRET)$/;
const PROVIDER_AUTH = new Set([
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_PROFILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
]);

/** makora's environment without provider credentials. */
function setupEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !SECRET_NAME.test(name) && !PROVIDER_AUTH.has(name)),
	);
}

/**
 * What a finished child hands back. A write child's uncommitted changes are committed to its branch first, so a rerun
 * after a crash finds nothing left to commit and returns the same head.
 */
export async function finishedResult(record: AgentRecord, summary: string): Promise<AgentResult> {
	const { worktree } = record;
	if (worktree.kind === "shared") return { mode: "shared", summary };
	if (record.mode === "review") return { mode: "review", summary };
	const title = summary.split("\n").find((line) => line.trim() !== "") ?? "work";
	await commitWork(record, `${record.name}: ${title.slice(0, 72)}`, summary);
	const headCommit = await git(worktree.root, ["rev-parse", "HEAD"]);
	return {
		mode: "write",
		summary,
		headCommit,
		diffStat: await diffStat(worktree.root, worktree.baseCommit, headCommit),
	};
}

/**
 * Commit what write child `record` left uncommitted to its branch, as makora. The repository's hooks and commit signing
 * are skipped: a failing hook or a signing key waiting for a passphrase must not lose or hold up the child's work.
 * Does nothing for a review child, a clean tree, or a worktree that is not on disk.
 */
export async function commitWork(record: AgentRecord, title: string, body: string): Promise<void> {
	const { worktree } = record;
	if (record.mode !== "write" || worktree.kind !== "worktree" || !existsSync(worktree.root)) return;
	const top = worktree.root;
	if ((await git(top, ["status", "--porcelain"])).length === 0) return;
	const env = { ...process.env, ...MAKORA_AUTHOR };
	await git(top, ["add", "-A"], env);
	const message = ["-m", title, ...(body === "" ? [] : ["-m", body])];
	const unhooked = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
	await git(top, [...unhooked, "commit", "--no-verify", "-q", ...message], env);
}

async function diffStat(
	top: string,
	base: string,
	head: string,
): Promise<{ files: number; added: number; removed: number }> {
	const lines = (await git(top, ["diff", "--numstat", base, head])).split("\n").filter((line) => line !== "");
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		// Binary files show `-` for both counts.
		const [plus, minus] = line.split("\t");
		added += Number.parseInt(plus ?? "", 10) || 0;
		removed += Number.parseInt(minus ?? "", 10) || 0;
	}
	return { files: lines.length, added, removed };
}

/**
 * Delete the child's worktree. A merged write child's branch goes too; an unmerged one is kept, with what the child left
 * uncommitted committed to it first. Converges.
 */
export async function removeAgentWorktree(record: AgentRecord, merged: boolean): Promise<void> {
	const { worktree } = record;
	if (worktree.kind === "shared") return;
	if (!merged) await commitWork(record, `${record.name}: unfinished work (removed)`, "");
	await removeWorktree(worktree.repository, worktree.root);
	if (merged && worktree.branch !== undefined) {
		await git(worktree.repository, ["branch", "-D", worktree.branch]).catch(() => undefined);
	}
}
