// Makora's own files and build: a release folder holding `makora.mjs`, or `apps/makora` in a source checkout. Every
// reader of a bundled asset, skill or the Python package finds it here.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Which makora is running: a release built by `npm run build:release`, or the TypeScript sources. */
export type Build =
	| { readonly kind: "release"; readonly version: string; readonly commit: string; readonly date: string }
	| { readonly kind: "source"; readonly version: string };

/** Where makora's own files are, and which build they are. */
export interface Install {
	/** The directory holding makora's `package.json`. */
	readonly root: string;
	readonly skills: string;
	readonly quizTemplate: string;
	/** The directory holding `makora_rlm`, put on the kernel's `PYTHONPATH`. */
	readonly python: string;
	/** The installer a release ships, which `makora update` runs. */
	readonly installer: string;
	readonly build: Build;
}

/** The running makora's install. */
export const INSTALL: Install = installAt(packageRoot(dirname(fileURLToPath(import.meta.url))));

/** The text `makora --version` prints. */
export function describeBuild(build: Build): string {
	return build.kind === "release" ? `makora ${build.version} (${build.commit})` : `makora ${build.version}+dev`;
}

// The same rule in both layouts: `src/install.ts` sits one level below apps/makora's package.json, and the bundle's
// code sits next to the release's package.json.
function packageRoot(from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) return dir;
		if (dirname(dir) === dir) throw new Error(`makora: no package.json above ${from}`);
	}
}

function installAt(root: string): Install {
	return {
		root,
		skills: join(root, "skills"),
		quizTemplate: join(root, "assets", "quiz", "template.html"),
		python: join(root, "python"),
		installer: join(root, "install.sh"),
		build: buildAt(root),
	};
}

// `BUILD` is written by scripts/build-release.mjs into releases only; a source checkout has none.
function buildAt(root: string): Build {
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
	const buildFile = join(root, "BUILD");
	if (!existsSync(buildFile)) return { kind: "source", version };
	const { commit, date } = JSON.parse(readFileSync(buildFile, "utf8")) as { commit: string; date: string };
	return { kind: "release", version, commit, date };
}
