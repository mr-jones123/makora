#!/usr/bin/env node
// Builds a makora release: one bundle of makora with the fork's packages/* sources, the bundle of Durable's image
// worker beside it, its runtime files, and a tarball with its sha256, in dist/release/. A release installs no npm
// dependencies; Photon's WebAssembly ships as the one file of its package that the worker reads.
// Usage: npm run build:release [-- --version <x.y.z>]   (default: the version in package.json)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { shippedPaths } from "./release/repo.ts";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(APP, "..", "..");

const { values } = parseArgs({ options: { version: { type: "string" } } });
const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
const version = values.version ?? pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a release version: ${version}`);
const minimumNode = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines.node)?.[1];
if (minimumNode === undefined) fail(`engines.node must be ">=x.y.z", not ${pkg.engines.node}`);

const name = `makora-${version}`;
const out = join(APP, "dist", "release");
const dir = join(out, name);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** Bundle `entry` with every workspace package resolved to its sources; returns the bundled npm packages. */
async function bundle(entry, outfile) {
	const result = await build({
		absWorkingDir: APP,
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: `node${minimumNode}`,
		// The root tsconfig's paths are the aliases src/source-resolver.ts applies when makora runs from source.
		tsconfig: join(REPO, "tsconfig.json"),
		// CommonJS dependencies require Node built-ins, which an ES module bundle has no `require` for.
		banner: {
			js: '#!/usr/bin/env node\nimport { createRequire as makoraCreateRequire } from "node:module";\nconst require = makoraCreateRequire(import.meta.url);',
		},
		metafile: true,
		logLevel: "warning",
	});
	chmodSync(outfile, 0o755);
	const inputs = Object.keys(result.metafile.inputs);
	const stale = inputs.filter((input) => /(^|\/)packages\/[^/]+\/dist\/|node_modules\/@earendil-works\//.test(input));
	if (stale.length > 0) fail(`the bundle must take workspace packages from their sources, not:\n${stale.join("\n")}`);
	// The release plan counts commits under shippedPaths; a package the bundle reaches outside it would ship unannounced.
	const shipped = shippedPaths(REPO);
	const unplanned = [...new Set(inputs.map((input) => /^(?:\.\.\/)+(packages\/[^/]+\/)/.exec(input)?.[1]))].filter(
		(dir) => dir !== undefined && !shipped.includes(dir),
	);
	if (unplanned.length > 0)
		fail(`the bundle reaches packages scripts/release/repo.ts does not list: ${unplanned.join(", ")}`);
	const packages = new Set();
	for (const input of inputs) {
		const at = input.lastIndexOf("node_modules/");
		if (at === -1) continue;
		const [first, second] = input.slice(at + "node_modules/".length).split("/");
		packages.add(join(APP, input.slice(0, at), "node_modules", first.startsWith("@") ? `${first}/${second}` : first));
	}
	return [...packages].sort();
}

/** The files makora reads at runtime, laid out as in apps/makora, plus the launcher and the installer. */
function copyRuntimeFiles() {
	cpSync(join(APP, "assets"), join(dir, "assets"), { recursive: true });
	cpSync(join(APP, "skills"), join(dir, "skills"), { recursive: true });
	cpSync(join(APP, "python", "makora_rlm"), join(dir, "python", "makora_rlm"), {
		recursive: true,
		filter: (source) => !source.includes("__pycache__"),
	});
	cpSync(join(APP, "install.sh"), join(dir, "install.sh"));
	// Durable's image worker reads Photon's WebAssembly through the package's path, from beside the bundle.
	const photon = dirname(DURABLE_REQUIRE.resolve("@silvia-odwyer/photon/package.json"));
	const photonDir = join(dir, "node_modules", "@silvia-odwyer", "photon");
	mkdirSync(photonDir, { recursive: true });
	for (const file of ["package.json", "photon_rs_bg.wasm", "LICENSE.md"])
		cpSync(join(photon, file), join(photonDir, file));
	// pi-tui's optional native helpers (modifier keys, clipboard images) are looked up next to the bundle.
	for (const platform of ["darwin", "linux"]) {
		const prebuilds = join("native", platform, "prebuilds");
		cpSync(join(REPO, "packages", "tui", prebuilds), join(dir, prebuilds), { recursive: true });
	}
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "makora"), LAUNCHER);
	chmodSync(join(dir, "bin", "makora"), 0o755);
}

// install.sh links `<bin dir>/makora` to `<install dir>/current/bin/makora`; the launcher follows the links to the
// release folder it belongs to, so a running makora keeps its version while `current` moves.
const LAUNCHER = `#!/bin/sh
# Runs makora with the node on PATH, from the release folder this script is in.
set -eu
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  echo "makora: node is not on PATH; makora needs Node.js ${pkg.engines.node}" >&2
  exit 127
