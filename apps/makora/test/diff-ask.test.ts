import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiffLine, Hunk } from "../src/git/diff.ts";
import { ASK_MAX_LINES, askBlock } from "../src/tui/diff-ask.ts";

const HUNK: Hunk = {
	header: "@@ -40,3 +40,3 @@ export async function refresh(",
	oldStart: 40,
	oldLines: 3,
	newStart: 40,
	newLines: 3,
	lines: [
		{ kind: "context", oldNo: 40, newNo: 40, text: "  const token = await store.read(id);" },
		{ kind: "del", oldNo: 41, text: "  if (!token) return undefined;" },
		{ kind: "add", newNo: 41, text: "  if (token === undefined) {" },
		{ kind: "context", oldNo: 42, newNo: 42, text: "  return token;" },
	],
};

const at = (line: number | undefined, extra: { commit?: string } = {}) =>
	askBlock({ path: "src/auth/session.ts", hunk: HUNK, line, source: "working tree", ...extra });

describe("askBlock", () => {
	it("marks a deleted line with its old-side number", () => {
		assert.equal(
			at(1),
			[
				"About src/auth/session.ts:41 (working tree):",
				"```diff",
				"@@ -40,3 +40,3 @@ export async function refresh(",
				"   const token = await store.read(id);",
				"-  if (!token) return undefined;     ← line 41",
				"+  if (token === undefined) {",
				"   return token;",
				"```",
				"",
			].join("\n"),
		);
	});

	it("marks an added line and a context line with their new-side numbers", () => {
		assert.match(at(2), /^About src\/auth\/session\.ts:41 \(working tree\):\n/);
		assert.match(at(2), /\n\+ {2}if \(token === undefined\) \{ {5}← line 41\n/);
		assert.match(at(3), /^About src\/auth\/session\.ts:42 /);
		assert.match(at(3), /\n {3}return token; {5}← line 42\n/);
	});

	it("names the commit in History and the hunk start on a hunk header", () => {
		assert.match(
			at(undefined, { commit: "3e9a1f2c0ffee" }),
			/^About src\/auth\/session\.ts:40 @ 3e9a1f2 \(working tree\):\n```diff\n@@ /,
		);
		assert.doesNotMatch(at(undefined), /← line/);
	});

	it("trims a long hunk to a window around the asked line", () => {
		const lines: DiffLine[] = Array.from({ length: 200 }, (_, index) => ({
			kind: "add",
			newNo: index + 1,
			text: `l${index + 1}`,
		}));
		const block = askBlock({
			path: "big.ts",
			hunk: { header: "@@ -0,0 +1,200 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 200, lines },
			line: 120,
			source: "staged",
		});
		const body = block.split("\n").filter((line) => line.startsWith("+"));
		assert.equal(body.length, ASK_MAX_LINES);
		assert.ok(body.includes("+l121     ← line 121"));
		assert.match(block, /\n … 110 lines\n\+l111\n/);
		assert.match(block, /\n\+l140\n … 60 lines\n```\n$/);
	});

	it("uses a longer fence when the hunk holds backticks, and keeps no-newline markers", () => {
		const block = askBlock({
			path: "README.md",
			hunk: {
				header: "@@ -1 +1 @@",
				oldStart: 1,
				oldLines: 1,
				newStart: 1,
				newLines: 1,
				lines: [{ kind: "add", newNo: 1, text: "```ts", noNewline: true }],
			},
			line: 0,
			source: "staged",
		});
		assert.match(block, /^About README\.md:1 \(staged\):\n````diff\n/);
		assert.match(block, /\n\\ No newline at end of file\n````\n$/);
	});
});
