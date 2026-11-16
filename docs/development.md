# Development

How to work on makora in this repository. Repo-wide rules are in `/AGENTS.md` (no `any`, no inline imports, erasable
TypeScript only, no hardcoded key checks, pinned dependencies, never `git add -A`).

## Repository

| Path | What |
| --- | --- |
| `apps/makora/` | The app |
| `docs/` | These docs: the source of truth for makora |
| `packages/*` | Pi's packages; makora uses `durable`, `ai`, `tui`, `chord`, `schema` |
| `apps/p2`, `apps/p2-mac`, `apps/p3` | Upstream prototypes, not used by makora |
| `.github/workflows/makora*.yml` | Makora's CI |

Remotes: `origin` is the fork `github.com/mr-jones123/pi`; `upstream` is `github.com/earendil-works/pi`.

## Running from source

Makora runs TypeScript directly: Node strips types, and `src/source.ts` maps `@earendil-works/*` imports to package
sources through the root `tsconfig.json` paths, so nothing needs building.

```sh
npm install --ignore-scripts && npm run hydrate:model-data   # once
cd apps/makora
npm start -- --fake                                          # or the linked `makora` command
```

The REPL needs [uv](https://docs.astral.sh/uv/), or `python3` (3.11 or newer) with `venv` and `pip`. The first cell
builds `<MAKORA_HOME>/python/venv` with Python 3.12 (uv) and `dill==0.4.1`, which needs network access once. The
Python side is `apps/makora/python/makora_rlm/`; it is put on `PYTHONPATH`, not installed, so edits apply to the next
kernel. Change `src/kernel/protocol.ts` and `python/makora_rlm/protocol.py` together.

## Checks and tests

```sh
cd apps/makora
npm run check                                                            # biome + tsc for makora
node --import ./src/source.ts --test --test-concurrency=1 test/*.test.ts  # all makora tests (npm test does the same)
node --import ./src/source.ts --test test/<file>.test.ts                  # one file
node scripts/sync-skills.mjs --check                                     # generated skills are current
```

The repository's root `npm run check` covers `packages/*` only; run it too after changing a package (for example
`packages/ai`). Tests are `node:test`, behavior-level, with temporary `MAKORA_HOME` directories. Lock tests start real
child processes (`test/fixtures/`).

The REPL tests need uv or Python too, because they build a real environment in their temporary home:

| File | Covers |
| --- | --- |
| `test/kernel.test.ts` | The environment build (two processes at once), the kernel protocol (variables, output, last value, tracebacks, interrupts, timeouts, `os._exit`, host requests), snapshots and restore (shared objects, dropped variables, unchanged blobs), and killing a kernel a crashed process left behind |
| `test/repl-print.test.ts` | The real CLI with `--fake` in a temporary repo: cells across runs, `write`, `read` (whole files and the long-line refusal) and `edit` through Durable, `ctx`, a kernel crash, files changed since the restored cell, `kill -9` of makora mid-cell, `llm` with and without a schema, `"snapshots": false`, both `restarted empty` notices, and `--ephemeral` |
| `test/agents.test.ts` | Subagents with real kernels and a temporary repo: parallel review and write children, merge and conflicts, remove, messages and their limits, `wait_agents`, budgets and depth, the setup command, typing into a finished child, a woken child queued for its slot and stopped past its `minutes`, and removing a write child while its anchor commits |
| `test/agents-crash.test.ts` | A session killed with running children: nothing runs twice, and a deleted review checkout comes back |
| `test/dashboard.test.ts` | The dashboard's rows (sections, indentation, glyphs, budget bars, the running cell) and inspector lines |
| `test/git-writes.test.ts` | The per-repository git write queue across worktrees and repositories, and waiting for a lock another process holds |
| `test/list-window.test.ts` | The dashboard list's window: a list that fits, the selection at the top, middle and bottom, section titles, scrolling up and down, a resize, and a screen too short for the markers |
| `test/quiz.test.ts` | `/quiz` with the fake model and a real kernel in a temporary repo: the saved page's questions and diffs, the opener called once, the notice, a bad bank's errors back in the cell, and the ranges `/quiz` asks for. `test/quiz-bank.test.ts` and `test/quiz-page.test.ts` need no kernel ([architecture/quiz.md](architecture/quiz.md#tests)) |
| `test/session-delete.test.ts` | `makora rm` on a session with a fork, a reviewer and two writers (one branch with work, one empty), after a cleaned temp folder took the review checkout, and the same cleanup when an ephemeral session closes |

For TUI changes, check the real screen in tmux with `--fake` and a temporary `MAKORA_HOME`, at a wide size (140x40), a
narrow one (80x40) and a short one (140x20). Example harnesses from phase 1 are kept locally in `.audit/harness/`
(not committed). `apps/makora/scripts/tmux-agents.sh`, `apps/makora/scripts/tmux-dashboard.sh` and `scripts/tmux-dashboard-scroll.sh` (40 agents, the list scrolled at 140x40 and 90x40) drive subagents and
the agents dashboard end to end in a temporary repository; each saves its screens under `/tmp/makora-agents/` or
`/tmp/makora-dashboard/` and exits non-zero when a wait times out.

## CI

| Workflow | Runs | On |
| --- | --- | --- |
| `makora.yml` | Node 22 and Python 3.12 (`actions/setup-python`, pinned by commit), `npm ci`, model data, makora `check` and tests | PRs and pushes to `main` touching `apps/makora`, `packages`, the lockfile |
| `makora-skills.yml` | `sync-skills --check`; daily `--latest` and a sync PR | See [architecture/skills-pipeline.md](architecture/skills-pipeline.md) |
| `ci.yml` (upstream) | Root build and check | All PRs |

`makora-skills.yml`'s sync job needs the `MAKORA_BOT_TOKEN` secret.

## Changing skills

Never edit `apps/makora/skills/`. Change `apps/makora/skills-src/` (the adapter or an overlay), then run
`node apps/makora/scripts/sync-skills.mjs` and commit the tree and the lock together. When makora gains a tool or a
REPL helper, update the adapter's rows in the same PR.

## Pulling from upstream Pi

```sh
git fetch upstream
git merge upstream/main
```

Then run makora's check and tests. Durable is experimental upstream and its API can change; makora's CI runs on
changes under `packages/` to catch that. Keep makora's edits to shared packages few and small (currently two lines of
behavior in `packages/ai` and one path in `scripts/check-pinned-deps.mjs`), so merges stay easy.

## Conventions for makora code

- One concept per file, a first-line comment saying what it is for, exported functions documented.
- Validate only at trust boundaries: `auth.json`, `settings.json`, `keybindings.json`, `meta.json`, SKILL.md
  frontmatter, network responses, a kernel's tool arguments and `llm` schemas, stored `python` result details. Trust
  internal types.
- Stateful logic in typed models (reducers, tagged unions), not scattered flags.
- Key handling only through binding ids.
- Docs change in the same change as the behavior they describe; record decisions in [decisions.md](decisions.md).
