# Sessions

A session is one durable conversation history in one directory. Every `makora` run opens one. Internals:
[architecture/runtime.md](../architecture/runtime.md).

## What a session holds

`~/.makora/sessions/<id>/`:

| File | What |
| --- | --- |
| `session.sqlite` | Durable's storage: the transcript, model turns, tool calls, tasks, documents, usage |
| `meta.json` | `{ id, cwd, title, createdAt, updatedAt, model }`, read by the session list |
| `lock.sqlite`, `lock.pid` | The writer lock and the pid of its holder |

IDs are time-sortable (UUIDv7). The title is the first line of the first prompt.

## Opening sessions

| Command | Opens |
| --- | --- |
| `makora` | A new session in the current directory |
| `makora --continue` (`-c`) | The newest session whose directory is the current one; a new one when there is none |
| `makora --resume [id]` (`-r`) | The given session, or a picker |
| `makora ls` | Nothing: prints the sessions, newest first |
| `/new`, `/resume` | The same from inside the TUI |

## Crash recovery

Durable commits every change before it is shown, so a crash loses nothing that was on screen. When a session opens,
makora resumes whatever was unfinished:

- A model request that was streaming is retried.
- A tool call that was running is reported to the model as interrupted ("may have partially run"), and the run
  continues from there.
- The TUI shows `⚠ Restored the session; resuming N unfinished task(s).`

Verified: `kill -9` during a `bash` call, then `makora --continue`, finishes the run.

## One writer per session

Only one makora process may write a session. The lock is an exclusive SQLite lock on `lock.sqlite`; the operating
system releases it when the process exits, including on `kill -9`, so there are no stale locks and no problems with
reused process ids. A second process gets:

```text
makora: Session <id> is open in another makora process (pid N). Close it there first.
```

## Print mode

`makora -p "<prompt>"` runs one prompt without the TUI:

- The answer streams to stdout; one line per finished tool call goes to stderr.
- Exit code 0 when the prompt was answered, 1 when it was not (the reason goes to stderr).
- Combine with `--continue` or `--resume` to add to an existing session. `-p ""` submits nothing: it replays the
  transcript, waits for unfinished work to finish, and exits.

## Compaction

Automatic compaction is on: when the context fills up, Durable summarizes older turns. `/compact [instructions]`
compacts now. The activity row shows the compaction state.

## Limits in phase 1

- The TUI and the session run in one process; closing the terminal ends the run. The background service comes in
  phase 4.
- Tools run locally with your permissions (no sandbox).
