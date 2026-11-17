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

Remotes: `origin` is the fork `github.com/mr-jones123/makora`; `upstream` is `github.com/earendil-works/pi`.

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

`test/install-sh.test.ts` runs `install.sh` with a temporary `HOME` against a fake GitHub on `127.0.0.1` serving fake
release tarballs: a fresh install, the same version, upgrades and pruning, `--version`, a checksum mismatch and a
release that does not start (both leave the installed version working), `--uninstall`, a `PATH` without node, and the
PATH line. `test/version.test.ts` checks `--version` and `update` from the source checkout. Both need `curl` or `wget`,
`tar` and `shasum` or `sha256sum`, and no network. `test/release-commits.test.ts` and `test/release-plan.test.ts`
cover the commit parser, the bump, the changelog and the pending release; `test/release-repo.test.ts` runs the plan
and `commit-lint.mjs` in a temporary git repository with a tag, a merged branch carrying a non-conventional commit,
and a commit only in another app.

## Releases

```sh
cd apps/makora
npm run build:release -- --version 0.2.0   # without --version: the version in package.json
```

`scripts/build-release.mjs` needs the model data (`npm run hydrate:model-data`), and writes to `dist/release/`:

| Output | What |
| --- | --- |
| `makora-<version>/makora.mjs` | One ES module bundle (esbuild, the root devDependency, target from `engines`) of `src/main.ts` with every `@earendil-works/*` import taken from `packages/*/src` through the root `tsconfig.json` paths, the aliases `src/source-resolver.ts` uses. The build fails if anything comes from a package's `dist/` or an npm copy of a workspace package. Only Node built-ins stay external |
| `makora-<version>/bin/makora` | The `sh` launcher `install.sh` links; it follows links to its release folder and runs `node makora.mjs` |
| `makora-<version>/{assets,skills,python/makora_rlm,native}` | What makora reads at runtime, in the same layout as `apps/makora`; `native/` holds pi-tui's optional macOS and Linux helpers |
| `makora-<version>/install.sh` | The installer, which `makora update` runs |
| `makora-<version>/package.json` | Name, version, `type: module`, `engines`, `bin`; no dependencies |
| `makora-<version>/{LICENSE,NOTICE}` | pi's MIT license; the bundled skills' sources and licenses, and every bundled npm package with its license text |
| `makora-<version>/BUILD` | `{"commit", "date"}`: the commit, with `-dirty` when `apps/makora` or `packages/` had uncommitted changes, and the build time |
| `makora-<version>.tar.gz`, `.sha256` | The release assets, one for every platform |

`src/install.ts` finds makora's own files from the directory holding its `package.json`: `apps/makora` from source,
the release folder in a release. A `BUILD` file there marks a release. Every reader of a bundled file goes through it.

`install.sh` reads releases from `https://api.github.com`; `MAKORA_RELEASE_BASE` replaces that base URL, which is how
the tests and a local check serve releases from `127.0.0.1`. To check a build by hand, copy the release folder to a
temporary directory away from the repository and run `bin/makora --version` and `bin/makora --fake -p python` with a
temporary `MAKORA_HOME`.

### Versions and the release PR

