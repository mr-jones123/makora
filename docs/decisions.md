# Makora: decisions

The owner's decisions for Makora, newest last. Each entry says what was decided and why.

- **Makora is a self-evolving harness for long-running tasks (owner, 2026-11-14).** Developers start an instance on a
  long task and let it refine its own harness; the evolved harness is exported and reused elsewhere. Self-evolution is
  built last, after reliable long runs and an evaluation suite exist. See [vision.md](vision.md).
- **Built on `pi-durable` (owner, 2026-11-14).** Durable commits every change before showing it and already provides
  owned subagent conversations, child tasks with cascading abort, parked waits, sleeps and signals, compaction and
  in-place extension reload. Without it Makora would rebuild what Prime Agent's daemon does (recovery journal, child
  lifecycle, ledger, cron) and its recurring bugs. Makora is a new app in `apps/makora`, not a change to
  `coding-agent` (single process, file-based sessions) or a fork of p2 (marked "will be gone soon"). Risk: Durable is
  experimental and its API changes without notice; keeping Makora in one app directory contains the breakage.
- **The REPL is Python (owner, 2026-11-14).** Models write Python more fluently for data and context work, and the
  library ecosystem is there. Rejected: a JavaScript REPL on QuickJS code mode, which can be replayed deterministically
  after a crash but has no libraries and is slow. Cost accepted: REPL state is recovered from per-cell snapshots, so the
  cell running at a crash is lost, and unpicklable values are dropped.
- **Per-cell snapshots tied to Durable commits (owner, 2026-11-14).** At the end of each cell, changed variables are
  pickled into content-addressed blobs and the worktree is captured as a git tree; one Durable commit then stores the
  result with references to both. Restore uses the last committed cell on the current branch. Prime Agent's debounced
  snapshots are not tied to the transcript, so their state can differ from what the model saw.
- **Spawned children are owned by the conversation, not the cell (owner, 2026-11-14).** Durable aborts nested calls of
  a tool call that is not replay-safe on restart; a child owned by the cell would die with it.
- **Pickle blobs per session; git objects per repository with refs per session (owner, 2026-11-14).** Per-session
  blobs make deleting and pruning a session independent of other sessions; cross-session deduplication is not worth
  the pruning race. Git's object store is shared by a repository's worktrees; Makora manages only its own refs.
- **Exports never contain kernel snapshots (owner, 2026-11-14).** Pickles run code when loaded and depend on the exact
  Python version.
- **Current scope is the app skeleton, the Python REPL and worktree subagents (owner, 2026-11-14).** Later phases are
  revisited once these work.
- **Sandboxes are deferred (owner, 2026-11-14).** There is no design for sandboxing on macOS yet. Makora runs locally
  with the user's permissions; Durable's `env` function is where sandboxed environments will plug in.
- **The skeleton includes a new TUI (owner, 2026-11-14).** A full redesign, not coding-agent's interactive mode.
- **pstack and no-mistakes ship with Makora and are updated by a scheduled CI job (owner, 2026-11-14).** Both are
  generated from pinned upstream sources with a Makora adapter, as `mr-jones123/pstack-harness` does for OMP and Pi.
- **The TUI is layout A plus the agents view (owner, 2026-11-14).** One column (top bar, transcript with one-line
  cell summaries, activity row, status row with context gauge and account, editor, key hints) and a full-screen
  agents view. The three-pane layout waits until pi-tui gets split panes and a virtualized transcript.
- **Skills are generated inside the makora repository (owner, 2026-11-14).** The adapter changes in the same PR as
  the makora API it maps to.
- **Subscription login without Claude Code impersonation (owner, 2026-11-14).** Makora keeps pi's Claude Pro/Max
  OAuth login and adds multiple accounts with explicit switching, account identity, a 30-day grant warning, plan
  usage display, and an environment override for the Claude Code version pi sends. It does not copy oh-my-pi's billing
  header and body checksum, device-id metadata, client-mimicking headers, version adoption from rejections or
  automatic account rotation: those make Anthropic bill third-party traffic as Claude Code, which is against
  Anthropic's terms and puts users' accounts at risk. Anthropic subscription usage in makora is billed as extra usage.
