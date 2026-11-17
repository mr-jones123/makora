import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Conversation, UserInput } from "@earendil-works/pi-durable";
import { AgentsDoc } from "../src/agents/docs.ts";
import { openApp } from "../src/app.ts";
import { forkPoints } from "../src/fork.ts";
import { describeImage } from "../src/images.ts";
import { SECOND_FAKE_MODEL } from "../src/models.ts";
import { type MakoraSession, openSession } from "../src/session.ts";
import { createSession, readSession } from "../src/sessions.ts";
import { messageImages, messageText } from "../src/transcript-rows.ts";

const context = BACKGROUND_CONTEXT;

/** A decodable RGB PNG of `width`×`height`. */
function png(width: number, height: number): Buffer {
	const chunk = (kind: string, data: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const PICTURE: ImageContent = { type: "image", data: png(64, 48).toString("base64"), mimeType: "image/png" };

// One home for the file, so the Python environment is built once.
const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-images-")));
const home = join(root, "home");
const repo = join(root, "repo");
mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "# demo\n");
for (const args of [
	["init", "-q"],
	["add", "README.md"],
	["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init"],
]) {
	execFileSync("git", args, { cwd: repo });
}
writeFileSync(join(repo, "small.png"), png(8, 6));
// A stand-in for Pillow, which makora's environment does not install: `show()` looks PIL images up by `PIL.Image.Image`.
mkdirSync(join(repo, "PIL"));
writeFileSync(join(repo, "PIL", "__init__.py"), "");
writeFileSync(
	join(repo, "PIL", "Image.py"),
	'class Image:\n    mode = "RGB"\n    def __init__(self, data):\n        self.data = data\n    def save(self, buffer, format):\n        assert format == "PNG"\n        buffer.write(self.data)\n',
);
const app = openApp(home, true);
const sessions: MakoraSession[] = [];
after(() => Promise.all(sessions.map((session) => session.close())));

async function open(id?: string): Promise<MakoraSession> {
	const meta = id === undefined ? createSession(app.paths.sessions, repo) : readSession(app.paths.sessions, id);
	assert.ok(meta !== undefined);
	const session = await openSession(app, meta, {}, context);
	sessions.push(session);
	return session;
}

async function ask(session: MakoraSession, input: UserInput, conversation: Conversation = session.root) {
	const settled = await (await session.submit(conversation, input, context))!.wait(context);
	assert.equal(settled.status, "done");
}

async function newest(conversation: Conversation) {
	return (await conversation.entries({ order: "descending" }, 50, undefined, context)).items;
}

async function lastAnswer(conversation: Conversation): Promise<string> {
	for (const entry of await newest(conversation)) {
		const message = entry.model?.[0];
		if (message?.role === "assistant") return messageText(message);
	}
	throw new Error("no answer");
}

async function lastCell(conversation: Conversation): Promise<ToolResultMessage> {
	for (const entry of await newest(conversation)) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult" && message.toolName === "python") return message;
	}
	throw new Error("no python cell");
}

/** Poll `check` until it gives a value: a woken subagent answers on its own schedule. */
async function until<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const cell = (code: string) => `\`\`\`python\n${code}\n\`\`\``;

describe("images in a message", () => {
	it("reach the model, are kept in the session, and come back with a fork's draft", async () => {
		const session = await open();
		await ask(session, "hello");
		await ask(session, [{ type: "text", text: "how many images in [image #1]" }, PICTURE]);
		const bytes = Buffer.from(PICTURE.data, "base64").length;
		assert.equal(await lastAnswer(session.root), `The last message had 1 image(s): png · 64×48 · ${bytes} B.`);
		const id = session.meta.id;
		await session.close();
		sessions.splice(sessions.indexOf(session), 1);

		const reopened = await open(id);
		const user = (await newest(reopened.root)).find((entry) => entry.kind === "pi.user")?.model?.[0];
		assert.ok(user !== undefined);
		assert.deepEqual(messageImages(user), [PICTURE]);
		const [point] = await forkPoints(reopened.root, context);
		assert.equal(point?.text, "how many images in [image #1]");
		assert.deepEqual(point?.images, [PICTURE]);
	});

	it("wake a finished subagent the user types into, which sees them", async () => {
		const session = await open();
		await ask(session, cell('await spawn("reviewer", "review", mode="review")'));
		const reviewer = await until("the reviewer to finish", async () => {
			const record = (await session.harness.snapshot(AgentsDoc, session.root.id, context))?.agents.reviewer;
			return record?.state.kind === "done" ? record : undefined;
		});
		const child = (await session.harness.conversation(reviewer.conversationId, context))!;
		await session.submit(child, [{ type: "text", text: "how many images in [image #1]" }, PICTURE], context);
		const answer = await until("the reviewer's answer", async () => {
			const text = await lastAnswer(child);
			return text.startsWith("The last message had") ? text : undefined;
		});
		assert.match(answer, /^The last message had 1 image\(s\): png · 64×48/);
	});

	it("stay out of what a cell reads of the history", async () => {
		const session = await open();
		await ask(session, [{ type: "text", text: "look at [image #1]" }, PICTURE]);
		await ask(session, cell("print(await ctx.transcript(limit=5))"));
		const output = messageText(await lastCell(session.root));
		assert.match(output, /look at \[image #1\]/);
		assert.ok(!output.includes(PICTURE.data.slice(0, 40)), output);
	});
});

describe("show() in a cell", () => {
	it("takes a path, bytes, a read() image and a PIL image, at most 4, and the result carries them", async () => {
		const session = await open();
		await ask(
			session,
			cell(
				[
					"import PIL.Image",
					"from pathlib import Path",
					'show("small.png")',
					'show(open("small.png", "rb").read())',
					'show(await read("small.png"))',
					'show(PIL.Image.Image(Path("small.png").read_bytes()))',
					'show(Path("small.png"))',
					"try:",
					"    show(42)",
					"except TypeError as error:",
					'    print("refused:", error)',
				].join("\n"),
			),
		);
		const result = await lastCell(session.root);
		assert.equal(result.isError, false, messageText(result));
		assert.deepEqual(messageText(result).split("\n"), [
			...Array.from({ length: 4 }, () => "image · png · 8×6"),
			"image not shown: a cell shows at most 4 images",
			"refused: show() takes a path, bytes, an image from `await read(path)`, or a PIL image, not int",
		]);
		assert.deepEqual(
			messageImages(result).map(describeImage),
			Array.from({ length: 4 }, () => "png · 8×6"),
		);
	});

	it("says why for a model without image input, and attaches nothing", async () => {
		const session = await open();
		await session.setModel(session.root, SECOND_FAKE_MODEL, context);
		await ask(session, cell('show("small.png")'));
		const result = await lastCell(session.root);
		assert.equal(messageText(result), "image not shown: faux-2 cannot see images");
		assert.deepEqual(messageImages(result), []);
	});

	it("reaches the model on its next request", async () => {
		const session = await open();
		await ask(session, "show-image");
		assert.match(
			await lastAnswer(session.root),
			/image · png · 800×600[\s\S]*It carried 1 image\(s\): png · 800×600\./,
		);
	});
});
