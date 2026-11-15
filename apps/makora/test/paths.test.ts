import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makoraHome } from "../src/paths.ts";

describe("makora home", () => {
	it("resolves a relative MAKORA_HOME against the working directory", () => {
		const saved = process.env.MAKORA_HOME;
		process.env.MAKORA_HOME = "relative-home";
		try {
			assert.equal(makoraHome(), join(process.cwd(), "relative-home"));
		} finally {
			if (saved === undefined) delete process.env.MAKORA_HOME;
			else process.env.MAKORA_HOME = saved;
		}
	});
});
