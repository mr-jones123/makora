---
name: makora-adapter
description: Maps the Cursor names in pstack skills to Makora's Python REPL helpers, paths, and limits. pstack skills read it once per session; poteto-mode embeds it.
disable-model-invocation: true
---

# pstack in Makora

pstack skills use Cursor names. In Makora, read this once per session, then map each Cursor name in a pstack skill with the tables below. When this text arrives embedded in `poteto-mode`, it is already read. Do not read it again. `<pstack>` means the folder that holds the bundled skills, one level up from the skill file you are reading. If a Cursor field has no row, drop it and say so.

Makora gives you one tool, `python`: a persistent Python REPL whose cells call `await read(...)`, `await write(...)`, `await edit(...)`, `await bash(...)`, and `await llm(...)`. Each helper call runs through Durable and is recorded. Makora has no subagents yet, no todo tool, no question tool, and no web tool. When a step needs something Makora lacks, put one line in your reply, `Skipped in Makora: <step>. <reason>.`, then do the work yourself where you can and go on. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

## Tools

| Cursor | Makora |
| --- | --- |
| `Task` | No subagents yet. See Subagents. |
| `AskQuestion` | Ask in plain text and end your turn to wait for the answer. |
| Open a todolist | Keep a short checklist in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/<name>/SKILL.md` and follow it, unless its body is already in context from `/skill:<name>` or an earlier read. When you tell the user to type it, write `/skill:<name>`. |
| `Read`, `Write`, `StrReplace`, `Shell`, `Grep`, `Glob` | In a `python` cell: `await read(path)`, `await write(path, content)`, `await edit(path, old, new)`, `await bash(command)`, then `await bash("rg <pattern>")` for `Grep` and `await bash("rg --files -g '<glob>'")` for `Glob`. Keep long results in variables and print what you need. |
| `WebFetch`, `WebSearch` | `await bash("curl -sL <url>")` for a known URL. Search is unavailable, so say so. |

## Subagents

Makora has no subagents yet. Subagents arrive in phase 3. When a step spawns a `Task`, do that seat's work yourself in this conversation, one seat after another, and keep each seat's output under its own heading. Write `Skipped in Makora: <step>. No subagents yet.` when the step's value comes from independence that inline work cannot give: a second model's opinion, a blind reviewer, a parallel race, or a seat that must not see the others' work. Never present your own inline review as an independent one.

| Cursor | Makora |
| --- | --- |
| `subagent_type: generalPurpose` | Do the seat's work inline. |
| `poteto-agent` | Do the delegate's work inline under the `poteto-mode` rules you already follow. |
| `comment-sicko` | Do the comment review inline. Say it is a self-review, not an independent one. |
| `readonly: true` | Do the seat inline without editing files. `readonly: false` needs nothing. |
| `environment: "cloud"` | Skip with the line when the step needs an isolated machine. For isolation from your own checkout, create a worktree with `git worktree add`, work in it, and name its base commit. A worktree is not a VM. `environment: "local"` needs nothing. |
| `cloud_base_branch: <b>` | Base the worktree on `<b>`. |
| `run_in_background: true` | Drop it. Run the seats one after another. |
| `resume` | Drop it. Continue the earlier seat's work inline from its notes. |
| `file_attachments` | Read each file with `await read(path)` before the seat's work. |

## Models

Makora phase 1 has no model roles. Every role runs on the session model.

| Cursor | Makora |
| --- | --- |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | None in phase 1. Skip every step that reads or writes it with the line. |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | The session model. Drop the slug. |
| A `grok-*`, `gpt-*`, or other non-Claude slug | The session model. Drop the slug. |
| `auto` or `inherit-parent` | The session model. |
| An effort suffix (`-xhigh`, `-high`) or `-fast` | Drop it. |
| A two-family panel (arena, architect, interrogate) | One model runs every seat, inline. That is not multi-model evidence, so say so in the reply. |

`setup-pstack` configures model roles, which Makora phase 1 does not have. Answer it with `Skipped in Makora: setup-pstack. Phase 1 has no model roles; every role runs on the session model.`

## Paths

| Cursor | Makora |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.makora/skills/`, `~/.makora/skills/`. Makora also reads `.agents/skills/` and `~/.agents/skills/`. The first skill found with a name wins, in this order: bundled `<pstack>`, `~/.makora/skills/`, `.makora/skills/`, `~/.agents/skills/`, `.agents/skills/`. |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `<pstack>`. The pinned upstream commit and pstack version are in `skills.lock.json`, next to `<pstack>`. Never edit `<pstack>`, because the generator overwrites it. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md`. Makora loads every `AGENTS.md` from the working directory up to the repository root, and `~/.makora/AGENTS.md` for user-wide rules. Makora never reads `.mdc` files. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | Makora sessions live in `~/.makora/sessions/<id>/session.sqlite`. Phase 1 has no reader for them, so never open or query the database. Work from this conversation, and skip a step that mines earlier transcripts with the line. |

## Cursor-only features

Makora has no Cursor Automations, Bugbot, Cursor cloud agents, persistent `/loop` wakes, custom mode, or built-in PR tool. Each row says what to do instead.

| Cursor | Makora |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, automation webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command the step gives. When the PR has no Bugbot check or comment, skip with the line any step that kicks off, awaits, or sets up Bugbot. |
| Cursor cloud agents | `environment: "cloud"` maps as in Subagents. Skip a step that needs the cloud agent itself, such as its dashboard. |
| A built-in PR tool | Use the forge command the step gives, such as `gh pr create`, through `await bash(...)`. That is not a skip, so write no line. |
| `/loop` | Keep working in this session until the predicate holds. Makora phase 1 has no wake scheduler, so say so when the task needs one. |
| A custom mode that stays on across turns | Skip with the line. The user types `/skill:poteto-mode` again when they want the mode again. |
| `/visualize` | Draw the diagram as a Mermaid block in the reply. |
| Cursor's built-in `create-skill` | The bundled [create-skill](../create-skill/SKILL.md) skill. |

## Helper limits

`poteto-mode/scripts/worktree-audit.sh` decides liveness from Cursor transcripts, so this copy exits 2 before it audits anything. Use `await bash("git worktree list")`, then check each checkout's status and its unpushed commits. Unknown liveness means keep the checkout. Other helpers keep their own protocols, such as internal `gh --json` calls. Read a helper before you run it.
