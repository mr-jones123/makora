import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { INSTALL } from "../src/install.ts";

function makora(args: readonly string[]) {
	return spawnSync(
		process.execPath,
		["--import", join(INSTALL.root, "src", "source.ts"), join(INSTALL.root, "src", "main.ts"), ...args],
		{ encoding: "utf8" },
	);
}

describe("makora from a source checkout", () => {
	it("prints the package version marked +dev", () => {
		const { version } = JSON.parse(readFileSync(join(INSTALL.root, "package.json"), "utf8")) as { version: string };
		const run = makora(["--version"]);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, `makora ${version}+dev\n`);
	});

	it("refuses to update and says to pull instead", () => {
		const run = makora(["update"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /makora runs from the source checkout at .*; update it with `git pull` there/);
	});
});
