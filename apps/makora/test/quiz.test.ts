import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import type { QuizPage } from "../src/quiz/page.ts";
import { quizRequest } from "../src/quiz/request.ts";
import { type MakoraSession, openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { discoverSkills } from "../src/skills.ts";
import { messageText } from "../src/transcript-rows.ts";

const context = BACKGROUND_CONTEXT;

type Workspace = { readonly home: string; readonly repo: string; readonly base: string; readonly session: string[] };

/** A temp makora home and a git repository: a base commit from 2020, then two commits made during the session. */
function workspace(): Workspace {
	// The real path: git reports top levels with macOS's /var -> /private/var link resolved.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-quiz-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	git(repo, ["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "README.md"), "# demo\n");
	commit(repo, "init", "2020-01-01T00:00:00Z");
	const base = git(repo, ["rev-parse", "HEAD"]);
	const later = new Date(Date.now() + 60_000).toISOString();
	writeFileSync(join(repo, "page.html"), "<p>before</p>\n</script><img src=x onerror=alert(1)>\n");
	commit(repo, "feat: a page that says </script>", later);
	writeFileSync(join(repo, "README.md"), "# demo\n\nusage: run it\n");
	commit(repo, "docs: usage", later);
	const session = git(repo, ["rev-list", "--reverse", `${base}..HEAD`]).split("\n");
	return { home, repo, base, session };
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

function commit(repo: string, message: string, date: string): void {
	git(repo, ["add", "-A"]);
	git(repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", message], {
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	});
}

/** A bank of 10 questions on the workspace's session commits. */
function bank(where: Workspace) {
	const [page, docs] = where.session.map((sha) => sha.slice(0, 8)) as [string, string];
	return {
		range: `${where.base.slice(0, 12)}..HEAD`,
		summaries: { [page]: "Adds a page whose text closes a script tag.", [docs]: "Documents how to run it." },
		decisions: [{ title: "Usage in the README", summary: "Users read the README first." }],
		annotations: [
			{
				commit: page,
				file: "page.html",
				line: 2,
				side: "new" as const,
				comment: "Closes a script tag in `page.html`: </script><img src=x onerror=alert(1)>.",
			},
			{
				commit: docs,
				file: "README.md",
				line: 3,
				side: "new" as const,
				comment: "The usage line the decision asks for.",
				cites: ["Usage in the README"],
			},
		],
		questions: Array.from({ length: 10 }, (_, index) => ({
			question: `Quiz question ${index + 1}: why does the README carry usage?`,
			options: [
				`Users read it first (${index})`,
				`Git needs it (${index})`,
				`Tests read it (${index})`,
				`No reason (${index})`,
			],
			correct: 0,
			explanation: "The decision says users read the README first.",
			category: "why",
			cites: [index % 2 === 0 ? docs : page, "Usage in the README", "README.md:3"],
		})),
	};
}

async function open(where: Workspace, opened: string[]): Promise<MakoraSession> {
	const app = openApp(where.home, true);
	const meta = createSession(app.paths.sessions, where.repo);
	return openSession(
		app,
		meta,
		{
			openBrowser: async (path) => {
				opened.push(path);
				return true;
			},
		},
		context,
	);
}

/** Submit `/quiz <args>`'s message to the root and wait; returns the output of the run's python cell. */
async function quiz(session: MakoraSession, where: Workspace, args: string): Promise<string> {
	const skill = discoverSkills({ cwd: where.repo, makoraHome: where.home, userHome: homedir() }).find(
		(each) => each.name === "session-quiz",
	);
	assert.ok(skill !== undefined, "makora bundles session-quiz");
	const request = await quizRequest(skill, where.repo, session.meta.createdAt, args);
	assert.equal(request.kind, "submit");
	if (request.kind !== "submit") return "";
	const submission = await session.submit(session.root, request.text, context);
	assert.equal((await submission!.wait(context)).status, "done");
	const page = await session.root.entries({ order: "descending" }, 50, undefined, context);
	for (const entry of page.items) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult" && message.toolName === "python") return messageText(message);
	}
	throw new Error("no python cell");
}

