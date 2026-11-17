// The images attached to the editor's draft. Each stands in the text as a token `[image #N]` the editor keeps whole; a
// token deleted from the text leaves its image out, and undo brings both back. On submit the draft becomes the input:
// its text with the tokens numbered in order, then the images in that order.
import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { describeImage, formatSize, type ImageModel, imageBytes, MAX_IMAGES } from "../images.ts";

/** An image of the draft and the number its token carries. */
export type Attachment = { readonly id: number; readonly image: ImageContent };

/** A submitted draft: the input to send, or why it stays in the editor. */
export type Draft =
	| { readonly kind: "input"; readonly content: UserInput }
	| { readonly kind: "refused"; readonly notice: string };

/** The draft's images by token number; numbers count up until the draft is cleared, like pi-tui's paste markers. */
export class Attachments {
	#images = new Map<number, ImageContent>();
	#next = 1;

	/** Attach `image`; returns the token to insert into the text. */
	add(image: ImageContent): string {
		const id = this.#next++;
		this.#images.set(id, image);
		return imageToken(id);
	}

	/** The tokens of every attached image, for the editor to keep whole. */
	tokens(): string[] {
		return [...this.#images.keys()].map(imageToken);
	}

	/** The attached images whose token is in `text`, in the order their tokens first appear. */
	inText(text: string): Attachment[] {
		const found = new Map<number, ImageContent>();
		for (const match of text.matchAll(TOKEN)) {
			const id = Number(match[1]);
			const image = this.#images.get(id);
			if (image !== undefined && !found.has(id)) found.set(id, image);
		}
		return [...found].map(([id, image]) => ({ id, image }));
	}

	/** Start a new draft holding `images`, numbered from 1 in order, as a submitted draft's tokens are. */
	reset(images: readonly ImageContent[]): void {
		this.#images = new Map(images.map((image, index) => [index + 1, image]));
		this.#next = images.length + 1;
	}
}

const TOKEN = /\[image #(\d+)\]/g;

/** The token of image `id` in the text. */
export function imageToken(id: number): string {
	return `[image #${id}]`;
}

/** The line above the editor: `image #1 · png · 1280×800 · 210 KB` for each attachment. */
export function attachmentLine(attached: readonly Attachment[]): string {
	return attached
		.map(({ id, image }) => `image #${id} · ${describeImage(image)} · ${formatSize(imageBytes(image))}`)
		.join("   ");
}

/**
 * The input for draft `text` with `attached` (from `inText`), for `model`: the text alone without images; else the
 * text with the tokens renumbered 1, 2, ... in order, then the images. Refused, with a notice naming the limit, when
 * the model cannot see images, when there are more than `MAX_IMAGES`, or when one is over the model's byte limit.
 */
export function composeInput(text: string, attached: readonly Attachment[], model: ImageModel): Draft {
	if (attached.length === 0) return { kind: "input", content: text };
	const tokens = attached.map(({ id }) => imageToken(id));
	if (!model.vision) {
		return {
			kind: "refused",
			notice: `${model.name} cannot see images; switch with /model or remove ${tokens.join(", ")}`,
		};
	}
	if (attached.length > MAX_IMAGES) {
		return {
			kind: "refused",
			notice: `A message takes at most ${MAX_IMAGES} images; this one has ${attached.length}. Remove ${attached.length - MAX_IMAGES} of ${tokens.join(", ")}`,
		};
	}
	const over = attached.find(({ image }) => image.data.length > model.limits.maxBytes);
	if (over !== undefined) {
		return {
			kind: "refused",
			notice: `${imageToken(over.id)} is ${formatSize(over.image.data.length)} as sent, over the ${formatSize(model.limits.maxBytes)} ${model.name} takes; remove it`,
		};
	}
	const order = new Map(attached.map(({ id }, index) => [id, index + 1]));
	const numbered = text.replace(TOKEN, (token, id: string) => {
		const index = order.get(Number(id));
		return index === undefined ? token : imageToken(index);
	});
	return { kind: "input", content: [{ type: "text", text: numbered }, ...attached.map(({ image }) => image)] };
}
