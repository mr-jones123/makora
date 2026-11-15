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

## Phase 2: Python REPL (built)

Delivered in `apps/makora`, verified with the fake model in print mode (`test/repl-print.test.ts`) and, for the cell
lines, in tmux ([features/repl.md](features/repl.md), [architecture/repl.md](architecture/repl.md)):

- The model is offered one tool, `python`: a persistent kernel per conversation, with top-level `await`, output
  streaming, interrupts on Esc and a 600 s default timeout.
- Helpers in every cell: `read`, `write`, `edit` and `bash` as nested Durable calls, `llm` for one model call
  (optionally schema-checked), `ctx.input()` and `ctx.transcript()`.
- Per-cell snapshots: variables pickled into content-addressed blobs, a git tree of the worktree under
  `refs/makora/<session>/<conversation>`, both referenced from the committed result. A new kernel restores the newest
  snapshot and tells the model what was restored, dropped, failed, or changed on disk.
- A makora killed with `kill -9` mid-cell: the cell ends as interrupted, the next open kills the leftover kernel by its
  pid file, and the next cell restores.
- Durability is optional: `--ephemeral` sessions live in memory, and `"snapshots": false` keeps sessions but not
  variables.
- Cells in the TUI with their number, code, output and nested calls; the kernel's state in the activity row.
- The new preamble, and the skills adapter mapping Cursor's tools to the REPL helpers.

Open items of phase 2:

| Item | Needs |
| --- | --- |
| Blob pruning: every blob stays until its session is deleted | Keep the last N cells, fork points and marked cells; pick N |
| `ctx.get(name)` handles for files and child results | Child results arrive with phase 3 |
| Cheaper change detection: every variable is pickled again after every cell to hash it | A measurement on real workloads (DataFrames) |
| Memory limits on the kernel process | A limit and how to report it |
| Kernel startup cost per subagent (a process plus a restore) | Measure with 4 children in phase 3 |

## Forks (built)

`/fork` branches the active conversation before an earlier message, with that point's Python variables and files: a
Durable fork, plus a git worktree at the fork point's file snapshot under `~/.makora/worktrees/`. The agents view
lists the main conversation and its forks; Enter makes one active and `x` removes a fork with its worktree
([features/sessions.md](features/sessions.md#forks), [architecture/forks.md](architecture/forks.md)). Verified in
`test/fork.test.ts` (real kernels, temp repository) and in tmux with the fake model.

Open items of forks:

| Item | Needs |
| --- | --- |
| Merging a fork's files back | Phase 3's `merge` |
| Deleting a session's fork worktrees and refs with the session | Session deletion |
| An ephemeral session's fork worktrees stay after it ends | A decision: remove them on exit, or keep them as the session's file output |

## The diff view (built)

`/diff` and Ctrl+G open a full-screen view of the repository: Working tree, Staged, vs the base branch and History
tabs; layout A (file list and diff), B (one scroll, under 100 columns) and C (side by side); stage, unstage and
revert; and `a` to ask about a diff line in the editor ([features/diff.md](features/diff.md)).

Open items of the diff view:

| Item | Needs |
| --- | --- |
| A "This session" tab and one tab per subagent | The session's cell trees; phase 3 |
| Mouse support | Mouse handling in `DiffView` |
| At 80 columns the hint row is cut off after `r reve…` | A shorter hint set for narrow screens |
| `diff-state.ts` has no unit tests; the tmux runs cover it | Reducer tests |

## Phase 3: subagents (designed, next)

Every subagent gets its own worktree (`review` or `write` mode) and its own kernel, and is managed from the agents
dashboard (layout A). Design: [architecture/subagents.md](architecture/subagents.md).

Build order, continuing the REPL's steps 1 to 3; each step ends in a check on the real thing before the next starts:

| # | Step | Done when |
| --- | --- | --- |
| 4 | Worktree manager; `spawn`, `send`, `collect`, `wait_agents`, `merge`; budgets; cleanup | Two reviewers and a writer run in parallel; a makora crash keeps the children; merge reports conflicts; remove deletes the worktree |
| 5 | Dashboard (layout A): inspector, open an agent, message, diff, merge, stop, remove | Each action works in tmux with the fake model |
| 6 | Prompt and skills: `wait_agents` offered to the model; adapter maps Task to `spawn` (cloud agents to `write` worktrees); pstack model roles as a makora setting | `sync-skills --check` green; `interrogate` and `swarm` run real subagents |
| 7 | End-to-end scenarios with the fake model; docs updated | "Two reviewers on worktrees, crash midway, resume, merge" passes |

## Later phases (planned)

4. Long-running operation: a background service with one worker process per session, attach and detach, goals,
   autonomous mode with quality gates, schedules and heartbeats on Durable sleeps and signals.
5. Evaluations against Prime Agent on the same tasks (long-running coding, parallel fan-out, crash and resume),
   extending `packages/evals`.
6. Self-evolution: harness changes promoted only when they beat the current harness on an evaluation; export as a Pi
   package.
7. Sandboxed execution environments (deferred: no design for macOS yet). Durable's `env` function is where they plug
   in.
