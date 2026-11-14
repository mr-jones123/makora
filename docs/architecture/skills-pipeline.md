# Skills pipeline

How the bundled skills are generated, checked and kept current. What the user sees:
[features/skills.md](../features/skills.md). The mechanism follows `mr-jones123/pstack-harness` (`build.mjs`) and raga's
`raga-sync-skills.mjs`.

## Inputs and outputs

| Path | What |
| --- | --- |
| `apps/makora/skills.lock.json` | Pinned sources (`cursor/plugins` commit and pstack version, `no-mistakes` tag and commit) and the sha256 of every source file read and every file generated |
| `apps/makora/skills-src/` | Hand-written overlays: `makora-adapter/SKILL.md`, `create-skill/SKILL.md` |
| `apps/makora/scripts/sync-skills.mjs` | The generator (Node built-ins and `git` only) |
| `apps/makora/skills/` | The generated tree: 63 skills and `LICENSES/{pstack,cursor-team-kit,no-mistakes}` |
| `node_modules/.cache/makora-skills/` | Upstream checkouts, reset before every build |

## What a build does

1. Check out each upstream at its pinned commit (fetching only a missing commit) and reset the worktree.
2. Map upstream files to output paths: every pstack skill except `make-bot-ui`, the four cursor-team-kit companions,
   no-mistakes' `SKILL.md`, the licenses. Refuse symlinks.
3. Verify every source file against its recorded sha256; refuse files that are recorded but not read, or read but not
   recorded.
4. Remove Cursor-only text (Automations, cloud agents, Custom Modes, Bugbot start/wait/configure, `cursor.com`):
   prose paragraphs and code fences whole, list items and table rows one by one.
5. Lay the overlays on top; an overlay may not overwrite an upstream file.
6. Validate each skill: `name` equals its folder, kebab-case, at most 64 characters, a description.
7. Read upstream's own term list (`TERMS`, `ROUTE_KEY` in `scripts/generate-pstack-harness-trees.mjs`) by regex,
   never by executing it, and add makora's extra terms. Fail when a skill uses a term the adapter has no row for.
8. Insert the adapter pointer line into each pstack skill that uses a term; embed the adapter in `poteto-mode`; add
   the bash pointer line to no-mistakes.
9. Guard `poteto-mode/scripts/worktree-audit.sh` (it reads Cursor transcripts) to print a message and exit 2.
10. Rewrite links: relative when the target ships, a GitHub URL at the pinned commit otherwise; fail on dangling links.

## Modes

| Command | Does |
| --- | --- |
| `node apps/makora/scripts/sync-skills.mjs` | Build from the pins; write the tree and the lock |
| `… --check` | Build in memory and compare byte for byte (and the executable bit) with disk; exit 1 naming drifted files |
| `… --latest` | Repin `cursor/plugins` to `main` only when a tracked path changed (`pstack`, `cursor-team-kit`, the term generator); repin no-mistakes to its latest release tag; then build |

## CI

`.github/workflows/makora-skills.yml`:

- **check** (pull requests and pushes to `main` touching `apps/makora/**`): `--check`.
- **sync** (daily at 05:23 UTC and manual dispatch): `--latest`, then `--check`; if anything changed, commit to
  `bot/sync-skills` and open or update a PR. It uses the secret `MAKORA_BOT_TOKEN` (a PAT or GitHub App token with
  contents and pull-requests write), because PRs opened with `GITHUB_TOKEN` do not trigger CI; without the secret the
  job fails with a clear error.
- Actions pinned by SHA; `permissions: {}` at the top, `contents: read` per job.

A failed sync (usually a new upstream term) emails the repository owner. The fix is a new row in
`skills-src/makora-adapter/SKILL.md`, then a rebuild.

## Interaction with the repo checks

`scripts/check-pinned-deps.mjs` skips `apps/makora/skills`: upstream ships tooling manifests with version ranges
(`poteto-mode/scripts/package.json`) that its scripts need. `apps/makora/biome.json` excludes `skills/`, `skills-src/`
and `skills.lock.json`, which the generator formats.
