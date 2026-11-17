// Tests for the grid runner and the page builder: the small parsers they read a model and a run with, and the
// commands run against a real model when TLC is available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { combinations, readable, readConstants, ruleSentence, splitDeclarations } from "../grid.mjs";
import { readActions, readStories, withoutFrontmatter } from "../page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = dirname(here);
const node = (script, args, cwd) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { cwd, encoding: "utf8" });

const SPEC = `---- MODULE Jobs ----
EXTENDS Naturals, TLC

CONSTANT Workers
VARIABLES claimed, finished
vars == <<claimed, finished>>

Init == claimed = 0 /\\ finished = 0

\\* code: src/jobs.ts:41 claim
Claim == /\\ claimed < Workers
         /\\ claimed' = claimed + 1
         /\\ finished' = finished

\\* code: src/jobs.ts:58 finish
Finish == /\\ claimed > finished
          /\\ claimed' = claimed
          /\\ finished' = finished + 1

Next == Claim \\/ Finish
Spec == Init /\\ [][Next]_vars

\\* Two workers never hold the same job at once.
NoDoubleClaim == claimed - finished <= 1

====
`;
const CFG = `SPECIFICATION Spec
CONSTANT Workers = 2
INVARIANT NoDoubleClaim
`;
const MAP = `export const readerActions = ["Claim", "Finish"];
export function state(v) {
\treturn v.claimed === 0 ? "Idle: nothing claimed" : \`\${v.claimed} claimed: \${v.finished} finished\`;
}
`;

function model(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-rules-"));
  writeFileSync(join(dir, "Jobs.tla"), SPEC);
  writeFileSync(join(dir, "Jobs.cfg"), CFG);
  writeFileSync(join(dir, "Jobs.map.mjs"), MAP);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const tools = spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0 ? process.env.TLA2TOOLS : undefined;
const needsTlc = { skip: tools ? false : "TLA2TOOLS or java is missing" };

test("splitDeclarations keeps a set's commas inside one declaration", () => {
  assert.deepEqual(splitDeclarations("A = 1, B = {1, 2}, C"), ["A = 1", "B = {1, 2}", "C"]);
});

test("readConstants reads every declaration form in a cfg", () => {
  const { constants, kept } = readConstants([
    "SPECIFICATION Spec",
    "CONSTANT Workers = 2",
    "CONSTANTS A, B = {1, 2}",
    "CONSTANT",
    "INVARIANT NoDoubleClaim",
  ]);
  assert.deepEqual([...constants], [
    ["Workers", "2"],
    ["A", null],
    ["B", "{1, 2}"],
  ]);
  assert.deepEqual(kept, ["SPECIFICATION Spec", "INVARIANT NoDoubleClaim"]);
});

test("readConstants joins a declaration whose brackets stay open", () => {
  const { constants } = readConstants(["CONSTANTS A = {1,", "  2}, B = 3"]);
  assert.deepEqual([...constants], [
    ["A", "{1, 2}"],
    ["B", "3"],
  ]);
});

test("ruleSentence is the comment above the rule, and nothing else", () => {
  assert.equal(ruleSentence(SPEC, "NoDoubleClaim"), "Two workers never hold the same job at once.");
  assert.equal(ruleSentence(SPEC, "Missing"), "");
});

test("combinations is the cartesian product in input order", () => {
  const domains = new Map([
    ["Workers", ["1", "2"]],
    ["Rounds", ["0", "1"]],
  ]);
  assert.deepEqual(
    combinations(domains, ["Workers", "Rounds"]).map((row) => [...row].map(([k, v]) => `${k}=${v}`).join(",")),
    ["Workers=1,Rounds=0", "Workers=1,Rounds=1", "Workers=2,Rounds=0", "Workers=2,Rounds=1"],
  );
});

test("readable turns a value into a folder name", () => {
  assert.equal(readable('"idle"'), "idle");
  assert.equal(readable("{a, b}"), "a-b");
  assert.equal(readable("<<1, 2>>"), "1-2");
  assert.equal(readable(","), "value");
});

test("withoutFrontmatter drops mermaid options and keeps the diagram", () => {
  assert.equal(withoutFrontmatter("---\nconfig:\n  state:\n    useMaxWidth: false\n---\nstateDiagram-v2\n  A --> B"), "stateDiagram-v2\n  A --> B");
  assert.equal(withoutFrontmatter("stateDiagram-v2\n  A --> B"), "stateDiagram-v2\n  A --> B");
});

test("readStories splits one section per bug", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-rules-"));
  const file = join(dir, "stories.md");
  writeFileSync(file, "## 1. paid twice\n\nRule broken: NoDoubleCharge.\n1. Pay\n\n## 2. lost\n\nRule broken: AlwaysDelivers.\n1. Send\n");
  assert.deepEqual(readStories(file), {
    1: "paid twice\n\nRule broken: NoDoubleCharge.\n1. Pay",
    2: "lost\n\nRule broken: AlwaysDelivers.\n1. Send",
  });
  assert.deepEqual(readStories(join(dir, "missing.md")), {});
});

