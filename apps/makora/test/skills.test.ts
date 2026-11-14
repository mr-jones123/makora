import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverSkills, readSkillBody, renderSkills, type SkillRoots } from "../src/skills.ts";

function skill(dir: string, folder: string, frontmatter: string, body = "Body text."): void {
	mkdirSync(join(dir, folder), { recursive: true });
	writeFileSync(join(dir, folder, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

function roots(): SkillRoots & { readonly base: string } {
	const base = mkdtempSync(join(tmpdir(), "makora-skills-"));
	const repo = join(base, "repo");
	const cwd = join(repo, "pkg");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return {
		base,
		cwd,
		makoraHome: join(base, "makora-home"),
		userHome: join(base, "user-home"),
		bundled: join(base, "bundled"),
	};
}

describe("skill discovery", () => {
	it("takes each name from the first directory in precedence order", () => {
		const r = roots();
		const repo = join(r.base, "repo");
		skill(r.bundled!, "shared", "name: shared\ndescription: from bundled");
		skill(join(r.makoraHome, "skills"), "shared", "name: shared\ndescription: from makora home");
		skill(join(r.makoraHome, "skills"), "home-only", "name: home-only\ndescription: from makora home");
		skill(join(r.cwd, ".makora", "skills"), "home-only", "name: home-only\ndescription: from project makora");
		skill(join(r.cwd, ".makora", "skills"), "project", "name: project\ndescription: from project makora");
		skill(join(r.userHome, ".agents", "skills"), "project", "name: project\ndescription: from user agents");
		skill(join(r.userHome, ".agents", "skills"), "agents", "name: agents\ndescription: from user agents");
		skill(join(r.cwd, ".agents", "skills"), "agents", "name: agents\ndescription: from cwd agents");
		skill(join(r.cwd, ".agents", "skills"), "nested", "name: nested\ndescription: from cwd agents");
		skill(join(repo, ".agents", "skills"), "nested", "name: nested\ndescription: from repo agents");
		skill(join(repo, ".agents", "skills"), "repo", "name: repo\ndescription: from repo agents");
		skill(join(r.base, ".agents", "skills"), "outside", "name: outside\ndescription: above the repo root");

		const found = Object.fromEntries(discoverSkills(r).map((s) => [s.name, s.description]));
		assert.deepEqual(found, {
			shared: "from bundled",
			"home-only": "from makora home",
			project: "from project makora",
			agents: "from user agents",
			nested: "from cwd agents",
			repo: "from repo agents",
		});
	});

	it("lists the user's copies a skill hides, and lets a user's no-mistakes win over the bundled one", () => {
		const r = roots();
		const agents = join(r.userHome, ".agents", "skills");
		skill(r.bundled!, "teach", "name: teach\ndescription: bundled teach");
		skill(agents, "teach", "name: teach\ndescription: user teach");
		skill(r.bundled!, "no-mistakes", "name: no-mistakes\ndescription: bundled pin");
		skill(agents, "no-mistakes", "name: no-mistakes\ndescription: matches the user's binary");

		const found = Object.fromEntries(discoverSkills(r).map((s) => [s.name, [s.description, s.hides]]));
		assert.deepEqual(found, {
			teach: ["bundled teach", [join(agents, "teach", "SKILL.md")]],
			"no-mistakes": ["matches the user's binary", []],
		});
	});

	it("parses name, description and disable-model-invocation, defaulting the name to the folder", () => {
		const r = roots();
		skill(r.bundled!, "folder-name", "description: >\n  Folded\n  description.\ndisable-model-invocation: true");
		skill(r.bundled!, "plain", "name: renamed\ndescription: Visible");
		skill(r.bundled!, "broken", "name: [unclosed");

		const skills = discoverSkills(r);
		assert.deepEqual(
			skills.map(({ name, description, modelInvocable }) => ({ name, description, modelInvocable })),
			[
				{ name: "folder-name", description: "Folded description.", modelInvocable: false },
				{ name: "renamed", description: "Visible", modelInvocable: true },
			],
		);
		assert.equal(skills[1]!.path, join(r.bundled!, "plain", "SKILL.md"));
	});

	it("lists only model-invocable skills with their paths, and reads a body without frontmatter", () => {
		const r = roots();
		skill(r.bundled!, "hidden", "name: hidden\ndescription: user only\ndisable-model-invocation: true");
		skill(r.bundled!, "shown", "name: shown\ndescription: for the model", "# Steps\n\nDo it.");

		const skills = discoverSkills(r);
		const section = renderSkills(skills)!;
		assert.match(section, /<available_skills>/);
		assert.match(section, /<name>shown<\/name>/);
		assert.ok(section.includes(join(r.bundled!, "shown", "SKILL.md")));
		assert.doesNotMatch(section, /hidden/);
		assert.match(section, /read/);
		assert.equal(readSkillBody(skills.find((s) => s.name === "shown")!), "# Steps\n\nDo it.");
		assert.equal(renderSkills(skills.filter((s) => !s.modelInvocable)), undefined);
	});
});
