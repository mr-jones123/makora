# Skills

Skills are folders with a `SKILL.md`: a name, a description, and instructions. The model sees the names and
descriptions of model-invocable skills and reads a skill's file when a task matches. You run any skill with
`/skill:<name> [args]`. Pipeline internals: [architecture/skills-pipeline.md](../architecture/skills-pipeline.md).

## Bundled skills

Makora ships 64 skills in `apps/makora/skills`, generated from pinned upstream sources:

| Group | Skills | Source |
| --- | --- | --- |
| pstack | `poteto-mode` and its playbooks, `how`, `why`, `interrogate`, `swarm`, `arena`, `architect`, `figure-it-out`, `show-me-your-work`, `teach`, `technical-writing`, … and 24 `principle-*` skills | `cursor/plugins` (pstack) |
| Companions | `deslop`, `control-cli`, `control-ui`, `verify-this` | `cursor/plugins` (cursor-team-kit) |
| no-mistakes | `no-mistakes` | `kunchenguid/no-mistakes` |
| Makora overlays | `makora-adapter` (maps Cursor terms to makora), `create-skill`, `session-quiz` (what `/quiz` runs; [quiz.md](quiz.md)) | `apps/makora/skills-src` |

Most pstack skills are user-invoked only (`disable-model-invocation: true`); 8 of the 64 are offered to the model.

pstack was written for Cursor. Each pstack skill that uses a Cursor term starts with a line pointing to
`makora-adapter`, which maps those terms to what makora has today: the `python` tool and its helpers (`await
read(...)`, `write`, `edit`, `bash`, with `rg` through `bash` for searching); questions asked in plain text; and
subagents. A `Task` becomes `await spawn(name, brief, mode=...)` in a cell: a seat that writes code is a `write` child,
and a read-only, review or verification seat is a `review` child. A cloud agent becomes a `write` child on its own
branch, `run_in_background` becomes spawning and then `wait_agents`, and `resume` becomes `await send(name, text)`.
A model slug in a pstack skill becomes the role's tier (see below). Steps that need something makora lacks are skipped
with a `Skipped in Makora:` line. The adapter changes in the same PR as the makora API it maps to
([subagents.md](subagents.md)).

## pstack model roles

pstack names a model per role: a fast code model for feature work, bug fixes and swarm workers, a judgment model for
prose, synthesis and the hardest tasks, and both for the panels of `arena`, `architect` and `interrogate`. Makora keeps
two tiers, `code` and `judge`, each a model and a thinking level, and maps every role to `code`, `judge` or `session`
(the spawning conversation's model). With nothing set, both tiers are the session model, so every seat runs on one
model as before.

`/pstack` opens the picker; `/skill:setup-pstack` opens it too, because that skill would write a Cursor rule makora
never reads. Choices are saved in `~/.makora/settings.json` under `pstack`
([reference/configuration.md](../reference/configuration.md#settingsjson-fields)) and apply to the next spawn.

The picker at 90 columns, after the judge tier, a role, a panel seat and the budget were changed:

```text
╭─ pstack models ──────────────────────────────────────── budget: unlimited (max) ─╮
│  MODELS                                                                          │
│ ▌ code    session model                                                          │
│   judge   faux/faux-2                       thinking high · clamped from max     │
│                                                                                  │
│  ROLES                                      runs on                              │
│   feature, refactoring                      code                                 │
│   bug-fix                                   judge                                │
│   perf-issue                                code                                 │
│   hillclimb                                 code                                 │
│   judgment and prose                        judge                                │
│   hardest tasks                             judge                                │
│   how explorer                              code                                 │
│   how explainer                             judge                                │
│   why investigators                         code                                 │
│   why synthesizer                           judge                                │
│   reflect tooling                           code                                 │
│   reflect judgment, divergent, synthesizer  judge                                │
│   arena runners                             judge + code + judge                 │
│   arena cross-judge pool                    judge + code                         │
│   swarm workers                             code                                 │
│   architect runners                         judge + code                         │
│   interrogate reviewers                     judge + code                         │
│                                                                                  │
│ ↑↓ select · enter change · b budget · r reset defaults · esc save and close      │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

- **Enter on a tier** lists the session model and the models you have credentials for, then the model's thinking
  levels when it thinks (cancelling that question keeps the budget's level).
- **Enter on a role** cycles it through `code`, `judge` and `session`. On a panel role it edits the seats: ←/→ pick a
  seat, Enter cycles it, `a` adds one, `x` removes one (a panel keeps at least one), Esc finishes. Each seat is one
  subagent, so the seat count is the panel's size.
- **`b`** picks the budget: `unlimited` (max), `large` (xhigh), `medium` (high) or `small` (medium). It sets both
  tiers' thinking level, clamped to the highest level each model supports below it; the tier row shows `clamped from
  <level>` when it was.
- **`r`** resets everything to the defaults after a confirmation. **Esc** saves and closes. On a short terminal the
  list scrolls with `↑ N more` / `↓ N more`.

When `poteto-mode` is among the skills, the prompt carries one line per tier with its roles and one for the panels,
for example ``- `model="code"`: feature, refactoring; bug-fix; …``. The adapter tells pstack skills to pass that
`model=` to `spawn`, one child per panel seat. When both tiers are one model (the default) the prompt says so, and the
model reports panel seats as one model, not as multi-model evidence. In print mode no picker can open, so the adapter
has the model explain the `pstack` block of `settings.json` instead.

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
