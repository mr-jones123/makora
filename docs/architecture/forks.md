# Forks

> **Status: built.** What a user sees: [features/sessions.md](../features/sessions.md#forks) and
> [features/tui.md](../features/tui.md). Decision: [decisions.md](../decisions.md).

A fork branches a conversation before an earlier message. It continues with the Python variables and the files as they
were at that point, while the original conversation stays as it is. `apps/makora/src/fork.ts` owns the domain and the
git work; the picker is `/fork` in `src/tui/commands.ts`; switching and removing are in `src/tui/run.ts`.

## The problem it solves

Without a fork's own files, a fork would share the folder with the original. Example: the root runs `x = 41`, writes
`fake.txt` = `hi`, then runs `x = 99` and writes `fake.txt` = `bumped`. A fork before that last message gets `x == 41`
back from the snapshot, but would read `fake.txt` = `bumped`: its variables and files disagree, and each conversation's
cells would overwrite the other's files. So a fork gets a git worktree of its own, at the tree the fork point's cell
captured.

## What a fork is

1. **A Durable fork.** `parent.fork(at, { ownership: { kind: "ownerless" } })`. `at` is the entry just before the
   chosen user message, so the fork sees the parent's entries up to the state before that message was sent. The first
   user message has no entry before it, so it is not offered. Durable gives the fork a copy of the parent's agent as of
   `at`; makora then sets its `cwd`.
2. **A `makora.fork` document** on the fork, written in the commit that creates it (a conversation document family
   member keyed `fork`, created with its value as the seed, `history: "latest"`, `fork: "initial"`, so a fork of a fork
   writes its own):

   ```ts
   type ForkRecord = {
   	label: string; // "fork N", N counting the session's forks
   	parentConversationId: ConversationId;
   	forkEntryId: EntryId; // the last entry shared with the parent
   	files:
   		| { kind: "snapshot"; path: string; commit: string; tree: string }
   		| { kind: "head"; path: string; commit: string }
   		| { kind: "shared" };
   	removed?: true; // hidden from the agents view; Durable keeps the transcript
   };
   ```

3. **Files**, decided from the parent's `cwd`:

   | Case | `files.kind` | Worktree at | Notice |
   | --- | --- | --- | --- |
   | In a git repository, and the newest `python` result at or before `at` with `details.kernel.tree` exists | `snapshot` | A commit of that tree | None |
   | In a git repository without such a result (no cell before the fork point, snapshots off, an ephemeral session) | `head` | `HEAD` | `No file snapshot at the fork point; the fork's files start at HEAD (uncommitted changes are not included).` |
   | In a repository without commits and without such a result | `shared` | None | `No file snapshot at the fork point and the repository has no commits; the fork shares this folder.` |
   | Outside a git repository | `shared` | None | `Not in a git repository; the fork shares this folder with the conversation it came from.` |

4. **Variables** need no fork code. The fork's first `python` cell starts a kernel in the fork's `cwd`, and
   `findRestorePoint` scans the fork's history, which is the parent's entries up to `at` followed by the fork's own, so
   it restores the fork point's snapshot with the usual notice ([repl.md](repl.md#restore)). The worktree holds the
   same tree the snapshot's cell captured, so the notice lists no changed files.

## The worktree

```text
~/.makora/worktrees/<repo dir name>-<8 hex of sha256(repo path)>/<session id>/<fork conversation id>/
<repo>/.git/refs/makora/<session id>/forks/<fork conversation id>   keeps a snapshot fork's commit alive
```

- The root of `~/.makora` follows `MAKORA_HOME`. The repository path is the main worktree's (from `git rev-parse
  --git-common-dir`), so a fork of a fork lands under the same repository directory.
- The commit for a `snapshot` fork is `git commit-tree <tree> -p HEAD` by `makora <makora@localhost>`, so `git diff
  HEAD` in the fork shows what the fork point had on top of the branch. A repository without commits gets a root
  commit.
- `git worktree add --detach <path> <commit>`: no branch is created. The real index, the branches and the main worktree
  never change; the only writes to the repository are the commit's objects, the keep-alive ref and the worktree's
  administrative files under `.git/worktrees/`.
- The fork's `cwd` is the worktree plus the parent's `cwd` relative to its top level, created if git does not track
  it (an empty or ignored folder).
- Each cell in the fork captures its tree from the fork's worktree and keeps it alive under
  `refs/makora/<session>/<fork conversation id>`, as for any conversation.

## Order of writes

1. Find the fork point's tree and make the commit (objects only).
2. Durable fork: one commit creates the conversation, the `makora.fork` document, and the `cwd`.
3. `git update-ref` the keep-alive ref, then `git worktree add`.

A crash between 2 and 3 leaves a fork without its folder. Making a fork active (`ensureForkFiles`) checks for the
worktree and adds it again from the record, so the fork recovers on its next use; it does the same when the folder was
deleted by hand. When step 3 fails during `/fork`, the fork is marked removed and the error is shown.

## Switching

The TUI keeps one `SessionFeed` per conversation shown so far; the active one draws the main screen. Making a
conversation active (`/fork`, or Enter in the agents view) moves the top bar (`fork N · …`), the status row's folder
and branch (a short commit for a detached worktree), the dock's kernel, `@` file completion, `/diff`, `/model`,
`/thinking`, `/compact`, Esc and what you type to that conversation. Session notices go to the active conversation.
`--continue` and `/resume` open the root.

## Removing

`x` in the agents view on a fork, after a confirmation that warns when `git status --porcelain` in the worktree is not
empty:

1. Abort the fork's work and stop its kernel.
2. `git worktree remove --force <path>` (or `git worktree prune` when the folder is already gone).
3. `git update-ref -d refs/makora/<session>/forks/<id>`.
4. Set `removed: true` in the fork's document. The agents view hides it; Durable keeps its transcript.

Each step converges, so removing again after a crash finishes the job. The root cannot be removed. Removing a fork
whose files are shared removes no folder.

## Limits

- **Merging a fork back is not built.** Phase 3's `merge` will bring a worktree's work back
  ([subagents.md](subagents.md)). Until then, use git in the worktree (`git diff HEAD`, commit, cherry-pick).
- **Ephemeral sessions** fork at `HEAD` (they save no snapshots), and their fork worktrees stay on disk after the
  process ends, like any other file a session's tools write. Remove them with `git worktree remove`.
- **Deleting a session** does not yet remove its fork worktrees and refs.
- A fork's cell numbers continue from the parent's count when the fork was made (`makora.python-cells` forks as
  `current`), so the fork's first cell can be cell 6 while it restores to after cell 4.
