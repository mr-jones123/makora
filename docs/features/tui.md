# The TUI

Makora's terminal UI is one column ("layout A") plus two full-screen views: the agents dashboard and the diff view. It
runs on pi-tui's alternate screen with mouse support. Internals: [architecture/tui.md](../architecture/tui.md).

## The main screen

Top to bottom:

| Row | Shows |
| --- | --- |
| Top bar | `makora` · on a fork or subagent, `viewing <name> · <mode> · <branch> · esc back to main` · session title (the first prompt) · the active conversation's directory; right: session cost and time since the session started |
| Transcript | Your messages (`›`, an attached image as a muted `[image #1 · png · 1280×800]`), the model's answers as markdown, thinking as one muted line (`∴ thinking · …`), tool calls, subagent results and messages (`↩`), notices |
| Activity row | `◆ N running` (green when above 0) · `◌ N waiting` · `N worktrees` (the session's fork and subagent worktrees, removed ones not counted) · the active conversation's Python kernel, once a cell started one (`py running 3 vars @ cell 7 45 MB`, `py dead (exit 1)` as a warning; see [repl.md](repl.md#cells-in-the-tui)) · compaction state |
| Status row | the active conversation's model · thinking level · directory (git branch, or a short commit in a fork's worktree) · a 20-cell context gauge with `NN% of <window>`; right: the account label |
| Attachments | Only while the draft has images: `image #1 · png · 1280×800 · 210 KB` for each ([Images](#images)) |
| Editor | A rounded box; `/` opens command autocomplete |
| Hint row | The main keys, read from the key bindings so remaps show (`esc back to main` instead of `esc interrupt` on a fork or subagent); shows `press ctrl+c again to exit` after a first Ctrl+C |

### Tool calls

Each tool call is one line that keeps its height while its state changes: `<marker> <tool> · <argument preview> ·
<duration>`. Markers: a spinner while running, `✓` success, `✗` error, `◌` pending or parked. The model's calls are
Python cells, shown as `✓ python · cell 3 · <first line of the code> · 2.3s`. Ctrl+O toggles expanded mode for all
calls, which adds the arguments (a cell's code), the last 20 lines of output, and for a cell one `↳` line per call it
made, such as `↳ ✓ bash · echo hello; sleep 2 · 2.1s` ([repl.md](repl.md#cells-in-the-tui)).

### Notices

Run failures, retries, aborts, compaction problems and session restores show as a warning box (`⚠ …`). Command output
(for example `/accounts`) and news from the session (`Quiz saved · <path> · opened in browser`) show as a muted `·`
line; those lines are not saved in the session.

### Subagent results and messages

A subagent's result and a message from another agent show as a `↩` row: a title line (`↩ writer · done`, `↩ message
from reviewer-b (sibling)`) and the first 6 lines of the text, with `… N more lines` after them. Ctrl+O shows all of it
([subagents.md](subagents.md#results)).

### Images

Ctrl+V pastes from the system clipboard, in this order:

1. Files copied in Finder are inserted as their paths, one per line.
2. An image is attached. It shows in the editor as a token, `[image #1]`, which moves and deletes as one character,
   and the line above the editor lists it: `image #1 · png · 1280×800 · 210 KB`. Images larger than 2000×2000 pixels
   or 4.5 MB (the model's own limits when it declares them) are scaled down and re-encoded first, by Photon in a worker
   thread, so pasting a large photo does not freeze the screen.
3. Otherwise the clipboard's text is inserted, as the terminal's own paste does (a long text becomes `[paste #1 …]`).

Dragging a file into the terminal pastes its path as text; it is not attached, since the model can read files.

Deleting a token leaves its image out, and undo brings both back. Ctrl+C clears the text and the images together. On
Enter the message goes out as its text, with the tokens numbered `[image #1]`, `[image #2]`, … in order, followed by
the images in that order, so the model can tell which is which. The transcript shows each token as
`[image #1 · png · 1280×800]`, muted. The images are saved in the session and show the same after `--continue`.

Makora refuses to send, keeps the draft and shows a notice when:

- The model takes no images: `faux-2 cannot see images; switch with /model or remove [image #1]`.
- The message has more than 4 images.
- An image is over the byte limit of the model in use (possible after switching to a model with a smaller one).

Ctrl+V works in the main editor, also when the active conversation is a fork or a subagent opened from the
dashboard; typing an image into a busy conversation steers it as text does. `/fork` puts the message back in the
editor with its images attached. Not in dialogs. Print mode takes text only. The clipboard is read through pi-tui's
native helper, which covers macOS, Windows and Linux under X11; under Wayland alone Ctrl+V says it cannot read the
clipboard. Images are not drawn inline in the transcript.

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

## The agents dashboard

Ctrl+A opens it; Esc returns. It lists every agent of the session: `main` (the root), its forks by label (`fork 1`),
and the subagents by name, each indented under the agent it belongs to.

- Title: `Agents · N running · M waiting on you · K done`; right: total cost, requests, elapsed time.
- Left: sections RUNNING (running and queued subagents; `main` and forks while they have a run), WAITING ON YOU
  (finished write subagents not merged yet) and DONE (finished reviews, merged and stopped subagents; `main` and forks
  when idle). Each row has a state glyph, name, mode, branch or `@<short commit>`, model, a 5-cell budget bar, cost,
  time worked and the cell running now. Removed subagents and forks are not listed.
- Right: the selected agent's inspector: where it started, its task, its kernel, cost, time and turns against its
  budget, its last 3 cells, its last messages, its worktree's changes and path, and its result or why it stopped. A
  fork shows where its files come from (`worktree at the fork point's snapshot (82927d5)`, `worktree at HEAD (…)`,
  `shares the original's folder`).
- Below 100 columns the inspector goes under the list.
- Keys: ↑/↓ select; Enter opens the selected agent in the main screen, where what you type goes to it; `d` diff, `m`
  merge, `s` stop, `x` remove, each after a confirmation where it changes something; Esc back. The outcome of an action
  shows in the hint row.

On a fork, `x` removes the fork after a confirmation that warns when its worktree has uncommitted changes, and `d`
opens its diff against the fork point. The main conversation cannot be removed, merged or stopped from here.

Details of every column and key: [subagents.md](subagents.md#the-dashboard). Forks:
[sessions.md](sessions.md#forks).

## Keys

| Key | Action | Binding id |
| --- | --- | --- |
| Esc | Stop the running work | `app.interrupt` |
| Esc (on a fork or subagent) | Back to the main conversation; checked before `app.interrupt` | `app.back` |
| Ctrl+C | Stop the run; else clear the editor; else press twice within 1.5 s to exit | `app.cancel` |
| Ctrl+D | Exit when the editor is empty | `app.exit` |
| Ctrl+O | Expand or collapse tool calls | `app.tools.expand` |
| Ctrl+A | Agents dashboard | `app.agents` |
| Ctrl+L | Model picker | `app.model.select` |
| Ctrl+G | Diff view ([diff.md](diff.md)) | `app.diff` |
| Ctrl+V (also Alt+V on Windows) | Paste copied files as paths, an image as an attachment, or text ([Images](#images)) | `app.clipboard.pasteImage` |
| d (dashboard) | Diff of the selected agent's work against its base commit | `app.agents.diff` |
| m (dashboard) | Merge the selected write subagent | `app.agents.merge` |
| s (dashboard) | Stop the selected running or queued subagent | `app.agents.stop` |
| x (dashboard) | Remove the selected subagent with its children, or the selected fork | `app.agents.remove` |
| b, r (`/pstack`) | Pick the budget; reset to the defaults | `app.pstack.budget`, `app.pstack.reset` |
| ←/→, a, x (`/pstack`, editing a panel) | Pick a seat; add one; remove one | `app.pstack.previousSeat`, `app.pstack.nextSeat`, `app.pstack.addSeat`, `app.pstack.removeSeat` |
| Home | Start of the editor line (Ctrl+A is taken by the agents dashboard) | pi-tui editor |
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
| `/pstack` | Choose pstack's code and judge models, their thinking budget, and where each pstack role runs; `/skill:setup-pstack` opens it too ([skills.md](skills.md#pstack-model-roles)) |
| `/new` | Start a new session in this directory |
| `/resume` | Resume another session |
| `/fork` | Fork the active conversation before an earlier message, with that point's variables and files; the message, with its images, goes back in the editor ([sessions.md](sessions.md#forks)) |
| `/quiz [rev-range \| all]` | Have the agent write a 10-question quiz on what this session's commits built and decided (or the range's, or the whole project's), saved as a self-scoring HTML page and opened in the browser ([quiz.md](quiz.md)) |
| `/compact [instructions]` | Compact the context now |
| `/diff` | Open the diff view of the active conversation's directory: changes, staging, commit history, ask about a line ([diff.md](diff.md)) |
| `/skill:<name> [args]` | Run a skill: its instructions plus your arguments become the message |
| `/update` | Install the newest release and show the installer's report; the session keeps its version until makora restarts. A source checkout says to `git pull` instead ([reference/cli.md](../reference/cli.md)) |
| `/quit` | Exit |

`/model`, `/thinking` and `/compact` act on the active conversation. The model and thinking choices are also saved in
`~/.makora/settings.json` as the default for new sessions, and apply to new requests immediately. `/pstack` saves its
choices there when you close it with Esc; they apply to the next subagent.
