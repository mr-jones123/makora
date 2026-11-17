import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { parseCommitMessage } from "../scripts/release/commits.ts";
import { planRelease } from "../scripts/release/plan.ts";
import { commitsSince, firstParentCommits, releasedVersions, shippedPaths } from "../scripts/release/repo.ts";
import { INSTALL } from "../src/install.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function commit(repo: string, message: string, path: string): string {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), `${message}\n`);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", message);
	return git(repo, "rev-parse", "HEAD");
}

/**
 * A monorepo shaped like this one: makora depends on `pkg-a`, which depends on `pkg-b`; `pkg-c` and `apps/other` are
 * not shipped. Tagged makora-v0.1.0 (and an upstream v9.0.0), then: a fix in pkg-b, a merged side branch with a
 * non-conventional commit and a feature, a commit only in apps/other, and a docs commit in makora.
 */
function repository(): { repo: string; tagged: string } {
	const repo = mkdtempSync(join(tmpdir(), "makora-release-"));
	git(repo, "init", "-q", "-b", "main");
	const manifest = (name: string, dependencies: Record<string, string> = {}) =>
		`${JSON.stringify({ name, version: "1.0.0", dependencies, devDependencies: { "pkg-c": "1.0.0" } })}\n`;
	mkdirSync(join(repo, "apps", "makora"), { recursive: true });
	writeFileSync(join(repo, "apps", "makora", "package.json"), manifest("makora", { "pkg-a": "1.0.0", yaml: "2.9.0" }));
	for (const [dir, dependencies] of [
		["a", { "pkg-b": "1.0.0" }],
		["b", {}],
		["c", {}],
	] as const) {
		mkdirSync(join(repo, "packages", dir), { recursive: true });
		writeFileSync(join(repo, "packages", dir, "package.json"), manifest(`pkg-${dir}`, dependencies));
	}
	const tagged = commit(repo, "feat: makora", "apps/makora/src/main.ts");
	git(repo, "tag", "makora-v0.1.0");
	git(repo, "tag", "v9.0.0");
	commit(repo, "fix(b): an upstream fix", "packages/b/src/x.ts");
	git(repo, "switch", "-q", "-c", "side");
	commit(repo, "wip side work", "apps/makora/src/side.ts");
	commit(repo, "feat: side feature", "apps/makora/src/side.ts");
	git(repo, "switch", "-q", "main");
	git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side");
	commit(repo, "feat(other): another app", "apps/other/src/x.ts");
	commit(repo, "docs: makora readme", "apps/makora/README.md");
	return { repo, tagged };
}

describe("release plan in a git repository", () => {
	it("ships makora and its workspace dependencies, transitively, and not dev dependencies", () => {
		const { repo } = repository();
		assert.deepEqual(shippedPaths(repo), ["apps/makora/", "packages/a/", "packages/b/"]);
	});

	it("plans from the last makora tag, counting merged commits on shipped paths and ignoring other apps", () => {
		const { repo } = repository();
		assert.deepEqual(releasedVersions(repo), ["0.1.0"]);
		const plan = planRelease(commitsSince(repo, "makora-v0.1.0"), "0.1.0", shippedPaths(repo), "2026-11-17");
		// Commits made within one second come in any order.
		assert.deepEqual(plan.commits.map((each) => `${each.type}: ${each.subject}`).sort(), [
			"docs: makora readme",
			"feat: side feature",
			"fix: an upstream fix",
			"null: wip side work",
		]);
		assert.equal(plan.bump, "minor");
		assert.equal(plan.next, "0.2.0");
		assert.match(plan.changelog, /### Features\n\n- side feature/);
		assert.doesNotMatch(plan.changelog, /another app|wip/);
	});

	it("checks first-parent commits only, so a merged branch's history never fails the check", () => {
		const { repo, tagged } = repository();
		const line = firstParentCommits(repo, tagged, "HEAD");
		assert.deepEqual(
			line.map((each) => [each.merge, each.message.split("\n")[0]]),
			[
				[false, "docs: makora readme"],
				[false, "feat(other): another app"],
				[true, "Merge branch 'side'"],
				[false, "fix(b): an upstream fix"],
			],
		);
		assert.ok(line.every((each) => each.merge || parseCommitMessage(each.message).kind === "conventional"));
		const lint = (cwd: string, ...args: string[]) =>
			spawnSync(process.execPath, [join(INSTALL.root, "scripts", "commit-lint.mjs"), ...args], {
				cwd,
				encoding: "utf8",
			});
		assert.equal(lint(repo, tagged, "HEAD").status, 0);
		const bad = commit(repo, "Fixed the thing", "apps/makora/src/x.ts");
		const run = lint(repo, tagged, "HEAD");
		assert.equal(run.status, 1);
		assert.ok(
			run.stderr.includes(`${bad.slice(0, 12)} "Fixed the thing": does not match type(scope)!: subject`),
			run.stderr,
		);
		// A new branch's push has no base: only its head is checked.
		assert.equal(lint(repo, "0".repeat(40), "HEAD").status, 1);
		assert.equal(lint(repo, "0".repeat(40), "HEAD~1").status, 0);
	});
});