- **Phase 1 runs the TUI and the Durable harness in one process (2026-11-14).** One worker process per session is
  deferred to the background service (phase 4). Until the Python kernel arrives, no untrusted code runs inside the
  process, and the kernel is a subprocess anyway.
- **An account is a person in one organization (2026-11-14, open for the owner).** A login matches a stored account
  when the account uuid (else the email) and the organization uuid are equal, because a token is scoped to one
  organization: a Team seat and a personal plan of one person stay two accounts, labeled `email (organization)`.
  If Anthropic's token response carries no account or organization, every login adds an account; oh-my-pi falls back
  to a bootstrap endpoint for that case, makora does not yet.
- **Bundled skills win name collisions, except no-mistakes, and hidden skills are reported (owner, 2026-11-15).**
  Skills are found in bundled, `~/.makora/skills`, `.makora/skills`, `~/.agents/skills`, `.agents/skills` order and the
  first copy of a name wins, so a pstack copy installed for another harness never reaches the model. `no-mistakes` is
  the exception: the user's copy wins, because `no-mistakes init` writes one matching the installed binary while the
  bundled copy is pinned. When a bundled skill hides a user's skill, the splash and the `/skill:` autocomplete say so.
- **The splash is the dharma wheel beside the MAKORA wordmark (owner, 2026-11-15).** The wheel alone when the window is
  narrow or zoomed in, a smaller wheel when it is short.
- **Ctrl+C stops a run, else clears the editor, else exits on a second press within 1.5 s (2026-11-15).**
- **`docs/` is the source of truth for makora (owner, 2026-11-15).** Features, architecture, roadmap and decisions
  live there and change with the code.
- **Every subagent gets its own worktree and its own REPL (owner, 2026-11-15).** Reviewers too: a `review` child gets
  a detached checkout of the commit under review, so it can run tests without touching the parent's tree, and its
  worktree is deleted with it; a `write` child gets branch `makora/<session>/<name>` and only an explicit `merge`
  brings its work back. Each child conversation starts its own Python kernel in its worktree.
- **The subagents dashboard is layout A: list and inspector (owner, 2026-11-15).** Enter opens an agent in the main
  screen, where typed input goes to it. A live view inside the dashboard waits until pi-tui can route keys to a second
  scrolling area.
- **REPL details (2026-11-15, recommended defaults, open for the owner).** The model is offered only `python` and
  `wait_agents`; file and shell tools are called from Python and still run through Durable. Worktrees live outside the
  repository, at `~/.makora/worktrees/<repo>/<session>/<name>`. A project may set a setup command run in new
  worktrees. Makora starts kernels itself with `child_process`, from one shared `uv` environment at
  `~/.makora/python`; Durable stays unchanged.
