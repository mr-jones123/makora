import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiff, unquote, untrackedFile } from "../src/git/diff.ts";
import { parseLog } from "../src/git/log.ts";

// Real `git diff --cached -M --src-prefix=a/ --dst-prefix=b/` output (git 2.55), one file per case.
const MODIFIED = `diff --git a/a.txt b/a.txt
index 4cb29ea..ddc897f 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const RENAMED_WITH_SPACES = `diff --git a/old name.txt b/new name.txt
similarity index 71%
rename from old name.txt
rename to new name.txt
index 600d48a..9e5419d 100644
--- a/old name.txt\t
+++ b/new name.txt\t
@@ -2,4 +2,4 @@ alpha
 beta
 gamma
 delta
-epsilon
+epsilon!
`;

const PURE_RENAME = `diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
`;

const BINARY = `diff --git a/img.bin b/img.bin
index 88768ef..3e3315e 100644
Binary files a/img.bin and b/img.bin differ
`;

const NEW_BINARY = `diff --git a/new.bin b/new.bin
new file mode 100644
index 0000000..718882c
Binary files /dev/null and b/new.bin differ
`;

const NO_NEWLINE = `diff --git a/nonl.txt b/nonl.txt
index 1b32298..6e94b48 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1,2 +1,2 @@
 x
