// What `/review [range | #pr]` asks the agent: the review skill and the change it covers, by default the working
// tree's uncommitted changes.
import { git } from "../repl/git-tree.ts";
import { type Skill, skillMessage } from "../skills.ts";

/** The message `/review` submits and the line the TUI shows for it, or why there is nothing to review. */
export type ReviewRequest =
	| { readonly kind: "submit"; readonly text: string; readonly summary: string }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * The request for `/review <args>` in `cwd`: `args` is empty (the uncommitted changes), a pull request number
 * (`#123` or `123`, which the skill reads with `gh`), or a revision range.
 */
export async function reviewRequest(skill: Skill, cwd: string, args: string): Promise<ReviewRequest> {
	if ((await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined)) === undefined) {
		return { kind: "refused", reason: `/review needs a git repository; ${cwd} is not in one.` };
	}
	const pr = /^#?(\d+)$/.exec(args)?.[1];
	if (pr !== undefined) return request(skill, `pull request #${pr}`, `pull request #${pr}`);
	if (args !== "") {
		const output = await git(cwd, ["rev-list", "--count", "--end-of-options", args, "--"]).catch(() => undefined);
		if (output === undefined) return { kind: "refused", reason: `/review: git cannot read the range ${args}.` };
		const commits = Number(output);
		if (commits === 0) return { kind: "refused", reason: `/review: ${args} has no commits.` };
		return request(skill, `${args} (${commits} commit${commits === 1 ? "" : "s"})`, args);
	}
	const status = await git(cwd, ["status", "--porcelain"]);
	if (status === "") {
		return {
			kind: "refused",
			reason: "No uncommitted changes to review. Use /review <rev-range> or /review #<pr>.",
		};
	}
	const files = status.split("\n").length;
	return request(skill, "uncommitted changes", `the uncommitted changes, ${files} file${files === 1 ? "" : "s"}`);
}

function request(skill: Skill, target: string, summary: string): ReviewRequest {
	return {
		kind: "submit",
		text: skillMessage(skill, `Target: ${target}`),
		summary: `Review of ${summary}: the agent splits it among review subagents and reports what it confirms.`,
	};
}
