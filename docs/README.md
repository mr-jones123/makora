# Makora docs

Makora is a self-evolving agent harness for long-running tasks, built on this fork of Pi
(`github.com/mr-jones123/pi`, upstream `earendil-works/pi`). The app lives in `apps/makora`. These docs are the source
of truth for what makora is, what it does today, how it is built, and what comes next. When code and docs disagree,
fix one of them in the same change.

## Status

| Phase | What | State |
| --- | --- | --- |
| 1 | App skeleton: CLI, Durable sessions, TUI, Claude subscription login with accounts, bundled pstack and no-mistakes with a sync CI job | **Built**, committed on `main`, not pushed |
| 2 | Persistent Python REPL as the model's one tool: file and shell helpers, `llm`, `ctx`, per-cell snapshots, `--ephemeral`; plus the `/diff` view | **Built**, with `/fork`; open: pruning |
| 3 | Subagents, each with its own worktree and REPL; `wait_agents`; the agents dashboard | **Built**, not committed; open: model roles |
| 4+ | Background service, autonomous mode, evals against Prime Agent, self-evolution, sandboxes | Planned |

Details and open items: [roadmap.md](roadmap.md).

## Reading order

1. [vision.md](vision.md): the long-term goal, self-evolution and portable instances.
2. [getting-started.md](getting-started.md): install the `makora` command, log in, daily use.
3. Features, what a user sees and can rely on:
   - [features/tui.md](features/tui.md): the screen, the splash, the agents dashboard, keys and slash commands.
   - [features/repl.md](features/repl.md): the Python REPL, its helpers, cells in the TUI, what survives a crash.
   - [features/subagents.md](features/subagents.md): subagents for tasks and code review, budgets, messaging, the
     dashboard, where worktrees live.
   - [features/diff.md](features/diff.md): the diff view, its tabs, layouts and keys, asking about a line.
   - [features/sessions.md](features/sessions.md): sessions, crash recovery, ephemeral sessions, one writer per
     session, print mode.
   - [features/accounts.md](features/accounts.md): login, multiple accounts, plan usage, how Anthropic bills it.
   - [features/skills.md](features/skills.md): bundled pstack and no-mistakes, where skills are found, conflicts.
4. Architecture, how it is built:
   - [architecture/overview.md](architecture/overview.md): the big picture, process model, module map, files on disk.
   - [architecture/runtime.md](architecture/runtime.md): the Durable harness wiring, prompt, models, settings.
   - [architecture/tui.md](architecture/tui.md): the TUI's live model, layout, state and key routing.
   - [architecture/auth.md](architecture/auth.md): the account store, locking, login flow, the pi-ai change.
   - [architecture/skills-pipeline.md](architecture/skills-pipeline.md): the skills generator, lock, adapter and CI.
   - [architecture/repl.md](architecture/repl.md): the REPL as built: kernel, protocol, snapshots, restore.
   - [architecture/forks.md](architecture/forks.md): forks: the fork document, worktrees, switching, removing.
   - [architecture/subagents.md](architecture/subagents.md): subagents as built: the anchor, records, worktrees,
     limits, messaging, `wait_agents`, merge, crash safety.
5. Reference: [reference/cli.md](reference/cli.md), [reference/configuration.md](reference/configuration.md).
6. [development.md](development.md): working on makora, checks, tests, CI, upstream sync.
7. [decisions.md](decisions.md): every decision and its reason, newest last.

## Words used here

| Word | Meaning |
| --- | --- |
| Session | One `makora` run's durable state: a SQLite file holding the transcript, tasks and documents. |
| Conversation | A transcript inside a session. The user talks to the root conversation; subagents get their own. |
| Subagent | A child conversation a cell starts with `spawn`, with its own worktree, kernel and budget. |
| Anchor | The background task of the parent conversation that drives one subagent's life. |
| Durable | `packages/durable` (`@earendil-works/pi-durable`): the runtime that commits every change before it is shown and resumes after a crash. |
| Cell | One execution of the `python` tool in a conversation's REPL, numbered per conversation. |
| Kernel | The Python process that runs a conversation's cells and holds its variables. |
| Snapshot | The variables and the git tree saved after a cell, referenced from its committed result. |
| Skill | A folder with a `SKILL.md` of instructions the model reads when a task matches. |
| pstack | poteto's skill pack for rigorous agent work, from `cursor/plugins`, bundled with makora. |
| Harness bundle | The evolved prompts, memories, skills, subagent specs and extensions an instance exports (phase 6). |
