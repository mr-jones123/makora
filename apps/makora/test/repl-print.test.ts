import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { pythonDetails } from "../src/repl/details.ts";
import { openSession } from "../src/session.ts";
import { latestSession } from "../src/sessions.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

/** A temp makora home and a temp git repository to run in. */
function workspace(): { home: string; repo: string } {
	// The real path: makora records `process.cwd()`, which resolves macOS's /var -> /private/var link.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "makora-repl-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "# demo\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	return { home, repo };
}

function start(args: readonly string[], where: { home: string; repo: string }) {
	const child = spawn(
		process.execPath,
		["--import", join(APP, "src/source.ts"), join(APP, "src/main.ts"), "--fake", ...args],
		{ cwd: where.repo, env: { ...process.env, MAKORA_HOME: where.home, MAKORA_FAKE: "" } },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const done = once(child, "exit").then(([code]) => ({ code: code as number | null, stdout, stderr }));
	return { child, done, output: () => stdout };
}

function makora(args: readonly string[], where: { home: string; repo: string }) {
	return start(args, where).done;
}

/** The root conversation's python results of the latest session in `repo`, oldest first. */
async function pythonResults(where: { home: string; repo: string }) {
	const app = openApp(where.home, true);
	const meta = latestSession(app.paths.sessions, where.repo);
	assert.ok(meta !== undefined);
	const session = await openSession(app, meta, {}, BACKGROUND_CONTEXT);
	try {
		const page = await session.root.entries({ order: "ascending" }, 1_000, undefined, BACKGROUND_CONTEXT);
		return page.items.flatMap((entry: EntryRecord) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult" && message.toolName === "python" ? [message] : [];
		});
	} finally {
		await session.close();
	}
}

