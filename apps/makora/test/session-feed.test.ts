import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import { openSession } from "../src/session.ts";
import { createSession } from "../src/sessions.ts";
import { SessionFeed } from "../src/tui/session-feed.ts";

describe("session feed", () => {
	it("stops cleanly while a derived refresh is pending and the session then closes", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const home = mkdtempSync(join(tmpdir(), "makora-home-"));
			const app = openApp(home, true);
			const session = await openSession(app, createSession(app.paths.sessions, home), {}, BACKGROUND_CONTEXT);
			const feed = new SessionFeed(session, session.root);
			await feed.start();
			const changed = new Promise<void>((resolve) => feed.onChange(resolve));
			await session.submit(session.root, "hello", BACKGROUND_CONTEXT);
			await changed;

			await feed.stop();
			await session.close();
			await sleep(500);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		assert.deepEqual(rejections, []);
	});
});
