# Subagents

A subagent is a second agent the model starts from a Python cell. It works in its own git worktree, with its own
Python REPL and its own budget, while the parent goes on. Use one to review code without touching your tree, or to
work on a change in parallel and merge it when it is good. Internals: [architecture/subagents.md](../architecture/subagents.md).

## Start one from a cell

The model calls these helpers in its cells. You can ask for them in plain words ("review this in a subagent").

```python
await spawn(name, task, mode="write", ref=None, base=None, model=None, budget=None)
await collect(names, timeout=None)       # wait inside the cell; records by name
await send(to, message)                  # a child, a sibling, "parent", or "all"
await merge(name)                        # a write child's branch into this tree
await stop(name)                         # end its work, keep everything
await remove(name)                       # delete it, its worktree and its children
await agents.list(); await agents.get(name); await agents.recent(name, limit=6)
```

`spawn` returns the child's record at once and the child runs in the background. Calling `spawn` again with the same
name returns that child instead of starting a second one. A name uses lowercase letters, digits and dashes, and
`main`, `parent` and `all` are taken.

### Models

| `model=` | The child runs on |
| --- | --- |
| omitted | A copy of the parent's model and thinking level |
| `"code"`, `"judge"` | That pstack tier's model and thinking level from `/pstack`. A tier on the session model is the same as omitting `model=`; a tier whose model has no credentials falls back to it with a notice (`reviewer: the judge tier's model … has no credentials, so it runs on the session model`) |
| `"provider/modelId"` | That model, with the parent's thinking level; an unknown model is refused |

Any other word is refused (`Unknown model alias …`). The record's `model` is the model the child runs on, so the
dashboard shows the tier's model. Tiers are read at each spawn, so a change in `/pstack` applies to the next child
([skills.md](skills.md#pstack-model-roles)).

The model also has a second tool next to `python`: `wait_agents(names, policy="any"|"all")`. It ends the cell and parks
until one or all of the named children finish, or until a message for the model arrives. A parked wait holds no
process, so a session can wait for an hour without a running cell.

### Example: code review

```python
await spawn("review-auth", "Review the changes in src/auth for bugs and run the auth tests. List each problem with file and line.", mode="review")
await spawn("review-api", "Check that every handler in src/api validates its input.", mode="review", ref="main")
```

The model then calls `wait_agents(["review-auth", "review-api"], policy="all")` and reads both reviews. A `review`
child gets a checkout detached at `ref` (default `HEAD`). It can run tests and scratch files there, and everything it
changes is thrown away with it.

### Example: a task on a branch

```python
await spawn("fix-db", "Fix the off-by-one in migrations/004.sql and add a test.", mode="write", base="main", budget={"usd": 2, "minutes": 30})
records = await collect(["fix-db"])
print(records["fix-db"]["state"]["result"]["diffStat"])
print(await merge("fix-db"))
```

A `write` child works on a new branch from `base` (default `HEAD`). When it finishes or is stopped, makora commits what
it left uncommitted to its branch, skipping the repository's hooks and commit signing, so a failing lint hook or a GPG
passphrase prompt cannot hold up or lose the work. Nothing reaches your tree until `merge`. `merge` returns
`{'merged': True, 'commit': '…'}`, or `{'conflicts': ['path', …]}` with your tree left as it was.

`merge` refuses with an error while your tree has a merge, cherry-pick, revert or rebase of your own in progress:
finish or abort it first. A merge that stops without conflicts, because your `pre-merge-commit` hook or commit signing
failed, is aborted and comes back as that error.

### Results

A child the model is not waiting for reports back by itself: its result arrives in the parent's transcript as a `↩`
row (`↩ fix-db · done`) and in the model's context as `<agent_result>`. A review child hands back its final answer. A
write child hands back its summary, its branch head and a diff stat. A stopped child reports why it stopped.

## Budgets

`budget={"usd": ..., "minutes": ...}` sets limits. Each is optional, and a child with neither has no limit.

| Limit | When it is reached |
| --- | --- |
| `usd` | Spend is checked after each tool round; past the budget the child stops with `cost` |
| `minutes` | The child stops with `time` |

A stopped child keeps its budget when something wakes it:

- **Cost.** A child stopped for `cost`, or one whose spend has reached its `usd`, takes no more input. A message or
  typed text to it is refused with an error, because each wake spends at least one more model request.
- **Time.** A child stopped for `time` wakes only for its parent or for you typing into it. Its parent or you decide
  that it may go on; a sibling's message is refused.

Every run of a child, the first and each one a message or your typing starts, gets the whole of its `minutes`. Spend in
`usd` counts every run together.

At most 4 children run at once per session (`agents.maxRunning` in `settings.json`). Others wait as `queued`, and so
does a finished child woken by a message or by your typing: it runs once a slot frees up. A child may spawn children of
its own; a grandchild may not. A child that waits for its own children (`wait_agents` or `collect`) gives its slot to
them meanwhile, so even with `maxRunning` at 1 its grandchild runs. When its wait is over it needs a slot again before
it goes on, and it gets the next free one before any child that has not started yet. It still shows as running.

## Messaging

`await send(to, message)` reaches the sender's parent (`"parent"`), a sibling or a child by name, or all of them
(`"all"`). A running receiver gets the message during its current run. A finished one is woken by it: it waits as
`queued` for a running slot, then runs again with its transcript and its restored variables, unless its budget keeps it
stopped ([Budgets](#budgets)). A parent parked in `wait_agents` gets the message as the result of the wait. Messages
show in the receiver's transcript as `↩ message from <name> (<relationship>)`.

Limits: 16,384 characters per message, 20 pending messages per receiver, and 3 messages per sender, then one more each
second. A message to a queued or removed child is refused with an error, a woken one waiting for its slot included.

## The dashboard

Ctrl+A opens the agents dashboard: every agent of the session, what it is doing, what it costs, how much budget is
left and what it changed. A 90-column terminal with the fake model, after the reviewers finished:

```text
Agents · 1 running · 1 waiting on you · 3 done                         $0.25 · 15 req · 7s
──────────────────────────────────────────────────────────────────────────────────────────
 RUNNING
 ⠇ sleeper         review @b6cda33                 faux-1     ▰▱▱▱▱ $0.04   5s     cell 1

 WAITING ON YOU
 ◌ writer          write  makora/writer-d5e259-43  faux-1     ▰▱▱▱▱ $0.05   5s

 DONE
 ✓ main            main   main                     faux-1           $0.06   6s
