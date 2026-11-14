import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverContextFiles, renderContextFiles } from "../src/context-files.ts";

describe("context file discovery", () => {
	it("reads the user file first, then AGENTS.md from the repo root down to cwd, and nothing above the root", () => {
		const base = mkdtempSync(join(tmpdir(), "makora-context-"));
		const repo = join(base, "repo");
		const cwd = join(repo, "packages", "app");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const user = join(base, "home-AGENTS.md");
		writeFileSync(user, "user rules");
		writeFileSync(join(base, "AGENTS.md"), "above the repo");
		writeFileSync(join(repo, "AGENTS.md"), "repo rules");
		writeFileSync(join(cwd, "AGENTS.md"), "app rules");

		const files = discoverContextFiles(cwd, user);
		assert.deepEqual(
			files.map((file) => [file.path, file.content]),
			[
				[user, "user rules"],
				[join(repo, "AGENTS.md"), "repo rules"],
				[join(cwd, "AGENTS.md"), "app rules"],
			],
		);
		const section = renderContextFiles(files)!;
		assert.ok(section.indexOf("repo rules") < section.indexOf("app rules"));
		assert.ok(section.includes(`<file path="${join(cwd, "AGENTS.md")}">`));
	});

	it("outside a git repository reads only the cwd's file, and renders nothing without files", () => {
		const base = mkdtempSync(join(tmpdir(), "makora-context-"));
		const cwd = join(base, "plain");
		mkdirSync(cwd);
		writeFileSync(join(base, "AGENTS.md"), "parent");
		writeFileSync(join(cwd, "AGENTS.md"), "here");

		const files = discoverContextFiles(cwd, join(base, "missing.md"));
		assert.deepEqual(
			files.map((file) => file.content),
			["here"],
		);
		assert.equal(renderContextFiles([]), undefined);
	});
});