-y
\\ No newline at end of file
+z
\\ No newline at end of file
`;

const UNICODE = `diff --git a/café ü.txt b/café ü.txt
index 5fb50d3..9d4a8ba 100644
--- a/café ü.txt\t
+++ b/café ü.txt\t
@@ -1 +1 @@
-héllo
+héllo wörld
`;

const QUOTED = `diff --git "a/we\\tird.txt" "b/we\\tird.txt"
index 8cc35a3..bac686b 100644
--- "a/we\\tird.txt"
+++ "b/we\\tird.txt"
@@ -1 +1 @@
-tab
+tab2
`;

const DELETED_DASHES = `diff --git a/del.txt b/del.txt
deleted file mode 100644
index 286c5f5..0000000
--- a/del.txt
+++ /dev/null
@@ -1,2 +0,0 @@
--- a/x
-+++ b/y
`;

describe("parseDiff", () => {
	it("reads a modified file's hunk with old and new line numbers", () => {
		assert.deepEqual(parseDiff(MODIFIED), [
			{
				path: "a.txt",
				status: "M",
				added: 1,
				removed: 1,
				body: {
					kind: "text",
					hunks: [
						{
							header: "@@ -1,3 +1,3 @@",
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 3,
							lines: [
								{ kind: "context", oldNo: 1, newNo: 1, text: "one" },
								{ kind: "del", oldNo: 2, text: "two" },
								{ kind: "add", newNo: 2, text: "TWO" },
								{ kind: "context", oldNo: 3, newNo: 3, text: "three" },
							],
						},
					],
				},
			},
		]);
	});

	it("reads renames with spaces in both paths, with and without content changes", () => {
		const [renamed, pure] = parseDiff(RENAMED_WITH_SPACES + PURE_RENAME);
		assert.equal(renamed?.status, "R");
		assert.equal(renamed?.path, "new name.txt");
		assert.equal(renamed?.oldPath, "old name.txt");
		assert.equal(renamed?.body.kind === "text" && renamed.body.hunks[0]?.lines.at(-1)?.text, "epsilon!");
		assert.deepEqual(pure, {
			path: "b.txt",
			oldPath: "a.txt",
			status: "R",
			added: 0,
			removed: 0,
			body: { kind: "text", hunks: [] },
		});
	});

	it("marks binary changes, modified and new, without hunks", () => {
		assert.deepEqual(
			parseDiff(BINARY + NEW_BINARY).map((file) => [file.path, file.status, file.body.kind]),
			[
				["img.bin", "M", "binary"],
				["new.bin", "A", "binary"],
			],
		);
	});

	it("flags the lines followed by `\\ No newline at end of file` on both sides", () => {
		const [file] = parseDiff(NO_NEWLINE);
		assert.ok(file?.body.kind === "text");
		assert.deepEqual(file.body.hunks[0]?.lines, [
			{ kind: "context", oldNo: 1, newNo: 1, text: "x" },
			{ kind: "del", oldNo: 2, text: "y", noNewline: true },
			{ kind: "add", newNo: 2, text: "z", noNewline: true },
		]);
	});

	it("reads unicode paths printed raw and C-quoted paths with escapes", () => {
		assert.deepEqual(
			parseDiff(UNICODE + QUOTED).map((file) => file.path),
			["café ü.txt", "we\tird.txt"],
		);
		assert.equal(unquote('"caf\\303\\251 \\"q\\".txt"'), 'café "q".txt');
	});

	it("keeps deleted lines that look like file headers inside their hunk", () => {
		const files = parseDiff(DELETED_DASHES + MODIFIED);
		assert.equal(files.length, 2);
		assert.deepEqual(files[0], {
			path: "del.txt",
			status: "D",
			added: 0,
			removed: 2,
			body: {
				kind: "text",
				hunks: [
					{
						header: "@@ -1,2 +0,0 @@",
						oldStart: 1,
						oldLines: 2,
						newStart: 0,
						newLines: 0,
						lines: [
							{ kind: "del", oldNo: 1, text: "-- a/x" },
							{ kind: "del", oldNo: 2, text: "+++ b/y" },
						],
					},
				],
			},
		});
	});

	it("returns no files for an empty diff", () => {
		assert.deepEqual(parseDiff(""), []);
	});
});

describe("untrackedFile", () => {
	const bytes = (text: string) => ({ kind: "read" as const, bytes: new TextEncoder().encode(text) });

	it("shows an untracked text file as one hunk adding every line", () => {
		const file = untrackedFile("notes/new file.md", bytes("a\nb\n"));
		assert.equal(file.status, "?");
		assert.equal(file.added, 2);
		assert.deepEqual(file.body, {
			kind: "text",
			hunks: [
				{
					header: "@@ -0,0 +1,2 @@",
					oldStart: 0,
					oldLines: 0,
					newStart: 1,
					newLines: 2,
					lines: [
						{ kind: "add", newNo: 1, text: "a" },
						{ kind: "add", newNo: 2, text: "b" },
					],
				},
			],
		});
	});

	it("flags a missing final newline, and an empty file has no hunks", () => {
		const file = untrackedFile("x", bytes("only"));
		assert.ok(file.body.kind === "text");
		assert.deepEqual(file.body.hunks[0]?.lines, [{ kind: "add", newNo: 1, text: "only", noNewline: true }]);
		assert.deepEqual(untrackedFile("empty", bytes("")).body, { kind: "text", hunks: [] });
	});

	it("skips binaries and files over the cap with a note", () => {
		assert.deepEqual(untrackedFile("a.png", { kind: "read", bytes: new Uint8Array([137, 80, 0, 1]) }).body, {
			kind: "binary",
		});
		assert.deepEqual(untrackedFile("big.log", { kind: "tooLarge", size: 3 * 1024 * 1024 }).body, {
			kind: "omitted",
			reason: "3.0 MiB, not shown",
		});
	});
});

describe("parseLog", () => {
	it("reads each commit with its summed line counts, binaries counting nothing", () => {
		const output =
			"\x1e50d3f9d8fa7e\x1f1794759431\x1fAda Lovelace\x1ftwo · with dots\n\n1\t1\ta.txt\n-\t-\timg.bin\n0\t3\tdel.txt\n" +
			"\x1e3e2d54fdb523\x1f1794759425\x1fT\x1finit\n\n3\t0\ta.txt\n";
		assert.deepEqual(parseLog(output), [
			{
				sha: "50d3f9d8fa7e",
				subject: "two · with dots",
				author: "Ada Lovelace",
				date: 1794759431000,
				added: 1,
				removed: 4,
			},
			{ sha: "3e2d54fdb523", subject: "init", author: "T", date: 1794759425000, added: 3, removed: 0 },
		]);
	});
});
