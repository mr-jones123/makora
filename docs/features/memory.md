# Memory

Makora forgets a session when it ends, unless you dream. A dream reads the sessions a project has had since its last
dream and turns them into claims: facts about the code, decisions and why, the user's preferences. Each claim keeps
the quotes from the transcripts it rests on, every earlier wording, and its disputes. Later sessions search them from
cells, and `/wiki-setup` renders them into an Obsidian vault you can read.

Design and reasons: [apps/makora/docs/memory.md](../../apps/makora/docs/memory.md).

## Dreaming

| Command | What it does |
| --- | --- |
| `/dream` | Starts a dream for the project of the session's directory and returns at once; a background process runs it |
| `/dream status [id]` | The newest dream, or dream `id`: its state, sessions read, spend, and its report |
| `/dream cancel [id]` | Stops the newest dream, or dream `id`; nothing it staged is applied |

The command line has the same: `makora dream`, `makora dream status [id]`, `makora dream cancel [id]`.

A dream goes `pending`, `running`, then `completed`, `failed` or `canceled`, as Anthropic's Dreams API does. Only one
runs at a time; `/dream` while one runs says which. Its steps:

1. **Finds the sessions due**: those of this project (the same git remote, so every clone and worktree counts) that
   changed since the dream that last read them, at most 20 a dream, oldest first.
2. **Copies their turns** into memory as episodes, so evidence still resolves after `makora rm` deletes a session. A
   session open in another makora is read as it stands.
3. **Checks the budget**: an estimate over `memory.dreamBudgetUsd` fails the dream before any model call.
4. **Analyzes** each slice of each session's new turns on the pstack `code` tier, then **organizes** the notes into
   operations on memory on the `judge` tier (create, confirm, revise, supersede, dispute, link, retitle).
5. **Checks every operation**: a quote must appear in a turn the dream read, and a claim with no quote left is
   dropped. The report lists what was dropped and why.
6. **Applies** the operations, marks the sessions read and records the dream completed, in one transaction: memory
   never holds half a dream.
7. Then embeds the new turns and claims for search, and renders the wiki if one is set up.

The report ends with lines the dream suggests for `AGENTS.md`, which you write: standards and procedures belong there,
and a dream never makes claims of them or edits the file.

A dream's log is `~/.makora/memory/dreams/<id>.log`.

## Searching from cells

| Helper | What it returns |
| --- | --- |
| `await memory.search(query, limit=8, episodes=False)` | `{hits, note?}`, best first: the project's live claims and global ones that match by words and meaning; with `episodes=True` raw turns too. `note` says why vectors did not take part when they did not |
| `await memory.get(id)` | One claim: its statement, every earlier version, its quotes with their sessions, and its disputes |

Every claim a search returns is logged, so a dream can tell which claims are read.

## The wiki

`/wiki-setup <vault> [folder]` points makora at an Obsidian vault and makes `<vault>/<folder>` (default `makora`), the
one folder makora writes into; then it renders. A vault path with spaces is quoted.

| `<vault>` is | Setup does |
| --- | --- |
| missing | creates it as a new vault; open it in Obsidian with "Open folder as vault" |
| a vault without the folder | creates the folder; nothing else in the vault is touched |
| already set up | nothing, and renders |
| holding the folder with notes makora did not write | refuses |
| a file, or not writable | refuses |

It warns when the vault has Bases turned off, and never edits the vault's `.obsidian` settings. Running it with
another folder name leaves the old folder in place and says so.

`/wiki` (and `makora wiki`) renders again; a completed dream renders too. A render writes only the pages whose content
changed and deletes pages whose claims are gone, so Obsidian re-indexes only those and keeps your tabs.

```text
<vault>/<folder>/
  index.md                every project, and claims that need a look (disputed or proposed)
  <project>/index.md      the project's subjects
  <project>/<subject>.md  a subject's claims with their quotes, links and disputes, then their History
  global/                 claims about you that hold in every project
  sessions/<id>.md        one session: when, and the claims it is evidence for; never the transcript
  bases/Subjects.base     subject pages by project, needing a look, recently changed
  bases/Sessions.base     sessions by date
```

A subject page keeps its file name when its title changes (the title is in `aliases`), so links from your own notes
keep working. Pages are generated: edit memory through dreams, not the pages; keep your own notes in another folder.

## Embeddings

Search ranks by words (SQLite FTS5) and by meaning (sqlite-vec), fused by rank. Meaning needs a local
[Ollama](https://ollama.com) with an embedding model:

```sh
ollama pull embeddinggemma
ollama serve
```

Without Ollama, search ranks by words alone and says so; a dream embeds what it could not the next time Ollama is up.
Changing `memory.embedModel` embeds everything again, since vectors of two models cannot be compared.

## Where memory lives

`~/.makora/memory/memory.sqlite` holds everything; the wiki is rendered from it and never read back. It is made the
first time you run `/dream` or a cell searches memory; nothing turns it on. Every table, column and what a row is:
[the schema](../../apps/makora/docs/memory.md#schema). Settings are in
[configuration.md](../reference/configuration.md#settingsjson-fields).

Not built yet: reading your own notes vault as a source, pruning claims nothing reads, and loading a short index of
memory into every session's prompt.
