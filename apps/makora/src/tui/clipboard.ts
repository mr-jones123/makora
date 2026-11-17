// What Ctrl+V takes from the system clipboard: copied files as their paths, else an image, else text. Read through
// pi-tui's native clipboard helper, which covers macOS, Windows and Linux under X11.
import { getNativeClipboard } from "@earendil-works/pi-tui";

/** The reads Ctrl+V tries, in its order; each is undefined when the clipboard holds nothing of that kind. */
export interface ClipboardReader {
	files(): Promise<readonly string[] | undefined>;
	image(): Promise<Uint8Array | undefined>;
	text(): Promise<string | undefined>;
}

/** What one Ctrl+V pastes. */
export type ClipboardPaste =
	| { readonly kind: "files"; readonly paths: readonly string[] }
	| { readonly kind: "image"; readonly bytes: Uint8Array }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "empty" };

/**
 * What `clipboard` pastes: copied files first, because a Finder copy also carries the file's icon as an image, then an
 * image, then text.
 */
export async function readPaste(clipboard: ClipboardReader): Promise<ClipboardPaste> {
	const paths = await clipboard.files();
	if (paths !== undefined) {
		// Clipboard contents are outside input; a path with control characters would act on the terminal.
		if (paths.some((path) => /\p{Cc}/u.test(path)))
			throw new Error("a copied file's path contains control characters");
		return { kind: "files", paths };
	}
	const bytes = await clipboard.image();
	if (bytes !== undefined) return { kind: "image", bytes };
	const text = await clipboard.text();
	return text === undefined ? { kind: "empty" } : { kind: "text", text };
}

/** The system clipboard, or undefined on a platform without pi-tui's native helper (Linux without X11). */
export function systemClipboard(): ClipboardReader | undefined {
	const native = getNativeClipboard();
	if (native === undefined) return undefined;
	return {
		files: async () => {
			const paths = await native.getFilePaths?.();
			return paths?.length ? paths : undefined;
		},
		image: async () => {
			const bytes = await native.getImage();
			return bytes?.length ? bytes : undefined;
		},
		text: async () => (await native.getText()) || undefined,
	};
}

/** `paths` one per line, with a space added where the text around the cursor would run into them. */
export function spacedPaths(paths: readonly string[], before: string, after: string): string {
	const leading = before !== "" && !/\s$/.test(before) ? " " : "";
	const trailing = after !== "" && !/^\s/.test(after) ? " " : "";
	return `${leading}${paths.join("\n")}${trailing}`;
}
