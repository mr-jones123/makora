import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type CellHandlers, describeExit, Kernel, type KernelOutcome } from "../src/kernel/kernel.ts";
import { KernelManager } from "../src/kernel/manager.ts";
import type { HostRequest, KernelMessage } from "../src/kernel/protocol.ts";
import { DILL_VERSION, ensurePythonEnv, type PythonEnv } from "../src/kernel/python-env.ts";

const home = mkdtempSync(join(tmpdir(), "makora-kernel-"));
let env: PythonEnv;
const kernels: Kernel[] = [];

before(async () => {
	env = await ensurePythonEnv(home);
});

after(async () => {
	await Promise.all(kernels.map((kernel) => kernel.shutdown()));
});

async function start(): Promise<Kernel> {
	const kernel = await Kernel.start(env, home, BACKGROUND_CONTEXT);
	kernels.push(kernel);
	return kernel;
}

/** Run a cell, collecting its stdout and answering host requests with `answer`. */
async function run(
	kernel: Kernel,
	code: string,
	options: {
		answer?: (request: HostRequest) => unknown;
		onStdout?: () => void;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
) {
	let stdout = "";
	const handlers: CellHandlers = {
		stream: (stream, text) => {
			if (stream !== "stdout") return;
			stdout += text;
			options.onStdout?.();
		},
		hostRequest: async (request) => options.answer?.(request),
	};
	const context =
		options.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
	const outcome = await kernel.execute(code, options.timeoutMs ?? 30_000, handlers, context);
	return { outcome, stdout };
}

function reply<T>(outcome: KernelOutcome<T>): T {
	if (outcome.kind !== "reply") assert.fail(`the kernel died: ${JSON.stringify(outcome)}`);
	return outcome.value;
}

// An exiting process sends no event to a non-parent, so this polls.
async function gone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await sleep(20);
	}
	return false;
}

const HAS_UV = spawnSync("uv", ["--version"]).status === 0;

// macOS ships Python 3.9 as /usr/bin/python3.
const OLD_PYTHON = "/usr/bin/python3";
const HAS_OLD_PYTHON =
	spawnSync(OLD_PYTHON, ["-c", "import sys; print(sys.version_info < (3, 11))"], {
		encoding: "utf8",
	}).stdout?.trim() === "True";

describe("python environment", () => {
	it("is built once, also when two callers race, and pins dill", async () => {
		const raceHome = mkdtempSync(join(tmpdir(), "makora-env-"));
		const [first, second] = await Promise.all([ensurePythonEnv(raceHome), ensurePythonEnv(raceHome)]);
		assert.equal(first.python, second.python);
		assert.ok(existsSync(first.python));
		const kernel = await Kernel.start(first, raceHome, BACKGROUND_CONTEXT);
		assert.equal(kernel.dill, DILL_VERSION);
		await kernel.shutdown();
	});

	it(
		"ignores the uv configuration of the project it starts in",
		{ skip: !HAS_UV && "uv is not installed" },
		async () => {
			const project = mkdtempSync(join(tmpdir(), "makora-uv-project-"));
			// Nothing listens on port 9: uv would fail to install dill from this index.
			writeFileSync(join(project, "uv.toml"), 'index-url = "http://127.0.0.1:9/simple"\n');
			const cwd = process.cwd();
			process.chdir(project);
			try {
				const built = await ensurePythonEnv(mkdtempSync(join(tmpdir(), "makora-env-")));
				const config = readFileSync(join(dirname(dirname(built.python)), "pyvenv.cfg"), "utf8");
				assert.match(config, /^uv = /m, "built by uv, not by the python3 fallback");
			} finally {
				process.chdir(cwd);
			}
		},
	);

	it("refuses a python3 older than the kernel needs", { skip: !HAS_OLD_PYTHON && "no old python3" }, async () => {
		const bin = mkdtempSync(join(tmpdir(), "makora-bin-"));
		symlinkSync(OLD_PYTHON, join(bin, "python3"));
		const path = process.env.PATH;
		// Without uv on PATH, the environment comes from the python3 fallback.
		process.env.PATH = bin;
		try {
			await assert.rejects(
				ensurePythonEnv(mkdtempSync(join(tmpdir(), "makora-env-"))),
				/Python 3\.\d+\.\d+ is too old; makora needs Python 3\.11 or newer/,
			);
		} finally {
			process.env.PATH = path;
		}
	});
});

