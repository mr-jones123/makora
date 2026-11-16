# Roadmap

The order of work, what each phase delivers, and what is still open. Current scope is phases 1 to 3, now built; later
phases are revisited next. The long-term goal is in [vision.md](vision.md).

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
| `ctx.get(name)` handles for files and child results | A design; `agents.get(name)` returns a child's record today |
| Cheaper change detection: every variable is pickled again after every cell to hash it | A measurement on real workloads (DataFrames) |
| Memory limits on the kernel process | A limit and how to report it |
| Kernel startup cost per subagent (a process plus a restore) | Measure with 4 children (listed under phase 3) |

## Forks (built)

`/fork` branches the active conversation before an earlier message, with that point's Python variables and files: a
Durable fork, plus a git worktree at the fork point's file snapshot under `~/.makora/worktrees/`. The agents dashboard
lists the main conversation and its forks; Enter makes one active and `x` removes a fork with its worktree
([features/sessions.md](features/sessions.md#forks), [architecture/forks.md](architecture/forks.md)). Verified in
`test/fork.test.ts` (real kernels, temp repository) and in tmux with the fake model.

Open items of forks:

| Item | Needs |
| --- | --- |
| Merging a fork's files back | `merge` takes a write subagent's branch; a fork's worktree is detached and has none |

## The diff view (built)

`/diff` and Ctrl+G open a full-screen view of the repository: Working tree, Staged, vs the base branch and History
tabs; layout A (file list and diff), B (one scroll, under 100 columns) and C (side by side); stage, unstage and
revert; and `a` to ask about a diff line in the editor ([features/diff.md](features/diff.md)).

Open items of the diff view:

| Item | Needs |
| --- | --- |
| A "This session" tab | The session's cell trees |
| Mouse support | Mouse handling in `DiffView` |
| At 80 columns the hint row is cut off after `r reve…` | A shorter hint set for narrow screens |
| `diff-state.ts` has no unit tests; the tmux runs cover it | Reducer tests |

## Phase 3: subagents (built)

Delivered in `apps/makora`, verified with the fake model in `test/agents.test.ts`, `test/agents-crash.test.ts` and
`test/dashboard.test.ts`, and in tmux by `scripts/tmux-agents.sh` and `scripts/tmux-dashboard.sh`
([features/subagents.md](features/subagents.md), [architecture/subagents.md](architecture/subagents.md)):

- `spawn` from a cell: a `review` child in a checkout detached at a ref, or a `write` child on its own branch, each
  with its own kernel, its own model when given, and a budget in turns, USD and minutes. At most 4 run at once; more
  queue, a child woken by a message or typed input included, and every run gets its whole time limit. A child may spawn
  children once.
- `wait_agents` for the model and `collect` in a cell, parked in Durable without holding a process; results reported
  as `<agent_result>` to a parent that is not waiting.
- `send` between a parent, siblings and children, with length, inbox and rate limits; a message wakes a finished child.
- makora's git writes (commits, merges, worktree adds and removes, branch deletes) take turns per repository, and a
  lock another git process holds is waited for.
- `merge` with `--no-ff`, conflicts returned as paths with the tree left clean, refused during the user's own merge or
  rebase; `stop`; `remove` with the children and worktrees, keeping an unmerged branch with all its work.
- `makora rm <id>` deletes a session after a confirmation, and an ephemeral session cleans up as it ends: every fork
  and subagent worktree, the write branches without work, `refs/makora/<session>/` and the session's folders; a write
  branch with work stays ([features/sessions.md](features/sessions.md#deleting-a-session)).
- Crash safety: a killed session resumes its children without running anything twice, and a deleted review checkout
  comes back.
- The project's `worktreeSetup` command in new worktrees, once the user approved it, without provider credentials and
  with a time limit; review checkouts in the temp folder, write worktrees under `~/.makora/worktrees`, both
  configurable.
- The agents dashboard (layout A): sections RUNNING, WAITING ON YOU and DONE, rows with budget bars and the running
  cell, an inspector, and `d` diff against the base commit, `m` merge, `s` stop, `x` remove, Enter to open an agent and
  type to it. The list scrolls with `↑ N more` / `↓ N more` markers when the agents do not fit
  (`scripts/tmux-dashboard-scroll.sh`).
- The preamble and the skills adapter: `Task` maps to `spawn`, read-only seats to `review` children, cloud agents to
  `write` children.
- pstack model roles: `code` and `judge` tiers, each a model and a thinking level, every pstack role mapped to a tier
  or the session model, chosen in the `/pstack` picker (also opened by `/skill:setup-pstack`) and saved under
  `pstack` in `settings.json`; `spawn(model="code" | "judge")` resolves host-side, and the prompt lists the roles per
  tier ([features/skills.md](features/skills.md#pstack-model-roles); `test/pstack.test.ts`, `test/agents.test.ts`,
  `scripts/tmux-pstack.sh`).

Open items of phase 3:

| Item | Needs |
| --- | --- |
| Re-adding a missing worktree does not rerun the setup command | Rerun it, or record that it ran in the worktree |
| The cost limit is checked after each tool round, so one long response can pass it | Usage during a generation |
| `interrogate` and `swarm` with real subagents | A run on a real model |
| A live view of a running agent inside the dashboard | Key routing to a second scrolling area in pi-tui |
| Kernel startup cost per subagent | A measurement with 4 children |

## The session quiz (built)

`/quiz` has the agent write 10 multiple-choice questions on what the session's commits built and decided, from the
commits, their diffs, the docs and decisions they changed, and the transcript, through the bundled `session-quiz` skill,
with inline comments on the diff lines that matter. makora checks the bank, the comments against the diffs included,
renders one self-contained HTML page with the commits' diffs and the comments under their lines, shuffles each
question's options, saves it under `~/.makora/quizzes/` and opens it; the page scores itself, and nothing is recorded
([features/quiz.md](features/quiz.md), [architecture/quiz.md](architecture/quiz.md)). Verified with the fake model in
`test/quiz.test.ts`, unit tests of the checks, the shuffle and the escaping, and a real quiz on makora's own history in
headless Chrome, light and dark, before and after submitting.

Open items of the quiz:

| Item | Needs |
| --- | --- |
| Quiz results are not kept: a score lives only in the page | The memory system, which decides what the owner's results feed into |
| A page holds every diff of its range (4.2 MB for makora's 12 commits and 45 comments) | A cap per commit, or a more compact row encoding, if larger ranges make pages slow |
| `/quiz all` leaves finding the project's first commit to the agent | A project setting, if the agent's choice proves unreliable |

## Later phases (planned)

4. Long-running operation: a background service with one worker process per session, attach and detach, goals,
   autonomous mode with quality gates, schedules and heartbeats on Durable sleeps and signals.
5. Evaluations against Prime Agent on the same tasks (long-running coding, parallel fan-out, crash and resume),
   extending `packages/evals`.
6. Self-evolution: harness changes promoted only when they beat the current harness on an evaluation; export as a Pi
   package.
7. Sandboxed execution environments (deferred: no design for macOS yet). Durable's `env` function is where they plug
   in.

The memory system: the session, project and user memories of [vision.md](vision.md#what-evolves), and with it the wiki,
a project's long-term record in the owner's Obsidian vault (intent, architecture, decisions as ADRs, progress) written
from commits, docs and transcripts. The wiki is designed as part of the memory system, not before
([decisions.md](decisions.md)); where the memory system falls among the phases above is open.
