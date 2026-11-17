import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { describeImage, formatSize, type ImageModel, imageBytes, MAX_IMAGES } from "../src/images.ts";
import { Attachments, attachmentLine, composeInput } from "../src/tui/attachments.ts";

/** A PNG's signature and IHDR chunk, enough for its size; `padding` more bytes make it bigger. */
function png(width: number, height: number, padding = 0): ImageContent {
	const bytes = Buffer.alloc(33 + padding);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
}

const VISION: ImageModel = { name: "faux-1", vision: true, limits: DEFAULT_IMAGE_LIMITS };

describe("attachment tokens", () => {
	it("are numbered in the order images are pasted, and the editor keeps each whole", () => {
		const attachments = new Attachments();
		assert.equal(attachments.add(png(1, 1)), "[image #1]");
		assert.equal(attachments.add(png(2, 2)), "[image #2]");
		assert.deepEqual(attachments.tokens(), ["[image #1]", "[image #2]"]);
	});

	it("attach the images whose tokens are in the text, in the order the tokens first appear", () => {
		const attachments = new Attachments();
		const first = png(1, 1);
		const second = png(2, 2);
		attachments.add(first);
		attachments.add(second);
		assert.deepEqual(attachments.inText("b [image #2] a [image #1] again [image #2]"), [
			{ id: 2, image: second },
			{ id: 1, image: first },
		]);
	});

	it("leave an image out once its token is deleted from the text, and bring it back with the token", () => {
		const attachments = new Attachments();
		attachments.add(png(1, 1));
		const second = png(2, 2);
		attachments.add(second);
		assert.deepEqual(attachments.inText("only [image #2]"), [{ id: 2, image: second }]);
		assert.equal(attachments.inText("[image #1] [image #2]").length, 2);
	});

	it("ignore typed tokens no image was pasted for", () => {
		const attachments = new Attachments();
		attachments.add(png(1, 1));
		assert.deepEqual(
			attachments.inText("[image #7] [image #1]").map(({ id }) => id),
			[1],
		);
	});

	it("start over when the draft is cleared, and number a restored draft's images from 1", () => {
		const attachments = new Attachments();
		attachments.add(png(1, 1));
		attachments.reset([]);
		assert.deepEqual(attachments.tokens(), []);
		assert.equal(attachments.add(png(1, 1)), "[image #1]");
		attachments.reset([png(1, 1), png(2, 2)]);
		assert.deepEqual(attachments.tokens(), ["[image #1]", "[image #2]"]);
		assert.equal(attachments.add(png(3, 3)), "[image #3]");
	});

	it("are listed above the editor with format, size and bytes", () => {
		const image = png(1280, 800, 215_000);
		assert.equal(attachmentLine([{ id: 1, image }]), `image #1 · png · 1280×800 · ${formatSize(imageBytes(image))}`);
		assert.equal(formatSize(imageBytes(image)), "210 KB");
		assert.equal(describeImage(image), "png · 1280×800");
	});
});

describe("a submitted draft", () => {
	it("without images is its text", () => {
		assert.deepEqual(composeInput("hello", [], VISION), { kind: "input", content: "hello" });
	});

	it("is its text with tokens numbered in order, then the images in that order", () => {
		const attachments = new Attachments();
		const first = png(1, 1);
		const second = png(2, 2);
		const third = png(3, 3);
		attachments.add(first);
		attachments.add(second);
		attachments.add(third);
		const text = "compare [image #3] with [image #2], then [image #3] again";
		assert.deepEqual(composeInput(text, attachments.inText(text), VISION), {
			kind: "input",
			content: [{ type: "text", text: "compare [image #1] with [image #2], then [image #1] again" }, third, second],
		});
	});

	it("is refused for a model that cannot see images, naming the model and the tokens", () => {
		const attachments = new Attachments();
		attachments.add(png(1, 1));
		const text = "what is [image #1]";
		assert.deepEqual(composeInput(text, attachments.inText(text), { ...VISION, name: "faux-2", vision: false }), {
			kind: "refused",
			notice: "faux-2 cannot see images; switch with /model or remove [image #1]",
		});
	});

	it(`is refused with more than ${MAX_IMAGES} images, saying so`, () => {
		const attachments = new Attachments();
		const text = Array.from({ length: MAX_IMAGES + 1 }, () => attachments.add(png(1, 1))).join(" ");
		const draft = composeInput(text, attachments.inText(text), VISION);
		assert.equal(draft.kind, "refused");
		assert.match(draft.kind === "refused" ? draft.notice : "", /^A message takes at most 4 images; this one has 5\./);
	});

	it("is refused when an image is over the model's byte limit, naming the image and the limit", () => {
		const attachments = new Attachments();
		attachments.add(png(1, 1));
		attachments.add(png(1, 1, 3000));
		const text = "[image #1] [image #2]";
		const small = { ...VISION, name: "tiny", limits: { ...VISION.limits, maxBytes: 2048 } };
		assert.deepEqual(composeInput(text, attachments.inText(text), small), {
			kind: "refused",
			notice: "[image #2] is 4 KB as sent, over the 2 KB tiny takes; remove it",
		});
	});
});