fi
exec node "$root/makora.mjs" "$@"
`;

/** HEAD's sha, marked `-dirty` when the sources a release bundles have uncommitted changes. */
function commit() {
	const sha = git(["rev-parse", "HEAD"]);
	return git(["status", "--porcelain", "--", "apps/makora", "packages"]) === "" ? sha : `${sha}-dirty`;
}

function git(args) {
	return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** The licenses of everything in the release besides makora and pi's MIT code. */
function notice(packages) {
	const lock = JSON.parse(readFileSync(join(APP, "skills.lock.json"), "utf8"));
	const lines = [
		`makora ${version}`,
		"",
		"makora and the pi packages it bundles (packages/* of the same repository) are under the MIT license in LICENSE.",
		"",
		"Bundled skills (skills/), synced by skills.lock.json; their licenses are in skills/LICENSES/:",
	];
	for (const [source, pin] of Object.entries(lock.sources)) {
		const licenses = Object.keys(lock.outputs).filter(
			(output) =>
				output.startsWith("skills/LICENSES/") &&
				Object.entries(lock.inputs).some(
					([input, hash]) =>
						input.startsWith(`${source}/`) && input.endsWith("/LICENSE") && hash === lock.outputs[output],
				),
		);
		lines.push(`- ${pin.repository} at ${pin.commit}: ${licenses.join(", ")}`);
	}
	lines.push("", "Bundled npm packages (in makora.mjs), each with its license:");
	const unlicensed = [];
	const texts = [];
	for (const path of packages) {
		const meta = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		lines.push(`- ${meta.name}@${meta.version} (${meta.license})`);
		const files = readdirSync(path).filter((file) => /^(licen[cs]e|copying|notice)/i.test(file));
		if (files.length === 0) unlicensed.push(meta.name);
		for (const file of files) {
			texts.push(
				"",
				`==== ${meta.name}@${meta.version}: ${file} ====`,
				"",
				readFileSync(join(path, file), "utf8").trim(),
			);
		}
	}
	if (unlicensed.length > 0) {
		lines.push(
			"",
			`These packages ship no license file; their package.json license applies: ${unlicensed.join(", ")}`,
		);
	}
	return `${[...lines, ...texts].join("\n")}\n`;
}

/** `<name>.tar.gz` of the release folder and its `.sha256`, in `shasum -a 256` format. */
function pack() {
	const tarball = join(out, `${name}.tar.gz`);
	// macOS tar would add AppleDouble `._` files for extended attributes.
	execFileSync("tar", ["-czf", tarball, "-C", out, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
	const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	writeFileSync(`${tarball}.sha256`, `${sha}  ${name}.tar.gz\n`);
	return tarball;
}

function fail(message) {
	console.error(`build-release: ${message}`);
	process.exit(1);
}

// `createNodePhotonImages()` starts `node-worker.js` from beside the code that calls it, which is makora.mjs.
const DURABLE_REQUIRE = createRequire(join(REPO, "packages", "durable", "package.json"));
const bundled = [
	...new Set([
		...(await bundle("src/main.ts", join(dir, "makora.mjs"))),
		...(await bundle(
			join(REPO, "packages", "durable", "src", "images", "node-worker.ts"),
			join(dir, "node-worker.js"),
		)),
	]),
].sort();
copyRuntimeFiles();
writeFileSync(
	join(dir, "package.json"),
	`${JSON.stringify(
		{
			name: "makora",
			version,
			private: true,
			type: "module",
			engines: pkg.engines,
			bin: { makora: "bin/makora" },
		},
		null,
		"\t",
	)}\n`,
);
writeFileSync(join(dir, "BUILD"), `${JSON.stringify({ commit: commit(), date: new Date().toISOString() })}\n`);
cpSync(join(REPO, "LICENSE"), join(dir, "LICENSE"));
writeFileSync(join(dir, "NOTICE"), notice(bundled));
const tarball = pack();
console.log(`${relative(process.cwd(), dir)}/`);
console.log(`${relative(process.cwd(), tarball)}`);
console.log(`${relative(process.cwd(), tarball)}.sha256`);