test("readActions reads a step that takes arguments", () => {
  const tla = "\\* code: src/kernel/kernel.ts:300\nReply(c, o) == /\\ slot = c\n";
  assert.deepEqual(readActions(tla), { Reply: "src/kernel/kernel.ts:300" });
});

test("readActions pairs each step with the code named above it", () => {
  assert.deepEqual(readActions(SPEC), { Claim: "src/jobs.ts:41", Finish: "src/jobs.ts:58" });
});

test("grid.mjs prints its usage without a spec", () => {
  const r = node("grid.mjs", [], tmpdir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /node grid\.mjs SPEC\.tla/);
});

test("grid.mjs refuses an input the cfg does not declare", () => {
  const dir = model({ "Jobs.inputs.json": '{ "Workers": [1], "Ghost": [1] }' });
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /names Ghost, which Jobs\.cfg does not declare/);
});

test("grid.mjs refuses a grid wider than it takes", () => {
  const dir = model({ "Jobs.inputs.json": JSON.stringify({ Workers: Array.from({ length: 25 }, (_, i) => i + 1) }) });
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is 25 runs, and a grid takes at most 24/);
});

test("grid.mjs refuses a constant with no value and no input", () => {
  const dir = model();
  writeFileSync(join(dir, "Jobs.cfg"), "SPECIFICATION Spec\nCONSTANT Workers\nINVARIANT NoDoubleClaim\n");
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /declares Workers without a value/);
});

test("grid.mjs runs one TLC pass per input value", needsTlc, () => {
  const dir = model({ "Jobs.inputs.json": '{ "Workers": [1, 2] }' });
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  const out = join(dir, "Jobs-grid");
  const grid = JSON.parse(readFileSync(join(out, "grid.json"), "utf8"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(
    grid.runs.map((run) => run.id),
    ["Workers-1", "Workers-2"],
  );
  assert.deepEqual(grid.runs[0].broken, []);
  assert.deepEqual(grid.runs[1].broken, ["NoDoubleClaim"]);
  assert.ok(grid.runs[1].chart.states > grid.runs[0].chart.states);
  assert.equal(grid.rules[0].sentence, "Two workers never hold the same job at once.");
  assert.ok(existsSync(join(out, "Workers-2", "chart", "bug-1.mmd")));
});

test("grid.mjs replaces the folder, so a wider grid's run leaves nothing behind", needsTlc, () => {
  const dir = model({ "Jobs.inputs.json": '{ "Workers": [1, 2] }' });
  node("grid.mjs", ["Jobs.tla"], dir);
  const stale = join(dir, "Jobs-grid", "Workers-9");
  mkdirSync(stale);
  writeFileSync(join(stale, "Jobs.tla"), SPEC);
  mkdirSync(join(stale, "chart"));
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(join(dir, `Jobs-grid.${process.pid}.tmp`)), false);
});

test("grid.mjs assigns several constants, one per line", needsTlc, () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-rules-"));
  writeFileSync(
    join(dir, "Jobs.tla"),
    SPEC.replace("CONSTANT Workers", "CONSTANTS Workers, Rounds").replace(
      "Next == Claim \\/ Finish",
      "Round == /\\ claimed = finished /\\ claimed' = claimed /\\ finished' = finished\n\nNext == Claim \\/ Finish \\/ Round",
    ),
  );
  writeFileSync(join(dir, "Jobs.cfg"), "SPECIFICATION Spec\nCONSTANT Workers = 2\nCONSTANT Rounds = 1\nINVARIANT NoDoubleClaim\n");
  writeFileSync(join(dir, "Jobs.map.mjs"), MAP);
  writeFileSync(join(dir, "Jobs.inputs.json"), '{ "Workers": [1, 2], "Rounds": [0, 1] }');
  const r = node("grid.mjs", ["Jobs.tla"], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const grid = JSON.parse(readFileSync(join(dir, "Jobs-grid", "grid.json"), "utf8"));
  assert.equal(grid.runs.length, 4);
  assert.deepEqual(grid.runs[0].assignment, { Rounds: "0", Workers: "1" });
  rmSync(dir, { recursive: true, force: true });
});

test("page.mjs writes one page holding every run", needsTlc, () => {
  const dir = model({ "Jobs.inputs.json": '{ "Workers": [1, 2] }' });
  node("grid.mjs", ["Jobs.tla"], dir);
  const r = node("page.mjs", [join(dir, "Jobs-grid"), "--no-open"], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const page = readFileSync(join(dir, "Jobs-grid", "index.html"), "utf8");
  assert.doesNotMatch(page, /__DATA__|__PELE__|__TITLE__/);
  assert.match(page, /const DATA = \{/);
  assert.match(page, /"id":"Workers-2"/);
  assert.match(page, /src\/jobs\.ts:41/);
  rmSync(dir, { recursive: true, force: true });
});
