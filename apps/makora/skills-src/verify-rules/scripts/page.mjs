#!/usr/bin/env node
// Builds the one page for a grid: every run's chart, every bug's chart, the rules, and the code each step stands
// for, in a single HTML file that renders the diagrams with the bundled Pele and needs no network.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `node page.mjs GRID_DIR [--out FILE] [--no-open]

  GRID_DIR is what grid.mjs wrote: it holds grid.json and one folder per run. The page goes to
  GRID_DIR/index.html and opens in the browser unless --no-open is given.

  --out FILE   Where to write the page. Default: GRID_DIR/index.html.
  --no-open    Do not open the page.`;

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

// Mermaid source may open with a frontmatter block that sets diagram options; Pele reads the diagram only.
export function withoutFrontmatter(text) {
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text.trim() : text.slice(end + 4).trim();
}

// One section per bug, as "## N. <end state>"; the page shows the selected bug's section as its story.
export function readStories(file) {
  if (!fs.existsSync(file)) return {};
  const stories = {};
  const parts = fs.readFileSync(file, "utf8").split(/^## (\d+)\. /m);
  for (let i = 1; i < parts.length; i += 2) stories[parts[i]] = parts[i + 1].trimEnd();
  return stories;
}

// A step's code is the "\* code: <path>:<line>" comment above the action that defines it, which is also how the
// model keeps every step answerable to a place a reviewer can open.
export function readActions(tla) {
  const actions = {};
  const lines = tla.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const defined = /^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*==/.exec(lines[i]);
    if (!defined) continue;
    for (let j = i - 1; j >= 0 && /^\s*\\\*/.test(lines[j]); j--) {
      const found = /^\s*\\\*\s*code:\s*(\S+)/.exec(lines[j]);
      if (!found) continue;
      actions[defined[1]] = found[1];
      break;
    }
  }
  return actions;
}

function main(argv) {
  const args = [...argv];
  const flags = {};
  while (args.length > 0) {
    const a = args.shift();
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--out") flags.out = args.shift();
    else if (a === "--no-open") flags.open = false;
    else if (a.startsWith("--")) fail(`Unknown flag ${a}.\n\n${USAGE}`);
    else flags.grid = a;
  }
  if (!flags.grid) fail(USAGE);
  const gridDir = path.resolve(flags.grid);
  const gridFile = path.join(gridDir, "grid.json");
  if (!fs.existsSync(gridFile)) fail(`${gridFile} does not exist. Run grid.mjs first.`);
  const grid = JSON.parse(fs.readFileSync(gridFile, "utf8"));

  const runs = grid.runs.map((run) => {
    const dir = path.join(gridDir, run.dir);
    const chartDir = path.join(dir, "chart");
    const chartFile = path.join(chartDir, "chart.mmd");
    if (!fs.existsSync(chartFile)) fail(`${chartFile} does not exist. Run grid.mjs again.`);
    const bugMmd = {};
    for (const bug of run.bugs) {
      const file = path.join(chartDir, `bug-${bug.n}.mmd`);
      if (fs.existsSync(file)) bugMmd[bug.n] = withoutFrontmatter(fs.readFileSync(file, "utf8"));
    }
    return {
      ...run,
      mmd: withoutFrontmatter(fs.readFileSync(chartFile, "utf8")),
      bugMmd,
      stories: readStories(path.join(chartDir, "stories.md")),
      actions: readActions(fs.readFileSync(path.join(dir, `${grid.spec}.tla`), "utf8")),
    };
  });

  const page = {
    spec: grid.spec,
    rules: grid.rules,
    inputs: grid.inputs,
    runs,
  };
  const template = fs.readFileSync(path.join(here, "page.html"), "utf8");
  const pele = fs.readFileSync(path.join(here, "vendor", "pele-state.js"), "utf8");
  // The data goes inside a script element, so "<" must not be able to close it.
  const data = JSON.stringify(page).replace(/</g, "\\u003c");
  const filled = template
    .replace("__TITLE__", () => `${grid.spec} rules`)
    .replace("__PELE__", () => pele)
    .replace("__DATA__", () => data);

  const out = path.resolve(flags.out ?? path.join(gridDir, "index.html"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, filled);
  for (const run of runs) console.log(`  ${run.id}: ${Object.keys(run.bugMmd).length} bug chart(s).`);
  console.log(`\nWrote ${out}.`);
  if (flags.open !== false) {
    const [command, openArgs] =
      process.platform === "darwin"
        ? ["open", [out]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", out]]
          : ["xdg-open", [out]];
    const r = spawnSync(command, openArgs, { stdio: "ignore" });
    if (r.error) console.error(`Could not open the page: ${r.error.message}`);
  }
  return 0;
}

// Imported by the test for its helpers; only a run from the command line writes a page.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