▌✓   reviewer-a    review @b6cda33                 faux-1     ▰▱▱▱▱ $0.05   4s
 ✓   reviewer-b    review @b6cda33                 faux-1     ▰▱▱▱▱ $0.05   4s
──────────────────────────────────────────────────────────────────────────────────────────
reviewer-a · review · @b6cda33 from HEAD
task   steady
model  faux/faux-1
kernel none

cost   $0.05 / no limit
time   4s / 5m00s
turns  3 / 50

RECENT CELLS
✓ cell 1 print((await bash("sleep 3; echo slept")).output.strip())
✓ cell 2 print("README:", open("README.md").read().strip())

WORKTREE
+0 −0 · 0 files against b6cda33
```

- **Sections.** RUNNING holds running agents and queued ones (`queued`). WAITING ON YOU holds finished write agents
  whose branch is not merged yet. DONE holds finished reviews, merged and stopped agents. The main conversation and
  forks are under RUNNING while they have a run and under DONE otherwise. Removed agents are not listed.
- **Rows.** A state glyph (a spinner while running, `◌` queued or waiting on you, `✓` done, `✗` stopped), the name
  indented under its parent, the mode (`write`, `review`, `fork`, `main`), the branch or `@<short commit>`, the
  model, a 5-cell budget bar, the cost, the time worked, and the cell running now. The bar measures cost against
  `usd`, else time against `minutes`, else turns.
- **Inspector.** The selected agent's name, mode and where it started; its task; its kernel (`running`, `restored`,
  `dead` or `none`, with variables and the last snapshot cell); cost, time and turns as `used / limit`; its last 3
  cells; its last messages (`from → to: text`); its worktree's changes against its base (`+N −M · K files`) and path;
  its result when done, or why it stopped.
- **Narrow terminals.** Below 100 columns the inspector goes under the list, and the list takes at most half the
  screen.
- **Scrolling.** With more agents than fit, the list scrolls by the least that keeps the selected row on screen. The
  title of the section at the top stays visible, and `↑ N more` and `↓ N more` count the agents scrolled away. After a
  resize the list keeps the selected row in view and fills the rows it gained.

The dashboard reads the agents again every second, so rows change while you watch. After `m`, `s` or `x` it reads them
once more before the hint row shows the outcome, so `Removed reviewer-a.` never stands next to a row of reviewer-a.

| Key | Does |
| --- | --- |
| ↑ ↓ | Select |
| Enter | Open the agent in the main screen. The top bar shows `viewing <name> · <mode> · <branch> · esc back to main`, and what you type goes to that agent: a running one gets it during its run, a finished one queues for a slot and runs again |
| `d` | The diff view on the agent's worktree, starting on a `vs base <commit>` tab of everything it changed since it started; Esc returns to the dashboard |
| `m` | Merge a finished write agent into its parent's folder, after a confirmation; the hint row shows the merge commit or the conflicting paths |
| `s` | Stop a running or queued agent, after a confirmation; it keeps its transcript and worktree |
| `x` | Remove an agent and its children, after a confirmation that says what is kept and what is lost. A review checkout goes with anything changed in it. An unmerged write branch is kept with all its work, because makora commits what is uncommitted first; only the worktree folder and the files git ignores there go. A merged branch goes with its worktree. On a fork, removes the fork as before |
| Esc | Back to the main screen |

In an opened agent, Esc returns to the main conversation and Ctrl+C stops the agent's run.

## Where worktrees live, and why

| Mode | Where | Why there |
| --- | --- | --- |
| `review` | `<temp folder>/makora-worktrees/<repo>-<hash>/<session>/<conversation>/` | A review checkout is thrown away anyway, so losing it on a reboot costs nothing. A checkout deleted while it is still needed comes back before the child's next cell |
| `write` | `~/.makora/worktrees/<repo>-<hash>/<session>/<conversation>/`, branch `makora/<name>-<session>-<conversation>` | Unmerged work has to survive a reboot |

Both roots can be changed in `settings.json` (`worktrees.review`, `worktrees.write`). Worktrees live outside the
repository, so tools that walk the project (tsc, biome, test globs, `rg`) never wander into a child's checkout.

A fresh worktree has no `node_modules` or untracked files such as `.env`. Set a setup command in the repository's
`.makora/settings.json`, for example `{ "worktreeSetup": "npm ci --ignore-scripts" }`. It runs with `sh -c` in each new
worktree before the child starts, and its output shows at the top of the child's transcript. A command that fails,
runs longer than `agents.setupTimeoutMinutes` (default 10), or is still running when you stop or remove the child is
killed with everything it started, and the child stops with `error`.

### The setup command is code from the repository

`.makora/settings.json` belongs to the repository, so a repository you cloned decides what its `worktreeSetup` runs. A
command runs only once you approved that exact command for that repository:

- **Asking.** The first time a child needs a command you have not approved, the TUI shows it in a dialog. "Approve and
  run it" stores the repository's path and the command's SHA-256 in `agents.approvedSetups` of `~/.makora/settings.json`,
  and makora does not ask again for that repository until the command changes. Cancel skips it until makora exits.
- **Skipping.** Print mode cannot ask, so it skips a command that is not approved, as the TUI does after Cancel. The
  child starts without it, its brief says so, and a notice in its transcript and in its parent's names the command and
  the settings entry that approves it, for example
  `{"repository":"/home/me/src/app","sha256":"9f2c…"}`.
- **Environment.** An approved command runs as you, in the worktree, with makora's environment minus provider
  credentials: variables ending in `_API_KEY`, `_TOKEN` or `_SECRET`, and the AWS, Google and Anthropic credential
  variables pi-ai reads. Approving a command trusts it with everything else your user can reach.

Outside a git repository, a child shares its parent's folder and its changes land there directly.

## After a crash

Children belong to the conversation, not to the cell that spawned them. After `kill -9` and `makora --continue`,
running children continue, nothing they finished runs again, and their variables come back from snapshots on their next
cell. See [sessions.md](sessions.md).
