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

For TUI changes, check the real screen in tmux with `--fake` and a temporary `MAKORA_HOME`, at a wide size (140x40), a
narrow one (80x40) and a short one (140x20). Example harnesses from phase 1 are kept locally in `.audit/harness/`
(not committed).

## CI

| Workflow | Runs | On |
| --- | --- | --- |
| `makora.yml` | `npm ci`, model data, makora `check` and tests | PRs and pushes to `main` touching `apps/makora`, `packages`, the lockfile |
| `makora-skills.yml` | `sync-skills --check`; daily `--latest` and a sync PR | See [architecture/skills-pipeline.md](architecture/skills-pipeline.md) |
| `ci.yml` (upstream) | Root build and check | All PRs |

`makora-skills.yml`'s sync job needs the `MAKORA_BOT_TOKEN` secret.

## Changing skills

Never edit `apps/makora/skills/`. Change `apps/makora/skills-src/` (the adapter or an overlay), then run
`node apps/makora/scripts/sync-skills.mjs` and commit the tree and the lock together. When makora gains a tool, update
the adapter's rows in the same PR.

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
  frontmatter, network responses. Trust internal types.
- Stateful logic in typed models (reducers, tagged unions), not scattered flags.
- Key handling only through binding ids.
- Docs change in the same change as the behavior they describe; record decisions in [decisions.md](decisions.md).
