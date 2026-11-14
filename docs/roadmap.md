# Roadmap

The order of work, what each phase delivers, and what is still open. Current scope is phases 1 to 3; later phases are
revisited once those work. The long-term goal is in [vision.md](vision.md).

## Phase 1: app skeleton (built)

Delivered in `apps/makora`, verified with the fake model:

- `makora` command, sessions in `~/.makora/sessions/<id>/session.sqlite`, `--continue`, `--resume`, `ls`, print mode
  ([features/sessions.md](features/sessions.md)).
- Crash recovery: `kill -9` during a tool, then `--continue`, resumes the run and reports the interrupted tool.
- One writer per session through an OS-level SQLite lock.
- TUI layout A, the dharma-wheel splash, the agents view, slash commands, configurable keys
  ([features/tui.md](features/tui.md)).
- Login with several accounts per provider, Claude Pro/Max identity, 30-day grant warning, plan usage
  ([features/accounts.md](features/accounts.md)).
- 63 bundled skills (pstack, companions, no-mistakes) generated from pinned upstreams, a daily sync PR, and a CI job
  for makora's checks and tests ([features/skills.md](features/skills.md)).

Open items of phase 1:

| Item | Needs |
| --- | --- |
| Live Claude Pro/Max login: does the token response carry `account` and `organization`; does the usage endpoint answer | The owner logs in once with `/login` |
| `MAKORA_BOT_TOKEN` repository secret for the daily skills PR | The owner adds a PAT or App token |
| Workflows have not run on GitHub | A push |
| Account identity rule "a person in one organization" | Owner confirmation ([decisions.md](decisions.md)) |
| `auth.json` uses `proper-lockfile`, whose stale-lock takeover can double-grant after a crash | Switch to the SQLite lock the sessions use |
| Bootstrap-endpoint fallback when the token response has no identity | Only if the live login shows it is needed |
| Nothing is committed | The owner asks for a commit or PR |

## Phase 2: Python REPL (designed)

The model's main tool becomes a persistent Python kernel: context as variables, `llm()` for cheap model calls,
`spawn()`/`collect()` for subagents, per-cell snapshots tied to Durable commits so variables survive crashes.
Design: [architecture/repl.md](architecture/repl.md). The skills adapter gains rows for the new tools in the same PR.

## Phase 3: worktree subagents (designed)

`spawn(..., worktree=True)` gives a child its own git worktree and branch, a budget, and an explicit merge back.
Design: [architecture/subagents.md](architecture/subagents.md).

## Later phases (planned)

4. Long-running operation: a background service with one worker process per session, attach and detach, goals,
   autonomous mode with quality gates, schedules and heartbeats on Durable sleeps and signals.
5. Evaluations against Prime Agent on the same tasks (long-running coding, parallel fan-out, crash and resume),
   extending `packages/evals`.
6. Self-evolution: harness changes promoted only when they beat the current harness on an evaluation; export as a Pi
   package.
7. Sandboxed execution environments (deferred: no design for macOS yet). Durable's `env` function is where they plug
   in.