describe("the python REPL in print mode", () => {
	it("keeps variables across makora runs through a snapshot", async () => {
		const where = workspace();
		const first = await makora(["-p", "python"], where);
		assert.equal(first.code, 0, first.stderr);
		assert.match(first.stdout, /```\n42\n```/);
		const second = await makora(["--continue", "-p", "remember"], where);
		assert.equal(second.code, 0, second.stderr);
		assert.match(second.stdout, /Kernel restarted\. Variables restored to after cell 2: x\.\n41\n/);
	});

	it("writes and reads files through Durable's tools, recorded as nested calls", async () => {
		const where = workspace();
		const run = await makora(["-p", "file"], where);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /```\nhi\n```/);
		assert.equal(readFileSync(join(where.repo, "fake.txt"), "utf8"), "hi");
		const calls = (await pythonResults(where)).map((result) =>
			pythonDetails(result.details)?.calls?.map((call) => `${call.name} ${JSON.stringify(call.args)}`),
		);
		assert.deepEqual(calls, [['write {"path":"fake.txt","content":"hi"}'], ['read {"path":"fake.txt"}']]);
	});

	it("restores after the kernel crashed and says so", async () => {
		const where = workspace();
		assert.equal((await makora(["-p", "python"], where)).code, 0);
		const crash = await makora(["--continue", "-p", "crash"], where);
		assert.match(crash.stdout, /kernel died \(exit 1\) during cell 3/);
		const after = await makora(["--continue", "-p", "remember"], where);
		assert.match(after.stdout, /Kernel restarted\. Variables restored to after cell 2: x\.\n41\n/);
	});

	it("ends a cell cut off by a killed makora as interrupted, and the next cell restores", async () => {
		const where = workspace();
		assert.equal((await makora(["-p", "python"], where)).code, 0);
		const run = start(["--continue", "-p", "tool"], where);
		// The bash call sleeps 2 s; the kernel's pid record shows the cell started.
		const kernels = join(where.home, "sessions", readdirSync(join(where.home, "sessions"))[0]!, "kernels");
		while (!run.output().includes("Running cell 1.") || !existsSync(kernels) || readdirSync(kernels).length === 0) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		const kernelPid = Number(readFileSync(join(kernels, readdirSync(kernels)[0]!), "utf8"));
		run.child.kill("SIGKILL");
		await run.done;

		const replay = await makora(["--continue", "-p", ""], where);
		assert.equal(replay.code, 0, replay.stderr);
		// The cell number is in the call's running details, which a kill within the first second may not have stored.
		assert.match(replay.stderr, /✗ python · (cell 3 · )?print\(await bash\("echo hello; sleep 2"\)\)/);
		assert.throws(() => process.kill(kernelPid, 0), "the old kernel is gone");
		const next = await makora(["--continue", "-p", "remember"], where);
		assert.match(next.stdout, /Variables restored to after cell 2: x\.\n41\n/);
		const results = await pythonResults(where);
		assert.match(JSON.stringify(results.at(-2)?.content), /interrupted/i);
	});

	it("restarts a dead kernel empty and says so when snapshots are off", async () => {
		const where = workspace();
		mkdirSync(where.home, { recursive: true });
		writeFileSync(join(where.home, "settings.json"), `${JSON.stringify({ snapshots: false })}\n`);
		assert.equal((await makora(["-p", "python"], where)).code, 0);
		await makora(["--continue", "-p", "crash"], where);
		const after = await makora(["--continue", "-p", "remember"], where);
		assert.match(
			after.stdout,
			/Kernel restarted empty: variables of earlier cells were lost \(snapshots are off\)\./,
		);
		assert.match(after.stdout, /NameError: name 'x' is not defined/);
		const sessions = readdirSync(join(where.home, "sessions"));
		assert.equal(existsSync(join(where.home, "sessions", sessions[0]!, "blobs")), false);
	});

	it("answers llm() from a cell with one model call", async () => {
		const where = workspace();
		const run = await makora(["-p", "ask"], where);
		assert.match(run.stdout, /Fake model here\. You asked: say hi/);
	});

	it("leaves nothing on disk with --ephemeral", async () => {
		const where = workspace();
		const run = await makora(["--ephemeral", "-p", "python"], where);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /```\n42\n```/);
		assert.equal(existsSync(join(where.home, "sessions")), false);
		assert.deepEqual(readdirSync(where.home), ["python"]);
	});

	it("edits a file through Durable's edit tool, recorded as a nested call", async () => {
		const where = workspace();
		writeFileSync(join(where.repo, "notes.txt"), "hello world\n");
		const run = await makora(["-p", "edit"], where);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(readFileSync(join(where.repo, "notes.txt"), "utf8"), "hello there\n");
		const [result] = await pythonResults(where);
		assert.deepEqual(
			pythonDetails(result?.details)?.calls?.map((call) => `${call.name} ${JSON.stringify(call.args)}`),
			['edit {"path":"notes.txt","edits":[{"oldText":"world","newText":"there"}]}'],
		);
	});

	it("reads a whole file past Durable's truncation limits, and refuses a line it cannot return whole", async () => {
		const where = workspace();
		const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index} ${"·".repeat(20)}`);
		writeFileSync(join(where.repo, "long.txt"), `${lines.join("\n")}\n`);
		writeFileSync(join(where.repo, "wide.txt"), `${"w".repeat(80_000)}\n`);
		const run = await makora(["-p", "long"], where);
		assert.equal(run.code, 0, run.stderr);
		const output = await pythonResults(where);
		assert.match(JSON.stringify(output[0]?.content), /5000 True/);
		assert.match(JSON.stringify(output[1]?.content), /refused: wide\.txt: line 1 is over read's 51200-byte limit/);
	});

	it("gives a cell the latest input and the transcript through ctx", async () => {
		const where = workspace();
		const run = await makora(["-p", "context please"], where);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /```\ncontext please\n\['user', 'assistant'\]\n```/);
	});

	it("returns llm()'s answer parsed and checked against a schema", async () => {
		const where = workspace();
		const run = await makora(["-p", "schema"], where);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /```\n43\n```/);
	});

	it("lists the files changed since the restored cell", async () => {
		const where = workspace();
		assert.equal((await makora(["-p", "python"], where)).code, 0);
		const crash = await makora(["--continue", "-p", "scribble"], where);
		assert.match(crash.stdout, /kernel died \(exit 1\) during cell 3/);
		const after = await makora(["--continue", "-p", "remember"], where);
		assert.match(
			after.stdout,
			/Variables restored to after cell 2: x\.\nFiles changed since cell 2 \(not restored\): late\.txt\n41\n/,
		);
	});

	it(
		"restores when the worktree cannot be compared",
		{ skip: process.getuid?.() === 0 && "root reads any file" },
		async () => {
			const where = workspace();
			assert.equal((await makora(["-p", "python"], where)).code, 0);
			// git cannot add a file it cannot read, so comparing the worktree with cell 2's tree fails.
			const locked = join(where.repo, "locked.txt");
			writeFileSync(locked, "secret\n");
			chmodSync(locked, 0o000);
			const after = await makora(["--continue", "-p", "remember"], where);
			chmodSync(locked, 0o600);
			assert.match(after.stdout, /Kernel restarted\. Variables restored to after cell 2: x\.\n41\n/);
		},
	);

	it("says no earlier cell saved a snapshot when snapshots were off for them", async () => {
		const where = workspace();
		mkdirSync(where.home, { recursive: true });
		const settings = join(where.home, "settings.json");
		writeFileSync(settings, `${JSON.stringify({ snapshots: false })}\n`);
		assert.equal((await makora(["-p", "python"], where)).code, 0);
		writeFileSync(settings, `${JSON.stringify({ snapshots: true })}\n`);
		const after = await makora(["--continue", "-p", "remember"], where);
		assert.match(
			after.stdout,
			/Kernel restarted empty: no earlier cell saved a snapshot, so their variables were lost\./,
		);
	});
});
