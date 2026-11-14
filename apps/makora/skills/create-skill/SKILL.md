---
name: create-skill
description: Author or revise an Agent Skills SKILL.md for Makora. Stands in for Cursor's built-in create-skill, which pstack skills name. Use when writing or editing a skill.
---

# Author a skill in Makora

This stands in for Cursor's built-in `create-skill`. It is an authoring guide, not Cursor's implementation.

1. Define when the skill applies, its inputs, its observable outcome, its approval boundaries, and how it fails. Read nearby skills before you design its interface.
2. Place it. A project skill goes in `.makora/skills/<name>/SKILL.md`. A user-wide skill goes in `~/.makora/skills/<name>/SKILL.md`, and only when the user asked for user-wide scope. Makora also reads `.agents/skills/` and `~/.agents/skills/`. The first skill found with a name wins, in this order: bundled, `~/.makora/skills/`, `.makora/skills/`, `~/.agents/skills/`, `.agents/skills/`. A bundled skill shadows every other skill with its name, so pick a name no bundled skill uses.
3. A skill bundled with Makora itself goes in `apps/makora/skills-src/<name>/SKILL.md` of the Makora repository. Then run `node apps/makora/scripts/sync-skills.mjs`. Never edit `apps/makora/skills/`, because the generator overwrites it.
4. Write YAML frontmatter with `name` equal to the folder name (lowercase words joined by hyphens, at most 64 characters) and a `description` that says what the skill does and when to use it. Add `disable-model-invocation: true` only for a skill that should run when the user types it.
5. Keep helpers and references beside `SKILL.md`. Resolve relative paths from the skill's own folder. Write Makora tool names (`read`, `write`, `edit`, `bash`) and `/skill:<name>` in user-facing examples.
6. Write the smallest draft that works. Run representative success, failure, and ambiguous cases through the real workflow, inside what the user authorized. Run referenced helpers for real where you can. A model-behavior change needs a behavioral trial, not a text match.
7. Read the outputs and revise. Report static checks apart from end-to-end proof, and name the cases you did not test.

Never add global automation or publish a skill without the user's approval.
