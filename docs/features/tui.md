# The TUI

Makora's terminal UI is one column ("layout A") plus two full-screen views: the agents view and the diff view. It runs
on pi-tui's alternate screen with mouse support. Internals: [architecture/tui.md](../architecture/tui.md).

## The main screen

Top to bottom:

| Row | Shows |
| --- | --- |
| Top bar | `makora` · the active fork's label (`fork 2`), when a fork is active · session title (the first prompt) · the active conversation's directory; right: session cost and time since the session started |
| Transcript | Your messages (`›`), the model's answers as markdown, thinking as one muted line (`∴ thinking · …`), tool calls, notices |
| Activity row | `◆ N running` (green when above 0) · `◌ N waiting` · `N worktrees` (the session's fork worktrees) · the active conversation's Python kernel, once a cell started one (`py running 3 vars @ cell 7 45 MB`, `py dead (exit 1)` as a warning; see [repl.md](repl.md#cells-in-the-tui)) · compaction state |
| Status row | the active conversation's model · thinking level · directory (git branch, or a short commit in a fork's worktree) · a 20-cell context gauge with `NN% of <window>`; right: the account label |
| Editor | A rounded box; `/` opens command autocomplete |
| Hint row | The main keys, read from the key bindings so remaps show; shows `press ctrl+c again to exit` after a first Ctrl+C |

### Tool calls

Each tool call is one line that keeps its height while its state changes: `<marker> <tool> · <argument preview> ·
<duration>`. Markers: a spinner while running, `✓` success, `✗` error, `◌` pending or parked. The model's calls are
Python cells, shown as `✓ python · cell 3 · <first line of the code> · 2.3s`. Ctrl+O toggles expanded mode for all
calls, which adds the arguments (a cell's code), the last 20 lines of output, and for a cell one `↳` line per call it
made, such as `↳ ✓ bash · echo hello; sleep 2 · 2.1s` ([repl.md](repl.md#cells-in-the-tui)).

### Notices

Run failures, retries, aborts, compaction problems and session restores show as a warning box (`⚠ …`). Command output
(for example `/accounts`) shows as a muted `·` line; those lines are not saved in the session.

### Scrolling

The transcript follows the newest output. Scrolling up (wheel, PgUp) shows a `↓ jump to latest` pill; Ctrl+End
returns. Earlier entries load when you scroll to the top.

## The splash

While the transcript is empty, the splash replaces it, centered:

- Wide and tall enough (about 87 columns, 24 rows): the brass dharma wheel beside the `MAKORA` wordmark, the tagline
  "a self-evolving harness for long-running work", and key hints (`/login`, `/ commands`, `ctrl+a agents`, `ctrl+g
  diff`).
- Narrower (zoomed in, split panes): the wheel alone.
- Shorter: an 11-row wheel alone. Shorter still: nothing.
- When one of makora's bundled skills hides a skill you installed under the same name, a warning line under the
  hints says so (see [skills.md](skills.md)).

The first message replaces the splash.

## The agents view

Ctrl+A opens it; Esc returns.

- Title: `Agents · N running · M done`, total cost, requests, elapsed time.
- Left: every conversation of the session in sections RUNNING, IDLE, DONE: `main` (the root), its forks by label
  (`fork 1`) indented under the conversation they came from, and, in phase 3, subagents under their owner. Each row has
  model, directory or worktree, cost and age. Removed forks are not listed.
- Right: the selected agent's model, directory, for a fork where its files come from (`worktree at the fork point's
  snapshot (82927d5)`, `worktree at HEAD (…)`, `shares the original's folder`), cost and turns, and its recent tool
  calls.
- Keys: ↑/↓ select; Enter makes the selected conversation the active one and returns to the main screen, where what
  you type goes to it; `x` removes the selected fork after a confirmation, which warns when its worktree has
  uncommitted changes (the main conversation cannot be removed); Esc back. The outcome of `x` shows in the hint row.

Forks: [sessions.md](sessions.md#forks).

In phase 3 this becomes the subagents dashboard (layout A): sections RUNNING, WAITING ON YOU, DONE; rows with mode,
branch or ref, budget bar and current cell; an inspector with kernel state, budgets, recent cells and the worktree
diff stat; keys `d` diff, `m` merge, `s` stop, `x` remove; Enter opens the agent in the main screen, where what you
type goes to it. Design: [architecture/subagents.md](../architecture/subagents.md#the-dashboard).

## Keys

| Key | Action | Binding id |
| --- | --- | --- |
| Esc | Stop the running work | `app.interrupt` |
| Ctrl+C | Stop the run; else clear the editor; else press twice within 1.5 s to exit | `app.cancel` |
| Ctrl+D | Exit when the editor is empty | `app.exit` |
| Ctrl+O | Expand or collapse tool calls | `app.tools.expand` |
| Ctrl+A | Agents view | `app.agents` |
| Ctrl+L | Model picker | `app.model.select` |
| Ctrl+G | Diff view ([diff.md](diff.md)) | `app.diff` |
| x (agents view) | Remove the selected fork | `app.agents.remove` |
| Home | Start of the editor line (Ctrl+A is taken by the agents view) | pi-tui editor |
| PgUp / PgDn, Ctrl+Home / Ctrl+End | Scroll the transcript | pi-tui |

Every binding can be remapped in `~/.makora/keybindings.json` ([reference/configuration.md](../reference/configuration.md)).

## Slash commands

| Command | What it does |
| --- | --- |
| `/login` | Log in to a provider (OAuth or API key); opens the browser for OAuth when it can |
| `/accounts` | List accounts; pick one to make it active or remove it |
| `/logout` | Remove the current provider's active account |
| `/model` | Choose the model among providers you are logged in to |
| `/thinking` | Choose the thinking level |
| `/new` | Start a new session in this directory |
| `/resume` | Resume another session |
| `/fork` | Fork the active conversation before an earlier message, with that point's variables and files ([sessions.md](sessions.md#forks)) |
| `/compact [instructions]` | Compact the context now |
| `/diff` | Open the diff view of the active conversation's directory: changes, staging, commit history, ask about a line ([diff.md](diff.md)) |
| `/skill:<name> [args]` | Run a skill: its instructions plus your arguments become the message |
| `/quit` | Exit |

`/model`, `/thinking` and `/compact` act on the active conversation. The model and thinking choices are also saved in
`~/.makora/settings.json` as the default for new sessions, and apply to new requests immediately.
