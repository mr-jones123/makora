#!/usr/bin/env node
// Generates Makora's bundled skills (apps/makora/skills) from pinned cursor/plugins and no-mistakes sources.
//
//   node apps/makora/scripts/sync-skills.mjs            regenerate from the pins in skills.lock.json
//   node apps/makora/scripts/sync-skills.mjs --latest   repin both sources, then regenerate
//   node apps/makora/scripts/sync-skills.mjs --check    exit 1 when skills/ or the lock differ from a fresh build
//
// Mechanism follows mr-jones123/pstack-harness build.mjs (term rows, pointer lines, link rewriting) and raga's
// sync script (source sha256 pinning, Cursor-only paragraph removal, verbatim no-mistakes skill).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK = "skills.lock.json";
const OUT = "skills";
const OVERLAYS = join(APP, "skills-src");
// Under node_modules so repo-wide scans (pinned deps, biome) skip upstream checkouts.
const CACHE = join(APP, "..", "..", "node_modules", ".cache", "makora-skills");
const PLUGINS = "cursor-plugins";
const NO_MISTAKES = "no-mistakes";
const ADAPTER = "makora-adapter";
const LINK = /\]\(([^)\s]+)\)/g;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const COMPANIONS = ["deslop", "control-cli", "control-ui", "verify-this"];
// make-bot-ui builds webhook pages for Cursor routines; nothing in it works outside Cursor.
const EXCLUDED = ["make-bot-ui"];

// Every push to cursor/plugins moves main, so --latest repins only when a path this build reads changed.
const TRACKED = ["pstack", "cursor-team-kit", "scripts/generate-pstack-harness-trees.mjs"];

// Cursor names the upstream term list misses. The adapter needs a row for each key a skill uses.
const EXTRA_TERMS = [
	{ key: "`/loop`", re: /`\/loop`|\/loop\b/ },
	{ key: "`/visualize`", re: /`\/visualize`/ },
	{ key: "custom mode", re: /custom mode/i },
	{ key: "`create-skill`", re: /\*\*create-skill\*\* skill|Cursor's built-in/ },
];

// Paragraphs that only make sense inside Cursor (raga's list). They are dropped from upstream markdown. Bugbot
// triage stays (the adapter maps it to review threads), so a start, wait, or configure verb must share Bugbot's
// sentence: raga's `.*` dropped babysit's "Stop at the human's line" step over a later `bugbot-triage.md` link.
const CURSOR_ONLY =
	/make-bot-ui|api2\.cursor|Cursor Automations|Cursor cloud agents|cloud-agent dashboard|Custom Modes?|Use as Mode|Bugbot[^.\n]*(start|wait|configure)|(?:start|wait|configure)[^.\n]*Bugbot|\/automations\/|\/plugin (?:install|marketplace)|\/add-plugin|cursor\.com|\/in-cloud/i;
const CURSOR_ONLY_LINE = /^.*(?:make-bot-ui|api2\.cursor|Automations webhook).*\n?/gim;

const POINTER =
	"In Makora, read [the Makora adapter](../makora-adapter/SKILL.md) once per session before you follow this skill. " +
	"It maps the Cursor names in pstack skills to Makora.";
const NO_MISTAKES_POINTER =
	"In Makora, run no-mistakes through `bash` (`no-mistakes axi ...`), and the user invokes this skill as `/skill:no-mistakes`. " +
	"Makora does not ship the `no-mistakes` binary; install it separately before you follow this skill.";
const AUDIT_GUARD =
	"printf '%s\\n' 'Unavailable in Makora: this audit reads Cursor transcripts. " +
	"Use git worktree list and check the status and unpushed commits of each checkout instead.' >&2\nexit 2\n";

function fail(messages) {
	for (const message of [messages].flat()) console.log(`FAIL ${message}`);
	process.exit(1);
}

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir) {
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			if (name === ".DS_Store" || name === "node_modules") return [];
			const path = join(dir, name);
			if (lstatSync(path).isSymbolicLink()) fail(`${path} is a symlink; the build copies regular files only`);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
}

function file(path) {
	return { bytes: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
}

function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
	return {
		fields: match?.[1] ?? "",
		head: match?.[0] ?? "",
		body: match ? text.slice(match[0].length).replace(/^\n+/, "") : text,
	};
}

function field(fields, name) {
	return fields.match(new RegExp(`^${name}:(.*)$`, "m"))?.[1].trim();
}

