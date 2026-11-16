// Opening a URL or a file in the user's default browser through the platform's opener.
import { spawn } from "node:child_process";

/** Open `target` (a URL or a file path) with `open`, `xdg-open` or `explorer`; resolves whether the opener started. */
export function openInBrowser(target: string): Promise<boolean> {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	const { promise, resolve } = Promise.withResolvers<boolean>();
	try {
		const child = spawn(opener, [target], { stdio: "ignore", detached: true });
		child.once("spawn", () => resolve(true)).once("error", () => resolve(false));
		child.unref();
	} catch {
		resolve(false);
	}
	return promise;
}