function pageData(html: string): QuizPage {
	const open = '<script id="quiz-data" type="application/json">';
	const start = html.indexOf(open) + open.length;
	return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

describe("/quiz with the fake model", () => {
	it("publishes the bank: a page with the questions and makora's own diffs, opened once, announced to the user", async () => {
		const where = workspace();
		const opened: string[] = [];
		const session = await open(where, opened);
		try {
			writeFileSync(join(where.repo, "quiz-bank.json"), JSON.stringify(bank(where)));
			const output = await quiz(session, where, "");
			assert.match(output, /'opened': True/, output);
			assert.equal(opened.length, 1);
			const [path] = opened as [string];
			const now = new Date();
			const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
				.map((n) => String(n).padStart(2, "0"))
				.join("-");
			assert.match(path, new RegExp(`^${join(where.home, "quizzes")}/repo-[0-9a-f]{8}/${day}-1\\.html$`));
			const page = pageData(readFileSync(path, "utf8"));
			assert.equal(page.project, "repo");
			assert.deepEqual(
				page.commits.map((each) => [each.sha, each.summary]),
				where.session.map((sha) => [sha, bank(where).summaries[sha.slice(0, 8)]]),
			);
			assert.deepEqual(
				page.questions.map((question) => question.question).sort(),
				bank(where)
					.questions.map((question) => question.question)
					.sort(),
			);
			for (const question of page.questions) {
				assert.match(question.options[question.correct]!, /^Users read it first/);
				assert.deepEqual(question.cites.slice(1), [
					{ kind: "decision", text: "Usage in the README", index: 0 },
					{ kind: "note", text: "README.md:3", index: 1 },
				]);
			}
			const htmlFile = page.commits[0]!.files.find((file) => file.path === "page.html")!;
			assert.deepEqual(htmlFile.rows, [
				{ kind: "hunk", text: "@@ -0,0 +1,2 @@" },
				{ kind: "add", newNo: 1, text: "<p>before</p>" },
				{ kind: "add", newNo: 2, text: "</script><img src=x onerror=alert(1)>" },
			]);
			assert.deepEqual(
				htmlFile.notes.map((note) => [note.index, htmlFile.rows[note.row], note.comment]),
				[[0, htmlFile.rows[2], bank(where).annotations[0]!.comment]],
			);
			const readme = page.commits[1]!.files.find((file) => file.path === "README.md")!;
			assert.deepEqual(readme.rows[readme.notes[0]!.row], { kind: "add", newNo: 3, text: "usage: run it" });
			const saved = session.notices.filter((notice) => notice.level === "info").map((notice) => notice.message);
			assert.equal(saved.length, 1);
			assert.match(saved[0]!, /^Quiz saved · .*\.html · opened in browser · [0-9a-f]{12}\.\.HEAD, 2 commit\(s\)$/);
		} finally {
			await session.close();
		}
	});

	it("hands a bad bank's problems back to the agent, and saves and opens nothing", async () => {
		const where = workspace();
		const opened: string[] = [];
		const session = await open(where, opened);
		try {
			const bad = bank(where);
			bad.questions[2] = { ...bad.questions[2]!, options: ["only", "three", "options"] };
			bad.questions[4] = { ...bad.questions[4]!, cites: ["deadbeef"] };
			bad.annotations.push({ ...bad.annotations[1]!, line: 9 });
			writeFileSync(join(where.repo, "quiz-bank.json"), JSON.stringify(bad));
			const schema = await quiz(session, where, "");
			assert.match(schema, /quiz\.publish refused:/);
			assert.match(schema, /bank\.questions\.2\.options: expected at least 4 items/);

			bad.questions[2] = bank(where).questions[2]!;
			delete bad.summaries[where.session[1]!.slice(0, 8)];
			writeFileSync(join(where.repo, "quiz-bank.json"), JSON.stringify(bad));
			const semantic = await quiz(session, where, "");
			assert.match(semantic, /The bank has 3 problem\(s\); fix them and publish again:/);
			assert.match(
				semantic,
				/- annotations\[2\]\.line: README\.md has no new line 9 in [0-9a-f]{9}'s diff; its new lines there are 1-3/,
			);
			assert.match(semantic, /- summaries: no summary for [0-9a-f]{9} \(docs: usage\)/);
			assert.match(semantic, /- questions\[4\]\.cites\[0\]: deadbeef is not a commit of/);
			assert.deepEqual(opened, []);
		} finally {
			await session.close();
		}
	});
});

describe("the range /quiz asks for", () => {
	it("defaults to this session's commits, takes a range or all, and refuses ranges without commits", async () => {
		const where = workspace();
		const [skill] = discoverSkills({ cwd: where.repo, makoraHome: where.home, userHome: homedir() }).filter(
			(each) => each.name === "session-quiz",
		);
		const now = Date.now();
		const session = await quizRequest(skill!, where.repo, now, "");
		assert.equal(session.kind, "submit");
		assert.match(
			session.kind === "submit" ? session.text : "",
			new RegExp(
				`\\n\\nRange: ${where.base.slice(0, 12)}\\.\\.HEAD \\(the 2 commits on this branch since this session started at `,
			),
		);
		const explicit = await quizRequest(skill!, where.repo, now, "HEAD~1..HEAD");
		assert.match(explicit.kind === "submit" ? explicit.text : "", /\n\nRange: HEAD~1\.\.HEAD \(1 commit\)$/);
		const all = await quizRequest(skill!, where.repo, now, "all");
		assert.match(all.kind === "submit" ? all.text : "", /\n\nRange: all \(the project's whole history\)$/);
		assert.equal((await quizRequest(skill!, where.repo, now + 3_600_000, "")).kind, "refused");
		assert.equal((await quizRequest(skill!, where.repo, now, "HEAD..HEAD")).kind, "refused");
		assert.equal((await quizRequest(skill!, where.repo, now, "no-such-ref")).kind, "refused");
		assert.equal((await quizRequest(skill!, where.home, now, "")).kind, "refused");
	});
});