// Decodes a one-line YAML scalar. Block scalars and escapes JSON cannot read fail the build instead of shipping garbage.
function scalar(value, where) {
	if (value === undefined || value === "") fail(`${where} is missing`);
	if (/^[>|]/.test(value)) fail(`${where} is a YAML block scalar, which this build does not decode`);
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value);
		} catch {
			fail(`${where} is a double-quoted scalar this build cannot decode: ${value}`);
		}
	}
	if (value.startsWith("'")) {
		if (!/^'(?:[^']|'')*'$/.test(value)) fail(`${where} is not a single-quoted scalar: ${value}`);
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value;
}

function insertAfterHeading(text, line) {
	const { fields, body } = frontmatter(text);
	const head = fields ? `---\n${fields}\n---\n\n` : "";
	const placed = /^# .*$/m.test(body) ? body.replace(/^(# .*)(?:\n+|$)/m, `$1\n\n${line}\n\n`) : `${line}\n\n${body}`;
	return head + placed;
}

// Raga drops every paragraph that names a Cursor-only feature. A list or table paragraph loses only its matching items,
// so one Bugbot step does not take its sibling steps with it. A table whose header matches goes whole.
function stripCursorOnly(text) {
	const { head, body } = frontmatter(text);
	const kept = body.split(/\n\s*\n/).flatMap((block) => {
		if (!CURSOR_ONLY.test(block)) return [block];
		const parts = items(block);
		if (!parts) return [];
		const dropped = parts.filter((part) => CURSOR_ONLY.test(part.join("\n")));
		if (dropped.some((part) => part.some((line) => TABLE_SEPARATOR.test(line)))) return [];
		const left = parts.filter((part) => !dropped.includes(part));
		return left.length > 0 ? [left.flat().join("\n")] : [];
	});
	return (head ? `${head}\n` : "") + kept.join("\n\n").replace(CURSOR_ONLY_LINE, "");
}

const TABLE_SEPARATOR = /^\|[\s|:-]+$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;

// Splits a paragraph into table rows and top-level list items, each with its continuation lines. Prose and code
// fences return undefined, so they are kept or dropped whole.
function items(block) {
	if (block.includes("```")) return undefined;
	const lines = block.split("\n");
	const depth = lines.find((line) => LIST_ITEM.test(line))?.match(LIST_ITEM)[1].length;
	const opens = (line) =>
		(line.startsWith("|") && !TABLE_SEPARATOR.test(line)) ||
		(LIST_ITEM.test(line) && line.match(LIST_ITEM)[1].length <= depth);
	if (!lines.some(opens)) return undefined;
	const parts = [];
	for (const line of lines) {
		if (parts.length === 0 || opens(line)) parts.push([line]);
		else parts.at(-1).push(line);
	}
	return parts;
}

// --- upstream checkouts ------------------------------------------------------------------------

// Always resets the worktree, so edits inside .cache never leak into a build. Fetches only a missing commit.
function checkout(dir, commit) {
	if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: dir }).status !== 0) {
		git(["fetch", "-q", "--depth", "1", "origin", commit], dir);
	}
	git(["checkout", "-q", "--force", "--detach", commit], dir);
	git(["clean", "-qfdx"], dir);
}

function cache(name, repository) {
	const dir = join(CACHE, name);
	if (!existsSync(join(dir, ".git"))) {
		mkdirSync(dir, { recursive: true });
		// The cache sits inside the app; this file keeps it out of git without touching the root .gitignore.
		writeFileSync(join(CACHE, ".gitignore"), "*\n");
		git(["init", "-q"], dir);
		git(["remote", "add", "origin", repository], dir);
	}
	return dir;
}

function pinPlugins(source, latest) {
	const dir = cache(PLUGINS, source.repository);
	checkout(dir, source.commit);
	if (!latest) return source;
	const main = git(["ls-remote", source.repository, "refs/heads/main"], dir).split(/\s/)[0];
	if (!/^[0-9a-f]{40}$/.test(main)) fail(`cannot resolve main of ${source.repository}`);
	if (main === source.commit) return source;
	git(["fetch", "-q", "--depth", "1", "origin", main], dir);
	const diff = spawnSync("git", ["diff", "--quiet", source.commit, main, "--", ...TRACKED], { cwd: dir });
	if (diff.status === 0) return source;
	if (diff.status !== 1) fail(`git diff ${source.commit} ${main} failed: ${diff.stderr}`);
	checkout(dir, main);
	return { ...source, commit: main };
}