- **Durable stays the only runtime; durability is optional (owner asked for optional durability, 2026-11-15).** Not
  every task is long-running, but the cost of saving sits in REPL snapshots and session files, not in Durable's
  commits: a measured fake-model run took about 1 ms longer on SQLite than in memory. A second runtime for quick
  tasks would need a second version of the REPL tool, subagents and the TUI feed. So two switches decide what is
  saved: `--ephemeral` runs the session on Durable's `MemoryStorage` (no session directory, no snapshots), and
  `"snapshots": false` in `settings.json` keeps sessions but not REPL variables. Print mode still saves its session,
  so `--continue -p` keeps working. See [architecture/repl.md](architecture/repl.md#durability-is-optional).
- **The model is offered only `python` (2026-11-16, follows the 2026-11-15 default, open for the owner).** The coding
  tools stay installed and run as nested Durable calls from cells, so every file and shell action is still recorded.
  `wait_agents` joins `python` when subagents are built.
- **Snapshots pickle with Python's C pickler and fall back to dill (2026-11-16).** dill's pickler is written in Python
  and took 3.6 s on a list of 1e7 ints, against 258 ms for the whole snapshot with the C pickler. dill is still used
  for functions and classes defined in the REPL, which the C pickler would save by name, and for every load. Both
  write the same bytes for plain data, so blob hashes do not depend on which pickler ran. Blobs are not compressed:
  Python 3.12 has no zstd in its standard library.
- **The `/diff` view is layout A, with B and C, plus a History tab (owner, 2026-11-16).** A is a file list beside the
  selected file's diff. B stacks every file in one scroll below 100 columns. C shows old and new side by side on `v`
  from 120 columns. Tabs are Working tree, Staged, vs the base branch and History, so recent commits are readable
  without leaving makora. `a` puts the hunk with the cursor line marked into the editor, so the user can ask the agent
  about a line. The view stages, unstages and reverts, but never commits: committing stays with the agent and
  `no-mistakes`. See [features/diff.md](features/diff.md).
- **Forks get their own worktree at the fork-point file snapshot (owner, 2026-11-16).** `/fork` makes a Durable fork
  before an earlier message, and inside a git repository a detached worktree at a commit of the tree the newest cell
  before the fork point captured, under `~/.makora/worktrees/<repo>-<hash>/<session>/<conversation>`. Without that
  tree the worktree starts at `HEAD`; outside git the fork shares the folder; each case says so. A fork that shared the
  folder would restore the fork point's variables next to the original's later files, and the two conversations would
  overwrite each other's files. The fork reuses the worktree layout planned for subagents; merging back waits for
  phase 3's `merge`. See [architecture/forks.md](architecture/forks.md).
- **Review worktrees in the temp folder, write worktrees under `~/.makora/worktrees`, both configurable (owner,
  2026-11-16).** A review checkout is thrown away anyway, so losing it on a reboot costs nothing; a write agent's
  unmerged work has to survive one. Subagents serve both tasks (`write`) and code review (`review`).
- **A write subagent's branch is `makora/<name>-<last 6 of the session id>-<conversation id>` (2026-11-16).** The
  planned `makora/<session>/<name>` was replaced because names repeat across a session's parents and conversation ids
  repeat across sessions; both parts together are unique in a repository.
- **A child's result reaches a parent that is itself a child the way a message does (2026-11-16).** While that parent
  runs, the result is a steer of its run, so the parent's anchor still watches the run. A finished parent is woken by
  it. The root gets results as follow-up inputs.
- **Messages a child cannot take are refused, not queued (2026-11-16).** A message to a queued or removed child, or one
  that arrives between the end of a child's run and its anchor recording it, fails with an error the sender reads,
  and the sender can send again.
- **A run woken by a message or by user input takes no running slot and has no time limit (2026-11-16, open for the
  owner).** Its turn limit applies. Replaced by the entry on every run taking a slot, below.
- **The record types are type aliases (2026-11-16).** Durable's documents take JSON types, which interfaces do not
  satisfy; the shapes are unchanged. Added to the contract: `AgentWorktree.repository` (where git runs for the
  worktree), the sender's and receiver's conversation ids on `AgentMessage`, `AgentsDocument`, `AgentMessageLog`, and
  a `{ mode: "shared" }` result for children outside git.
- **Text typed into an opened subagent goes through its anchor (2026-11-16).** `MakoraSession.submit` admits it the
  way `send` admits a message: a steer while the child runs, a wake-up under the anchor's next round once it finished,
  refused while queued or removed. A plain submission started a run no anchor watched, so the record kept its old
  state and the parent never heard the new result.
- **The dashboard puts the main conversation and forks in RUNNING or DONE (2026-11-16).** Its sections are RUNNING,
  WAITING ON YOU and DONE. A subagent's section follows its record; the root and forks are RUNNING while they have a
  run, a parked `wait_agents` included, and DONE when idle. Children are indented only under a parent in the same
  section.
- **Esc on a fork or subagent returns to the main conversation (2026-11-16).** The banner promises `esc back to main`,
  so the key does that (`app.back`, checked before `app.interrupt`); Ctrl+C still stops the opened agent's run. Before,
  Esc on a fork stopped the fork's run.
- **The dashboard's merge, stop and remove are the cell tools' functions (2026-11-16).** `src/agents/control.ts` takes
  a tool call's API or the host's harness, so a user's merge and the model's merge record the same states and converge
  the same way after a crash.
- **A repository's worktree setup command runs only once the user approved it (2026-11-16).** `.makora/settings.json`
  comes with the repository, so running its `worktreeSetup` unasked lets any clone run code with the user's rights.
  The user's `settings.json` keeps approvals as the repository path and the command's SHA-256, so a changed command asks
  again. The TUI asks once in a dialog; print mode skips an unapproved command and the notices say how to approve it.
  The command runs without provider credentials and is killed after `agents.setupTimeoutMinutes` (default 10) or on a
  stop or remove.
- **makora commits a child's work without the repository's hooks or signing (2026-11-16).** Those are the user's rules
  for their own commits. A failing lint hook or a GPG passphrase prompt with no terminal would otherwise fail the
  anchor, which keeps its running slot and leaves waits on the child parked for good. The user's hooks still run when
  `merge` brings the branch into their tree.
- **A stopped write child's work is committed to its branch (2026-11-16).** Removing it then deletes only the worktree
  folder and the files git ignores there, and the confirmation says so.
- **A child stopped by its budget stays stopped (2026-11-16).** A child stopped for cost, or at its `usd`, refuses
  every wake, because the spend check runs only after a tool round and each wake spends at least one more request. A
  child stopped for turns or time wakes only for its parent or the user, who decide that it may go on.
- **`merge` refuses while the user has a merge, cherry-pick, revert or rebase in progress (2026-11-16).** Aborting a
  conflict that was not makora's threw away the user's resolution, and a merge into a stopped rebase landed in its
  middle. A merge that stops without conflicts (a failing hook, failed signing) is aborted and reported as its error.
- **Every run of a child takes a running slot and gets its whole time limit (2026-11-16, replaces the entry that a
  woken run takes no slot).** A message, a child's result or typed text that wakes a finished child no longer starts a
  run at once: the child is `queued`, its anchor takes a slot behind `agents.maxRunning` as for a first run, then
  submits the input and runs it with the full `minutes` and `turns` of the budget. `usd` stays a total across all runs.
  Before, `agents.maxRunning` capped only first runs and a woken run had no time limit, so a parent could keep any
  number of children running and a woken child could run forever.
- **makora's git writes take turns per repository (2026-11-16).** Commits of a child's work, merges, worktree adds and
  removes and branch deletes go through one queue per repository and session, keyed by the repository's common git
  dir. Removing a running write child collided with its anchor committing the child's work on the worktree's
  `index.lock`. A lock another process holds is waited for about 3 s, then the call fails naming the lock file. Cell
  snapshots stay outside the queue: they write a temporary index and a ref per conversation, and queueing them would
  slow every cell.
- **Deleting a session removes its worktrees and keeps write branches with work (2026-11-16).** `makora rm <id>` and
  the end of an ephemeral session remove every fork and subagent worktree the session made, its
  `refs/makora/<session>/` and its folders under the worktree roots. A write branch with unmerged commits, or with
  changes its worktree left uncommitted (committed to it first), stays: it is the user's work, and a merge can still
  bring it in. A branch with no commits beyond its base, or a merged one, goes. Worktrees outside the session's folders
  under makora's roots are never touched. This settles the forks open item: an ephemeral session's fork worktrees go
  when it ends, rather than staying as its file output, because nothing in makora can open them once the session is
  gone.
  There was no delete path before; `rm` sits next to `ls` and asks first, saying which branches stay.
- **The dashboard list scrolls by the least that keeps the selection in view (2026-11-16).** With more agents than
  fit, rows past the screen were cut off. The list keeps the title of the section at its top on screen and counts the
  rows above and below as `↑ N more` and `↓ N more`; under 100 columns it takes at most half the screen so the
  inspector stays readable.
- **A child waiting on its own children holds no running slot (2026-11-16).** A child kept its slot through
  `wait_agents` and `collect`, so children waiting on grandchildren could hold every slot while the grandchildren
  queued behind them: 4 children each waiting on a grandchild deadlocked the default `agents.maxRunning` of 4, and one
  did at 1. The wait now frees the slot in the commit that parks it. Once the wait is over it claims a slot again
  before it returns, in a lane served before first and woken runs, so new spawns cannot starve a parent; how the wait
  ended is kept in its checkpoint while it waits. The commit that signals the end of the wait (a finishing child's
  `notify`, a `send`) already puts the parent in that lane, because the finishing child gives back its slot right after
  and the woken call usually claims later. The slot and every claim count against the child's anchor, whose
  `release` drops both, so a stop, removal or crash while waiting leaks no slot. `makora.agent-slots` is version 2
  (claims with the key their grant signals, and the `resuming` lane); compatibility was not kept, so reading a stored
  version 1 fails. Each queued anchor now sleeps on `slot-<round>`: the shared `slot` key served one wait, so an anchor
  that queued for its first run could not queue again once woken.
- **pstack's model roles are two tiers, chosen in `/pstack` (2026-11-16, replaces "Makora has no model roles").**
  pstack names a model per role (17 roles in setup-pstack), but its slugs are Cursor's, and a model per role is more
  choice than a user makes well. Makora keeps two tiers, `code` and `judge`, each a model and a thinking level, and maps
  each role to a tier or to the session model; a panel role maps each seat. They live under `pstack` in
  `settings.json`, which stores only what differs from the defaults: with nothing set both tiers are the session model,
  which is the behavior before tiers. `spawn(model="code" | "judge")` resolves host-side at each spawn, so the record
  and the dashboard show the real model, a settings change applies to the next child, and the model never sees a slug
  it could misspell. A tier whose model lost its credentials falls back to the session model with a notice rather than
  failing the spawn. The prompt lists the roles per tier in a few lines while `poteto-mode` is among the skills, and says
  so when both tiers are one model, because seats on one model are not multi-model evidence. `/skill:setup-pstack`
  opens the picker instead of submitting the skill, whose steps write a Cursor rule makora never reads.
- **The quiz and the wiki are separate, and the wiki waits for the memory system (owner, 2026-11-16).** The first plan
  had `/wiki` write the project's record into the owner's Obsidian vault and `/quiz` report its scores there. The wiki
  is the project's long-term record, the material the memory system will work from, so it is designed later as part of
  the memory system. `/quiz` ships alone and touches no vault.
- **The quiz is a static page that scores itself, with nothing recorded (owner, 2026-11-16).** makora renders one
  self-contained HTML file and opens it; the page scores in the browser, and its result stays there. The first plan
  served the page on `127.0.0.1` and took the answers back by a POST, to record them in the session and the wiki.
  Without a record to keep, a server would only add a listening port, its lifetime and a fallback for a page opened
  later from disk. A file works the same opened now, tomorrow or on another machine. The agent writes the questions, but
  makora's code shuffles the options, takes the diffs from git and renders the page, and the bank is checked at
  `quiz.publish` (10 questions of 4 options, cited shas in the range, a summary per commit), so the model cannot invent
  a commit or place the right answer. Pages live in `MAKORA_HOME/quizzes/<repo>-<hash>/`, next to makora's other
  per-repository state, not in the repository, which they would dirty. See [features/quiz.md](features/quiz.md).
- **Releases bundle the fork's packages and have no npm dependencies (owner, 2026-11-17).** Users must run exactly
  the fork's code. The npm packages `@earendil-works/*@1.5.2` are upstream builds without the fork's `packages/*`
  changes, for example `5f5cc0428` (Anthropic OAuth keeps the account and the organization), so a release that installed
  them would silently run other code than this repository. A release is one esbuild bundle of `src/main.ts` with
  `packages/*/src` resolved through the root `tsconfig.json` paths, plus the files makora reads at runtime, published as a
  GitHub release tagged `makora-v<version>` and installed by `apps/makora/install.sh` (`curl … | sh`, or
  `makora update`). Rejected: publishing makora to npm on top of the upstream packages, and publishing the fork's
  packages to npm under another scope, which would add a release process per package for no user benefit. The
  `upstream` remote stays, only for merging pi's changes into the fork. The tarball fits every platform: the only
  native code is pi-tui's optional helpers, shipped for macOS and Linux. pi-ai loads OAuth flows and bedrock through
  variable import specifiers next to its own files, so `main.ts` registers pi-ai's literal-import loaders
  (`lazy-oauth`, `lazy-bedrock-provider`), which keeps them inside the bundle. The kernels' shared venv is keyed by its
  requirements (Python version and dill), not by the release: an upgrade that changes them rebuilds it, and one that
  does not keeps it, so the previous version, which install.sh keeps for sessions still running on it, shares it
  without a rebuild each time the two alternate.
- **makora's version comes from conventional commits through a release PR (owner, 2026-11-17).** Commit messages
  follow `type(scope)!: subject`, checked in CI on the first-parent line only, so merging upstream pi never fails on
  its history. Only commits that change what ships count: those under `apps/makora/` or a workspace package makora
  depends on, transitively, through `package.json`, which is also the list the release build checks its bundle against,
  so there is one source of truth. `fix` and `revert` bump patch, `feat` minor, a breaking change major (minor below
  1.0), the other types nothing, and the changelog lists only breaking changes, features, fixes and reverts: docs, CI
  and refactors are not news to someone installing makora. The first release is 0.1.0, and its changelog starts at the
  fork point from upstream pi, because everything before it shipped as pi's own releases. A push to `main` does not
  release on its own: it refreshes one release PR that carries the version and the changelog section, and merging
  that PR tags `makora-vX.Y.Z` and publishes the GitHub release after the check, the tests and a smoke run of the
  build. The PR is where the owner sees what the next release says and decides when it ships; releasing every push
  would publish each fix separately, with nobody reading the notes first.
- **Images: makora reads the clipboard itself, and fits images with Durable's Photon worker (builder, 2026-11-17).**
  pi's coding agent reads clipboard images in `utils/clipboard-image.ts` with its helpers, but its package exports none
  of them, and makora does not depend on it. Moving them into `packages/tui` was the preferred reuse; it was not done
  because the files keep changing upstream (five commits between 2026-09-28 and 2026-10-30), so every later upstream
  fix would conflict with the move, their 790 lines of tests mock modules with vitest while pi-tui tests with
  `node:test`, and BMP conversion needs
  Photon, which pi-tui does not carry. `src/tui/clipboard.ts` is 60 lines over pi-tui's exported `getNativeClipboard()`
  (macOS, Windows, Linux X11), giving up only pi's Wayland and WSL command paths. Images are fitted by Durable's
  `createNodePhotonImages()`, the processor `read` already supports, in a worker thread: pi's 2000×2000 pixels and
  4.5 MB of base64, so a model's limit is "about 5 MB" with headroom. The release ships `node-worker.js` beside
  `makora.mjs` and Photon's `.wasm` under `node_modules/@silvia-odwyer/photon/`, where the worker resolves it. The
  limits (4 per message or cell, the per-image size) are not settings: they follow the provider limits, not taste.
- **An attached image is a token in the text (builder, 2026-11-17).** The draft keeps `[image #N]` in its text, kept
  whole by pi-tui's new `Editor.atomicTokens`, and the attachments are derived from the tokens present, so deleting,
  undoing and restoring a draft need no separate state. On send the tokens are renumbered 1, 2, … in order and the
  images follow the text in that order, so the model can tell which image a sentence means.
- **`show(image)` is the cell helper's name (builder, 2026-11-17).** It says what happens: the model is shown the
  image. `display` was rejected because in Jupyter it renders any object, which the model would expect for a
  DataFrame; `attach` describes the mechanism rather than the effect. It is synchronous like `ctx.input()`, so it works
  in plain loops, and it reports in the cell's output instead of raising when an image is refused, so one bad image
  does not lose the cell's other work.
