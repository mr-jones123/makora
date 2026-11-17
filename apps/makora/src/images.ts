// Images makora hands a model, pasted into a message or shown from a cell: what the model takes, each image sniffed and
// prepared to its limits by Photon, and how an image is described in the transcript.
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
	DEFAULT_IMAGE_LIMITS,
	detectSupportedImageMimeType,
	type ImageLimits,
	type ImageProcessor,
	imageDimensions,
} from "@earendil-works/pi-durable/tools";

/** Images one message, or one cell, may give the model; each is within its model's limits after preparing. */
export const MAX_IMAGES = 4;

/** What a conversation's model takes: its name for notices, whether it sees images, and the limits they must keep. */
export type ImageModel = { readonly name: string; readonly vision: boolean; readonly limits: ImageLimits };

/**
 * The image input of `ref`: Durable's default limits overridden by the model's `inputLimits.images.resize`, as Durable's
 * `read` applies them. A model the catalog does not know counts as one that sees images, as in `read`.
 */
export function imageModel(ref: ModelRef | undefined, models: Models): ImageModel {
	const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
	const resize = model?.inputLimits?.images?.resize;
	return {
		name: ref?.modelId ?? "no model",
		vision: model?.input.includes("image") ?? true,
		limits: {
			maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
			maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
			maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
		},
	};
}

/** An image ready for the model, or why it cannot be. */
export type PreparedImage =
	| {
			readonly kind: "image";
			readonly image: ImageContent;
			/** The size before Photon scaled it down. */
			readonly resizedFrom?: { readonly width: number; readonly height: number };
	  }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * `bytes` as an image within `limits`: its format sniffed from its header, then turned upright, converted and scaled
 * down by `images`.
 */
export async function prepareImage(
	bytes: Uint8Array,
	limits: ImageLimits,
	images: ImageProcessor,
): Promise<PreparedImage> {
	const mimeType = detectSupportedImageMimeType(bytes);
	if (mimeType === undefined) return { kind: "refused", reason: "it is not a PNG, JPEG, GIF, WebP or BMP image" };
	const prepared = await images.prepare(bytes, mimeType, limits);
	if (prepared === undefined) {
		return { kind: "refused", reason: `it cannot be decoded, or made to fit ${formatSize(limits.maxBytes)}` };
	}
	const image: ImageContent = { type: "image", data: prepared.data, mimeType: prepared.mimeType };
	return prepared.resized === undefined
		? { kind: "image", image }
		: { kind: "image", image, resizedFrom: prepared.resized.from };
}

// Enough base64 for every format's size header; Photon's JPEGs carry no EXIF before their frame header.
const HEADER_CHARS = 64 * 1024;

/** An image as the transcript names it: `png · 1280×800`, or just the format when its header has no size. */
export function describeImage(image: ImageContent): string {
	const format = image.mimeType.replace(/^image\//, "");
	const size = imageDimensions(Buffer.from(image.data.slice(0, HEADER_CHARS), "base64"), image.mimeType);
	return size === undefined ? format : `${format} · ${size.width}×${size.height}`;
}

/** How many bytes an image's base64 decodes to. */
export function imageBytes(image: ImageContent): number {
	const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
	return (image.data.length / 4) * 3 - padding;
}

/** A byte count as `840 B`, `210 KB`, `4.5 MB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}
