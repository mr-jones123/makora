# Architecture overview

Makora is a host application on top of three packages of this monorepo. It adds no runtime of its own: Durable runs
the agent and keeps it durable, pi-ai talks to models, pi-tui draws the screen.

```mermaid
flowchart TB
  subgraph process[makora process]
    CLI[cli-args.ts / main.ts] --> TUI[tui/run.ts]
    CLI --> PRINT[print.ts]
    TUI --> SESSION[session.ts]
    PRINT --> SESSION
    SESSION --> H[Durable Harness]
    H --> REPL[makora-repl extension: python, llm]
    H --> EXT[makora extension: prompt sections]
    H --> MODELS[pi-ai Models]
    REPL --> TOOLS[CodingTools: read, write, edit, bash]
    REPL --> KM[kernel/manager.ts]
    MODELS --> AUTH[auth/store.ts]
    TUI --> GIT[git/: diff view data]
  end
  KM --> K[Python kernel per conversation]
  H --> DB[(sessions/id/session.sqlite)]
  REPL --> BLOBS[(sessions/id/blobs)]
  AUTH --> AJ[(auth.json)]
  TOOLS --> FS[project files, shell]
  GIT --> REPO[project git repository]
  MODELS --> API[model providers]
```

## Packages it builds on

| Package | Used for | Notes |
| --- | --- | --- |
| `packages/durable` (`pi-durable`) | Conversations, tasks, crash recovery, compaction, tools, SQLite storage | Marked experimental upstream; its API can change between releases |
| `packages/ai` (`pi-ai`) | Model catalog, streaming, OAuth and API-key login, token refresh | One change by makora: Anthropic credentials keep account and organization |
| `packages/tui` (`pi-tui`) | Alternate-screen rendering, layout stacks, editor, markdown, key bindings | Used as is |
| `packages/chord` | `Context` for cancellation (`BACKGROUND_CONTEXT`) | Workers come in phase 4 |

Makora does not use `packages/coding-agent` (the `pi` CLI) or the `apps/p2`/`apps/p3` prototypes; it copies small
patterns from p2 (the source resolver, the keybinding declaration merge).

## Process model

One process per `makora` run. The TUI and the Durable harness share it. Tools run as child processes through Durable's
`NodeExecutionEnv` in the session's directory. Each conversation that runs a cell has one Python kernel subprocess in
its own process group, talking NDJSON over its stdin and stdout ([repl.md](repl.md)). The diff view runs `git` as child
processes. Phase 4 moves sessions into worker processes behind a background service.

## Module map

`apps/makora/src`:

| File | Owns |
| --- | --- |
| `main.ts`, `cli-args.ts` | The command line, parsed into one tagged command, and dispatch |
| `app.ts` | Process-wide state: home paths, auth store, models, settings |
| `paths.ts` | `~/.makora` and the files under it; `MAKORA_HOME` |
| `sessions.ts` | Session directories, `meta.json`, the session list, the writer lock |
| `session.ts` | One open session, stored or ephemeral: lock, kernels, `Harness.open`, root conversation, resume, restore notices |
| `settings.ts` | `settings.json`, read live (model, thinking level, `snapshots`); the harness run policy |
| `models.ts` | Built-in providers plus the scripted fake provider and its `FAKE_SCRIPTS` |
| `extension.ts` | The `makora` Durable extension: the REPL preamble, cwd, context files, skills |
| `kernel/` | `python-env.ts` (the shared venv), `protocol.ts` (the kernel wire protocol), `kernel.ts` (one kernel process), `manager.ts` (kernels per conversation, status, pid files); see [repl.md](repl.md) |
| `repl/` | `python-tool.ts`, `llm-tool.ts`, `history.ts`, `git-tree.ts`, `details.ts`, `extension.ts` (the `makora-repl` extension); see [repl.md](repl.md) |
| `git/` | `repo.ts` (runs git), `diff.ts` (the diff parser), `log.ts` (the log parser) for the diff view; see [tui.md](tui.md#the-diff-view) |
| `context-files.ts` | AGENTS.md discovery |
| `skills.ts` | Skill discovery, precedence, hidden copies, the prompt section |
| `project.ts` | Directories from cwd to the git root; the branch |
| `tool-cell.ts`, `transcript-rows.ts` | Entries and live state turned into rows and one-line tool summaries, with a python cell's number and nested calls |
| `print.ts` | Print mode |
| `auth/` | `types.ts` (contract), `store.ts`, `login.ts`, `usage.ts` |
| `tui/` | See [tui.md](tui.md); the diff view is `tui/diff-*.ts` |
| `source.ts`, `source-resolver.ts` | Resolve `@earendil-works/*` imports to package sources so nothing needs building |

Other parts of `apps/makora`: `bin/makora.mjs` (launcher), `python/makora_rlm/` (the kernel's Python package:
`kernel.py`, `snapshot.py`, `helpers.py`, `protocol.py`), `scripts/sync-skills.mjs`, `skills/` (generated),
`skills-src/` (overlays), `skills.lock.json`, `test/`.

## Files on disk

```text
~/.makora/                      (MAKORA_HOME)
  auth.json                     accounts and credentials, mode 0600
  settings.json                 default model, thinking level, snapshots
  keybindings.json              optional key overrides
  AGENTS.md                     optional user-wide instructions
  skills/                       optional user skills
  python/venv/                  the Python environment every kernel runs in, built on first use
  sessions/<id>/
    session.sqlite              Durable storage
    meta.json                   id, cwd, title, timestamps, model
    lock.sqlite, lock.pid       writer lock
    blobs/sha256/…              pickled REPL variables, one file per blob
    kernels/<conversation>.pid  pid of each running kernel
<project>/.git/
  refs/makora/<session>/<conversation>   commits of the worktree's tree after each cell
```

An `--ephemeral` session writes none of `sessions/<id>/` and no refs; it still uses `python/venv/`
([repl.md](repl.md#durability-is-optional)).

## Changes outside apps/makora

| Path | Change |
| --- | --- |
| `packages/ai/src/auth/oauth/anthropic.ts` | Keeps `account` and `organization` from the token response, across refresh |
| `packages/ai/src/api/anthropic-messages.ts` | `PI_AI_CLAUDE_CODE_VERSION` overrides the Claude Code version string |
| `scripts/check-pinned-deps.mjs` | Skips `apps/makora/skills` (vendored upstream manifests) |
| `.github/workflows/makora.yml`, `makora-skills.yml` | CI for makora, with Python 3.12 for the REPL tests ([development.md](../development.md)) |

Keeping changes to shared packages small keeps merges from upstream cheap.
