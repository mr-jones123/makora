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
