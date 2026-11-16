# The diff view

`/diff` or Ctrl+G opens a full-screen view of the repository's changes and history inside makora, so you do not need
lazygit or another terminal. Esc returns to the conversation. Internals: [architecture/tui.md](../architecture/tui.md#the-diff-view).

## Tabs

Tab and Shift+Tab cycle through them.

| Tab | Shows |
| --- | --- |
| Working tree | Unstaged changes and untracked files (as added files) under CHANGES, staged changes under STAGED |
| Staged | `git diff --cached` |
| vs `<base>` | Everything since the branch left its base, uncommitted changes to tracked files included: the working tree against the merge base with `main`, else `master`, else the remote's default branch (`origin/HEAD`). Hidden when there is no base or the checked-out branch is the base |
| History | The newest 300 commits of the branch, one row each: short sha, subject, author, age, `+N −M`. Select one to see its diff. Merge commits show their changes against the first parent |

Opened with `d` from the agents dashboard, the view shows the selected agent's worktree with one more tab, `vs base
<commit>` (for a fork, `vs fork point <commit>`): the working tree and its untracked files against the commit the
subagent started at, or the fork's starting commit. It starts on that tab, and Esc returns to the dashboard ([subagents.md](subagents.md#the-dashboard)).

Outside a git repository the view says so; Esc closes it. A "This session" tab (what the session changed) is planned
([roadmap.md](../roadmap.md)).

## Layouts

- **Files and diff** (default): the file list on the left (status `M` `A` `D` `R` `?`, path, `+N −M`) and the selected
  file's diff on the right, with old and new line numbers. In History the left side lists commits and the right side
  shows the commit's files one under another.
- **One scroll** (terminals under 100 columns): every file's diff stacked under a header; → or Enter on a header folds
  or unfolds that file. In History the commit list fills the screen, and → shows the selected commit's diff full
  width.
- **Side by side** (`v`, at least 120 columns): old on the left, new on the right; `v` again returns.

Large changes stay fast: only the visible rows are drawn, and a file shows at most 2000 rows with an "N more lines"
note. Binary files are listed with `bin` and not shown. Untracked files over 512 KiB, untracked files past the first
500, untracked symlinks (`symlink to <target>`), nested repositories (`directory, not shown`) and special files are
listed but not read.

## Keys

| Key | Action |
| --- | --- |
| ↑/↓ or k/j | Move in the focused pane |
| → or Enter, ← | Focus the diff, back to the list (in the one-scroll layout, → or Enter folds the file under the cursor) |
| PgUp / PgDn | Scroll the diff |
| ] / [ | Next or previous hunk (file, in the one-scroll layout) |
| Tab / Shift+Tab | Next or previous tab |
| s | Stage the selected file; works on files under CHANGES in the Working tree tab |
| u | Unstage the selected file; works on staged files (STAGED, or the Staged tab) |
| r | Revert the selected file's working-tree changes after a confirm, or delete it if untracked; works under CHANGES |
| v | Side by side |
| a | Ask about the line under the cursor |
| Esc | Back to the conversation |

All of them are binding ids under `app.diff.*` and can be remapped ([reference/configuration.md](../reference/configuration.md)).

## Asking about a line

The diff pane has a cursor line. `a` closes the view and puts a block into the editor at the cursor, then you type
your question:

````text
About src/session.ts:3 (working tree):
```diff
@@ -1,6 +1,8 @@
 export async function refresh(store: Store, id: string) {
     const token = await store.read(id);
-    if (!token) return undefined;     ← line 3
+    if (token === undefined) {
```
````

The location uses the new line number, or the old one for a deleted line. On a hunk header it names the hunk's start
and marks no line. The source in parentheses is `working tree`, `staged`, `vs <base>` or `history`, and in History the
location names the commit (`src/version.ts:1 @ dd71502`). Long hunks are trimmed to 30 lines around the cursor.

## What it does not do

No commits, branches or rebases: the agent or the `no-mistakes` skill commits. No mouse support yet.
