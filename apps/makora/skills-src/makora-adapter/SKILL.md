---
name: makora-adapter
description: Maps the Cursor names in pstack skills to Makora's Python REPL helpers, paths, and limits. pstack skills read it once per session; poteto-mode embeds it.
disable-model-invocation: true
---

# pstack in Makora

pstack skills use Cursor names. In Makora, read this once per session, then map each Cursor name in a pstack skill with the tables below. When this text arrives embedded in `poteto-mode`, it is already read. Do not read it again. `<pstack>` means the folder that holds the bundled skills, one level up from the skill file you are reading. If a Cursor field has no row, drop it and say so.

Makora gives you two tools. `python` is a persistent Python REPL whose cells call `await read(...)`, `await write(...)`, `await edit(...)`, `await bash(...)`, `await llm(...)`, and the subagent helpers `await spawn(...)`, `await collect(...)`, `await send(...)`, and `await merge(...)`. `wait_agents` parks until subagents finish or a message arrives. Each helper call runs through Durable and is recorded. Makora has no todo tool, no question tool, and no web tool. When a step needs something Makora lacks, put one line in your reply, `Skipped in Makora: <step>. <reason>.`, then do the work yourself where you can and go on. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

## Tools

| Cursor | Makora |
| --- | --- |
| `Task` | `await spawn(name, brief, mode=...)` in a cell. See Subagents. |
| `AskQuestion` | Ask in plain text and end your turn to wait for the answer. |
| Open a todolist | Keep a short checklist in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/<name>/SKILL.md` and follow it, unless its body is already in context from `/skill:<name>` or an earlier read. When you tell the user to type it, write `/skill:<name>`. |
| `Read`, `Write`, `StrReplace`, `Shell`, `Grep`, `Glob` | In a `python` cell: `await read(path)`, `await write(path, content)`, `await edit(path, old, new)`, `await bash(command)`, then `await bash("rg <pattern>")` for `Grep` and `await bash("rg --files -g '<glob>'")` for `Glob`. Keep long results in variables and print what you need. |
| `WebFetch`, `WebSearch` | `await bash("curl -sL <url>")` for a known URL. Search is unavailable, so say so. |

## Subagents

`await spawn(name, brief, mode="write" | "review", ref=None, base=None, model=None, budget=None)` starts a subagent: a child conversation with its own git worktree, its own Python REPL, and a budget (`{"usd": ..., "minutes": ..., "turns": ...}`). It returns the child's record at once, and spawning an existing name returns that child. A `review` child gets a checkout detached at `ref` whose changes are thrown away. A `write` child gets a new branch from `base`, and its work reaches your tree only through `await merge(name)`, which returns the merge commit or the conflicting paths. Children run in the background: wait with `await collect(names)` inside a cell, or end the cell and call the `wait_agents` tool, which holds no process while it waits. A child you are not waiting for reports back as `<agent_result>`. Put everything a seat needs in its brief, because a child starts with no conversation.

| Cursor | Makora |
| --- | --- |
| `subagent_type: generalPurpose` | `await spawn(name, brief, mode=...)`. A code-writing seat is `mode="write"`. An exploration, verification, review, or other read-only seat is `mode="review"`. |
| `poteto-agent` | `await spawn(name, brief, mode="write")`, with `<pstack>/poteto-mode/SKILL.md` named in the brief. |
| `comment-sicko` | `await spawn(name, brief, mode="review")` with the comment review brief. |
| `readonly: true` | `mode="review"`: its changes are discarded with its checkout. `readonly: false` on a seat that edits code is `mode="write"`. |
| `environment: "cloud"` | `mode="write"`: its own worktree on its own branch. A worktree is not a VM; it shares your machine and credentials. `environment: "local"` needs nothing. |
| `cloud_base_branch: <b>` | `base="<b>"`. |
| `run_in_background: true` | Spawn, keep working, then call `wait_agents` (or `await collect(names)`). Every child runs in the background. |
| `resume` | `await send(name, text)` to the existing child. A finished child wakes with its transcript, and its REPL restores from its last snapshot. |
| `file_attachments` | List the absolute paths in the brief. The child reads them with `await read(path)`. |

## Models

Makora has no model roles. Every seat runs on the session model unless the step needs an independent model: then pass `model="provider/modelId"` to `spawn`, with a model the session has credentials for (`/model` lists them).

| Cursor | Makora |
| --- | --- |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | None. Skip every step that reads or writes it with the line. |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | The session model. Drop the slug, or pass a Claude model you have as `model=` when the seat must differ from the others. |
| A `grok-*`, `gpt-*`, or other non-Claude slug | The session model. Drop the slug, or pass a model of that family you have as `model=` when the seat must differ from the others. |
| `auto` or `inherit-parent` | The session model: omit `model=`. |
| An effort suffix (`-xhigh`, `-high`) or `-fast` | Drop it. |
| A two-family panel (arena, architect, interrogate) | One `spawn` per seat, with `model=` set to a second family for half the seats when you have one. Seats on one model are not multi-model evidence, so say so in the reply. |

`setup-pstack` configures model roles, which Makora does not have. Answer it with `Skipped in Makora: setup-pstack. Makora has no model roles; every seat runs on the session model unless spawn gets model=.`

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
| `/loop` | Keep working in this session until the predicate holds. Makora has no wake scheduler that outlives the session, so say so when the task needs one. |
| A custom mode that stays on across turns | Skip with the line. The user types `/skill:poteto-mode` again when they want the mode again. |
| `/visualize` | Draw the diagram as a Mermaid block in the reply. |
| Cursor's built-in `create-skill` | The bundled [create-skill](../create-skill/SKILL.md) skill. |

## Helper limits

`poteto-mode/scripts/worktree-audit.sh` decides liveness from Cursor transcripts, so this copy exits 2 before it audits anything. Use `await bash("git worktree list")`, then check each checkout's status and its unpushed commits. Unknown liveness means keep the checkout. Other helpers keep their own protocols, such as internal `gh --json` calls. Read a helper before you run it.