Nobody picks version numbers. `scripts/release-plan.mjs` reads the commits since the last `makora-v*` tag (the
repository also holds upstream pi's `v*` tags, which it ignores), including the ones merges brought in, and keeps those
that change a file under `scripts/release/repo.ts`'s shipped paths: `apps/makora/` and every workspace package makora
depends on, transitively, through its `package.json` (today `packages/ai`, `chord`, `codemode`, `durable`, `schema`,
`telemetry` and `tui`). The release build fails if the bundle reaches a package outside that list. Among those commits
`fix` and `revert` bump patch, `feat` minor, `!` or a `BREAKING CHANGE:` footer major (minor while below 1.0), and the
other types nothing; the highest wins. A `fix(ai):` merged from upstream pi is a patch; a commit only in another app
is nothing. Before the first tag, the plan starts at the fork point from upstream pi and proposes 0.1.0.

```sh
node apps/makora/scripts/release-plan.mjs             # the plan: { current, next, bump, commits, changelog }
node apps/makora/scripts/release-plan.mjs --write     # what the release PR commits: the version and CHANGELOG.md
node apps/makora/scripts/release-plan.mjs --pending   # the release a merged release PR asks for, or null
```

`makora-release.yml` runs on every push to `main`, one run at a time:

1. **Plan.** Nothing to release and nothing pending: it stops.
2. **Release PR.** Unreleased changes: it force-pushes `release/makora` as `main` plus one commit
   `chore(release): makora X.Y.Z` (the version in `apps/makora/package.json` and `package-lock.json`, the new section on
   top of `apps/makora/CHANGELOG.md`) and opens or updates that PR, with the section as its description. Every push to
   `main` regenerates it, so it always lists everything unreleased.
3. **Release.** When `package.json`'s version is newer than every tag and `CHANGELOG.md` has its section, which only
   the merged release PR brings, it runs `npm ci --ignore-scripts`, the model data, makora's check and tests,
   `build:release`, and `bin/makora --version` (which must print this commit, not `-dirty`). Then it tags
   `makora-vX.Y.Z` at the commit and publishes the GitHub release with the tarball, the `.sha256` and the section as
   notes. A rerun keeps a tag already at that commit (and fails on one elsewhere) and replaces an existing release's
   files and notes, so it never tags twice or makes a second release.

To cut a release, merge the release PR. To release more, keep merging to `main`; the PR follows. `CHANGELOG.md` is
generated: change a release's text by rewording commits before the release PR merges, not by editing the file.

Tokens and settings, once per repository:

- The secret `MAKORA_BOT_TOKEN`, a fine-grained PAT or a GitHub App token with contents and pull-requests write on this
  repository, which the skills sync uses too. GitHub runs no workflows for a PR pushed with `GITHUB_TOKEN`, so without
  it the release PR gets no CI: the workflow falls back to `GITHUB_TOKEN` and warns.
- For that fallback, Settings → Actions → General → Workflow permissions: "Allow GitHub Actions to create and approve
  pull requests".
- Tagging and publishing use the workflow's own `GITHUB_TOKEN` with `contents: write`. If a ruleset protects tags,
  it must let GitHub Actions create `makora-v*`.

### Commit messages

The `commit-messages` workflow checks every PR and every push to `main` with `scripts/commit-lint.mjs`: each
first-parent commit in the range must read `type(scope)!: subject` with one of the types in `/AGENTS.md`. Merge commits
and the commits a merge brings in through its second parent are skipped, so merging upstream pi never fails on its
history. A failure lists each bad commit's short sha and subject. Locally, `.husky/commit-msg` runs the same check when
husky's hooks are installed (`npx husky`, since `npm install --ignore-scripts` skips it). The check and the release plan
share one parser, `scripts/release/commits.ts`.

## CI

| Workflow | Runs | On |
| --- | --- | --- |
| `makora.yml` | Node 22 and Python 3.12 (`actions/setup-python`, pinned by commit), `npm ci`, model data, makora `check` and tests | PRs and pushes to `main` touching `apps/makora`, `packages`, the lockfile |
| `makora-release.yml` | The release plan; the release PR, or the check, tests, build, tag and GitHub release of a merged one | Pushes to `main` |
| `commit-messages.yml` | `commit-lint.mjs` on the first-parent commits of the PR or the push | All PRs and pushes to `main` |
| `makora-skills.yml` | `sync-skills --check`; daily `--latest` and a sync PR | See [architecture/skills-pipeline.md](architecture/skills-pipeline.md) |
| `ci.yml` (upstream) | Root build and check | All PRs |

`makora-skills.yml`'s sync job needs the `MAKORA_BOT_TOKEN` secret; `makora-release.yml` uses it when set.

## Changing skills

Never edit `apps/makora/skills/`. Change `apps/makora/skills-src/` (the adapter or an overlay), then run
`node apps/makora/scripts/sync-skills.mjs` and commit the tree and the lock together. When makora gains a tool or a
REPL helper, update the adapter's rows in the same PR.

## Bringing in changes from pi

makora is a standalone repository (`github.com/mr-jones123/makora`), no longer a GitHub fork of `earendil-works/pi`,
and the checkout has no `upstream` remote. To take a fix from pi, fetch it explicitly and cherry-pick or merge it:

```sh
git fetch https://github.com/earendil-works/pi.git main
git cherry-pick -x <sha>        # one fix
git merge FETCH_HEAD            # everything
```

Then run makora's check and tests. Durable is experimental upstream and its API can change; makora's CI runs on
changes under `packages/` to catch that. Keep makora's edits to shared packages few and small, so merges stay easy.

## Conventions for makora code

- One concept per file, a first-line comment saying what it is for, exported functions documented.
- Validate only at trust boundaries: `auth.json`, `settings.json`, `keybindings.json`, `meta.json`, SKILL.md
  frontmatter, network responses, a kernel's tool arguments and `llm` schemas, stored `python` result details. Trust
  internal types.
- Stateful logic in typed models (reducers, tagged unions), not scattered flags.
- Key handling only through binding ids.
- Docs change in the same change as the behavior they describe; record decisions in [decisions.md](decisions.md).
