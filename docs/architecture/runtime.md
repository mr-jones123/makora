# Runtime

How a session is opened and run on Durable. Durable's own documentation: `packages/durable/README.md` and
`packages/durable/docs/spec.md`.

## Opening a session

`openSession` in `src/session.ts`:

1. Take the writer lock (`lockSession`, `src/sessions.ts`).
2. `Harness.open(openNodeSqliteStorage(<dir>/session.sqlite), { models, registry, settings, env, identity, onReport })`.
3. `harness.root(...)` gets or creates the root conversation with the chosen model, thinking level and cwd.
4. `harness.inspect()` finds tasks a previous process left unfinished; the TUI shows them as a restore notice.
5. `harness.resume()` starts the scheduler, which continues those tasks.

Every step after `Harness.open` runs inside a guard that closes the harness and releases the lock when it fails, so a
failed open never leaves a session locked.

| Option | Value |
| --- | --- |
| `models` | `builtinModels({ credentials: authStore })` from pi-ai; in fake mode also the faux provider |
| `registry` | Durable's `CodingTools` (`read`, `write`, `edit`, `bash`) and the `makora` extension |
| `settings` | `retry: { maxRetries: 3 }`, `compaction: { enabled: true }`, `toolExecution: "parallel"` |
| `env` | `({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? sessionCwd })` |
| `identity` | Attribution `makora` |

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
| `preamble` | "You are makora, a coding agent harness for long-running tasks." and the phase 1 tool list |
| `cwd` | The conversation's working directory |
| `context_files` | `~/.makora/AGENTS.md`, then every `AGENTS.md` from the git root down to the cwd |
| `skills` | `<available_skills>` with name, description and path of each model-invocable skill |

Durable stores section changes as transcript entries and only sends what changed, which keeps provider prompt caches
warm.

## Models and settings

- The model of a new session comes from `--model`, else `~/.makora/settings.json`, else the first Anthropic model
  you have auth for, else the first available model. Fake mode always uses the faux model.
- `settings.json` is read through getters with an mtime cache, so `/model`, `/thinking` or an edit in another process
  applies to the next request without a restart.
- Fake mode (`--fake` or `MAKORA_FAKE=1`) registers a scripted faux provider: markdown answers, and one
  `bash -c "echo hello; sleep 2"` call when the prompt mentions "tool". Used for demos, tests and the tmux checks.

## Durability

What Durable guarantees and makora relies on:

- Every change is committed to SQLite before it is shown.
- Model turns and tool calls are tasks with checkpoints. After a crash, a running task returns to pending; a tool that
  is not replay-safe ends as `interrupted` with the output committed so far, and the run continues.
- A task that keeps crashing the process is faulted after `restartLimit` restarts (Durable default 5).
- Submissions with the same `requestId` are not submitted twice.

## Print mode

`src/print.ts` submits one input, watches the root conversation (`root.watch`) and streams the partial assistant
message from `pi.live` to stdout, printing tool lines to stderr when each call finishes. It waits for the submission
to settle and exits 0 when it is `done`, 1 otherwise.
