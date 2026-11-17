# Memory

Design for makora's memory: what it stores, how a dream turns sessions into knowledge, and how that knowledge
becomes an Obsidian wiki. What is built is described as built, with its code in `apps/makora/src/memory/`; what is
not is listed under "Not built yet". Using it: [docs/features/memory.md](../../../docs/features/memory.md).

## Problem

A makora session forgets everything when it ends. The only thing that crosses sessions is `AGENTS.md`, and only
because a person writes it. Example: one session finds that a snapshot can split a shared object
(`snapshot.py` stops its sharing walk at 2,000,000 objects). The next session starts with no idea, and finds it
again or not at all.

The design follows Anthropic's "The components of agent memory": keep raw transcripts as ground truth, and let a
background pass ("dreaming") consolidate them, check notes against the transcripts, and build a representation a
person and a model can navigate. Two findings from that article shape every choice below:

- Storing everything loses. A model that saved every encounter wrote 413 files across 225 folders and made less
  progress than one that kept nine files; the big store went stale faster than it was read.
- Several writers on one shared page lose facts. A shared contract table kept 41 of 57 terms; one writer per
  page, quoting sources, kept 57 of 57.

## Decided

### Stores

`<home>/memory/memory.sqlite` is the source of truth. The wiki is generated from it and never read back.

Two kinds of memory:

- **Episodic**: the text of each turn, copied out of each session's `session.sqlite` when a dream reads it.
  Append-only and never edited. It is copied rather than referenced, so evidence still resolves after `makora rm`
  deletes the session, and so the vector index has text to embed.
- **Semantic**: claims about projects and the user (facts, decisions, preferences), each with its version
  history and the evidence behind it.

No procedural memory: standards and procedures stay in `AGENTS.md`, which every session already loads and the
user already writes. A dream may suggest an `AGENTS.md` line in its report; it never edits the file.

No knowledge graph and no separate timeline: links between claims cover what a graph would, and claim versions
are the timeline.

### Schema (outline)

Adapted from memorantado's hybrid layer (`src/db/schema.sql`), without its graph and timeline tables.

