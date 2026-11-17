#!/usr/bin/env node
// Runs one TLA+ model once for each combination of input values in <Name>.inputs.json, so a page can show how
// the states, the transitions and the broken rules change when an input changes. Each run writes its files in
// its own folder, and grid.json indexes them. The model checking itself is statechart's from-spec, run once
// per combination with that combination's cfg.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATECHART = path.resolve(here, "..", "..", "statechart", "scripts", "statechart.mjs");
// Each run is a full TLC pass, and the page holds every run's charts, so a wide grid is refused instead of
// taking minutes and producing a page nobody can read.
const MAX_RUNS = 24;

const USAGE = `node grid.mjs SPEC.tla [--inputs FILE] [--out DIR]

  Runs the model once per combination of the values in the inputs file, which defaults to NAME.inputs.json
  next to the spec. Without that file the grid is the one run the cfg describes, and the page still works.

  The inputs file holds one entry per constant, with the values to try:
    { "Workers": [1, 2, 3], "MaxRetries": [0, 2] }
  Each value is TLA+ text, so strings keep their quotes. A constant the cfg assigns and the inputs file does
  not name keeps the cfg's value, and one with neither value nor entry is refused.

  Runs at most ${MAX_RUNS} combinations. Each run's folder has the spec, its cfg, its map, and chart/ with
  the files from-spec writes. The command writes grid.json beside them and prints one line per run.

  --inputs FILE   The inputs file. Default: NAME.inputs.json next to the spec.
  --out DIR       The output folder. Default: NAME-grid next to the spec.

  TLA2TOOLS and JAVA reach TLC, as they do for statechart.mjs.

  Exit 0 when every rule holds in every run, 1 when a rule breaks in some run, and 2 when a run could not
  finish or when the model needs a map file filled in.`;

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

function findSpec(file) {
  if (!fs.existsSync(file)) fail(`${file} does not exist.`);
  const name = path.basename(file, ".tla");
  const cfgFile = path.join(path.dirname(file), `${name}.cfg`);
  if (!fs.existsSync(cfgFile))
    fail(`${path.basename(cfgFile)} does not exist. It needs SPECIFICATION and one INVARIANT line per rule.`);
  return { spec: path.resolve(file), name, cfgFile };
}

// A cfg constant declaration runs to the end of its line, and on to the next while brackets are still open or
// the line ends with a comma. Values hold commas of their own, as in {1, 2}, so the split tracks brackets.
export function splitDeclarations(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function readConstants(lines) {
  const constants = new Map();
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*CONSTANTS?\b(.*)$/.exec(lines[i]);
    if (!m) {
      kept.push(lines[i]);
      continue;
    }
    let text = m[1];
    while (i + 1 < lines.length && (/,\s*$/.test(text) || unbalanced(text))) text += ` ${lines[++i].trim()}`;
    for (const part of splitDeclarations(text)) {
      const eq = part.indexOf("=");
      const name = (eq < 0 ? part : part.slice(0, eq)).trim();
      if (name) constants.set(name, eq < 0 ? null : part.slice(eq + 1).trim());
    }
  }
  return { constants, kept };
}