describe("kernel protocol", () => {
	it("keeps variables across cells, captures stdout, returns the last value and reports tracebacks", async () => {
		const kernel = await start();
		assert.equal(reply((await run(kernel, "x = 41")).outcome).status, "ok");
		const printed = await run(kernel, "import os\nprint(x + 1)\nos.system('echo from-a-subprocess')");
		assert.equal(printed.stdout, "42\nfrom-a-subprocess\n");
		assert.equal(reply(printed.outcome).value, "0");
		assert.equal(reply((await run(kernel, "x * 2")).outcome).value, "82");
		const failed = reply((await run(kernel, "def f():\n    return 1 / 0\nf()")).outcome);
		assert.equal(failed.status, "error");
		assert.equal(failed.error?.name, "ZeroDivisionError");
		assert.match(failed.error?.traceback ?? "", /File "<cell-\d+>", line 2, in f\n {4}return 1 \/ 0/);
		assert.doesNotMatch(failed.error?.traceback ?? "", /kernel\.py/);
	});

	it("interrupts a cell blocked in time.sleep, and the kernel stays usable", async () => {
		const kernel = await start();
		const controller = new AbortController();
		const started = Date.now();
		const cell = "import time\nprint('sleeping')\ntime.sleep(30)";
		const result = reply(
			(await run(kernel, cell, { signal: controller.signal, onStdout: () => controller.abort() })).outcome,
		);
		assert.equal(result.status, "interrupted");
		assert.ok(Date.now() - started < 3_000);
		assert.equal(reply((await run(kernel, "1 + 1")).outcome).value, "2");
	});

	it("interrupts a cell past its timeout", async () => {
		const kernel = await start();
		const result = reply((await run(kernel, "import asyncio\nawait asyncio.sleep(30)", { timeoutMs: 300 })).outcome);
		assert.equal(result.status, "interrupted");
		assert.equal(result.error?.message, "timed out after 0.3s");
	});

	it("reports a kernel that died during a cell", async () => {
		const kernel = await start();
		const { outcome } = await run(kernel, "import os\nos._exit(3)");
		assert.equal(outcome.kind, "died");
		assert.equal(outcome.kind === "died" ? describeExit(outcome.exit) : "", "exit 3");
		assert.ok(kernel.dead);
	});

	it("reports a kernel that died before makora saw its exit as died, not as a write error", async () => {
		const kernel = await start();
		kernel.kill();
		// Block the event loop past the SIGKILL, so the process is gone but its exit event has not been handled: the
		// request's write then finds the pipe closed (EPIPE).
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
		assert.equal(kernel.dead, false, "makora has not seen the exit yet");
		const outcome = await kernel.snapshot(join(home, "blobs"), undefined, 1_000_000);
		assert.equal(outcome.kind, "died");
	});

	it("answers helper calls through the host", async () => {
		const kernel = await start();
		const requests: HostRequest[] = [];
		const { stdout } = await run(kernel, 'print(await read("notes.txt", limit=5))', {
			answer: (request) => {
				requests.push(request);
				return "hello from the host";
			},
		});
		assert.equal(stdout, "hello from the host\n");
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.method, "tool");
		assert.deepEqual(requests[0]?.params, { name: "read", args: { path: "notes.txt", limit: 5 } });
		const refused = await run(kernel, 'await write("x", "y")', {
			answer: () => {
				throw new Error("not allowed here");
			},
		});
		assert.equal(reply(refused.outcome).error?.name, "HostError");
		assert.equal(reply(refused.outcome).error?.message, "not allowed here");
	});

	it("starts in a project whose modules shadow the standard library, and cells import project modules", async () => {
		const project = mkdtempSync(join(tmpdir(), "makora-shadow-"));
		writeFileSync(join(project, "json.py"), "raise RuntimeError('the project json.py was imported')\n");
		writeFileSync(join(project, "local_module.py"), "VALUE = 7\n");
		const kernel = await Kernel.start(env, project, BACKGROUND_CONTEXT);
		kernels.push(kernel);
		assert.equal(reply((await run(kernel, "import local_module\nlocal_module.VALUE")).outcome).value, "7");
	});

	it("delivers every stream of a cell before its result", async () => {
		const kernel = await start();
		// A real-time race: the background flusher takes the output, then stalls 200 ms before sending it, while the
		// cell ends 60 ms in (past the 50 ms flush tick) and its result is sent.
		const stall = [
			"import sys, threading, time",
			"wire = sys.modules['makora_rlm.kernel'].Wire",
			"send = wire.send",
			"def stalled(self, message):",
			"    if message['type'] == 'stream' and threading.current_thread() is not threading.main_thread():",
			"        time.sleep(0.2)",
			"    send(self, message)",
			"wire.send = stalled",
		].join("\n");
		assert.equal(reply((await run(kernel, stall)).outcome).status, "ok");
		const { stdout } = await run(kernel, "print('last words')\ntime.sleep(0.06)");
		assert.equal(stdout, "last words\n");
	});

	it("clamps a timeout past Node's timer range", async () => {
		const kernel = await start();
		const result = reply((await run(kernel, "import time\ntime.sleep(0.1)\n1", { timeoutMs: 2 ** 31 })).outcome);
		assert.equal(result.status, "ok");
	});

	it("kills the processes its cells started when it shuts down", async () => {
		const kernel = await Kernel.start(env, home, BACKGROUND_CONTEXT);
		const { outcome } = await run(kernel, "import subprocess\nsubprocess.Popen(['sleep', '60']).pid");
		const pid = Number(reply(outcome).value);
		await kernel.shutdown();
		assert.ok(await gone(pid), "the cell's sleep ended with the kernel");
	});

	it("kills the processes its cells started when makora goes away", async () => {
		const child = spawn(env.python, ["-m", "makora_rlm.kernel"], {
			cwd: home,
			env: { ...process.env, PYTHONPATH: env.packagePath },
			stdio: ["pipe", "pipe", "inherit"],
			detached: true,
		});
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		const next = async (): Promise<KernelMessage> =>
			JSON.parse((await lines.next()).value as string) as KernelMessage;
		assert.equal((await next()).type, "ready");
		const code = "import subprocess\nsubprocess.Popen(['sleep', '60']).pid";
		child.stdin.write(`${JSON.stringify({ type: "execute", id: "cell-1", code, timeoutMs: 30_000 })}\n`);
		let result = await next();
		while (result.type !== "result") result = await next();
		const pid = Number(result.value);
		child.stdin.end();
		assert.ok(await gone(pid), "the cell's sleep ended with the kernel");
	});
});

