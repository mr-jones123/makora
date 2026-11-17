// Skills: directories holding a SKILL.md, found in makora's bundled set, the user's and the project's skill folders.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { INSTALL } from "./install.ts";
import { projectDirs } from "./project.ts";

/** One discovered skill. */
export interface Skill {
	readonly name: string;
	readonly description: string;
	/** Absolute path of its SKILL.md. */
	readonly path: string;
	/** False when its frontmatter sets `disable-model-invocation`: only the user runs it, with `/skill:<name>`. */
	readonly modelInvocable: boolean;
	/** SKILL.md paths of the user's own skills with this name that this one hides. */
	readonly hides: readonly string[];
}

/** Where skills are searched. */
export interface SkillRoots {
	readonly cwd: string;
	/** The makora home, holding `skills/`. */
	readonly makoraHome: string;
	/** The user's home directory, holding `.agents/skills`. */
	readonly userHome: string;
	/** Makora's bundled skills; default the install's `skills/`. */
	readonly bundled?: string;
}

/** The skill directories of `roots` in precedence order: an earlier directory's skill wins a name. */
export function skillDirs(roots: SkillRoots): string[] {
	return [
		roots.bundled ?? INSTALL.skills,
		join(roots.makoraHome, "skills"),
		join(roots.cwd, ".makora", "skills"),
		join(roots.userHome, ".agents", "skills"),
		...projectDirs(roots.cwd).map((dir) => join(dir, ".agents", "skills")),
	];
}

// no-mistakes's own installer (`no-mistakes init`) writes a skill matching the user's binary into `.agents/skills`,
// so a user's copy beats the bundled one, which is pinned to whatever release the last sync picked.
const USER_COPY_FIRST: Readonly<Record<string, true>> = { "no-mistakes": true };

/**
 * Every skill under `roots`; when several share a name, the one in the earliest directory wins and lists the others
 * in `hides`, except that a skill in `USER_COPY_FIRST` prefers any non-bundled copy.
 */
export function discoverSkills(roots: SkillRoots): Skill[] {
	const [bundled, ...others] = skillDirs(roots);
	const copies = new Map<string, { bundled: Skill[]; user: Skill[] }>();
	const collect = (dir: string, origin: "bundled" | "user") => {
		for (const skill of skillsIn(dir)) {
			const entry = copies.get(skill.name) ?? { bundled: [], user: [] };
			entry[origin].push(skill);
			copies.set(skill.name, entry);
		}
	};
	collect(bundled!, "bundled");
	for (const dir of others) collect(dir, "user");
	return [...copies].map(([name, entry]) => {
		const [winner, ...hidden] = USER_COPY_FIRST[name]
			? [...entry.user, ...entry.bundled]
			: [...entry.bundled, ...entry.user];
		// Only the user's own copies count as hidden; a bundled copy losing to a user copy is the intended order.
		return { ...winner!, hides: hidden.filter((skill) => entry.user.includes(skill)).map((skill) => skill.path) };
	});
}

/** The model-invocable skills as a prompt section; undefined when there are none. */
export function renderSkills(skills: readonly Skill[]): string | undefined {
	const listed = skills.filter((skill) => skill.modelInvocable);
	if (listed.length === 0) return undefined;
	const rows = listed.map(
		(skill) =>
			`  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.path}</location>\n  </skill>`,
	);
	return [
		"Skills are folders of instructions for specific tasks. When a task matches a skill's description, `read` its SKILL.md at the listed location before acting, and follow it. Paths inside a skill are relative to its folder.",
		"",
		"<available_skills>",
		...rows,
		"</available_skills>",
	].join("\n");
}

/** The user message that runs `skill`: its instructions in a `<skill>` block, then `args` when there are any. */
export function skillMessage(skill: Skill, args: string): string {
	const body = `<skill name="${skill.name}" location="${skill.path}">\n${readSkillBody(skill)}\n</skill>`;
	return args ? `${body}\n\n${args}` : body;
}

/** A skill's instructions: its SKILL.md without the frontmatter. */
export function readSkillBody(skill: Skill): string {
	return splitFrontmatter(readFileSync(skill.path, "utf8")).body.trim();
}

function skillsIn(dir: string): Skill[] {
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const path = join(dir, name, "SKILL.md");
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return [];
		}
		const skill = parseSkill(text, name, path);
		return skill === undefined ? [] : [skill];
	});
}

// SKILL.md frontmatter is user-authored YAML: the trust boundary of skills.
function parseSkill(text: string, folder: string, path: string): Skill | undefined {
	let meta: unknown;
	try {
		meta = parse(splitFrontmatter(text).frontmatter) ?? {};
	} catch {
		return undefined;
	}
	if (typeof meta !== "object" || meta === null) return undefined;
	const fields = meta as Record<string, unknown>;
	const name = typeof fields.name === "string" && fields.name.length > 0 ? fields.name : folder;
	const description = typeof fields.description === "string" ? fields.description.trim() : "";
	return { name, description, path, modelInvocable: fields["disable-model-invocation"] !== true, hides: [] };
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	return match === null
		? { frontmatter: "", body: text }
		: { frontmatter: match[1]!, body: text.slice(match[0].length) };
}
