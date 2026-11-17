#!/usr/bin/env node
// Checks commit messages against `type(scope)!: subject` (scripts/release/commits.ts), in the repository of the cwd.
// Usage: node apps/makora/scripts/commit-lint.mjs <base> <head>          the first-parent commits of base..head; merge
//                                                                       commits and what they merge are skipped
//        node apps/makora/scripts/commit-lint.mjs --message-file <path>  one message, as the commit-msg hook passes it
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMMIT_TYPES, parseCommitMessage } from "./release/commits.ts";
import { firstParentCommits } from "./release/repo.ts";

const FORMAT = `type(scope)!: subject, with type one of ${COMMIT_TYPES.join(", ")}; scope and ! are optional`;

const { values, positionals } = parseArgs({ options: { "message-file": { type: "string" } }, allowPositionals: true });

if (values["message-file"] !== undefined) {
	// git leaves its `#` help lines in the file, and `commit -v` the diff below a scissors line; `git commit --fixup`
	// and friends are squashed away before they land.
	const message = readFileSync(values["message-file"], "utf8")
		.split(/^# -+ >8 -+$/m)[0]
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.trim();
	const parsed = parseCommitMessage(message);
	if (parsed.kind === "invalid" && !/^(fixup|squash|amend)! /.test(message)) {
		console.error(`commit-msg: "${message.split("\n")[0]}" ${parsed.reason}.\nUse ${FORMAT}.`);
		process.exit(1);
	}
} else {
	const [base, head = "HEAD"] = positionals;
	const bad = firstParentCommits(process.cwd(), base, head)
		.filter((commit) => !commit.merge)
		.flatMap((commit) => {
			const parsed = parseCommitMessage(commit.message);
			return parsed.kind === "invalid"
				? [`${commit.sha.slice(0, 12)} "${commit.message.split("\n")[0]}": ${parsed.reason}`]
				: [];
		});
	if (bad.length > 0) {
		console.error(`These commits do not follow ${FORMAT}:\n${bad.map((line) => `  ${line}`).join("\n")}`);
		console.error("Reword them (git rebase -i) and push again.");
		process.exit(1);
	}
	console.log("Commit messages follow the conventional format.");
}
