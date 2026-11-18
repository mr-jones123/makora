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

### Schema

`apps/makora/src/memory/store.ts` creates every table. Times are milliseconds since the epoch; → marks a column that
names a row of another table. Each example is from a fake dream over one message, "We keep the cache in
~/.cache/demo and never in the repo."

How the tables connect: an episode backs a version's evidence, a version belongs to a claim, and a claim sits under a
subject, which is a wiki page. A dream never edits an episode; it adds versions and evidence, so every claim traces
back to the turn it came from.

#### `projects`: one row per repository

| Column | Meaning |
| --- | --- |
| `id` | Primary key: the git remote as `host/owner/repo`, else `commit:<first commit>`, else `dir:<folder>` |
| `name` | The project's folder name in the wiki |

Example: `github.com/me/demo`, `demo`.

#### `sessions`: one row per session a dream has read

| Column | Meaning |
| --- | --- |
| `id` | Primary key: the makora session id |
| `project` | → `projects` |
| `title`, `cwd` | From the session's `meta.json` |
| `created_at`, `updated_at` | From the session |
| `dreamed_through` | The session's `updated_at` when a dream last read it; a later update makes it due again |
| `dreamed_episode` | The last episode a dream read; the next dream reads only those after it |

Example: `01a1ecc2…`, `github.com/me/demo`, its title, `/…/repo`, `dreamed_episode` 2.

#### `episodes`: one row per message of a session, never edited

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `session` | → `sessions` |
| `conversation`, `entry` | Where the message is in the session; unique together |
| `role` | `user`, `assistant` or `tool` |
| `text` | The message; a tool call reads `→ python` and its code, and a long tool result is cut in the middle |
| `hash` | sha256 of `text` |

Example: `1`, the session, `1`, `7`, `user`, "We keep the cache in ~/.cache/demo and never in the repo.", `510da24c…`.

#### `subjects`: one row per wiki page

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `project` | → `projects`; empty for a global subject |
| `key` | The page's file name; never changes; unique per project |
| `title` | The page's title; may change, and goes into the page's `aliases` |

Example: `1`, `github.com/me/demo`, `what-the-user-asked`, "What the user asked".

#### `claims`: one row per claim, as it stands now

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `project` | → `projects`; empty for a claim about the user in every project |
| `subject` | → `subjects` |
| `kind` | `fact`, `decision` or `preference` |
| `statement` | Its current wording |
| `status` | `proposed`, `confirmed`, `disputed` or `superseded` |
| `superseded_by` | → `claims`: the claim that replaced it |
| `created_at`, `updated_at`, `checked_at` | When it was made, last changed, and last checked against a transcript |

Example: `1`, `github.com/me/demo`, subject `1`, `fact`, "The user asked: We keep the cache…", `confirmed`.

#### `claim_versions`: one row per wording a claim has had

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `claim` | → `claims` |
| `statement`, `status` | That version's wording and status |
| `valid_from`, `valid_to` | When it held in the world |
| `recorded_at`, `retracted_at` | When memory took it in and let it go; the current version has no `retracted_at` |
| `dream` | → `dreams`: the dream that wrote it |
| `prompt_version` | The dream prompts that wrote it, such as `memory-1` |

Example: `1`, claim `1`, its wording, `confirmed`, dream `1`, `memory-1`.

#### `evidence`: one row per quote backing a version

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `version` | → `claim_versions` |
| `episode` | → `episodes` |
| `quote` | The exact text, checked to appear in that episode |
| `polarity` | `supports`, `contradicts` or `mentions` |

Example: `1`, version `1`, episode `1`, "We keep the cache in ~/.cache/demo and never in the repo.", `supports`.

#### `conflicts`: one row per pair of claims that disagree

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `claim`, `other` | → `claims` |
| `reason` | Why they disagree |
| `status` | `open`, `resolved` or `ignored` |
| `created_at`, `resolved_at` | |

Example: claims `3` and `5`, "two cache locations", `open`.

#### `links`: one row per relation between two claims

| Column | Meaning |
| --- | --- |
| `from_claim`, `to_claim` | → `claims` |
| `relation` | Such as "caused by" or "part of"; the three columns are the key |

Example: `3`, `5`, "part of".

#### `dreams`: one row per dream

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `status` | `pending`, `running`, `completed`, `failed` or `canceled` |
| `project`, `cwd` | What it dreams about, and where it was started |
| `sessions` | JSON list of the session ids it read |
| `budget_usd`, `cost_usd`, `input_tokens`, `output_tokens` | Its budget and what it spent |
| `staged` | JSON of its checked operations and what was dropped, kept also when it fails |
| `report`, `error` | What it did, or why it failed |
| `pid`, `cancel_requested` | Its worker process, and whether `/dream cancel` asked it to stop |
| `created_at`, `started_at`, `ended_at` | |

Example: `1`, `completed`, `github.com/me/demo`, `["01a1ecc2…"]`, budget 2, spent 0.0055, 1,031 and 163 tokens,
"Read 1 session(s) in 1 slice(s); 1 notes…".

#### `reads`: one row per claim a search returned

| Column | Meaning |
| --- | --- |
| `claim` | → `claims` |
| `at` | When the search returned it |

#### `wiki_pages`: one row per page written

| Column | Meaning |
| --- | --- |
| `root`, `path` | The wiki folder and the page in it; the key |
| `hash` | sha256 of what was written |

Example: `/…/vault/makora`, `.makora-wiki`, `fdb147e4…`; one row per page.

#### `meta`: one row per setting of the database

| Column | Meaning |
| --- | --- |
| `key`, `value` | Today only `vectors`: the model and size of the stored vectors, such as `embeddinggemma:768` |

#### Search indexes

| Table | Columns |
| --- | --- |
| `episodes_fts`, `claims_fts` | FTS5 over `text` and `statement`; the row id is the episode's or the claim's, kept by triggers |
| `episodes_vec`, `claims_vec` | sqlite-vec: `episode` or `claim` (the id) and `embedding float[<size>]`, compared by cosine distance; made at the first embedding and emptied when the model changes |

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
