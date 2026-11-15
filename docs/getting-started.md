# Getting started

## Install the command

Makora runs from this repository's sources; nothing is built or published yet.

```sh
cd ~/Programming/Self-Projects/makora
npm install --ignore-scripts      # once, and after dependency changes
npm run hydrate:model-data        # once: the model catalog pi-ai reads
ln -s "$PWD/apps/makora/bin/makora.mjs" ~/.local/bin/makora
```

`~/.local/bin` must be on your `PATH`. The link points at the repository, so code changes apply on the next run
without reinstalling. Requires Node 22.19 or newer.

## First run

```sh
cd ~/some/project
makora
```

1. The splash shows while the session is empty.
2. Type `/login`, choose Anthropic, then Claude Pro/Max, and finish in the browser (or paste the code back).
3. Type `/model` and pick a model.
4. Check the status row: the account label should read your email, `subscription · extra usage`, and a plan usage
   window such as `5h 42%` when Anthropic answers the usage request.

Without logging in, `makora --fake` runs a scripted fake model: it answers in markdown, and a prompt with a keyword such
as `python`, `remember`, `file` or `crash` makes it run scripted Python cells (all keywords:
[architecture/runtime.md](architecture/runtime.md#models-and-settings)). Tools still act on real files.

The model works through a Python REPL ([features/repl.md](features/repl.md)). Its first cell builds makora's Python
environment, which needs [uv](https://docs.astral.sh/uv/), or `python3` 3.11 or newer with `venv` and `pip`.

## Daily use

| Command | What it does |
| --- | --- |
| `makora` | New session in the current directory |
| `makora --continue` | Latest session of the current directory |
| `makora --resume` | Pick a session |
| `makora ls` | List sessions |
| `makora -p "explain this repo"` | Print mode: answer on stdout, no TUI |
| `makora --ephemeral` | A session kept in memory only: nothing saved, nothing to resume |

In the TUI: Esc stops a run, Ctrl+C stops a run or clears the editor (twice on an empty editor exits), Ctrl+O expands
tool output, Ctrl+A opens the agents view, Ctrl+G opens the diff view, Ctrl+L picks a model, `/` lists commands. Full
list: [features/tui.md](features/tui.md).

## Where things live

Everything makora stores is under `~/.makora` (set `MAKORA_HOME` to use another directory, for example to try
makora without touching your real sessions). See [reference/configuration.md](reference/configuration.md).

## Optional: no-mistakes

The bundled `no-mistakes` skill drives the `no-mistakes` binary, which is installed separately
(`curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh`). Running
`no-mistakes init` also writes a skill matching your binary into `~/.agents/skills`, which makora then
prefers over its bundled copy ([features/skills.md](features/skills.md)).
