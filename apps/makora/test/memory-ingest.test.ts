import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli } from "../src/cli-args.ts";
import { episodeOf } from "../src/memory/ingest.ts";
import { remoteId } from "../src/memory/project.ts";

describe("the episode a message makes", () => {
	it("keeps what the user said and skips an empty message", () => {
		assert.deepEqual(episodeOf({ role: "user", content: "  remember this ", timestamp: 0 }), {
			role: "user",
			text: "remember this",
		});
		assert.equal(episodeOf({ role: "user", content: "   ", timestamp: 0 }), undefined);
	});

	it("keeps the assistant's text and its calls, with a python call as its code", () => {
		const episode = episodeOf({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "Checking the kernel." },
				{ type: "toolCall", id: "1", name: "python", arguments: { code: "print(1)" } },
			],
			api: "a",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		});
		assert.deepEqual(episode, { role: "assistant", text: "Checking the kernel.\n\n→ python\nprint(1)" });
	});

	it("cuts a long tool result in the middle and marks errors", () => {
		const text = `${"a".repeat(3_000)}${"b".repeat(5_000)}${"c".repeat(1_000)}`;
		const episode = episodeOf({
			role: "toolResult",
			toolCallId: "1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: true,
			timestamp: 0,
		});
		assert.equal(episode?.role, "tool");
		assert.match(episode!.text, /^← bash \(error\)\na{3000}\n\[5000 characters left out\]\nc{1000}$/);
	});
});

describe("a project's id", () => {
	it("is one id for a repository over ssh, https, with a user or a .git suffix", () => {
		for (const url of [
			"git@github.com:Me/Demo.git",
			"https://github.com/me/demo",
			"https://token@github.com/me/demo.git",
			"ssh://git@github.com/me/demo.git/",
		])
			assert.equal(remoteId(url), "github.com/me/demo", url);
	});
});

describe("memory's command line", () => {
	it("parses dream, its status and cancel, wiki and wiki-setup", () => {
		assert.deepEqual(parseCli(["dream"], undefined), { kind: "dream", action: "start", fake: false });
		assert.deepEqual(parseCli(["dream", "status", "3"], undefined), {
			kind: "dream",
			action: "status",
			fake: false,
			id: 3,
		});
		assert.deepEqual(parseCli(["dream", "cancel", "--fake"], undefined), {
			kind: "dream",
			action: "cancel",
			fake: true,
		});
		assert.deepEqual(parseCli(["dream-worker", "7", "--fake"], undefined), {
			kind: "dreamWorker",
			id: 7,
			fake: true,
		});
		assert.deepEqual(parseCli(["wiki"], undefined), { kind: "wiki" });
		assert.deepEqual(parseCli(["wiki-setup", "~/vault", "memory"], undefined), {
			kind: "wikiSetup",
			vault: "~/vault",
			folder: "memory",
		});
	});

	it("refuses what it cannot run", () => {
		for (const argv of [
			["dream", "sleep"],
			["dream", "status", "x"],
			["dream", "5"],
			["wiki", "now"],
			["wiki-setup"],
		])
			assert.equal(parseCli(argv, undefined).kind, "error", argv.join(" "));
	});
});
