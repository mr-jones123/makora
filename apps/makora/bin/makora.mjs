#!/usr/bin/env node
// Runs makora from its TypeScript sources: node with the source resolver preloaded, forwarding args, stdio and exit code.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(
	process.execPath,
	["--import", `${app}src/source.ts`, `${app}src/main.ts`, ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
// The terminal delivers SIGINT to the whole process group; the child handles it.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => {
	if (signal !== null) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