| Table | Holds |
| --- | --- |
| `projects` | id (git remote, else the repository's first commit), name |
| `episodes` | one turn: project, session id, entry id, role, text, content hash, time |
| `claims` | a claim as it stands now: project, scope (`global` or project), kind, subject, statement, status, importance |
| `claim_versions` | every version of a claim: valid from/to (when true in the world), recorded/retracted at (when we learned or dropped it), the dream run and prompt version that wrote it |
| `evidence` | a claim version's support: episode, exact quote, its span, content hash, polarity (`supports`, `contradicts`, `mentions`) |
| `conflicts` | two claims that disagree, and how the disagreement was resolved |
| `links` | claim to claim, with a relation |
| `subjects` | what a wiki page is about: a stable key (its file name) and a title that may change |
| `dreams` | one dream run: status, sessions read, budget, staged changes, usage, cost, report, error, times |
| `reads` | each claim a `memory.search` returned, to find claims nothing uses |
| `wiki_pages` | each generated page: path and content hash |
| `episodes_fts`, `claims_fts` | FTS5 indexes |
| `episodes_vec`, `claims_vec` | sqlite-vec `vec0` tables, created at the first embedding and rebuilt when the embedding model changes |

Kinds: `fact`, `decision`, `preference`. Statuses: `proposed`, `confirmed`, `disputed`, `superseded`.

Trust order, highest first: the user's own notes, code at a commit, a transcript, the model's inference. A dream
never overwrites a higher-trust claim with a lower-trust one; it opens a conflict instead.

### Search

Hybrid retrieval: FTS5 for words, sqlite-vec for meaning, fused by rank (reciprocal rank fusion), filtered by
project and status.

Embeddings come from Ollama, locally. memorantado's default embedding hashes words into 64 slots, which is word
matching in vector form, and its SQLite path scans only the newest 5000 rows per search (its own benchmark found
0 of 3 planted facts among the oldest rows). A `vec0` table searches every row, so neither limit applies.

The model reads memory through tools (`memory.search`, `memory.get`). Each read is logged in `reads`.

### Dreaming

Started by hand from makora (`/dream`, `makora dream`). It runs as an asynchronous job modeled on Anthropic's
Dreams API: starting it records a `pending` run and returns at once; a detached worker moves it to `running`, then
to `completed`, `failed` or `canceled`. `makora dream status` and `makora dream cancel` act on the run.

- **Input**: the sessions finished since the last completed dream, plus the current claims and the user's notes
  vault (read-only).
- **Analyzers**: one per session, on the cheap pstack tier. Each reads one transcript and proposes changes (new
  claims, new versions, contradictions), every change with its evidence quotes.
- **Organizer**: one, on the judge tier. It is the only writer: it merges duplicates, supersedes outdated
  versions with dates, opens conflicts, and prunes claims nothing has read.
- **Staging**: changes go to the run's staged set, not into claims. Only a `completed` run applies them, in one
  transaction, and then renders the wiki. A failed or canceled run leaves its staged set for inspection and
  changes nothing.
- **One worker at a time**: an exclusive SQLite lock, like the session lock. A run left `running` with no lock
  held (the machine slept, the process died) is marked failed by the next start.
- **Cost**: a ceiling per run, checked against an estimate before it starts; the run records what it spent.
  Anthropic's cookbook dream cost about $8 for 50 long sessions (about 12 MB) and $0.36 for 11 small ones.

### Wiki

`/wiki-setup <path> [folder]` points makora at an Obsidian vault and scaffolds it. `/wiki` (and `makora wiki`)
renders; a completed dream renders too.

Setup:

- The folder defaults to `makora`. It must be one folder name, not a path, and not `.obsidian`. Settings and the
  folder's marker both record it.
- It creates, from fixed templates:

  ```
  <path>/<folder>/
    .makora-wiki          marker: makora owns this folder; holds the layout version
    index.md              projects, and "Needs a look" (open conflicts, unconfirmed claims)
    sessions/
    bases/Subjects.base   subject pages: by project, needing a look, recently changed
    bases/Sessions.base   sessions by date, with the claims each produced
  ```

- It saves the path and folder in settings, then renders once.

| `<path>` is | Setup does |
| --- | --- |
| missing | creates it as a new vault (`.obsidian/`) and the folder |
| a vault without the folder | creates the folder only; nothing else in the vault is touched |
| already set up | nothing, except upgrading generated files when the layout version is newer |
| holding the folder without a marker | refuses: that folder holds someone's notes |
| a file, or not writable | refuses, with the reason |

Setup writes `.obsidian/` only into a vault it created. Rerunning it with another folder name creates the new
folder and leaves the old one, and says so.

Rendering:

- A pure function of the rows: the same rows give the same bytes. No model call.
- Writes only pages whose content hash changed since `wiki_pages` last recorded them, and deletes pages whose rows
  are gone. The folder is not swapped whole, because Obsidian would re-index all of it and drop open tabs.
- One page per subject: current claims first, each with its evidence quotes and links to the session pages they
  came from, then a History section of superseded versions with their dates.
- One page per session: title, date, and the claims it produced. No transcript.
- Filenames come from stable keys, never from titles, so a link from the user's own notes survives a retitle. The
  readable title goes in frontmatter `aliases`.
- Links are `[[wikilinks]]`; Obsidian builds backlinks and the graph itself.
- Frontmatter has fixed properties (`id`, `project`, `kind`, `status`, `confidence`, `valid_from`, `updated`)
  that the Base files filter on. The layout version changes whenever they do.

## Answered while building

- **Reading a live session.** Durable's storage migrates its schema when it opens, so a read-only open fails. A dream
  copies a consistent snapshot of `session.sqlite` with SQLite's `VACUUM INTO` (safe on a live WAL database) and opens
  the copy, so a session open in another makora is read as it stands.
- **Bases in a new vault.** Obsidian 1.15 turns every core plugin whose key `.obsidian/core-plugins.json` lacks to its
  default, and Bases defaults to on. Setup makes an empty `.obsidian/` for a new vault and writes nothing else of
  Obsidian's; it warns when an existing vault sets `"bases": false`.
- **Project names in the vault.** A project's folder is its repository's name; when two repositories share one, the
  first by id keeps it and the others get a suffix from a hash of their id. The git remote is on the project's index.
- **Ollama.** `embeddinggemma` (768 dimensions). Without Ollama, search ranks by words and says so, and a dream embeds
  later what it could not. Changing the model empties the vector tables: vectors of two models cannot be compared.
- **Shipping sqlite-vec.** Pinned at 0.1.9. `node:sqlite` loads it with `allowExtension`. A release is built on Linux,
  where npm installs only the Linux binary, so the build fetches the binary of every platform makora runs on from the
  URL `package-lock.json` pins and checks it against the lockfile's hash. `vec0` refuses a primary key bound as a float,
  which is how `node:sqlite` binds a JS number, so ids are bound as `BigInt`.
- **Atomic completion.** A dream's operations, marking its sessions read, and recording it completed are one
  transaction: a worker that dies between them would otherwise leave claims from a dream that says it failed, and
  sessions read twice.
- **The dream lock.** A completed dream releases it before embedding and rendering, which only make memory searchable
  and readable, so the next dream does not wait for them.

## Not built yet

- **The user's notes vault as a source.** The trust order puts the user's own notes first, but dreams do not read a
  notes vault yet.
- **Code anchors.** Claims about code do not record `path@commit`, so a dream cannot yet tell that the code moved.
- **Pruning.** `reads` logs every claim a search returns; dreams do not yet drop claims nothing reads.
- **What goes into the prompt.** No index of memory is loaded into sessions; the model only searches.
- **Dream prompts.** `memory-1` is a first version: general guidance and the model's judgment, as the article found
  works better than rules such as "record only failures". It needs tuning on real sessions, and every claim version
  records the prompt version that wrote it.
