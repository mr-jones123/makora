# CLI reference

```text
Usage:
  makora                       new session in this directory
  makora --continue            latest session of this directory
  makora --resume [id]         resume a session (pick one when no id)
  makora ls                    list sessions
  makora -p "<prompt>"         print mode: answer one prompt and exit

Options:
  --fake                       scripted fake model (also MAKORA_FAKE=1)
  --ephemeral                  keep the session in memory only
  --model <provider/id>        model for this session
  -h, --help                   show this help
```

| Flag | Short | Notes |
| --- | --- | --- |
| `--continue` | `-c` | Newest session whose directory is the current one. With no such session the TUI starts a new one; print mode exits with an error. |
| `--resume [id]` | `-r` | Without an id the TUI shows a picker. |
| `--print <prompt>` | `-p` | Combine with `-c` or `-r` to continue a session. `-p ""` submits nothing: it replays the transcript, waits for unfinished work, and exits 1 if the last run failed. |
| `--fake` | | Also enabled by `MAKORA_FAKE=1`. Registers the built-in providers too, so `/login` and `/model` still work. Prompt keywords drive REPL cells ([architecture/runtime.md](../architecture/runtime.md#models-and-settings)). |
| `--ephemeral` | | A new session kept in memory: no session directory, no lock, no REPL snapshots, not listed by `ls`. Works in the TUI and in print mode. In the TUI, `/new` opens another ephemeral session and `/resume` opens a stored one. Cannot be combined with `--continue` or `--resume`. |
| `--model <provider/id>` | | For example `--model anthropic/claude-opus-5-5`. Not saved to settings. |

Exit codes: 0 success; 1 for an unanswered print-mode prompt, a locked session, or a startup error; 2 for invalid
arguments (the message and the usage go to stderr), such as `--ephemeral --continue`.

`ls` prints one line per session, newest first: id, last update, directory, title.
