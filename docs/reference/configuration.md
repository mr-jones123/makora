# Configuration reference

## Environment variables

| Variable | Effect |
| --- | --- |
| `MAKORA_HOME` | Directory for all makora state; default `~/.makora`. A relative path is resolved against the cwd |
| `MAKORA_FAKE=1` | Same as `--fake` |
| `PI_AI_CLAUDE_CODE_VERSION` | Overrides the Claude Code version pi-ai sends with Anthropic OAuth requests (default `2.1.322`) |
| Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | Used by pi-ai when no account is stored for that provider; the status row shows `api key · <source>` |

## Files in `~/.makora`

| File | Written by | Format |
| --- | --- | --- |
| `settings.json` | `/model`, `/thinking`, `/pstack`, or you | `{ "model": { "provider": "anthropic", "modelId": "…" }, "thinkingLevel": "high", "snapshots": true, "worktrees": { "review": "…", "write": "…" }, "agents": { "maxRunning": 4, "setupTimeoutMinutes": 10, "approvedSetups": [{ "repository": "…", "sha256": "…" }] }, "pstack": { "budget": "large", "models": { "code": { "model": "provider/modelId", "thinking": "xhigh" }, "judge": "session" }, "roles": { "bug-fix": "judge", "arena runners": ["judge", "code"] } } }` |
| `keybindings.json` | You | `{ "<binding id>": "<key>" or ["<key>", …] }` |
| `auth.json` | `/login`, `/accounts`, `/logout`, token refresh | See [architecture/auth.md](../architecture/auth.md); mode 0600, do not edit while makora runs |
| `AGENTS.md` | You | Markdown instructions added to every conversation's prompt, before project AGENTS.md files |
| `skills/<name>/SKILL.md` | You | User skills; see [features/skills.md](../features/skills.md) |
| `sessions/<id>/` | makora | See [features/sessions.md](../features/sessions.md) |
| `worktrees/<repo>-<hash>/<session>/<conversation>/` | `/fork` and write subagents, removed by `x` in the agents dashboard or `remove(name)` | Git worktrees of forks ([architecture/forks.md](../architecture/forks.md#the-worktree)) and of write subagents unless `worktrees.write` moves them ([features/subagents.md](../features/subagents.md#where-worktrees-live-and-why)) |
| `quizzes/<repo>-<hash>/<YYYY-MM-DD>-<n>.html` | `quiz.publish`, from `/quiz` | Self-contained quiz pages, one folder per repository; makora never deletes them ([features/quiz.md](../features/quiz.md#where-pages-go)) |
| `memory/memory.sqlite` | dreams, `memory.search` | Memory: episodes, claims with versions and evidence, dreams; see [features/memory.md](../features/memory.md) |
| `memory/dreams/<id>.log` | a dream's worker | What the dream did, step by step |
| `python/venv/` | makora, on the first REPL cell | The Python environment kernels run in; delete it to force a rebuild ([architecture/repl.md](../architecture/repl.md#the-python-environment)) |

### `settings.json` fields

| Field | Default | Effect |
| --- | --- | --- |
| `model` | none | `{ "provider", "modelId" }` of new sessions |
| `thinkingLevel` | none | Thinking level of new sessions |
| `snapshots` | `true` | Save REPL variables and a git tree after each cell, and restore them after a kernel restart. `false` turns both off for stored sessions; read at every cell ([features/repl.md](../features/repl.md#turning-durability-off)) |
| `worktrees.review` | `<temp folder>/makora-worktrees` | Root of review subagents' checkouts; read at each spawn |
| `worktrees.write` | `~/.makora/worktrees` | Root of write subagents' worktrees; read at each spawn |
| `agents.maxRunning` | `4` | Subagents running at once per session; more wait as `queued`. A whole number of at least 1; read when an agent asks for a slot |
| `agents.setupTimeoutMinutes` | `10` | How long a repository's `worktreeSetup` may run before it is killed and its child stopped; a positive number, read at each run |
| `agents.approvedSetups` | none | The `worktreeSetup` commands you let run, as `{ "repository": "<top level>", "sha256": "<hex SHA-256 of the command>" }`. The TUI adds one when you approve a command; a command not listed is skipped ([features/subagents.md](../features/subagents.md#the-setup-command-is-code-from-the-repository)) |
| `pstack.models.code`, `pstack.models.judge` | `"session"` | A pstack tier: `"session"` (the spawning conversation's model), or `{ "model": "provider/modelId", "thinking": "<level>" }`. `spawn(model="code")` and `spawn(model="judge")` run the child on it; a model without credentials falls back to the session model with a notice. Read at each spawn ([features/subagents.md](../features/subagents.md#models)) |
| `memory.vault`, `memory.folder` | none, `"makora"` | The Obsidian vault and the folder of it that `/wiki` renders into; set by `/wiki-setup` |
| `memory.ollamaUrl` | `"http://127.0.0.1:11434"` | Where Ollama answers embedding requests |
| `memory.embedModel` | `"embeddinggemma"` | The Ollama embedding model; another one embeds memory again |
| `memory.dreamBudgetUsd` | `2` | What one dream may spend; a dream whose estimate is over it fails before any model call |
| `pstack.budget` | `"large"` | `unlimited` (max), `large` (xhigh), `medium` (high) or `small` (medium): the thinking level `/pstack` gives both tiers, clamped to what each model supports |
| `pstack.roles.<role>` | pstack's split | Where a pstack role runs, by its setup-pstack label (`"bug-fix"`, `"how explainer"`, …): `"code"`, `"judge"` or `"session"`; a panel role (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`) takes a list, one seat per subagent. Defaults: code roles on `code`, judgment roles on `judge`, panels `["judge", "code"]` ([features/skills.md](../features/skills.md#pstack-model-roles)) |

`settings.json` and `keybindings.json` are read live; a missing or unreadable `settings.json` reads as empty, and
malformed key bindings are skipped. `/pstack` writes only what differs from the defaults, and removes `pstack` when
nothing does. An unknown pstack role or a malformed `pstack` value is dropped, and each session that opens shows a
warning naming it.

## Key binding ids

Makora's own:

| Id | Default |
| --- | --- |
| `app.interrupt` | `escape` |
| `app.back` | `escape`; checked before `app.interrupt`, and only on a fork or subagent |
| `app.cancel` | `ctrl+c` |
| `app.exit` | `ctrl+d` |
| `app.tools.expand` | `ctrl+o` |
| `app.agents` | `ctrl+a` |
| `app.model.select` | `ctrl+l` |
| `app.diff` | `ctrl+g` |
| `app.clipboard.pasteImage` | `ctrl+v`; on Windows also `alt+v` |
| `app.agents.diff` | `d`; read only in the agents dashboard |
| `app.agents.merge` | `m`; read only in the agents dashboard |
| `app.agents.stop` | `s`; read only in the agents dashboard |
| `app.agents.remove` | `x`; read only in the agents dashboard |
| `app.pstack.budget` | `b`; read only in the `/pstack` picker |
| `app.pstack.reset` | `r`; read only in the `/pstack` picker |
| `app.pstack.previousSeat`, `app.pstack.nextSeat` | `left`, `right`; read only while the picker edits a panel's seats |
| `app.pstack.addSeat`, `app.pstack.removeSeat` | `a`, `x`; read only while the picker edits a panel's seats |

The picker moves, changes and closes with pi-tui's `tui.select.up`, `tui.select.down`, `tui.select.confirm` and
`tui.select.cancel`.

The diff view's own keys, read only while it is open ([features/diff.md](../features/diff.md)):

| Id | Default |
| --- | --- |
| `app.diff.up` | `up`, `k` |
| `app.diff.down` | `down`, `j` |
| `app.diff.focusDiff` | `right`, `enter` |
| `app.diff.focusList` | `left` |
| `app.diff.pageUp` | `pageUp` |
| `app.diff.pageDown` | `pageDown` |
| `app.diff.nextHunk` | `]` |
| `app.diff.previousHunk` | `[` |
| `app.diff.nextTab` | `tab` |
| `app.diff.previousTab` | `shift+tab` |
| `app.diff.stage` | `s` |
| `app.diff.unstage` | `u` |
| `app.diff.revert` | `r` |
| `app.diff.split` | `v` |
| `app.diff.ask` | `a` |
| `app.diff.close` | `escape` |

pi-tui's ids (editor, selection lists, scrolling) can be overridden the same way; the full table is
`TUI_KEYBINDINGS` in `packages/tui/src/keybindings.ts`. Example:

```json
{ "app.agents": "ctrl+t", "app.cancel": ["ctrl+c", "ctrl+x"] }
```

## Project files

| File | Effect |
| --- | --- |
| `AGENTS.md` in the cwd and each parent up to the git root | Added to the prompt, outermost first |
| `.makora/skills/` in the cwd | Project skills |
| `.agents/skills/` in the cwd and each parent up to the git root | Skills installed for any agent |
| `.makora/settings.json` at the repository's top level | `{ "worktreeSetup": "<shell command>" }`: run with `sh -c` in each new subagent worktree before the child starts, for example `npm ci --ignore-scripts`, once you approved that command for that repository (`agents.approvedSetups`). It runs without provider credentials in its environment; a failing or timed-out command stops the child. This file comes with the repository, so a clone you do not trust can put any command here: read it before you approve ([features/subagents.md](../features/subagents.md#the-setup-command-is-code-from-the-repository)) |
