# The TUI

Makora's terminal UI is one column ("layout A") plus a full-screen agents view. It runs on pi-tui's alternate screen
with mouse support. Internals: [architecture/tui.md](../architecture/tui.md).

## The main screen

Top to bottom:

| Row | Shows |
| --- | --- |
| Top bar | `makora` · session title (the first prompt) · working directory; right: session cost and time since the session started |
| Transcript | Your messages (`›`), the model's answers as markdown, thinking as one muted line (`∴ thinking · …`), tool calls, notices |
| Activity row | `◆ N running` (green when above 0) · `◌ N waiting` · `N worktrees` (always 0 until phase 3) · compaction state |
| Status row | model · thinking level · directory (git branch) · a 20-cell context gauge with `NN% of <window>`; right: the account label |
| Editor | A rounded box; `/` opens command autocomplete |
| Hint row | The main keys, read from the key bindings so remaps show; shows `press ctrl+c again to exit` after a first Ctrl+C |

### Tool calls

Each tool call is one line that keeps its height while its state changes: `<marker> <tool> · <argument preview> ·
<duration>`. Markers: a spinner while running, `✓` success, `✗` error, `◌` pending or parked. Ctrl+O toggles expanded
mode for all calls, which adds the arguments and the last 20 lines of output.

### Notices

Run failures, retries, aborts, compaction problems and session restores show as a warning box (`⚠ …`). Command output
(for example `/accounts`) shows as a muted `·` line; those lines are not saved in the session.

### Scrolling

The transcript follows the newest output. Scrolling up (wheel, PgUp) shows a `↓ jump to latest` pill; Ctrl+End
returns. Earlier entries load when you scroll to the top.

## The splash

While the transcript is empty, the splash replaces it, centered:

- Wide and tall enough (about 87 columns, 24 rows): the brass dharma wheel beside the `MAKORA` wordmark, the tagline
  "a self-evolving harness for long-running work", and key hints.
- Narrower (zoomed in, split panes): the wheel alone.
- Shorter: an 11-row wheel alone. Shorter still: nothing.
- When one of makora's bundled skills hides a skill you installed under the same name, a warning line under the
  hints says so (see [skills.md](skills.md)).

The first message replaces the splash.

## The agents view

Ctrl+A opens it; Esc returns.

- Title: `Agents · N running · M done`, total cost, requests, elapsed time.
- Left: every conversation of the session in sections RUNNING, IDLE, DONE, children indented under their owner, with
  model, directory or worktree, cost and age. Phase 1 shows only the root; phase 3 subagents appear here without
  changes.
- Right: the selected agent's model, directory, cost and turns, and its recent tool calls.
- Keys: ↑/↓ select, Enter opens (phase 1: the root only), Esc back.

## Keys

| Key | Action | Binding id |
| --- | --- | --- |
| Esc | Stop the running work | `app.interrupt` |
| Ctrl+C | Stop the run; else clear the editor; else press twice within 1.5 s to exit | `app.cancel` |
| Ctrl+D | Exit when the editor is empty | `app.exit` |
| Ctrl+O | Expand or collapse tool calls | `app.tools.expand` |
| Ctrl+A | Agents view | `app.agents` |
| Ctrl+L | Model picker | `app.model.select` |
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
| `/compact [instructions]` | Compact the context now |
| `/skill:<name> [args]` | Run a skill: its instructions plus your arguments become the message |
| `/quit` | Exit |

The model and thinking choices are saved in `~/.makora/settings.json` and apply to new requests immediately.
