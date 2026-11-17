import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommitMessage } from "../scripts/release/commits.ts";

describe("parseCommitMessage", () => {
	it("reads the type, an optional scope and the subject", () => {
		assert.deepEqual(parseCommitMessage("feat: makora /quiz"), {
			kind: "conventional",
			type: "feat",
			breaking: false,
			subject: "makora /quiz",
		});
		assert.deepEqual(parseCommitMessage("fix(p2,chord): reload reports deleted plugins\n\nBody text."), {
			kind: "conventional",
			type: "fix",
			scope: "p2,chord",
			breaking: false,
			subject: "reload reports deleted plugins",
		});
	});

	it("accepts every checked type, revert included", () => {
		for (const type of ["docs", "ci", "test", "chore", "refactor", "perf", "style", "build", "revert"]) {
			const parsed = parseCommitMessage(`${type}: something`);
			assert.equal(parsed.kind === "conventional" && parsed.type, type);
		}
	});

	it("marks a breaking change by ! or by a BREAKING CHANGE footer, keeping the footer's note", () => {
		assert.deepEqual(parseCommitMessage("refactor(ai)!: drop the old login"), {
			kind: "conventional",
			type: "refactor",
			scope: "ai",
			breaking: true,
			subject: "drop the old login",
		});
		assert.deepEqual(parseCommitMessage("feat: new settings file\n\nWhy.\n\nBREAKING CHANGE: settings.json moved"), {
			kind: "conventional",
			type: "feat",
			breaking: true,
			subject: "new settings file",
			breakingNote: "settings.json moved",
		});
		const hyphen = parseCommitMessage("fix: x\n\nBREAKING-CHANGE: y");
		assert.equal(hyphen.kind === "conventional" && hyphen.breaking, true);
	});

	it("recognizes merge commits", () => {
		assert.deepEqual(parseCommitMessage("Merge remote-tracking branch 'upstream/main'"), { kind: "merge" });
	});

	it("rejects malformed messages with a reason", () => {
		const cases: [string, RegExp][] = [
			["Add a thing", /does not match/],
			["feat:missing space", /does not match/],
			["feat: ", /does not match/],
			["Feat: capitalized type", /does not match/],
			["feat (ai): space before scope", /does not match/],
			["feature: unknown", /unknown type "feature"/],
			['Revert "feat: x"', /does not match/],
		];
		for (const [message, reason] of cases) {
			const parsed = parseCommitMessage(message);
			assert.equal(parsed.kind, "invalid", message);
			assert.match(parsed.kind === "invalid" ? parsed.reason : "", reason, message);
		}
	});
});
