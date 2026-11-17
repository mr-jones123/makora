# makora

A durable, self-evolving agent harness for long-running tasks.

makora runs an agent whose one tool is a persistent Python REPL. Every step is committed by
[pi-durable](packages/durable) before it is shown, so a crash, a `kill -9` or a reboot resumes the session where it
stopped, with the REPL's variables and files restored. The agent can start subagents for tasks and code review, each in
its own git worktree with its own REPL and budget. The long-term goal is a harness that improves its own prompts, skills
and extensions while it works, keeping only changes that pass an evaluation (see [docs/vision.md](docs/vision.md)).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mr-jones123/makora/main/apps/makora/install.sh | sh
```

The installer downloads the newest `makora-v*` release, checks its sha256, and links `~/.local/bin/makora`. It needs
Node 22.19+ and [uv](https://docs.astral.sh/uv/) (or Python 3.11+). `makora update` updates it;
`sh -s -- --uninstall` removes it and keeps your sessions and settings in `~/.makora`.

```sh
makora                  # new session in the current directory
makora --continue       # latest session of this directory
makora -p "<prompt>"    # print mode
```

Then `/login` to connect a provider. Details: [getting started](docs/getting-started.md).

## What it does

| Feature | What you get |
| --- | --- |
| Durable sessions | SQLite sessions that resume after any crash; one writer per session; `--ephemeral` for none. [sessions](docs/features/sessions.md) |
| Python REPL | The model works in a persistent kernel: `read`, `write`, `edit`, `bash`, `llm` from cells; variables and a git tree saved after each cell. [repl](docs/features/repl.md) |
| Subagents | `spawn(name, task, mode="write" \| "review")`: own worktree, REPL and budget; messaging; `wait_agents`; work returns only through `merge`. [subagents](docs/features/subagents.md) |
| Agents dashboard | Ctrl+A: every agent's state, budget, cells, messages and changes; open, diff, merge, stop, remove. [tui](docs/features/tui.md) |
| `/fork` and `/diff` | Fork a conversation at an earlier point, with that point's variables and files; review changes by tab. [diff](docs/features/diff.md) |
| `/quiz` | A self-scoring HTML quiz on what a session built and decided, with annotated diffs. [quiz](docs/features/quiz.md) |
| Skills | pstack and no-mistakes bundled; `/pstack` picks the code and judge models. [skills](docs/features/skills.md) |
| Accounts | Several provider logins, including Claude Pro/Max, switched with `/accounts`. [accounts](docs/features/accounts.md) |

## Docs

[docs/](docs/README.md) is the source of truth: [vision](docs/vision.md), [roadmap](docs/roadmap.md),
[architecture](docs/architecture/overview.md), [CLI](docs/reference/cli.md),
[configuration](docs/reference/configuration.md) and every [decision](docs/decisions.md) with its reason.

## Develop

```sh
npm install --ignore-scripts
npm run hydrate:model-data
cd apps/makora
npm start               # the TUI from source
npm run check           # lint and types
```

Tests, releases and CI: [docs/development.md](docs/development.md). Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/); `fix` and `feat` on makora's code drive its version
through a release PR.

## Built on pi

This repository is a fork of [earendil-works/pi](https://github.com/earendil-works/pi). makora lives in
[`apps/makora`](apps/makora) and uses pi's packages from this repository: [`packages/durable`](packages/durable)
(sessions and tasks), [`packages/ai`](packages/ai) (providers and login), [`packages/tui`](packages/tui),
[`packages/chord`](packages/chord) and [`packages/schema`](packages/schema). Releases bundle makora with these
packages as they are in this fork, so changes made here ship with it. Upstream pi is merged in from the `upstream`
remote; pi's own README and docs are in [`packages/coding-agent`](packages/coding-agent).

## Credits

makora's design draws on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by
[Prime Intellect](https://primeintellect.ai) (MIT): a self-improving RLM harness whose agent works in a persistent
Python REPL. The REPL-first agent, the self-improving harness as a goal, and the subagent messaging rules and limits
follow Prime Agent; makora's differences (Durable sessions, per-cell snapshots, worktree subagents, evaluated
self-evolution) are explained in [docs/vision.md](docs/vision.md) and [docs/decisions.md](docs/decisions.md).

The runtime, providers and TUI come from [pi](https://github.com/earendil-works/pi) by Mario Zechner and
contributors (MIT).

## License

MIT, as pi: see [LICENSE](LICENSE). Bundled skills keep their own licenses, listed in each release's `NOTICE`.
