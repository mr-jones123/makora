# Skills

Skills are folders with a `SKILL.md`: a name, a description, and instructions. The model sees the names and
descriptions of model-invocable skills and reads a skill's file when a task matches. You run any skill with
`/skill:<name> [args]`. Pipeline internals: [architecture/skills-pipeline.md](../architecture/skills-pipeline.md).

## Bundled skills

Makora ships 63 skills in `apps/makora/skills`, generated from pinned upstream sources:

| Group | Skills | Source |
| --- | --- | --- |
| pstack | `poteto-mode` and its playbooks, `how`, `why`, `interrogate`, `swarm`, `arena`, `architect`, `figure-it-out`, `show-me-your-work`, `teach`, `technical-writing`, … and 24 `principle-*` skills | `cursor/plugins` (pstack) |
| Companions | `deslop`, `control-cli`, `control-ui`, `verify-this` | `cursor/plugins` (cursor-team-kit) |
| no-mistakes | `no-mistakes` | `kunchenguid/no-mistakes` |
| Makora overlays | `makora-adapter` (maps Cursor terms to makora), `create-skill` | `apps/makora/skills-src` |

Most pstack skills are user-invoked only (`disable-model-invocation: true`); 7 of the 63 are offered to the model.

pstack was written for Cursor. Each pstack skill that uses a Cursor term starts with a line pointing to
`makora-adapter`, which maps those terms to what makora has today: `read`, `write`, `edit`, `bash`; questions asked in
plain text; no subagents yet, so subagent steps run inline or are skipped with a `Skipped in Makora:` line. When
makora gains the REPL and `spawn()`, the adapter changes in the same PR.

The `no-mistakes` binary is not bundled; install it separately ([getting-started.md](../getting-started.md)).

## Where skills are found

In this order:

1. Bundled: `apps/makora/skills`
2. `~/.makora/skills`
3. `<project>/.makora/skills`
4. `~/.agents/skills`
5. `.agents/skills` in the current directory and each parent up to the git root

`.agents/skills` is the vendor-neutral folder other tools install into (for example `npx skills add`), so skills you
installed for other agents show up in makora too.

## When two skills share a name

The first one found wins, and the others are hidden, with one exception:

- **Bundled skills win** over your copies. A pstack skill you installed in `~/.agents/skills` for another harness is
  hidden by makora's adapted copy, so the model never reads text written for a different tool.
- **`no-mistakes` is the exception: your copy wins.** `no-mistakes init` writes a skill that matches your installed
  binary; the bundled copy is pinned to whatever release the last sync picked.
- **Hidden skills are reported.** The splash shows a warning line (for example `makora's teach hides
  ~/.agents/skills/teach`), and the `/skill:` autocomplete entry says `(hides ~/.agents/skills/teach)`.

To use your own skill whose name collides with a bundled one, rename its folder and its `name`.

## Keeping bundled skills current

A daily CI job repins both upstreams, regenerates the tree, checks it, and opens or updates a PR from branch
`bot/sync-skills`. If upstream starts using a Cursor term the adapter has no row for, the job fails instead of shipping
unadapted text, and a human adds the row. Never edit `apps/makora/skills` by hand; see
[development.md](../development.md).
