// The shared Python environment every kernel runs in: `<home>/python/venv` with a pinned dill, built once on first use.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The dill version kernels pickle with; a venv built with another version is rebuilt. */
export const DILL_VERSION = "0.4.1";

/** The Python `uv` builds the environment with; the `python3 -m venv` fallback takes `python3` if it is 3.11 or newer. */
export const PYTHON_VERSION = "3.12";

/** A ready environment: the interpreter, and the directory holding `makora_rlm` for `PYTHONPATH`. */
export interface PythonEnv {
	readonly python: string;
	readonly packagePath: string;
	readonly dill: string;
}

/** `makora_rlm` lives in the app's `python/` directory and is put on `PYTHONPATH`, never installed. */
export const PACKAGE_PATH = fileURLToPath(new URL("../../python", import.meta.url));

/**
 * The environment under `home`, built when missing or pinned to another dill. Safe when several makora processes
 * race: each builds in its own directory and renames it into place, and a loser uses the winner's.
 */
export async function ensurePythonEnv(home: string): Promise<PythonEnv> {
	const root = join(home, "python");
	const venv = join(root, "venv");
	if (pinnedDill(venv) === DILL_VERSION) return envAt(venv);
	mkdirSync(root, { recursive: true });
	const building = join(root, `venv.${process.pid}.${Date.now()}.tmp`);
	try {
		await buildVenv(building);
		writeFileSync(join(building, MARKER), `${JSON.stringify({ dill: DILL_VERSION })}\n`);
		if (existsSync(venv) && pinnedDill(venv) !== DILL_VERSION) {
			const stale = join(root, `venv.${process.pid}.${Date.now()}.stale`);
			renameSync(venv, stale);
			rmSync(stale, { recursive: true, force: true });
		}
		try {
			renameSync(building, venv);
		} catch (error) {
			// Another process renamed its build into place first.
			if (pinnedDill(venv) !== DILL_VERSION) throw error;
		}
	} finally {
		rmSync(building, { recursive: true, force: true });
	}
	return envAt(venv);
}

const MARKER = "makora-env.json";

const run = promisify(execFile);

function envAt(venv: string): PythonEnv {
	return { python: join(venv, "bin", "python"), packagePath: PACKAGE_PATH, dill: DILL_VERSION };
}

// The marker is written by `ensurePythonEnv` itself; a missing or unreadable one means the venv needs building.
function pinnedDill(venv: string): string | undefined {
	try {
		const marker = JSON.parse(readFileSync(join(venv, MARKER), "utf8")) as { dill?: unknown };
		return typeof marker.dill === "string" ? marker.dill : undefined;
	} catch {
		return undefined;
	}
}

// The kernel starts with `-P` (Python 3.11) and `makora_rlm` uses 3.10 syntax.
const MINIMUM_PYTHON_CHECK = [
	"import sys",
	"if sys.version_info < (3, 11):",
	"    sys.exit(f'Python {sys.version.split()[0]} is too old; makora needs Python 3.11 or newer')",
].join("\n");

async function buildVenv(dir: string): Promise<void> {
	const failures: string[] = [];
	try {
		// uv reads `uv.toml` and `pyproject.toml` from its cwd upward; a cloned project must not pick the index dill
		// comes from, so neither command reads any configuration file, and they run outside the project.
		const isolated = { cwd: dirname(dir) };
		await run("uv", ["venv", "--quiet", "--no-config", "--python", PYTHON_VERSION, dir], isolated);
		await run(
			"uv",
			["pip", "install", "--quiet", "--no-config", "--python", join(dir, "bin", "python"), `dill==${DILL_VERSION}`],
			isolated,
		);
		return;
	} catch (error) {
		failures.push(`uv: ${describe(error)}`);
		rmSync(dir, { recursive: true, force: true });
	}
	try {
		await run("python3", ["-m", "venv", dir]);
		await run(join(dir, "bin", "python"), ["-c", MINIMUM_PYTHON_CHECK]);
		await run(join(dir, "bin", "python"), ["-m", "pip", "install", "--quiet", `dill==${DILL_VERSION}`]);
		return;
	} catch (error) {
		failures.push(`python3 -m venv: ${describe(error)}`);
	}
	throw new Error(
		`makora could not build its Python environment. Install uv (https://docs.astral.sh/uv/), or python3 3.11 or newer with venv and pip.\n${failures.join("\n")}`,
	);
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
	return stderr || error.message;
}
