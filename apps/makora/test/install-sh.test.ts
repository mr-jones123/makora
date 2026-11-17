import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { INSTALL } from "../src/install.ts";

const REPO = "mr-jones123/makora";

/** A release the fake GitHub serves: its tag, and its assets by name. */
interface FakeRelease {
	readonly tag_name: string;
	readonly draft: boolean;
	readonly prerelease: boolean;
	readonly files: ReadonlyMap<string, Buffer>;
}

const releases: FakeRelease[] = [];
let server: Server;
let base: string;

/** A makora-<version>.tar.gz whose bin/makora answers `--version` (or fails it) and `setup`, with its checksum. */
function publish(version: string, options: { checksum?: string; starts?: boolean } = {}): void {
	const dir = mkdtempSync(join(tmpdir(), "makora-fake-release-"));
	const bin = join(dir, `makora-${version}`, "bin");
	mkdirSync(bin, { recursive: true });
	const versionLine = options.starts === false ? "exit 1" : `echo "makora ${version} (fake)"`;
	writeFileSync(
		join(bin, "makora"),
		`#!/bin/sh\ncase "$1" in\n  --version) ${versionLine} ;;\n  setup) echo "fake setup ${version}" ;;\nesac\n`,
	);
	chmodSync(join(bin, "makora"), 0o755);
	const name = `makora-${version}.tar.gz`;
	execFileSync("tar", ["-czf", join(dir, name), "-C", dir, `makora-${version}`], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	const tarball = readFileSync(join(dir, name));
	const sha = options.checksum ?? createHash("sha256").update(tarball).digest("hex");
	releases.push({
		tag_name: `makora-v${version}`,
		draft: false,
		prerelease: false,
		files: new Map([
			[name, tarball],
			[`${name}.sha256`, Buffer.from(`${sha}  ${name}\n`)],
		]),
	});
}

function apiRelease(release: FakeRelease) {
	return {
		tag_name: release.tag_name,
		draft: release.draft,
		prerelease: release.prerelease,
		assets: [...release.files.keys()].map((name) => ({
			name,
			browser_download_url: `${base}/download/${release.tag_name}/${name}`,
		})),
	};
}

before(async () => {
	// The fork also holds upstream pi's releases and may hold drafts; neither is a makora release.
	releases.push(
		{ tag_name: "v99.0.0", draft: false, prerelease: false, files: new Map() },
		{ tag_name: "makora-v98.0.0", draft: true, prerelease: false, files: new Map() },
	);
	server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const list = `/repos/${REPO}/releases`;
		const byTag = path.startsWith(`${list}/tags/`) ? path.slice(`${list}/tags/`.length) : undefined;
		const download = /^\/download\/([^/]+)\/([^/]+)$/.exec(path);
		let body: Buffer | string | undefined;
		if (path === list) body = JSON.stringify(releases.toReversed().map(apiRelease));
		else if (byTag !== undefined) {
			const release = releases.find((each) => each.tag_name === byTag);
			body = release === undefined ? undefined : JSON.stringify(apiRelease(release));
		} else if (download) body = releases.find((each) => each.tag_name === download[1])?.files.get(download[2]!);
		response.writeHead(body === undefined ? 404 : 200).end(body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `sh install.sh <args>` for the user whose home is `home`, against the fake GitHub. */
function installSh(home: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Run> {
	const { promise, resolve } = Promise.withResolvers<Run>();
	execFile(
		"/bin/sh",
		[INSTALL.installer, ...args],
		{ env: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/zsh", MAKORA_RELEASE_BASE: base, ...env } },
		(error, stdout, stderr) => resolve({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
	);
	return promise;
}

function makoraVersion(home: string): string {
	return execFileSync(join(home, ".local", "bin", "makora"), ["--version"], { encoding: "utf8" }).trim();
}

function installed(home: string): { current: string; versions: string[] } {
	const app = join(home, ".makora", "app");
	return {
		current: readlinkSync(join(app, "current")),
		versions: readdirSync(app)
			.filter((name) => /^\d/.test(name))
			.sort(),
	};
}

describe("install.sh against a fake GitHub release", () => {
	const home = mkdtempSync(join(tmpdir(), "makora-install-home-"));

	it("installs the newest makora-v* release, ignoring pi's tags and drafts, and says how to put it on PATH", async () => {
		publish("0.1.0");
		const run = await installSh(home);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /fake setup 0\.1\.0/, "warms the Python environment");
		assert.match(run.stdout, /makora 0\.1\.0 is installed/);
		assert.deepEqual(installed(home), { current: "0.1.0", versions: ["0.1.0"] });
		assert.equal(makoraVersion(home), "makora 0.1.0 (fake)");
		assert.match(run.stdout, /\.local\/bin is not on your PATH/);
		assert.ok(run.stdout.includes(`export PATH="$HOME/.local/bin:$PATH"`), run.stdout);
		assert.ok(run.stdout.includes(join(home, ".zshrc")), run.stdout);
	});

	it("says so when the latest release is already installed", async () => {
		const run = await installSh(home);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /makora 0\.1\.0 is already installed \(up to date\)/);
	});

	it("upgrades, keeping the version it replaced and removing older ones", async () => {
		publish("0.2.0");
		const first = await installSh(home);
		assert.equal(first.code, 0, first.stderr);
		assert.match(first.stdout, /makora 0\.1\.0 → 0\.2\.0/);
		assert.deepEqual(installed(home), { current: "0.2.0", versions: ["0.1.0", "0.2.0"] });
		publish("0.3.0");
		const second = await installSh(home);
		assert.equal(second.code, 0, second.stderr);
		assert.deepEqual(installed(home), { current: "0.3.0", versions: ["0.2.0", "0.3.0"] });
		assert.equal(makoraVersion(home), "makora 0.3.0 (fake)");
	});

	it("takes the install directory by its real path, as makora update passes it", async () => {
		const run = await installSh(home, [], { MAKORA_INSTALL_DIR: realpathSync(join(home, ".makora", "app")) });
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /makora 0\.3\.0 is already installed/);
		assert.equal(
			readlinkSync(join(home, ".local", "bin", "makora")),
			join(realpathSync(join(home, ".makora", "app")), "current", "bin", "makora"),
		);
	});

	it("installs the release --version names", async () => {
		const run = await installSh(home, ["--version", "0.1.0"]);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /makora 0\.3\.0 → 0\.1\.0/);
		assert.deepEqual(installed(home), { current: "0.1.0", versions: ["0.1.0", "0.3.0"] });
		const missing = await installSh(home, ["--version", "7.7.7"]);
		assert.notEqual(missing.code, 0);
		assert.match(missing.stderr, /no release makora-v7\.7\.7 found/);
	});

	it("aborts on a checksum mismatch and leaves the installed version working", async () => {
		publish("0.4.0", { checksum: "0".repeat(64) });
		const run = await installSh(home);
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /checksum mismatch for makora-0\.4\.0\.tar\.gz/);
		assert.deepEqual(installed(home), { current: "0.1.0", versions: ["0.1.0", "0.3.0"] });
		assert.equal(makoraVersion(home), "makora 0.1.0 (fake)");
	});

	it("keeps the installed version when the new one does not start", async () => {
		publish("0.5.0", { starts: false });
		const run = await installSh(home);
		assert.notEqual(run.code, 0);
		assert.match(
			run.stderr,
			/makora 0\.5\.0 did not start \(makora --version failed\); makora 0\.1\.0 stays installed/,
		);
		assert.deepEqual(installed(home), { current: "0.1.0", versions: ["0.1.0", "0.3.0"] });
		assert.equal(makoraVersion(home), "makora 0.1.0 (fake)");
	});

	it("uninstalls the app and the link, and keeps sessions and settings", async () => {
		mkdirSync(join(home, ".makora", "sessions"), { recursive: true });
		writeFileSync(join(home, ".makora", "settings.json"), "{}\n");
		const run = await installSh(home, ["--uninstall"]);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /makora is uninstalled\. Your sessions, settings and Python environment in .* are kept/);
		assert.equal(existsSync(join(home, ".makora", "app")), false);
		assert.equal(existsSync(join(home, ".local", "bin", "makora")), false);
		assert.ok(existsSync(join(home, ".makora", "sessions")));
		assert.ok(existsSync(join(home, ".makora", "settings.json")));
	});
});

describe("install.sh preflight and PATH", () => {
	it("refuses to install without Node and prints how to install it", async () => {
		// Every tool install.sh may call, except node.
		const bin = mkdtempSync(join(tmpdir(), "makora-no-node-"));
		const tools = ["uname", "mkdir", "mktemp", "rm", "mv", "ln", "readlink", "basename", "dirname", "cat", "cut"];
		tools.push("sed", "tar", "gzip", "curl", "wget", "shasum", "sha256sum", "uv", "python3", "perl");
		for (const tool of tools) {
			const path = (process.env.PATH ?? "")
				.split(delimiter)
				.map((dir) => join(dir, tool))
				.find((candidate) => existsSync(candidate));
			if (path !== undefined) symlinkSync(path, join(bin, tool));
		}
		const home = mkdtempSync(join(tmpdir(), "makora-install-home-"));
		const run = await installSh(home, [], { PATH: bin });
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /makora needs:\n {2}- Node\.js 22\.19\.0 or newer\. Install it with: /);
		assert.equal(existsSync(join(home, ".makora")), false);
	});

	it("prints no PATH line when the bin directory is on PATH", async () => {
		const home = mkdtempSync(join(tmpdir(), "makora-install-home-"));
		const binDir = join(home, ".local", "bin");
		const run = await installSh(home, ["--version", "0.1.0"], { PATH: `${binDir}${delimiter}${process.env.PATH}` });
		assert.equal(run.code, 0, run.stderr);
		assert.doesNotMatch(run.stdout, /not on your PATH/);
	});

	it("requires the Node version package.json's engines names", () => {
		const engines = JSON.parse(readFileSync(join(INSTALL.root, "package.json"), "utf8")).engines.node as string;
		const script = readFileSync(INSTALL.installer, "utf8");
		assert.equal(`>=${/^NODE_MIN=(.*)$/m.exec(script)?.[1]}`, engines);
	});
});
