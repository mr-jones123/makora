#!/usr/bin/env node
// makora's next release from the conventional commits since the last makora-v* tag (scripts/release/plan.ts).
// Usage: node scripts/release-plan.mjs             print the plan: { current, next, bump, commits, changelog }
//        node scripts/release-plan.mjs --write     write the next version to package.json, package-lock.json and
//                                                  CHANGELOG.md, as the release PR carries them; prints the version
//        node scripts/release-plan.mjs --pending   print the release a merged release PR asks for, { version, notes },
//                                                  or null
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pendingRelease, planRelease, prependChangelog } from "./release/plan.ts";
import { commitsSince, releasedVersions, shippedPaths } from "./release/repo.ts";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = join(APP, "..", "..");
const PACKAGE = join(APP, "package.json");
const LOCK = join(ROOT, "package-lock.json");
const CHANGELOG = join(APP, "CHANGELOG.md");

// Before the first makora-v* tag, the plan starts where this fork left upstream pi: the commits before it shipped as
// pi's releases, so the first release's changelog lists the fork's own work and what was merged from upstream since.
const FORK_POINT = "a40abecaaf39e5a11e6c4850ee5cd8ecda4958cc";

const { values } = parseArgs({ options: { write: { type: "boolean" }, pending: { type: "boolean" } } });
const changelog = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : undefined;
const released = releasedVersions(ROOT);

if (values.pending) {
	const { version } = JSON.parse(readFileSync(PACKAGE, "utf8"));
	console.log(JSON.stringify(pendingRelease(version, released, changelog), null, "\t"));
} else {
	const current = released[0] ?? null;
	const commits = commitsSince(ROOT, current === null ? FORK_POINT : `makora-v${current}`);
	const plan = planRelease(commits, current, shippedPaths(ROOT), new Date().toISOString().slice(0, 10));
	if (!values.write) console.log(JSON.stringify(plan, null, "\t"));
	else if (plan.next === null) {
		console.error("release-plan: no commit since the last release changes what ships; nothing to write");
		process.exit(1);
	} else {
		writeVersion(plan.next);
		writeFileSync(CHANGELOG, prependChangelog(changelog, plan.changelog));
		console.log(plan.next);
	}
}

/** Set makora's version in its package.json and in the root lockfile's entry for it. */
function writeVersion(version) {
	const manifest = readFileSync(PACKAGE, "utf8");
	writeFileSync(PACKAGE, manifest.replace(/^(\t"version": )"[^"]*"/m, `$1"${version}"`));
	const lock = JSON.parse(readFileSync(LOCK, "utf8"));
	lock.packages["apps/makora"].version = version;
	writeFileSync(LOCK, `${JSON.stringify(lock, null, "\t")}\n`);
}
