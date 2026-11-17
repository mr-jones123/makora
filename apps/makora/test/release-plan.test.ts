import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Commit,
	changelogSection,
	nextVersion,
	pendingRelease,
	planRelease,
	prependChangelog,
	touchesShipped,
} from "../scripts/release/plan.ts";

const SHIPPED = ["apps/makora/", "packages/ai/"];

function commit(sha: string, message: string, files: readonly string[] = ["apps/makora/src/main.ts"]): Commit {
	return { sha: sha.padEnd(40, "0"), date: "2026-11-17T10:00:00+08:00", message, files };
}

describe("which commits ship", () => {
	it("counts files under apps/makora and the bundled packages only", () => {
		assert.ok(touchesShipped(["apps/makora/install.sh"], SHIPPED));
		assert.ok(touchesShipped(["docs/x.md", "packages/ai/src/index.ts"], SHIPPED));
		assert.equal(touchesShipped(["apps/p2/src/x.ts", "packages/coding-agent/src/x.ts", "README.md"], SHIPPED), false);
		assert.equal(touchesShipped(["apps/makora-other/x"], SHIPPED), false);
	});

	it("ignores a commit only in another app, and counts an upstream fix in a bundled package", () => {
		const plan = planRelease(
			[
				commit("a", "feat(p2): rooms", ["apps/p2/src/rooms.ts"]),
				commit("b", "fix(ai): retry", ["packages/ai/src/x.ts"]),
			],
			"0.3.1",
			SHIPPED,
			"2026-11-17",
		);
		assert.deepEqual(
			plan.commits.map((each) => each.subject),
			["retry"],
		);
		assert.equal(plan.next, "0.3.2");
	});
});

describe("the version bump", () => {
	const bumpOf = (messages: readonly string[], current: string | null) =>
		planRelease(
			messages.map((message, index) => commit(String(index), message)),
			current,
			SHIPPED,
			"2026-11-17",
		);

	it("is patch for fix and revert, minor for feat, and the highest wins", () => {
		assert.equal(bumpOf(["fix: a"], "0.2.0").next, "0.2.1");
		assert.equal(bumpOf(["revert: a"], "0.2.0").next, "0.2.1");
		assert.equal(bumpOf(["fix: a", "feat: b", "fix: c"], "0.2.3").next, "0.3.0");
		assert.equal(bumpOf(["feat: b"], "1.4.2").next, "1.5.0");
	});

	it("is major for a breaking change from 1.0, and minor below 1.0", () => {
		assert.equal(bumpOf(["fix!: a"], "1.2.3").next, "2.0.0");
		assert.equal(bumpOf(["chore: a\n\nBREAKING CHANGE: b"], "1.2.3").next, "2.0.0");
		assert.equal(bumpOf(["feat!: a"], "0.4.2").next, "0.5.0");
		assert.equal(nextVersion("0.4.2", "major"), "0.5.0");
	});

	it("releases nothing for docs, ci, test, chore, refactor, perf, style, build or a non-conventional message", () => {
		const plan = bumpOf(
			["docs: a", "ci: b", "test: c", "chore: d", "refactor: e", "perf: f", "style: g", "build: h", "wip"],
			"0.2.0",
		);
		assert.equal(plan.bump, "none");
		assert.equal(plan.next, null);
		assert.equal(plan.changelog, "");
		assert.equal(plan.commits.length, 9);
		assert.equal(plan.commits.at(-1)?.type, null);
	});

	it("starts at 0.1.0 without a release tag, whatever the bump", () => {
		assert.equal(bumpOf(["fix: a"], null).next, "0.1.0");
		assert.equal(bumpOf(["feat!: a"], null).next, "0.1.0");
		assert.equal(bumpOf(["docs: a"], null).next, null);
	});
});

describe("the changelog", () => {
	it("groups breaking changes, features, fixes and reverts with short sha links, under a dated heading", () => {
		const plan = planRelease(
			[
				commit("f1", "fix(tui): keep the cursor"),
				commit("b1", "feat!: settings move\n\nBREAKING CHANGE: settings.json is now config.json"),
				commit("a1", "feat: makora update"),
				commit("d1", "docs: install"),
				commit("r1", "revert: drop the splash"),
			],
			"0.1.0",
			SHIPPED,
			"2026-11-17",
		);
		const link = (sha: string) =>
			`([${sha.padEnd(7, "0")}](https://github.com/mr-jones123/pi/commit/${sha.padEnd(40, "0")}))`;
		assert.equal(
			plan.changelog,
			[
				"## [0.2.0](https://github.com/mr-jones123/pi/releases/tag/makora-v0.2.0) - 2026-11-17",
				"",
				"### Breaking changes",
				"",
				`- settings move ${link("b1")}`,
				"  settings.json is now config.json",
				"",
				"### Features",
				"",
				`- makora update ${link("a1")}`,
				"",
				"### Fixes",
				"",
				`- **tui:** keep the cursor ${link("f1")}`,
				"",
				"### Reverts",
				"",
				`- drop the splash ${link("r1")}`,
				"",
			].join("\n"),
		);
	});

	it("puts a new release above the earlier ones and reads a release's section back", () => {
		const first = prependChangelog(undefined, "## [0.1.0](u) - 2026-11-17\n\n### Features\n\n- a\n");
		assert.match(first, /^# makora changelog\n\nGenerated from conventional commits/);
		const second = prependChangelog(first, "## [0.2.0](u) - 2026-11-20\n\n### Fixes\n\n- b\n");
		assert.equal(second.indexOf("## [0.2.0]") < second.indexOf("## [0.1.0]"), true);
		assert.equal(second.match(/# makora changelog/g)?.length, 1);
		assert.equal(changelogSection(second, "0.2.0"), "### Fixes\n\n- b");
		assert.equal(changelogSection(second, "0.1.0"), "### Features\n\n- a");
		assert.equal(changelogSection(second, "0.3.0"), undefined);
	});
});

describe("the release a merged release PR asks for", () => {
	const changelog = prependChangelog(undefined, "## [0.1.0](u) - 2026-11-17\n\n### Features\n\n- a\n");

	it("is package.json's version when it is untagged, newer than every tag, and in the changelog", () => {
		assert.deepEqual(pendingRelease("0.1.0", [], changelog), { version: "0.1.0", notes: "### Features\n\n- a" });
	});

	it("is nothing once tagged, for an older version, or without a changelog section", () => {
		assert.equal(pendingRelease("0.1.0", ["0.1.0"], changelog), null);
		assert.equal(pendingRelease("0.1.0", ["0.2.0"], changelog), null);
		assert.equal(pendingRelease("0.0.1", [], undefined), null);
		assert.equal(pendingRelease("0.2.0", ["0.1.0"], changelog), null);
	});
});
