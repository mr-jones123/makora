// The sqlite-vec binaries a release ships under native/sqlite-vec/<platform>/: one per platform makora runs on, since
// npm installs only the build machine's. Each comes from the registry URL package-lock.json pins and must match the
// lockfile's integrity hash before it is unpacked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The platforms a release supports, as sqlite-vec names them, with each binary's file name. */
export const VEC_PLATFORMS: readonly (readonly [platform: string, file: string])[] = [
	["darwin-arm64", "vec0.dylib"],
	["darwin-x64", "vec0.dylib"],
	["linux-arm64", "vec0.so"],
	["linux-x64", "vec0.so"],
];

interface LockEntry {
	readonly version?: string;
	readonly resolved?: string;
	readonly integrity?: string;
	readonly license?: string;
}

/** Fetch, check and place every platform's binary under `dir`; returns the NOTICE line for them. */
export async function shipVec(repo: string, dir: string): Promise<string> {
	const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8")) as {
		packages: Record<string, LockEntry>;
	};
	const main = lock.packages["node_modules/sqlite-vec"];
	if (main?.version === undefined) throw new Error("package-lock.json has no sqlite-vec");
	const work = mkdtempSync(join(tmpdir(), "makora-vec-"));
	try {
		for (const [platform, file] of VEC_PLATFORMS) {
			const name = `sqlite-vec-${platform}`;
			const entry = lock.packages[`node_modules/${name}`];
			if (entry?.resolved === undefined || entry.integrity === undefined)
				throw new Error(`package-lock.json pins no download for ${name}`);
			if (entry.version !== main.version)
				throw new Error(`${name} is at ${entry.version}, sqlite-vec at ${main.version}`);
			const response = await fetch(entry.resolved);
			if (!response.ok) throw new Error(`${name}: ${entry.resolved} answered HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			const [algorithm, expected] = splitIntegrity(entry.integrity);
			const actual = createHash(algorithm).update(bytes).digest("base64");
			if (actual !== expected)
				throw new Error(`${name}: the download does not match package-lock.json's ${algorithm}`);
			const tarball = join(work, `${platform}.tgz`);
			const unpacked = join(work, platform);
			writeFileSync(tarball, bytes);
			mkdirSync(unpacked);
			execFileSync("tar", ["-xzf", tarball, "-C", unpacked, `package/${file}`]);
			const target = join(dir, "native", "sqlite-vec", platform);
			mkdirSync(target, { recursive: true });
			copyFileSync(join(unpacked, "package", file), join(target, file));
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return `- sqlite-vec@${main.version} (${main.license ?? "MIT OR Apache-2.0"}): native/sqlite-vec/, one binary for each of ${VEC_PLATFORMS.map(([platform]) => platform).join(", ")}`;
}

// An SRI string: `sha512-<base64>`.
function splitIntegrity(integrity: string): [string, string] {
	const dash = integrity.indexOf("-");
	return [integrity.slice(0, dash), integrity.slice(dash + 1)];
}
