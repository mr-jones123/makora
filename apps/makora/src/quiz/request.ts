// What `/quiz [range | all]` asks the agent: the session-quiz skill and the commit range it covers, by default the
// commits made on the current branch since the session started.
import { git } from "../repl/git-tree.ts";
import { type Skill, skillMessage } from "../skills.ts";

/** The message `/quiz` submits and the line the TUI shows for it, or why there is nothing to quiz on. */
export type QuizRequest =
	| { readonly kind: "submit"; readonly text: string; readonly summary: string }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * The request for `/quiz <args>` in `cwd`, for a session started at `sessionStart` (epoch ms): `args` is empty (this
 * session's commits), `all` (the project's whole history, which the skill narrows down), or a revision range.
 */
export async function quizRequest(skill: Skill, cwd: string, sessionStart: number, args: string): Promise<QuizRequest> {
	if ((await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined)) === undefined) {
		return { kind: "refused", reason: `/quiz needs a git repository; ${cwd} is not in one.` };
	}
	if (args === "all") {
		return request(skill, "all (the project's whole history)", "the project's whole history");
	}
	if (args !== "") {
		const commits = await count(cwd, args);
		if (commits === undefined) return { kind: "refused", reason: `/quiz: git cannot read the range ${args}.` };
		if (commits === 0) return { kind: "refused", reason: `/quiz: ${args} has no commits.` };
		return request(skill, `${args} (${plural(commits)})`, `${args}, ${plural(commits)}`);
	}
	const started = new Date(sessionStart);
	const before = `@${Math.floor(sessionStart / 1000)}`;
	const base = await git(cwd, ["rev-list", "-1", "--first-parent", `--before=${before}`, "HEAD"]).catch(() => "");
	const range = base === "" ? "HEAD" : `${base.slice(0, 12)}..HEAD`;
	const commits = (await count(cwd, range)) ?? 0;
	if (commits === 0) {
		return {
			kind: "refused",
			reason: `No commits on this branch since this session started (${started.toLocaleString()}). Use /quiz <rev-range> or /quiz all.`,
		};
	}
	const why = `the ${plural(commits)} on this branch since this session started at ${started.toISOString()}`;
	return request(skill, `${range} (${why})`, `${range}, ${plural(commits)} of this session`);
}

function request(skill: Skill, range: string, summary: string): QuizRequest {
	return {
		kind: "submit",
		text: skillMessage(skill, `Range: ${range}`),
		summary: `Quiz on ${summary}: the agent is writing 10 questions; the page opens when they are ready.`,
	};
}

async function count(cwd: string, range: string): Promise<number | undefined> {
	const output = await git(cwd, ["rev-list", "--count", "--end-of-options", range, "--"]).catch(() => undefined);
	return output === undefined ? undefined : Number(output);
}

function plural(commits: number): string {
	return `${commits} commit${commits === 1 ? "" : "s"}`;
}
