import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import { reviewRequest } from "../src/review/request.ts";
import { openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { discoverSkills, type Skill } from "../src/skills.ts";
import { messageText } from "../src/transcript-rows.ts";

const context = BACKGROUND_CONTEXT;

type Workspace = { readonly home: string; readonly repo: string };

/** A temp makora home and a git repository with two commits. */
function workspace(): Workspace {
	// The real path: git reports top levels with macOS's /var -> /private/var link resolved.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-review-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	git(repo, ["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "README.md"), "# demo\n");
	commit(repo, "init");
	writeFileSync(join(repo, "README.md"), "# demo\n\nusage: run it\n");
	commit(repo, "docs: usage");
	return { home, repo };
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo: string, message: string): void {
	git(repo, ["add", "-A"]);
	git(repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", message]);
}

function reviewSkill(where: Workspace): Skill {
	const skill = discoverSkills({ cwd: where.repo, makoraHome: where.home, userHome: homedir() }).find(
		(each) => each.name === "review",
	);
	assert.ok(skill !== undefined, "makora bundles review");
	return skill;
}

function text(request: Awaited<ReturnType<typeof reviewRequest>>): string {
	return request.kind === "submit" ? request.text : "";
}

describe("the target /review asks for", () => {
	it("defaults to uncommitted changes, takes a range or a pull request, and refuses what has nothing to review", async () => {
		const where = workspace();
		const skill = reviewSkill(where);
		assert.equal((await reviewRequest(skill, where.repo, "")).kind, "refused");
		writeFileSync(join(where.repo, "README.md"), "# demo\n\nusage: run it twice\n");
		writeFileSync(join(where.repo, "new.txt"), "new\n");
		const uncommitted = await reviewRequest(skill, where.repo, "");
		assert.match(text(uncommitted), /^<skill name="review" /);
		assert.match(text(uncommitted), /\n\nTarget: uncommitted changes$/);
		assert.match(uncommitted.kind === "submit" ? uncommitted.summary : "", /uncommitted changes, 2 files/);
		assert.match(
			text(await reviewRequest(skill, where.repo, "HEAD~1..HEAD")),
			/\n\nTarget: HEAD~1\.\.HEAD \(1 commit\)$/,
		);
		assert.match(text(await reviewRequest(skill, where.repo, "#42")), /\n\nTarget: pull request #42$/);
		assert.match(text(await reviewRequest(skill, where.repo, "42")), /\n\nTarget: pull request #42$/);
		assert.equal((await reviewRequest(skill, where.repo, "HEAD..HEAD")).kind, "refused");
		assert.equal((await reviewRequest(skill, where.repo, "no-such-ref")).kind, "refused");
		assert.equal((await reviewRequest(skill, where.home, "")).kind, "refused");
	});
});

describe("/review with the fake model", () => {
	it("fans out review subagents in one cell and collects what each handed back", async () => {
		const where = workspace();
		const app = openApp(where.home, true);
		const session = await openSession(app, createSession(app.paths.sessions, where.repo), {}, context);
		try {
			const request = await reviewRequest(reviewSkill(where), where.repo, "HEAD~1..HEAD");
			assert.equal(request.kind, "submit");
			const submission = await session.submit(session.root, text(request), context);
			assert.equal((await submission!.wait(context)).status, "done");
			const page = await session.root.entries({ order: "descending" }, 50, undefined, context);
			const cells = page.items
				.map((entry) => entry.model?.[0])
				.filter((message) => message?.role === "toolResult" && message.toolName === "python")
				.map((message) => messageText(message!));
			assert.equal(cells.length, 1, "the fan-out is one cell");
			assert.match(cells[0]!, /^slice-a done /m);
			assert.match(cells[0]!, /^slice-b done /m);
		} finally {
			await session.close();
		}
	});
});
