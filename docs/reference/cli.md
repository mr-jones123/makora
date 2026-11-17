# CLI reference

```text
Usage:
  makora                       new session in this directory
  makora --continue            latest session of this directory
  makora --resume [id]         resume a session (pick one when no id)
  makora ls                    list sessions
  makora rm <id>               delete a session, its worktrees, and its branches without work
  makora -p "<prompt>"         print mode: answer one prompt and exit
  makora update                update to the latest release
  makora setup                 build the Python environment REPL cells run in
  makora dream                 turn this project's recent sessions into memory, in the background
  makora dream status [id]     show the newest dream, or dream <id>
  makora dream cancel [id]     stop the newest dream, or dream <id>
  makora wiki-setup <vault> [folder]
                               render memory into <vault>/<folder> (default makora); a new path becomes a vault
  makora wiki                  render memory into the vault again

Options:
  --fake                       scripted fake model (also MAKORA_FAKE=1)
  --ephemeral                  keep the session in memory only
  --model <provider/id>        model for this session
  -v, --version                show the version
  -h, --help                   show this help
```

| Flag | Short | Notes |
| --- | --- | --- |
| `--continue` | `-c` | Newest session whose directory is the current one. With no such session the TUI starts a new one; print mode exits with an error. |
| `--resume [id]` | `-r` | Without an id the TUI shows a picker. |
| `--print <prompt>` | `-p` | Combine with `-c` or `-r` to continue a session. `-p ""` submits nothing: it replays the transcript, waits for unfinished work, and exits 1 if the last run failed. |
| `--fake` | | Also enabled by `MAKORA_FAKE=1`. Registers the built-in providers too, so `/login` and `/model` still work. Prompt keywords drive REPL cells ([architecture/runtime.md](../architecture/runtime.md#models-and-settings)). |
| `--ephemeral` | | A new session kept in memory: no session directory, no lock, no REPL snapshots, not listed by `ls`. Works in the TUI and in print mode. In the TUI, `/new` opens another ephemeral session and `/resume` opens a stored one. When it ends, its worktrees and its write branches without work are removed, as `rm` does. Cannot be combined with `--continue` or `--resume`. |
| `--model <provider/id>` | | For example `--model anthropic/claude-opus-5-5`. Not saved to settings. |
| `--version` | `-v` | An installed release prints `makora <version> (<commit>)`, the commit it was built from; a commit ending in `-dirty` was built with uncommitted changes. A source checkout prints `makora <package version>+dev`. |

Exit codes: 0 success; 1 for an unanswered print-mode prompt, a locked session, a declined `rm`, or a startup error; 2
for invalid arguments (the message and the usage go to stderr), such as `--ephemeral --continue`.

`ls` prints one line per session, newest first: id, last update, directory, title.

`dream` starts a dream for the project of the current directory and exits; a detached `makora dream-worker <id>`
process runs it, logging to `~/.makora/memory/dreams/<id>.log`. `dream`, `wiki` and `wiki-setup` take `--fake` like a
run. See [features/memory.md](../features/memory.md).

`rm <id>` lists what deleting the session removes (its worktrees, the write branches without work, its refs and its
directory) and which branches it keeps, then deletes it only after `y` or `yes` on stdin. See
[features/sessions.md](../features/sessions.md#deleting-a-session).

`update` runs the `install.sh` the installed release ships against the directory it is installed in, so it installs
the newest `makora-v*` release and prints `makora 0.1.0 → 0.2.0`, or `makora 0.2.0 is already installed (up to date)`.
Its exit code is the installer's. From a source checkout, or from a release folder that `install.sh` did not install,
it exits 1 and says why: update a checkout with `git pull`. `/update` in the TUI does the same and shows the
installer's output; the running session keeps its version until makora restarts.

`setup` builds the Python environment kernels run in (`<MAKORA_HOME>/python/venv`), as the first REPL cell otherwise
would. `install.sh` runs it after each install. Exit 1 when the environment cannot be built.
