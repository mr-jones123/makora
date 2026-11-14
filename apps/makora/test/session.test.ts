import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import { openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { lockInChild } from "./fixtures/lock-child.ts";

describe("open session", () => {
	it("leaves the session unlocked when opening fails after the harness is up", async () => {
		const home = mkdtempSync(join(tmpdir(), "makora-home-"));
		const auth = join(home, "auth.json");
		writeFileSync(auth, "{not json");
		const app = openApp(home, false);
		const meta = createSession(app.paths.sessions, home);

		await assert.rejects(openSession(app, meta, {}, BACKGROUND_CONTEXT), /Corrupt auth file/);
		const other = lockInChild(app.paths.sessions, meta.id, 0);
		assert.deepEqual(await other.outcome, { locked: true });
		await once(other.child, "exit");

		rmSync(auth);
		const session = await openSession(app, meta, {}, BACKGROUND_CONTEXT);
		await session.close();
	});
});