function unbalanced(text) {
  let depth = 0;
  for (const c of text) {
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return depth > 0;
}

// The rule's sentence is the "\*" comment above its definition, which is also where statechart reads it.
export function ruleSentence(tla, name) {
  const lines = tla.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^${name}\\s*==`).test(line));
  const said = [];
  for (let i = at - 1; i >= 0 && /^\s*\\\*/.test(lines[i]); i--) said.unshift(lines[i].replace(/^\s*\\\*\s?/, "").trim());
  return said.filter(Boolean).join(" ");
}

export const readable = (value) =>
  value
    .replace(/^"(.*)"$/, "$1")
    .replace(/[{}[\]()<>"]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "value";

export function combinations(domains, names) {
  let rows = [new Map()];
  for (const name of names) {
    const values = domains.get(name);
    rows = rows.flatMap((row) => values.map((value) => new Map(row).set(name, value)));
  }
  return rows;
}

function main(argv) {
  const args = [...argv];
  const flags = {};
  while (args.length > 0) {
    const a = args.shift();
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--inputs" || a === "--out") flags[a.slice(2)] = args.shift();
    else if (a.startsWith("--")) fail(`Unknown flag ${a}.\n\n${USAGE}`);
    else flags.spec = a;
  }
  if (!flags.spec) fail(USAGE);
  const { spec, name, cfgFile } = findSpec(flags.spec);
  if (!fs.existsSync(STATECHART))
    fail(`Cannot find statechart.mjs at ${STATECHART}. verify-rules expects it in the same skills folder.`);

  const cfgText = fs.readFileSync(cfgFile, "utf8");
  const { constants, kept } = readConstants(cfgText.split("\n"));
  const inputsFile = flags.inputs ?? path.join(path.dirname(spec), `${name}.inputs.json`);
  const domains = new Map();
  if (fs.existsSync(inputsFile)) {
    const given = JSON.parse(fs.readFileSync(inputsFile, "utf8"));
    for (const [key, values] of Object.entries(given)) {
      if (!constants.has(key))
        fail(`${path.basename(inputsFile)} names ${key}, which ${path.basename(cfgFile)} does not declare as a constant.`);
      if (!Array.isArray(values) || values.length === 0) fail(`${key} in ${path.basename(inputsFile)} needs a list of values.`);
      domains.set(key, values.map(String));
    }
  }

  const base = new Map();
  for (const [key, value] of constants) {
    if (domains.has(key)) continue;
    if (value === null)
      fail(
        `${path.basename(cfgFile)} declares ${key} without a value, so the grid needs one. Add "${key}" to ${path.basename(inputsFile)}.`,
      );
    base.set(key, value);
  }

  const names = [...domains.keys()];
  const rows = combinations(domains, names);
  if (rows.length > MAX_RUNS) {
    const widest = names.sort((a, b) => domains.get(b).length - domains.get(a).length)[0];
    fail(
      `${names.join(" x ")} is ${rows.length} runs, and a grid takes at most ${MAX_RUNS}. Give ${widest} fewer values, or check fewer inputs at once.`,
    );
  }

  const out = path.resolve(flags.out ?? path.join(path.dirname(spec), `${name}-grid`));
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length > 0 && !entries.includes("grid.json"))
      fail(`${out} has files and no grid.json, so it is not a grid this command wrote. Remove it, or pick --out.`);
  }
  // The runs go in a temporary folder that replaces the output folder at the end, so a run that stops leaves the
  // previous grid as it was instead of a half-written one, and drops the folders of a wider grid.
  const work = `${out}.${process.pid}.tmp`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

  const mapFile = path.join(path.dirname(spec), `${name}.map.mjs`);
  const tla = fs.readFileSync(spec, "utf8");
  const rules = kept
    .filter((line) => /^\s*INVARIANTS?\b/.test(line))
    .flatMap((line) => line.replace(/^\s*INVARIANTS?\b/, "").split(","))
    .map((rule) => rule.trim())
    .filter(Boolean);

  const runs = [];
  let worst = 0;
  const seen = new Set();
  for (const row of rows) {
    const assignment = new Map([...base, ...row]);
    const id = names.length === 0 ? "run" : [...row].map(([key, value]) => `${key}-${readable(value)}`).join(",");
    if (seen.has(id)) fail(`Two input values both name the folder ${id}. Give them values that read differently.`);
    seen.add(id);
    const dir = path.join(work, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(spec, path.join(dir, `${name}.tla`));
    if (fs.existsSync(mapFile)) fs.copyFileSync(mapFile, path.join(dir, `${name}.map.mjs`));
    // TLC takes one assignment per line: a comma list after one CONSTANT keyword is a config error.
    const config = [...[...assignment].map(([key, value]) => `CONSTANT ${key} = ${value}`), ...kept].join("\n");
    fs.writeFileSync(path.join(dir, `${name}.cfg`), `${config}\n`);

    const chartDir = path.join(dir, "chart");
    const r = spawnSync(process.execPath, [STATECHART, "from-spec", `${name}.tla`, "--out", chartDir], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    if (r.error) fail(`cannot run statechart.mjs: ${r.error.message}`);
    if (r.status === 2)
      fail(
        `The run ${id} could not finish. statechart said:\n${(r.stdout + r.stderr).trim()}\n\nFill in the map file it names, then run this command again.`,
      );
    const summaryFile = path.join(chartDir, "summary.json");
    if (!fs.existsSync(summaryFile)) fail(`The run ${id} wrote no summary.json. statechart said:\n${(r.stdout + r.stderr).trim()}`);
    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));

    // The rule's own TLC output is the record of whether it broke, which the summary only implies.
    const broken = rules.filter((rule) => {
      const file = path.join(chartDir, "tlc", `${name}-${rule}.out`);
      return fs.existsSync(file) && /^Error: Invariant /m.test(fs.readFileSync(file, "utf8"));
    });
    worst = Math.max(worst, r.status === 1 || broken.length > 0 ? 1 : 0);
    runs.push({
      id,
      assignment: Object.fromEntries(assignment),
      dir: id,
      chart: {
        states: summary.chartStates,
        transitions: summary.chartTransitions,
        works: summary.chartStatus.works,
        wrong: summary.chartStatus.wrong,
        fixed: summary.chartStatus.fixed,
      },
      broken,
      bugs: summary.classes.map((c) => ({
        n: c.n,
        end: c.end,
        invariant: c.invariant,
        rule: c.rule,
        cause: c.cause,
        readerSteps: c.readerSteps,
        modelSteps: c.modelSteps,
        counterexamples: c.counterexamples,
      })),
    });
    const shape = `${summary.chartStates} states, ${summary.chartTransitions} transitions`;
    const verdict = broken.length === 0 ? "no rule breaks" : `breaks ${broken.join(", ")}`;
    console.log(`  ${id}: ${shape}, ${verdict}.`);
  }

  const grid = {
    spec: name,
    rules: rules.map((rule) => ({ name: rule, sentence: ruleSentence(tla, rule) })),
    inputs: Object.fromEntries(names.map((key) => [key, domains.get(key)])),
    assignment: Object.fromEntries(base),
    runs,
  };
  fs.writeFileSync(path.join(work, "grid.json"), `${JSON.stringify(grid, null, 2)}\n`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(work, out);
  console.log(`\n${runs.length} run${runs.length === 1 ? "" : "s"} in ${out}.`);
  return worst;
}

// Imported by the test for its helpers; only a run from the command line checks anything.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
