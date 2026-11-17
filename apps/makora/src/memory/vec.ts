// sqlite-vec, the SQLite extension behind memory's vector search: where its binary is for this platform, in a release
// or in a source checkout's node_modules, and loading it into a database.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { INSTALL } from "../install.ts";

/** Load sqlite-vec into `db`; false when this platform has no binary or it does not load, and search uses FTS alone. */
export function loadVec(db: DatabaseSync): boolean {
	const file = vecBinary();
	if (file === undefined) return false;
	try {
		db.loadExtension(file);
		return true;
	} catch {
		return false;
	}
}

/** sqlite-vec's name for this platform, as in its packages `sqlite-vec-<os>-<arch>`. */
function vecPlatform(): string {
	const os = process.platform === "win32" ? "windows" : process.platform;
	return `${os}-${process.arch}`;
}

const EXTENSIONS: Readonly<Record<string, string>> = { darwin: "dylib", win32: "dll" };

// The file name of the binary in each platform package.
const VEC_FILE = `vec0.${EXTENSIONS[process.platform] ?? "so"}`;

// A release carries one binary per platform under native/sqlite-vec/, fetched by build-release; a source checkout
// has npm's install of this platform's package.
function vecBinary(): string | undefined {
	const shipped = join(INSTALL.root, "native", "sqlite-vec", vecPlatform(), VEC_FILE);
	if (existsSync(shipped)) return shipped;
	try {
		// The platform package exports only the binary itself.
		return createRequire(import.meta.url).resolve(`sqlite-vec-${vecPlatform()}/${VEC_FILE}`);
	} catch {
		return undefined;
	}
}