describe("kernel manager", () => {
	it("kills a kernel an earlier makora left behind when the session opens again", async () => {
		const pidDir = join(home, "session-kernels");
		const crashed = new KernelManager(home, pidDir);
		const { kernel } = await crashed.acquire(1 as ConversationId, home, BACKGROUND_CONTEXT);
		assert.equal(crashed.status(1 as ConversationId).state, "running");
		const reopened = new KernelManager(home, pidDir);
		assert.deepEqual(await kernel.exited, { code: null, signal: "SIGKILL" });
		assert.equal(reopened.status(1 as ConversationId).state, "none");
		const fresh = await reopened.acquire(1 as ConversationId, home, BACKGROUND_CONTEXT);
		assert.equal(fresh.fresh, true);
		await reopened.close();
	});
});

describe("snapshots", () => {
	it("restore values and shared objects into a new kernel and report what they could not keep", async () => {
		const blobDir = join(home, "blobs");
		const first = await start();
		const code = [
			"import json",
			"import sqlite3 as db",
			"a = b = []",
			"n = 5",
			"def twice(v):",
			"    return v * n",
			"conn = db.connect(':memory:')",
			"big = 'x' * 5000",
		].join("\n");
		assert.equal(reply((await run(first, code)).outcome).status, "ok");
		const manifest = reply(await first.snapshot(blobDir, undefined, 1_000));
		assert.deepEqual(manifest.imports, ["import json", "import sqlite3 as db"]);
		assert.deepEqual(manifest.vars.a?.group, ["b"]);
		assert.deepEqual(
			manifest.dropped.map(({ name, reason }) => ({ name, reason })),
			[
				{ name: "conn", reason: "unpicklable" },
				{ name: "big", reason: "over_cap" },
			],
		);
		assert.ok(existsSync(join(blobDir, "sha256", manifest.vars.n!.blob.slice(7, 9), manifest.vars.n!.blob.slice(9))));

		const second = await start();
		const restored = reply(await second.restore(blobDir, manifest));
		assert.deepEqual([...restored.restored].sort(), ["a", "b", "n", "twice"]);
		assert.deepEqual(restored.failed, []);
		const check = await run(second, "a.append(1)\n(b, twice(2), json.dumps(n), db.__name__)");
		assert.equal(reply(check.outcome).value, "([1], 10, '5', 'sqlite3')");

		const again = reply(await second.snapshot(blobDir, manifest, 1_000));
		assert.equal(again.vars.n?.blob, manifest.vars.n?.blob);
		assert.notEqual(again.vars.a?.blob, manifest.vars.a?.blob);
	});
});
