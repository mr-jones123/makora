import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClipboardReader, readPaste, spacedPaths } from "../src/tui/clipboard.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A clipboard holding what `contents` gives; it records which reads Ctrl+V made. */
function clipboard(contents: { files?: string[]; image?: Uint8Array; text?: string }) {
	const reads: string[] = [];
	const reader: ClipboardReader = {
		files: async () => {
			reads.push("files");
			return contents.files;
		},
		image: async () => {
			reads.push("image");
			return contents.image;
		},
		text: async () => {
			reads.push("text");
			return contents.text;
		},
	};
	return { reader, reads };
}

describe("what Ctrl+V pastes", () => {
	it("pastes copied files as paths, ahead of the icon image a Finder copy also carries", async () => {
		const { reader, reads } = clipboard({ files: ["/tmp/a.png"], image: PNG, text: "a.png" });
		assert.deepEqual(await readPaste(reader), { kind: "files", paths: ["/tmp/a.png"] });
		assert.deepEqual(reads, ["files"]);
	});

	it("pastes an image when no files were copied, ahead of text", async () => {
		const { reader, reads } = clipboard({ image: PNG, text: "alt text" });
		assert.deepEqual(await readPaste(reader), { kind: "image", bytes: PNG });
		assert.deepEqual(reads, ["files", "image"]);
	});

	it("pastes text when there are neither files nor an image", async () => {
		const { reader, reads } = clipboard({ text: "hello" });
		assert.deepEqual(await readPaste(reader), { kind: "text", text: "hello" });
		assert.deepEqual(reads, ["files", "image", "text"]);
	});

	it("pastes nothing from an empty clipboard", async () => {
		assert.deepEqual(await readPaste(clipboard({}).reader), { kind: "empty" });
	});

	it("refuses a copied path with control characters", async () => {
		await assert.rejects(readPaste(clipboard({ files: ["/tmp/a\u001b[2Jb"] }).reader), /control characters/);
	});
});

describe("pasted paths", () => {
	it("are one per line, spaced from text the cursor sits against", () => {
		assert.equal(spacedPaths(["/a", "/b"], "look at", "please"), " /a\n/b ");
		assert.equal(spacedPaths(["/a"], "look at ", " please"), "/a");
		assert.equal(spacedPaths(["/a"], "", ""), "/a");
	});
});