function pinNoMistakes(source, latest) {
	const dir = cache(NO_MISTAKES, source.repository);
	if (!latest) {
		checkout(dir, source.commit);
		return source;
	}
	// An annotated tag lists its tag object and, with ^{}, the commit it points at. The commit wins.
	const tags = new Map();
	for (const line of git(["ls-remote", "--tags", source.repository], dir).split("\n")) {
		const [sha, ref] = line.split("\t");
		const name = ref?.replace(/^refs\/tags\//, "");
		if (!name) continue;
		const tag = name.replace(/\^\{\}$/, "");
		if (RELEASE_TAG.test(tag) && (name.endsWith("^{}") || !tags.has(tag))) tags.set(tag, sha);
	}
	const version = (tag) => tag.match(RELEASE_TAG).slice(1).map(Number);
	const newest = [...tags.keys()]
		.sort((a, b) => {
			const [x, y] = [version(a), version(b)];
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
		})
		.at(-1);
	if (!newest) fail(`${source.repository} has no vX.Y.Z release tag`);
	const pinned = { ...source, tag: newest, commit: tags.get(newest) };
	checkout(dir, pinned.commit);
	return pinned;
}

// Parsed, not evaluated: --latest reads upstream main in a job that holds a write token.
function upstreamTerms(src) {
	const text = readFileSync(join(src, "scripts", "generate-pstack-harness-trees.mjs"), "utf8");
	const terms = text.match(/const TERMS = (\[[\s\S]*?\n\]);/)?.[1];
	const routeKey = text.match(/const ROUTE_KEY = ("[^"\n]+");/)?.[1];
	if (!terms || !routeKey)
		fail("cannot read TERMS and ROUTE_KEY from upstream scripts/generate-pstack-harness-trees.mjs");
	const entries = [...terms.matchAll(/\{ key: ("(?:[^"\\]|\\.)*"), re: \/((?:[^/\\\n]|\\.)+)\/([a-z]*) \}/g)];
	const count = (terms.match(/\{ key:/g) ?? []).length;
	if (count === 0 || entries.length !== count)
		fail(`parsed ${entries.length} of ${count} upstream TERMS entries; update upstreamTerms`);
	const parsed = entries.map(([, key, source, flags]) => ({ key: JSON.parse(key), re: new RegExp(source, flags) }));
	return { terms: [...parsed, ...EXTRA_TERMS], routeKey: JSON.parse(routeKey) };
}

// --- rendering ---------------------------------------------------------------------------------

// Output path -> "<source>/<upstream path>" for every copied upstream file.
function sources(plugins) {
	const map = new Map();
	const add = (from, to) => {
		for (const path of walk(join(plugins, from)))
			map.set(posix.join(to, relative(join(plugins, from), path)), posix.join(PLUGINS, relative(plugins, path)));
	};
	for (const skill of readdirSync(join(plugins, "pstack", "skills")).sort()) {
		if (!EXCLUDED.includes(skill) && existsSync(join(plugins, "pstack", "skills", skill, "SKILL.md")))
			add(`pstack/skills/${skill}`, `${OUT}/${skill}`);
	}
	for (const skill of COMPANIONS) add(`cursor-team-kit/skills/${skill}`, `${OUT}/${skill}`);
	map.set(`${OUT}/LICENSES/pstack`, `${PLUGINS}/pstack/LICENSE`);
	map.set(`${OUT}/LICENSES/cursor-team-kit`, `${PLUGINS}/cursor-team-kit/LICENSE`);
	map.set(`${OUT}/no-mistakes/SKILL.md`, `${NO_MISTAKES}/skills/no-mistakes/SKILL.md`);
	map.set(`${OUT}/LICENSES/no-mistakes`, `${NO_MISTAKES}/LICENSE`);
	return map;
}

function usedTerms(text, { terms, routeKey }, skills, self) {
	const others = skills.filter((name) => name !== self).join("|");
	const route = new RegExp(`the \\*\\*(?<bold>${others})\\*\\* skill|\`/(?<command>${others})\``, "g");
	const used = new Set(terms.filter((term) => term.re.test(text)).map((term) => term.key));
	const namesBareSkill = (line) =>
		[...line.matchAll(route)].some(({ groups }) => !line.includes(`(../${groups.bold ?? groups.command}/`));
	if (text.split("\n").some(namesBareSkill)) used.add(routeKey);
	return used;
}

// Compares every pinned input with the lock while its source commit is unchanged; a repinned source is recorded fresh.
function verifyInputs(inputs, previous, pins) {
	const problems = [];
	for (const name of Object.keys(pins)) {
		if (previous.sources[name]?.commit !== pins[name].commit) continue;
		const prefix = `${name}/`;
		const recorded = Object.keys(previous.inputs).filter((path) => path.startsWith(prefix));
		if (recorded.length === 0) continue;
		for (const path of recorded) {
			if (!(path in inputs)) problems.push(`pinned source ${path} is recorded in ${LOCK} but no longer read`);
			else if (inputs[path] !== previous.inputs[path])
				problems.push(`pinned source ${path} changed at the same commit`);
		}
		for (const path of Object.keys(inputs).filter((p) => p.startsWith(prefix) && !(p in previous.inputs))) {
			problems.push(`pinned source ${path} is read but not recorded in ${LOCK}`);
		}
	}
	return problems;
}

function render(pins, previous, roots, vocabulary) {
	const upstreamOf = sources(roots[PLUGINS]);
	const read = (from) => {
		const slash = from.indexOf("/");
		return file(join(roots[from.slice(0, slash)], from.slice(slash + 1)));
	};
	const original = new Map([...upstreamOf].map(([path, from]) => [path, read(from)]));
	const inputs = Object.fromEntries(
		[...new Set(upstreamOf.values())].sort().map((from) => [from, digest(read(from).bytes)]),
	);
	const problems = verifyInputs(inputs, previous, pins);

	const files = new Map([...original].map(([path, entry]) => [path, { ...entry }]));
	for (const [path, from] of upstreamOf) {
		if (from.startsWith(`${PLUGINS}/`) && path.endsWith(".md"))
			files.get(path).bytes = Buffer.from(stripCursorOnly(original.get(path).bytes.toString("utf8")));
	}
	for (const path of walk(OVERLAYS)) {
		const to = posix.join(OUT, relative(OVERLAYS, path));
		if (files.has(to)) fail(`skills-src/${relative(OVERLAYS, path)} would overwrite upstream ${to}`);
		files.set(to, file(path));
	}

	const skills = [
		...new Set([...files.keys()].map((p) => p.split("/")[1]).filter((name) => name !== "LICENSES")),
	].sort();
	if (!skills.includes("poteto-mode"))
		problems.push("upstream has no poteto-mode skill, and the adapter says poteto-mode embeds it");
	for (const skill of skills) {
		const path = `${OUT}/${skill}/SKILL.md`;
		if (!files.has(path)) {
			problems.push(`${path} is missing`);
			continue;
		}
		const { fields } = frontmatter(files.get(path).bytes.toString("utf8"));
		const raw = field(fields, "name");
		const name = raw === undefined ? undefined : scalar(raw, `${path} name`);
		if (name !== skill) problems.push(`${path} has name ${JSON.stringify(name ?? "")}, not its folder name`);
		if (!SKILL_NAME.test(skill) || skill.length > 64)
			problems.push(`${OUT}/${skill} is not a valid Agent Skills name`);
		if (!field(fields, "description")) problems.push(`${path} has no description`);
	}

	// A cursor-team-kit skill that pstack starts naming must be copied too, or the agent asks for a skill that is not there.
	const kit = readdirSync(join(roots[PLUGINS], "cursor-team-kit", "skills")).filter((name) => !skills.includes(name));
	const kitRef = new RegExp(`\`/?(${kit.join("|")})\`|\\*\\*(${kit.join("|")})\\*\\*`);
	const users = new Map();
	const pstackSkills = skills.filter((name) => upstreamOf.get(`${OUT}/${name}/SKILL.md`)?.startsWith(`${PLUGINS}/`));
	const adapterPath = `${OUT}/${ADAPTER}/SKILL.md`;
	if (!files.has(adapterPath)) fail(`skills-src/${ADAPTER}/SKILL.md is missing`);
	const adapter = files.get(adapterPath).bytes.toString("utf8");
	const wrapped = [];
	for (const skill of pstackSkills) {
		const paths = [...files.keys()].filter((p) => p.startsWith(`${OUT}/${skill}/`) && p.endsWith(".md"));
		const used = new Set();
		for (const p of paths) {
			const text = files.get(p).bytes.toString("utf8");
			const hit = kit.length > 0 && text.match(kitRef);
			if (hit) problems.push(`${p} names cursor-team-kit skill ${hit[1] ?? hit[2]}; add it to COMPANIONS`);
			for (const key of usedTerms(text, vocabulary, skills, skill)) used.add(key);
		}
		for (const key of used) users.set(key, [...(users.get(key) ?? []), skill]);
		const path = `${OUT}/${skill}/SKILL.md`;
		const text = files.get(path).bytes.toString("utf8");
		if (skill === "poteto-mode") {
			const { fields, body } = frontmatter(text);
			files.get(path).bytes = Buffer.from(
				`---\n${fields}\n---\n\n${frontmatter(adapter).body.trimEnd()}\n\n---\n\n${body}`,
			);
		} else if (used.size > 0) {
			files.get(path).bytes = Buffer.from(insertAfterHeading(text, POINTER));
			wrapped.push(skill);
		}
	}
	for (const [key, using] of users) {
		if (!adapter.includes(key)) problems.push(`Makora adapter has no row for ${key}, used by ${using.join(", ")}`);
	}

	const nmPath = `${OUT}/no-mistakes/SKILL.md`;
	const nm = frontmatter(files.get(nmPath).bytes.toString("utf8"));
	if (!nm.head) problems.push(`${upstreamOf.get(nmPath)} has no frontmatter to place the Makora pointer after`);
	files.get(nmPath).bytes = Buffer.concat([
		Buffer.from(`${nm.head}\n${NO_MISTAKES_POINTER}\n`),
		files.get(nmPath).bytes.subarray(Buffer.byteLength(nm.head)),
	]);

	const audit = `${OUT}/poteto-mode/scripts/worktree-audit.sh`;
	if (!files.has(audit))
		problems.push(`${audit} moved upstream; the adapter promises its guard, so move the guard too`);
	else
		files.get(audit).bytes = Buffer.from(
			files
				.get(audit)
				.bytes.toString("utf8")
				.replace(/^(#!.*\n)?/, `$1${AUDIT_GUARD}`),
		);
	for (const [path, from] of upstreamOf) {
		if (
			path === audit ||
			path.endsWith(".md") ||
			!/agent-transcripts|\.cursor\/projects/.test(original.get(path).bytes.toString("utf8"))
		)
			continue;
		problems.push(`${path} (${from}) reads Cursor transcripts; guard it like ${audit}`);
	}
	if (problems.length > 0) fail(problems);

	rewriteLinks(files, upstreamOf, pins, roots);
	return { files, inputs, skills, wrapped };
}

// A relative link that points at a copied file keeps working. One that points at an upstream file outside the
// tree becomes a GitHub link at the pinned commit. Anything else fails the build.
function rewriteLinks(files, upstreamOf, pins, roots) {
	const locate = (from) => {
		const slash = from.indexOf("/");
		const name = from.slice(0, slash);
		return { name, root: roots[name], path: from.slice(slash + 1) };
	};
	const inTree = (path) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`));
	const treeOf = new Map();
	for (const [to, from] of upstreamOf) if (!treeOf.has(from)) treeOf.set(from, to);
	// Copies keep their folder layout, so a directory maps by trimming the same suffix from any file under it.
	const mapped = (path) => {
		if (treeOf.has(path)) return treeOf.get(path);
		for (const [from, to] of treeOf) {
			const rest = from.slice(path.length);
			if (from.startsWith(`${path}/`) && to.endsWith(rest)) return to.slice(0, -rest.length);
		}
		return undefined;
	};
	const dangling = [];
	for (const [path, entry] of files) {
		if (!path.endsWith(".md")) continue;
		const from = upstreamOf.get(path);
		let text = entry.bytes.toString("utf8");
		// no-mistakes ships verbatim, so its links are only checked.
		if (from?.startsWith(`${PLUGINS}/`)) {
			const { name, root, path: upstreamPath } = locate(from);
			text = text.replace(LINK, (link, href) => {
				const dest = href.replace(/[#?].*/, "");
				if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest)) return link;
				const resolved = posix.join(posix.dirname(upstreamPath), dest).replace(/\/$/, "");
				if (resolved.startsWith("..") || !existsSync(join(root, resolved))) return link;
				const suffix = href.slice(href.search(/[#?]|$/));
				const local = mapped(`${name}/${resolved}`);
				if (local !== undefined) {
					const rel = posix.relative(posix.dirname(path), local) || ".";
					return `](${rel}${dest.endsWith("/") ? "/" : ""}${suffix})`;
				}
				const kind = statSync(join(root, resolved)).isDirectory() ? "tree" : "blob";
				return `](${pins[name].repository}/${kind}/${pins[name].commit}/${resolved}${suffix})`;
			});
			entry.bytes = Buffer.from(text);
		}
		for (const [, href] of text.matchAll(LINK)) {
			const dest = href.replace(/[#?].*/, "");
			if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
			const resolved = posix.join(posix.dirname(path), dest).replace(/\/$/, "");
			if (inTree(resolved)) continue;
			// Upstream prose has template links such as `[PR #123](url)`. Like upstream, only real targets count.
			if (from) {
				const { root, path: upstreamPath } = locate(from);
				const source = readFileSync(join(root, upstreamPath), "utf8");
				if (source.includes(`](${href})`) && !existsSync(join(root, posix.join(posix.dirname(upstreamPath), dest))))
					continue;
			}
			dangling.push(`${path} links to ${href}, which is not in the Makora skills tree`);
		}
	}
	if (dangling.length > 0) fail(dangling);
}

// --- write or check ----------------------------------------------------------------------------

function onDisk() {
	const entries = new Map();
	const base = join(APP, OUT);
	if (existsSync(base))
		for (const path of walk(base)) entries.set(relative(APP, path).split("\\").join("/"), file(path));
	if (existsSync(join(APP, LOCK))) entries.set(LOCK, file(join(APP, LOCK)));
	return entries;
}

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--check" && arg !== "--latest");
if (unknown.length > 0 || args.length > 1) fail(`usage: sync-skills.mjs [--latest | --check], got ${args.join(" ")}`);
const check = args.includes("--check");
const latest = args.includes("--latest");

const previous = JSON.parse(readFileSync(join(APP, LOCK), "utf8"));
const pins = {
	[PLUGINS]: pinPlugins(previous.sources[PLUGINS], latest),
	[NO_MISTAKES]: pinNoMistakes(previous.sources[NO_MISTAKES], latest),
};
const roots = { [PLUGINS]: join(CACHE, PLUGINS), [NO_MISTAKES]: join(CACHE, NO_MISTAKES) };
pins[PLUGINS] = {
	...pins[PLUGINS],
	pstackVersion: JSON.parse(readFileSync(join(roots[PLUGINS], "pstack", "plugin.json"), "utf8")).version,
};
const { files, inputs, skills, wrapped } = render(pins, previous, roots, upstreamTerms(roots[PLUGINS]));
const outputs = Object.fromEntries([...files.keys()].sort().map((path) => [path, digest(files.get(path).bytes)]));
const lock = { sources: pins, inputs, outputs };
files.set(LOCK, { bytes: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`), executable: false });

if (check) {
	const have = onDisk();
	const drifted = [...new Set([...files.keys(), ...have.keys()])].sort().flatMap((path) => {
		const [want, got] = [files.get(path), have.get(path)];
		if (!got) return [`missing ${path}`];
		if (!want) return [`extra   ${path}`];
		if (!want.bytes.equals(got.bytes)) return [`changed ${path}`];
		return want.executable === got.executable ? [] : [`mode    ${path}`];
	});
	for (const line of drifted.slice(0, 20)) console.log(`drift ${line}`);
	if (drifted.length > 20) console.log(`drift ... and ${drifted.length - 20} more`);
	if (drifted.length > 0)
		fail(
			`${drifted.length} generated paths are out of date. Run \`node apps/makora/scripts/sync-skills.mjs\` and commit the result.`,
		);
	console.log(
		`up to date: ${skills.length} skills, cursor/plugins ${pins[PLUGINS].commit.slice(0, 7)} (pstack ${pins[PLUGINS].pstackVersion}), no-mistakes ${pins[NO_MISTAKES].tag}`,
	);
} else {
	rmSync(join(APP, OUT), { recursive: true, force: true });
	for (const [path, { bytes, executable }] of files) {
		mkdirSync(dirname(join(APP, path)), { recursive: true });
		writeFileSync(join(APP, path), bytes);
		chmodSync(join(APP, path), executable ? 0o755 : 0o644);
	}
	console.log(`${skills.length} skills, ${wrapped.length} with the adapter line -> apps/makora/${OUT}/`);
	console.log(
		`cursor/plugins ${pins[PLUGINS].commit.slice(0, 7)} (pstack ${pins[PLUGINS].pstackVersion}), no-mistakes ${pins[NO_MISTAKES].tag} ${pins[NO_MISTAKES].commit.slice(0, 7)}`,
	);
}
