# realmem

Surprise-gated, on-demand long-term memory for [Pi](https://pi.dev). It replaces
AGENTS.md / CLAUDE.md and other memory systems with small Markdown facts. The agent
recalls those facts when it needs them. It stores a new fact only when that fact is
new, important and durable.

## Scopes and storage

| Scope | Purpose | Files |
|---|---|---|
| global | every project and session (user preferences, general knowledge) | `~/.pi/agent/realmem/global/*.md` |
| project-shared | replaces AGENTS.md: setup, architecture, conventions, release; **commit it** | `<project>/.pi/realmem/*.md` |
| project-personal | this machine or user only (local paths, workarounds) | `~/.pi/agent/realmem/personal/<project-key>/*.md` |

The project key is `git-<root commit>`, so it stays stable across clones, worktrees and
moves. Outside git, or in a repository without commits, it falls back to
`path-<hash of root>`. After the first commit, personal memories are moved to the git
key automatically. Each personal store has a `project.json` naming its project.

Each fact is one file:

```markdown
---
id: 01926b3e-5c1a-7d2f-9a4b-1c2d3e4f5a6b   # UUIDv7, never changes
caption: Run e2e tests with pnpm test:e2e
paths:                                     # project scopes only, relative to the root
  - packages/web
created: 2026-09-27T12:00:00.000Z
updated: 2026-09-27T12:00:00.000Z
---

`pnpm test:e2e` needs Docker running; it starts Postgres via docker compose.
```

The frontmatter never holds volatile or local data (usage counts, importance, conflicts).
All of that lives in `~/.pi/agent/realmem/realmem.sqlite`:

- **usage** counters: `used_count` (Reinforce + recall hits; recall and lists sort by
  it) and `path_inject_count` (times shown automatically on a path touch; never used
  for sorting).
- **path urgency** per memory (SemIf score, valid for its current content and paths),
  plus **missing-path** flags.
- **embeddings** cache, keyed by `sha256(caption + content)` and the embedding-space
  fingerprint (endpoint + model + dimensions). Changing the embedding API clears it.
- **index**: FTS5 BM25 over pre-tokenized text, plus a sqlite-vec `vec0` cosine index.
- **locks**, **pending** queue, **approvals** (quarantine), **imported context files**.

Keys are shown to models as 22-character base64url UUIDv7 values (e.g.
`AZJrPlwafS-aSxwtPk9aaw`), the fewest tokens that still carry all 128 bits. Tools also
accept the canonical UUID form.

### CJK

FTS5's `unicode61` tokenizer treats a run of CJK characters as a single token.
realmem therefore pre-tokenizes text in JavaScript before indexing:

- ICU word segmentation (`Intl.Segmenter`);
- identifier splitting (`usedCount` → `used`, `count`);
- overlapping CJK character bigrams, plus unigrams in the index.

Queries are tokenized the same way, so matching does not depend on both sides being
segmented identically.

## Remember path (surprise gate)

1. **Local safety scan**. Candidates containing secrets (keys, tokens, private keys,
   credentialed URLs, `password=…`) are refused (or redacted, if configured). Candidates
   containing prompt-injection patterns (override instructions, fake chat or system
   tags, exfiltration, `curl | sh`, bidi or invisible characters) are refused.
2. An exact duplicate (same hash) only reinforces the existing memory.
3. **Neighbours**: embed the candidate as a document, then run vector KNN and BM25
   across all visible scopes and fuse the results with RRF (up to 254).
4. **SemIf / System One judge**. The state contains the candidate plus the
   neighbours, each prefixed with `[id]`. The questions are:
   - `covered_by`, `conflict_with`, `merge_with`: choice among the ids plus `none`;
   - `action`: Add / Edit / Merge / Reinforce;
   - `importance`: score over trivial … broken or harmful result;
   - `durable`: noul — is this a lasting fact rather than task status?
   - `unsafe`: noul — secret or manipulation;
   - `scope`: Global / Project Shared / Project Personal;
   - `path_urgency` (asked when the fact has specific paths): score over three levels:
     *Low*, the fact can be read later after an agent touches the path; *Mid*, provide
     the caption; *High*, show the full fact as soon as the path is touched.

   Questions are split across requests according to `--max-questions`.
5. **Decision**. The judge's action is combined with the thresholded picks:
   - a confident `covered_by` means Reinforce;
   - a confident `conflict_with` means Edit, which takes precedence over Add;
   - Merge requires a confident `merge_with` target;
   - a fact whose scope differs from its target's store is added, not edited;
   - importance and durability gate Add and Merge; `user_requested` bypasses that gate;
   - `unsafe` rejects the candidate;
   - **disjoint paths are not a conflict**: an Edit or Merge whose target has
     non-overlapping paths becomes an Add ("jest in packages/a" vs "vitest in
     packages/b");
   - an exact duplicate for a new path widens the old memory's `paths` instead of adding
     a copy.
6. **Edit / Merge**: the configured Pi model rewrites the target memory, keeping its
   UUID. The result is scanned again; if it fails, a deterministic fallback is used.
7. The file is written atomically, then indexed and embedded in the background.

If the judge or embedder is unreachable, the candidate is queued and retried
automatically (or with `/realmem retry`). If only the embedder is down, the judge
compares against BM25 neighbours alone.

If another Pi process holds the write lock for more than 2 minutes, the candidate is
queued instead of failing.

Writes run under a SQLite lease lock (`locks` table, heartbeat-renewed and TTL-expired;
a dead holder is detected by pid) plus WAL with `busy_timeout`. Several Pi processes
can therefore share the stores safely.

## Sharing project memories through git

Project-shared memories live in `.pi/realmem/` and are shared by committing them. If git
ignores that directory, shared memories are silently never committed. This is common
when `.pi/` is in `.gitignore`. realmem therefore runs `git check-ignore` on the store:

- **At session start**, a warning names the rule that ignores it (file, line, pattern)
  and gives the fix.
- **`realmem_status`** repeats the warning, and a remember into the shared store notes
  that the memory will not be committed.
- **`/realmem fix-gitignore`** re-checks, asks for confirmation, and appends the fix.
  Fixes are verified in a scratch copy of the repository's ignore rules before they are
  suggested:

  | Ignored by | Fix |
  |---|---|
  | `.pi/*`, `*.md`, `.pi/**` | `!/.pi/realmem/` and `!/.pi/realmem/**` in `.gitignore` |
  | `.pi/` or `.pi` (the whole directory) | `!/.pi/`, `/.pi/*`, `!/.pi/realmem/`, `!/.pi/realmem/**` in `.gitignore`. Git cannot re-include a file inside an ignored directory, so `.pi` is re-included and everything else in it stays ignored |
  | a nested `.pi/.gitignore` | the negation is added to that file |
  | `.git/info/exclude` or the global excludes file | the negation goes into the committed `.gitignore` |

  Check it yourself with `git check-ignore -v --no-index .pi/realmem/x.md`: no output
  means the store is shared.

## Path scopes and path notes

`paths` in the frontmatter can hold files (`package.json`), directories (`db`) or globs
(`**/migrations/*.sql`, `packages/*/package.json`). When `paths` is not given it
defaults to the root of the store. Nothing is inferred.

| Store | Paths are relative to | Default |
|---|---|---|
| project shared / personal | the project root | `.` (whole project) |
| global | the user directory: `~/…`; absolute paths elsewhere | `~` (everywhere) |

The agent passes paths relative to its cwd, as `~/…`, or as absolute paths, and realmem
stores them in the store's frame. A path outside the project makes the fact global.
Moving a memory between stores (manage page) re-expresses its paths.

- **Shown on touch.** After every tool call, realmem works out which paths it
  touched: path arguments of any tool, and words of `bash` commands that exist on disk.
  Memories whose scope covers those paths are appended to the end of the tool result,
  inside `<realmem-path-notes>`, most specific scope first, then most used. The path
  urgency decides how much is shown:

  | Urgency (score 0–2) | Shown as |
  |---|---|
  | High (≥ 1.5) | full content |
  | Mid (≥ 0.75, or not judged yet) | caption with id |
  | Low | only counted: "N more memories are attached…" |

  Per-result limits (`maxFull`, `maxCaptions`, `charBudget`) demote overflow to
  captions, then to the count. Every memory is shown **once per session branch**. The
  shown ids are stored in `realmem-shown` session entries at each turn end, so reload,
  resume and tree navigation behave correctly. After a compaction, notes shown before
  the first kept entry may be shown again, because the summary no longer contains them.
  Only the path itself, or a location under it, triggers a note. Touching a parent
  directory (e.g. `ls src` for a note on `src/db`) does not. The system prompt is never
  touched.
- **Urgency** is judged when the memory is remembered. For hand-written or edited
  memories it is judged in the background by SemIf, and it is re-judged whenever the
  content or paths change.
- **Recall ranks, never filters, by path**: memories covering the given or recently
  touched paths come first, project-wide ones next, those about other areas last.
- **Missing paths.** At session start, scopes that no longer exist are flagged (✗ in
  `/realmem manage`), with a suggested new location taken from `git log` renames
  (press `f` to apply it).
- **Counters.** `used_count` (recall and reinforce) drives sorting. `path_inject_count`
  records automatic displays and never affects ranking.

## Model integration

- **System prompt**: a `<realmem>` section. It declares realmem as the only memory
  system (ignore MEMORY.md, Claude memory, surmem, and Magic Context's
  `ctx_memory` / `<project-memory>`), tells the model to recall before any work and to
  remember proactively, lists the captions of the most-used project-wide memories, and
  lists the paths that have path notes (for example `db (4), infra/terraform (2)`).
  Path-scoped memories are left out of the caption list, since they appear when their
  paths are touched. The section is computed on the first prompt and stored in the
  session (`realmem-snapshot`), so it stays byte-identical for the whole session,
  including after reload or resume. This preserves the prompt cache.
- **Context files**: AGENTS.md / CLAUDE.md are stripped from the prompt once imported
  (`/realmem import`), because realmem replaces them.
- **Hidden tools**: other memory tools (`ctx_memory` by default) are deactivated, and
  any call to them is blocked with a message pointing to realmem.
- **Import**: `/realmem import` marks context files as imported only when the agent
  actually stored facts from them.
- **Tools**:
  - `realmem_recall(queries?, paths?, ids?, page?, scope?)`: hybrid search. Results are
    ordered by path (memories about the given or recently touched paths first,
    project-wide next, other areas last), then by used_count, then by relevance, and are
    paginated. `paths` alone lists the memories attached to those paths; `ids` reads
    memories that were shown as captions.
  - `realmem_remember(caption, content, scope?, paths?, user_requested?)`: `paths` takes
    files, directories or globs.
  - `realmem_status()`
  - `realmem_list(page?, scope?)`: sorted by path, then used; demoted, since its output
    is large.
- **Skill**: `realmem` covers when and how to recall, remember, pick a scope and correct
  memories.

## Commands

`/realmem` opens a menu, or run a subcommand directly:

| Subcommand | Does |
|---|---|
| `manage [query]` | browse all memories (filter or semantic search); view content and metadata; edit, re-scope, move, delete, approve quarantined ones |
| `settings` | Edit/Merge model, embedding and SemIf endpoints, keys and models, thresholds, limits; built-in connectivity tests |
| `debug` | dry-run the full remember path and show the embedding, neighbours (cos / BM25 / RRF), raw SemIf answers and probabilities, the decision trace and the rewrite diff; `w` writes it for real |
| `add` | remember a fact yourself |
| `import` | the agent splits AGENTS.md / CLAUDE.md into facts |
| `fix-gitignore` | check whether `.pi/realmem` is ignored by git and append the verified fix |
| `status`, `embed`, `reindex`, `retry` | maintenance |

API keys may be given as `$VAR` or `env:VAR` so they are not stored in `config.json`
(which is mode 0600).

## Install

```bash
cd ~/Projects/realmem && npm install
pi install ~/Projects/realmem        # or add the path to "packages" in ~/.pi/agent/settings.json
```

realmem ships with no endpoints or API keys. Open `/realmem settings` and set:

- the **SemIf endpoint** and key. Without it, new memories are only queued; they are
  processed once it is set;
- the **embedding endpoint** and key. Without it, recall and deduplication use keyword
  (BM25) search only.

Keys may be written as `$VAR` or `env:VAR` so they stay out of `config.json`. Then run
`/realmem import` in each project that has an AGENTS.md or CLAUDE.md.

## Development

```bash
npm test          # unit + engine (mock embedding/SemIf servers, multi-process lock) + extension harness
npx tsc --noEmit
REALMEM_HOME=$(mktemp -d) pi -e ./extensions/realmem/index.ts   # isolated data dir
```
