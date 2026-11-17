# Makora: vision

Makora is an agent harness for long-running tasks that improves itself while it works. It is built on Pi's packages,
kept in this repository, using `pi-durable` for session state and a persistent Python REPL as the agent's main tool.

## The long-term goal

A developer starts a Makora instance on a long task (a migration, a research question, a performance hunt, an eval
campaign) and leaves it running. While it works, the instance refines its own harness: the prompts, memories, skills,
subagent specifications and extensions it runs with. When the task ends, the evolved harness is exported and used
elsewhere: on another task in the same project, by another developer, or as the starting point of a new instance.

Example: an instance spends three days porting a codebase from one ORM to another. Along the way it learns that the
test suite needs a seeded database, that a certain module is generated and must not be edited, and that a
two-subagent pattern (one migrates, one reviews against the schema) halves the rework. Each lesson becomes a harness
change that has passed an evaluation. The exported harness then starts the next port with those lessons already in place.

## What evolves

| Kind | Example | Scope |
| --- | --- | --- |
| Prompt sections | "In this repo, run `make seed` before tests" | session, project, user |
| Memories | "Module `gen/` is generated from `schema.yaml`" | session, project, user |
| Skills | A Python helper for bulk AST rewrites, with its description | project, user |
| Subagent specifications | "migrator + schema reviewer", with models, tools and budgets | project, user |
| Extensions | A Durable extension adding a tool or a hook, hot-swapped with `registry.install` | project, user |

Prime Agent's continual harness stores text entries only. Makora also evolves executable extensions, which Durable can
swap in while a session runs.

## Rules for self-evolution

- **No change without evidence.** A proposed change names what it should improve and how to check it (a replayed task,
  a test, an eval suite). It is promoted only after it beats the current harness on that check. Prime Agent validates
  refinements by schema alone; that is the gap Makora closes.
- **Promotion moves up scopes.** A change starts in the session. It moves to the project, then to the user, only with
  evidence from more than one task.
- **Every change can be rolled back.** The harness is a versioned, content-addressed bundle; each promotion is a new
  version with its parent recorded.
- **The base system prompt is not self-editable.** Evolution adds and replaces sections around it.
- **Exports carry no runtime state.** An exported harness contains prompts, memories, skills, subagent specifications
  and extensions. It never contains kernel snapshots: pickles run code when loaded and depend on the exact Python
  version. Extensions and skills in an import are reviewed before they run.

## How the evolved instance is used elsewhere

The harness bundle is exported as a Pi package (`packages.md` in coding-agent docs describes the format). Importing it
into a new Makora instance installs its extensions and skills and seeds its prompt sections and memories, at project or
user scope.

## Order of work

Self-evolution is built last. It needs a harness that already runs long tasks reliably and an evaluation suite to
gate changes. See [roadmap.md](roadmap.md) for the phases and [decisions.md](decisions.md) for what
is decided.

Current scope is phases 1 to 3; later phases are revisited once those work.

1. App skeleton on Durable: CLI, SQLite storage, a new TUI, Anthropic subscription login with multiple accounts, and
   the pstack and no-mistakes skills kept current by a scheduled CI job.
2. Persistent Python REPL with `llm` and context handles; per-cell snapshots.
3. Subagents with `spawn` and `collect`, each in its own git worktree with its own REPL, with explicit merge.
4. Long-running operation: background service with one worker process per session, goals, autonomous mode with
   quality gates, schedules.
5. Evaluations against Prime Agent on the same tasks.
6. Self-evolution, gated by those evaluations.
7. Sandboxed execution environments (deferred: no design for macOS yet).
