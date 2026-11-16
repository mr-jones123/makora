# Runtime

How a session is opened and run on Durable. Durable's own documentation: `packages/durable/README.md` and
`packages/durable/docs/spec.md`.

## Opening a session

`openSession` in `src/session.ts` opens a session stored in `<dir>/session.sqlite`. `openEphemeralSession` opens a new
one in memory for `--ephemeral`. Both run the same steps:

1. Take the writer lock (`lockSession`, `src/sessions.ts`). An ephemeral session has no lock.
2. Create the session's `KernelManager` (`src/kernel/manager.ts`). Under the lock, it kills kernels that an earlier
   process recorded in `<dir>/kernels/` and left running ([repl.md](repl.md#when-makora-itself-dies)).
3. `Harness.open(storage, { models, registry, settings, env, identity, onReport })`, where storage is
   `openNodeSqliteStorage(<dir>/session.sqlite)` or Durable's `MemoryStorage`.
4. `harness.root(...)` gets or creates the root conversation with the chosen model, thinking level, cwd, and
   `modelTools: [python, wait_agents]`. A root conversation that offers anything else (one made before the REPL, or
   before subagents) is reconfigured to offer exactly these two.
5. `harness.inspect()` finds tasks a previous process left unfinished; the TUI shows them as a restore notice.
6. `harness.resume()` starts the scheduler, which continues those tasks.

Every step after `Harness.open` runs inside a guard that closes the harness, stops the kernels and releases the lock
when it fails, so a failed open never leaves a session locked. `close()` does the same three things.

| Option | Value |
| --- | --- |
| `models` | `builtinModels({ credentials: authStore })` from pi-ai; in fake mode also the faux provider |
| `registry` | Durable's `CodingTools` (`read`, `write`, `edit`, `bash`), the `makora` extension, the `makora-repl` extension (`python`, `llm`), and the `makora-agents` extension (`spawn`, `collect`, `send`, `merge`, `stop`, `remove`, `agents`, `wait_agents`, the anchor and cost-stop tasks, and two hooks; see [subagents.md](subagents.md#tools)), and the `makora-quiz` extension (`quiz_publish`; see [quiz.md](quiz.md)) |
| `settings` | `retry: { maxRetries: 3 }`, `compaction: { enabled: true }`, `toolExecution: "parallel"` |
| `env` | `({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? sessionCwd })` |
| `identity` | Attribution `makora` |

The model is offered `python` and `wait_agents`. The coding tools stay in the registry because cells call them through
`await read(...)` and the other helpers. `llm` and the subagent tools other than `wait_agents` have
`callers: ["tools"]`, so only cells reach them. A child conversation starts as a copy of its parent's agent, so it is
offered the same two tools; a child at depth 2 has `spawn` removed. How a cell runs: [repl.md](repl.md).

## The writer lock

`lockSession` opens `<dir>/lock.sqlite` and takes an exclusive SQLite lock. The OS drops the lock when the process
exits, however it exits, so there is no stale-lock takeover to race on and no pid reuse problem. After acquiring it,
the holder writes `lock.pid` (temp file, then rename), read only for the error message. Two connections in one process
also conflict, so the rule holds within a process too. `proper-lockfile` was measured and rejected: its stale-lock
takeover granted the same lock to several openers in 26 of 200 trials.

## The system prompt

The `makora` extension (`src/extension.ts`) contributes sections that Durable renders before each request:

| Section | Content |
| --- | --- |
| `preamble` | "You are makora, a coding agent harness for long-running tasks.", then the REPL: `python` is the main tool, variables survive restarts through snapshots, the helper signatures (`read`, `write`, `edit`, `bash`, `llm`, `ctx`), and how to work (file and shell work through the helpers, large data in variables with short printed summaries, long jobs in the background with `bash`). Then subagents: `spawn` with its modes and budget, `collect` and the `wait_agents` tool, `<agent_result>` and `<agent_message>`, `send`, `merge`, and `agents.*`, `stop` and `remove` |
| `cwd` | The conversation's working directory |
| `context_files` | `~/.makora/AGENTS.md`, then every `AGENTS.md` from the git root down to the cwd |
| `skills` | `<available_skills>` with name, description and path of each model-invocable skill |

Durable stores section changes as transcript entries and only sends what changed, which keeps provider prompt caches
warm.

## Models and settings

- The model of a new session comes from `--model`, else `~/.makora/settings.json`, else the first Anthropic model
  you have auth for, else the first available model. Fake mode always uses `faux/faux-1`; its second model,
  `faux/faux-2`, answers the same scripts and lets tests and demos put a pstack tier or a subagent on another model.
- `settings.json` is read through getters with an mtime cache, so `/model`, `/thinking` or an edit in another process
  applies to the next request without a restart.
- `settings.json` also holds `snapshots` (default `true`), read at every cell
  ([repl.md](repl.md#durability-is-optional)), and the subagent settings `worktrees.review`, `worktrees.write` and
  `agents.maxRunning`, and the pstack tiers and roles under `pstack`, read at each spawn and each request's prompt
  ([reference/configuration.md](../reference/configuration.md#settingsjson-fields)).
- Fake mode (`--fake` or `MAKORA_FAKE=1`) registers a scripted faux provider. It picks the first script in
  `FAKE_SCRIPTS` (`src/models.ts`) whose keyword the prompt contains, runs its cells as `python` calls, one per turn,
  then summarizes the last result in markdown. A step can also be a `wait_agents` call. A prompt with a fenced
  `python` block runs that block as its one cell, which tests use to drive their own cells. A subagent matches keywords
  in its `<agent_task>` only, so its brief picks nothing. Without a keyword it answers in markdown and lists the
  keywords. Usage is priced at the fake model's rates (input $3, output $15 per million tokens), so `usd` budgets can
  be tested.
  A request without tools is a cell's `llm()` call and gets `Fake model here. You asked: <prompt>`, or
  `{"answer": 42}` in a `json` code fence when its system prompt asks for JSON (a call with `schema`). Answers depend
  only on the committed transcript, so a run reopened after a crash gets the same answer. Used for demos, tests and
  the tmux checks.

| Keyword | Cells |
| --- | --- |
| `<skill name="session-quiz"` | `print(await quiz.publish(json.load(open("quiz-bank.json"))))`, printing `quiz.publish refused:` and the error when makora refuses the bank ([quiz.md](quiz.md#tests)) |
| `crash` | `import os; os._exit(1)` |
| `scribble` | `await write("late.txt", "late\n")`, then `os._exit(1)` in the same cell |
| `edit` | `print(await edit("notes.txt", "world", "there"))` |
| `long` | `await read("long.txt")` compared with the file on disk, then `await read("wide.txt")` expecting a refusal |
| `context` | `print(ctx.input())` and the roles of `await ctx.transcript(limit=5)` |
| `schema` | `await llm("pick a number", schema=...)`, then `print(answer["answer"] + 1)` |
| `remember` | `print(x)` |
| `file` | `await write("fake.txt", "hi")`, then `print(await read("fake.txt"))` |
| `tool` | `print(await bash("echo hello; sleep 2"))` |
| `ask` | `print(await llm("say hi"))` |
| `python` | `x = 41`, then `print(x + 1)` |

Subagent scripts, used by `test/agents.test.ts`, `test/agents-crash.test.ts` and the tmux checks:

| Keyword | Steps |
| --- | --- |
| `dashboard` | Spawns `reviewer-a` (`steady`, 5 minutes), `reviewer-b` (`steady`), `writer` (`patient-writer`, $0.50) and `sleeper` (`doze`, $1) |
| `patient-writer` | `sleep 4` through `bash`, then writes `CHANGES.md` |
| `doze` | `sleep 600` through `bash` |
| `agents` | Spawns two reviewers and a writer, `wait_agents` on all three, then `merge("writer")` |
| `trio` | Spawns two reviewers and a writer |
| `first-of` | Spawns `quick` and `slow`, then `wait_agents` with policy `any` |
| `hear-from` | Spawns `slow` and `talker`, then waits on `slow` |
| `resume-team` | Spawns `slow-a`, `slow-b` and `talker`, then waits on all three |
| `message-sibling`, `message-parent`, `message-writer` | One `send` to `slow-a`, to the parent, or to `writer` |
| `steady` | `sleep 3`, then reads `README.md` |
| `wait-message` | `wait_agents` for a message, then writes `CHANGES.md` |
| `write-change` | Writes `CHANGES.md` |
| `review` | Reads `README.md` |
| `slow` | `sleep 3` through `bash` |
| `nest`, `nest-keep`, `nest-deeper` | A child that spawns a grandchild, and a grandchild that tries to spawn |

## Durability

What Durable guarantees and makora relies on:

- Every change is committed to SQLite before it is shown.
- Model turns and tool calls are tasks with checkpoints. After a crash, a running task returns to pending; a tool that
  is not replay-safe ends as `interrupted` with the output committed so far, and the run continues.
- A task that keeps crashing the process is faulted after `restartLimit` restarts (Durable default 5).
- Submissions with the same `requestId` are not submitted twice.

An ephemeral session (`--ephemeral`) commits to `MemoryStorage` instead, so nothing of it survives the process.

## Print mode

`src/print.ts` submits one input, watches the root conversation (`root.watch`) and streams the partial assistant
message from `pi.live` to stdout, printing tool lines to stderr when each call finishes. It waits for the submission
to settle and exits 0 when it is `done`, 1 otherwise.
