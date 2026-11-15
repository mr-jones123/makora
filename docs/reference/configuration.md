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
| `settings.json` | `/model`, `/thinking`, or you | `{ "model": { "provider": "anthropic", "modelId": "…" }, "thinkingLevel": "high", "snapshots": true }` |
| `keybindings.json` | You | `{ "<binding id>": "<key>" or ["<key>", …] }` |
| `auth.json` | `/login`, `/accounts`, `/logout`, token refresh | See [architecture/auth.md](../architecture/auth.md); mode 0600, do not edit while makora runs |
| `AGENTS.md` | You | Markdown instructions added to every conversation's prompt, before project AGENTS.md files |
| `skills/<name>/SKILL.md` | You | User skills; see [features/skills.md](../features/skills.md) |
| `sessions/<id>/` | makora | See [features/sessions.md](../features/sessions.md) |
| `python/venv/` | makora, on the first REPL cell | The Python environment kernels run in; delete it to force a rebuild ([architecture/repl.md](../architecture/repl.md#the-python-environment)) |

### `settings.json` fields

| Field | Default | Effect |
| --- | --- | --- |
| `model` | none | `{ "provider", "modelId" }` of new sessions |
| `thinkingLevel` | none | Thinking level of new sessions |
| `snapshots` | `true` | Save REPL variables and a git tree after each cell, and restore them after a kernel restart. `false` turns both off for stored sessions; read at every cell ([features/repl.md](../features/repl.md#turning-durability-off)) |

`settings.json` and `keybindings.json` are read live; a missing or unreadable `settings.json` reads as empty, and
malformed key bindings are skipped.

## Key binding ids

Makora's own:

| Id | Default |
| --- | --- |
| `app.interrupt` | `escape` |
| `app.cancel` | `ctrl+c` |
| `app.exit` | `ctrl+d` |
| `app.tools.expand` | `ctrl+o` |
| `app.agents` | `ctrl+a` |
| `app.model.select` | `ctrl+l` |
| `app.diff` | `ctrl+g` |

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
