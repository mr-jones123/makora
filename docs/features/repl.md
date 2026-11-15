# The Python REPL

The model works through one tool, `python`: a persistent Python REPL that runs in the session's directory. Variables,
functions and imports stay between cells, so the model can load a large file once, keep it in a variable, and print
only what it needs. File and shell work happens from Python, through helpers that makora records like any other tool
call. Internals: [architecture/repl.md](../architecture/repl.md).

## Requirements

The first cell builds makora's Python environment at `~/.makora/python/venv` (under `MAKORA_HOME` when set): a Python
3.12 environment made with [uv](https://docs.astral.sh/uv/), with dill installed. Without uv, makora falls back to
`python3 -m venv` and pip, which needs Python 3.11 or newer. Both paths download dill once, so the first cell needs
network access. When neither works, the cell fails and says to install uv.

## Helpers in every cell

Every cell starts with these names defined. The async ones need `await`; top-level `await` works in a cell.

| Helper | Does |
| --- | --- |
| `await read(path, offset=None, limit=None)` | Without `offset` and `limit`, returns the whole file. A line over 51,200 bytes raises `HostError`. With them, returns one page: `offset` is the first line (1-based), `limit` the number of lines, cut at Durable's `read` limits |
| `await write(path, content)` | Writes the file |
| `await edit(path, [{"oldText": ..., "newText": ...}])` | Replaces each `oldText` with its `newText` |
| `await edit(path, old, new)` | The same for one replacement |
| `await bash(command, timeout=None)` | Runs a shell command; `timeout` in seconds. Returns a `BashResult` with `.output`, `.exit_code`, `.truncated` and `.full_output_path`. `print()` shows the output, and `[exit code N]` when it is not 0 |
| `await llm(prompt, schema=None, model=None, timeout=300)` | One model call without tools, with the conversation's model unless `model` (`"provider/modelId"`) says otherwise. Returns the text. With `schema` (a JSON Schema, or a pydantic model class), returns the parsed JSON value after checking it against the schema |
| `ctx.input()` | The latest user message's text |
| `await ctx.transcript(limit=20)` | The newest `limit` transcript messages, oldest first, as dicts with `id`, `kind`, `role` and `text`. Tool results add `toolName` and `isError`, and assistant messages add `toolCalls` |

A failed call raises `HostError`. A `bash` command that exits with a non-zero code does not raise: check
`.exit_code`.

```python
src = await read("src/session.ts")
calls = [line for line in src.splitlines() if "await " in line]
print(len(calls), "awaits")
result = await bash("npm test -- --test-name-pattern session")
print(result.exit_code, result.output[-2000:])
```

What the model sees of a cell is its printed output (the last 16,000 characters) and the `repr` of the cell's final
expression, shown as `Out: ...`. A cell stops after 600 s unless the model passes another `timeout`. Esc interrupts
the running cell. `sys.exit()` ends the cell, not the REPL.

## Cells in the TUI

Each cell is one line in the transcript, numbered per conversation:

```text
✓ python · cell 3 · print(await bash("echo hello; sleep 2")) · 2.3s
```

The line shows the first non-empty line of the code. While the cell runs, the marker is a spinner and the time
counts up. `✗` marks a cell that ended with an error, an interrupt, or a dead kernel.

Ctrl+O expands every cell: the code under `│`, the last 20 lines of output under `┆`, and one `↳` line for each call
the cell made, each with its own marker and duration:

```text
✓ python · cell 3 · print(await bash("echo hello; sleep 2")) · 2.3s
  │ print(await bash("echo hello; sleep 2"))
  ┆ hello
  ↳ ✓ bash · echo hello; sleep 2 · 2.1s
```

A nested call shows its own spinner while it runs. Print mode (`makora -p`) prints one summary line per finished cell
to stderr.

The activity row shows the root conversation's kernel once a cell has started one:

| Label | Means |
| --- | --- |
| `py starting` | The kernel is starting (the first cell also builds the environment) |
| `py running 3 vars @ cell 7 45 MB` | Running; the last snapshot after cell 7 holds 3 variables; the kernel's peak memory is 45 MB |
| `py restored 3 vars @ cell 7 45 MB` | Started again with variables restored from cell 7; becomes `running` after the next cell |
| `py dead (exit 1)` | The kernel exited; shown as a warning. The next cell starts a new one |

With snapshots off, the label has no `@ cell N` and the variable count stays at 0.

## What survives a crash

After each cell, makora saves the variables that can be pickled and a git tree of the worktree, then commits the
cell's result. The next kernel restores the newest saved cell. This happens when the kernel dies (out of memory,
`os._exit`, a native crash, a cell that ignores interrupts) and after makora itself is killed and the session is
opened again with `makora --continue`.

The restoring cell's output starts with a notice, which the model reads:

```text
Kernel restarted. Variables restored to after cell 2: x.
Files changed since cell 2 (not restored): notes.md
Dropped: conn (unpicklable), big (over cap)
Failed: model (blob missing (pruned or never written))
```

- **Restored** names hold the values they had after that cell.
- **Files changed** lists files that differ from the worktree as it was after that cell. makora does not change
  files back.
- **Dropped** variables could not be saved: values that cannot be pickled, such as open connections and sockets, and
  values whose pickle exceeds 64 MiB.
- **Failed** variables were saved but would not load.
- Modules come back by replaying their `import` statements.

The cell that was running when the kernel died is lost and is not run again. Its result says
`kernel died (exit 1) during cell 3`. A cell that was running when makora was killed ends as interrupted. Processes the
cells started are killed with the kernel and are not restarted.

## Turning durability off

Snapshots are on by default. Two ways turn them off:

- `"snapshots": false` in `~/.makora/settings.json`. Sessions are still saved, but variables are not. The setting is
  read at every cell. After a kernel restart, the cell says `Kernel restarted empty: variables of earlier cells were
  lost (snapshots are off).` With snapshots on, but no earlier cell that saved any, it says `Kernel restarted empty:
  no earlier cell saved a snapshot, so their variables were lost.`
- `makora --ephemeral`. The whole session lives in memory: no session directory, no snapshots, nothing to continue
  later. See [sessions.md](sessions.md#ephemeral-sessions).

Snapshots cost time after every cell: about 20 ms for a list of a million ints (5 MB pickled) and 260 ms for ten
million (50 MB), measured on an M-series Mac ([architecture/repl.md](../architecture/repl.md#snapshots)). An unchanged
variable is pickled again to check it.

## Not yet

Subagents (`spawn`, `wait_agents`) come in phase 3 ([roadmap.md](../roadmap.md)). Old blobs are never pruned yet.
A fork (`/fork`) restores the variables and files of its fork point ([sessions.md](sessions.md#forks)).
