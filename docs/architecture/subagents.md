# Subagents in worktrees (phase 3, planned)

> **Status: designed, not built.** Depends on the REPL's `spawn()` ([repl.md](repl.md)).

- `spawn(..., worktree=True)` creates `.makora/worktrees/<name>` on branch `makora/<name>` and points the child's
  environment there. The child returns a summary plus its branch and diff; the parent merges explicitly, and conflicts
  come back as data. The anchor task's abort handler removes the worktree.
- Read-only children share the parent's tree.
- Every child has a budget: turns, tokens, cost, wall time, and a depth limit.
- Everything runs locally with the user's permissions. Sandboxed environments are deferred (see
  [decisions.md](../decisions.md)); Durable's `env` function is where they will plug in.

## How a child runs

1. `spawn(name, task, worktree=True)` in a REPL cell calls the `spawn` tool through Durable, with the name as its key.
2. The tool creates a background anchor task owned by the conversation (pattern:
   `packages/durable/test/examples/22-subagent-background.ts`), and under it a child conversation configured with its
   own `cwd` (the worktree), model, tools and turn limit.
3. The child runs in its own Durable tasks. A crash of the parent's cell does not touch it; `spawn(name)` again
   reattaches.
4. The model waits with `wait_agents`, which parks without holding a process, and reads results with `collect()`.
5. The parent merges the child's branch explicitly; conflicts come back as data. The anchor's abort handler removes
   the worktree.

The TUI's agents view already lists conversations from the task graph generically, so children appear there without
TUI changes.
