# Profile-Global Hybrid Memory Service (dsh-memory) — State, Architecture & Master Tracker

## Active Goal & Status
- **Goal ID**: `goal-3a075a36-2e3b-4a3b-8ebf-03a2f3651a21` (revision 12, phase `complete`).
- **Objective**: "Implement profile-global hybrid memory service (dsh-memory) with Core Memories, episodic/corpus storage with FTS5 and EmbeddingGemma-2-ONNX, pre-turn passive recall, post-turn background harvesting, and UI controls, conducting code reviews after each feature."
- **Current Task**: Task 17 — embedder setup mechanism (pinned manifest, on-demand download, per-variant cache, prepare UI); implemented and verified.
- **Review Requirement**: Explicit code review after each feature before proceeding to the next.
- **Context Preservation Note**: Compaction checkpoint at Round 8; all architectural invariants, test results (70/70 passing), and completed reviews (Tasks 1-8) preserved.

## Hardware & Environment Constraints
- **Host CPU**: 2-core CPU without AVX-512 VNNI.
- **Inference Constraints**: `onnxruntime` INT8 kernels are slow on 2 cores. Embeddings and extraction passes must NEVER block the user's turn reply path; all dense vector encoding and LLM extraction runs asynchronously in background jobs or off-cycle turn hooks.
- **Thread Count**: ONNX sessions must specify `{ intraOpNumThreads: 1 }` to prevent thread contention.
- **Dependency Resolution**:
  - `plugins/dsh-memory` runs under Node.js 24.21.0.
  - Native SQLite: `node:sqlite` (`DatabaseSync` on SQLite 3.53.4). No external native bindings (`better-sqlite3` forbidden).
  - Native ML: `onnxruntime-node@1.21.0` and `@huggingface/tokenizers@0.2.0` resolve via fallback to `plugins/dsh-tts/` using `createRequire(new URL('../dsh-tts/package.json', import.meta.url))` or local paths.
- **Prompt Cache Preservation**:
  - Volatile dynamic recall injected between user message and assistant turn (capped at 3–5 items, ~350 tokens) to avoid invalidating the static system prompt prefix.
  - Static Core Memories live in `systemPrompt.section` (order 110, static cache).
- **Single-Step Pipelines**: Autonomous multi-turn reflection loops are forbidden. Memory harvesting uses deterministic single-step JSON pipelines off-cycle via `agent/turn-stopping` hooks.
- **SQL Syntax Caution**: SQLite string literals must use single quotes (`'provisional'`), not double quotes in CHECK constraints or DDL.

## Architectural Tiers & Deliverables
1. **Tier 1 — Core Memories**:
   - Table: `core_memories` (`id`, `namespace`, `key`, `directive`, `priority`, `updated_at`, UNIQUE(`namespace`, `key`)).
   - Channel: `systemPrompt.section` (order 110, static cache).
   - Controls: Agent tool `manage_core_memory`, plus dedicated Web UI tab alongside Chat and Trajectory.
2. **Tier 2 — Passive Recall**:
   - Table: `memories` (episodic memories filtered by namespace, category, status).
   - Channel: Injected as runtime context between user message and assistant turn (3–5 items, ~350 tokens).
   - Triggers: Fast regex/entity matching or lightweight single-step probe.
3. **Tier 3 — Active Tool Search**:
   - Agent tools: `search_memories`, `store_memory`, `search_reference`.
4. **Tier 4 — Offline Corpus**:
   - Table: `corpus_chunks` (`id`, `collection`, `source_path`, `chunk_index`, `title`, `content`, `text_ratio`, `fts_only`, `embedding`, `updated_at`).
   - Ingestion: `scripts/ingest-corpus.mjs` (chunking ~1800 chars with 200 char overlap).

## Hybrid Retrieval Engine (DigUp Adaptation)
- **Dense Embedding**:
  - Primary: `onnx-community/embeddinggemma-2-ONNX` (270M text backbone, 8,192 token context, MRL truncated to 256-d float16 BLOB = 512 bytes per chunk).
  - Fallback: `all-MiniLM-L6-v2` (384-d float16 BLOB = 768 bytes).
  - Models cached under `$DSH_HOME/models` (or fallback `$DSH_HOME/cache`).
- **Task Formatting Prefixes**:
  - Queries: `task: search result | query: <text>`
  - Passages/chunks: `title: <title|none> | text: <text>`
- **Text Gating**:
  - Chunks with < 20% alphabetic letters skip dense vectors (`fts_only = 1`).
- **Vector Serialization**:
  - `Float16Array` (Node 24 native support) serialized as binary Buffer in SQLite BLOB.
- **DigUp Z-Score Hybrid Ranking Engine**:
  - Cosine similarity between Float16 query vector and candidate vectors:
    $$\cos(\mathbf{q}, \mathbf{c}) = \frac{\mathbf{q} \cdot \mathbf{c}}{\|\mathbf{q}\| \|\mathbf{c}\|}$$
  - Candidate distribution calibration:
    Calculate mean $\mu$ and standard deviation $\sigma$ across candidate similarities:
    $$z = \frac{s - \mu}{\sigma}$$
  - Candidate Gate: Admitted if $z \ge 2.0 \lor \text{coverage} \ge 0.50$.
  - Scoring Formulas:
    - General queries:
      $$\text{Score} = \max(z, 0) + 2.0 \times \text{coverage}^{1.5} + \text{type\_bonus}$$
      where `type_bonus` = 0.5 for core memories, 0.2 for episodic, 0.0 for corpus.
    - Identifier-heavy queries:
      $$\text{Score}_{\text{ID}} = 0.5 \times \max(z, 0) + 4.0 \times \text{coverage}^{1.5}$$
  - Source Deduplication:
    - Max 1 hit per source file for corpus chunks (keep highest scoring chunk).

## Implementation Roadmap & Progress
1. Update design docs in `docs/global-plugins.md` [COMPLETED]
2. Code review documentation updates [COMPLETED]
3. Implement SQLite storage and FTS5 schema in `plugins/dsh-memory` [COMPLETED]
   - Files: `plugins/dsh-memory/schema.js`, `plugins/dsh-memory/storage.js`, `plugins/dsh-memory/tests/storage.test.mjs`
   - Verified: 26/26 unit tests passing.
4. Code review SQLite storage and FTS5 schema [COMPLETED]
5. Implement dense vector embedding substrate and DigUp z-score hybrid ranking engine [COMPLETED]
   - Files:
     - `plugins/dsh-memory/embedding.js`
     - `plugins/dsh-memory/ranking.js`
     - `plugins/dsh-memory/tests/ranking.test.mjs`
   - Verified: 30/30 unit tests passing (230ms).
6. Code review embedding substrate and hybrid ranking engine [COMPLETED]
   - Hardware & Threading: `intraOpNumThreads: 1` explicitly enforced in `EmbeddingEngine`.
   - Text Gating: `<20%` alphabetic Unicode letters skips vector generation (`shouldBypassDenseEmbedding`).
   - MRL & Serialization: Truncation to 256 dimensions with L2 normalization producing native `Float16Array` (512-byte SQLite BLOB).
   - DigUp Scoring & Gate: Adaptive z-score distribution normalization ($z = (s - \mu) / \sigma$), candidate admission gate ($z \ge 2.0 \lor \text{coverage} \ge 0.50$), identifier-heavy query detection, corpus chunk deduplication (max 1 chunk per source file).
7. Implement Core Memories storage, prompt section injection, and agent tools [COMPLETED]
   - Files:
     - `plugins/dsh-memory/core.js` (CoreMemoryManager, `formatCorePromptSection`, `createCorePromptSectionDescriptor`, `createManageCoreMemoryTool`).
     - `plugins/dsh-memory/tests/core.test.mjs` (14 unit tests covering CRUD, XML ordering, prefix cache integrity, error handling, tool execution, bounding).
   - Invariants Enforced:
     - Deterministic XML format `<core_memories>` sorted by `priority DESC` then `key ASC` (`String(a.key).localeCompare(String(b.key))`).
     - Static Prefix Cache Integrity: `name: 'memory:core'`, `order: 110`, `interpolate: false`, empty string return on 0 memories.
     - Defensively Bounded Tool Execution: `manage_core_memory` caps `list` results at 100 entries (`MAX_TOOL_LIST_RESULTS = 100`).
     - Conformance: Compatible with `@deepseek-ai/dsh-tools` `defineTool` compilation.
   - Verified: 14/14 unit tests passing; 70/70 total suite tests passing (26 storage + 30 ranking + 14 core).
8. Code review Core Memories implementation [COMPLETED]
   - Static Cache Preservation Audit: Verified `interpolate: false` prevents mustache evaluation crashes on variable templates (e.g. `{{user}}`). Verified section order `110` places core memories right after base instructions (`100`) and before policies (`500`). Verified that when 0 memories exist, `""` is returned to drop the section without injecting empty XML tags.
   - XML Serialization & Tie-breaker Audit: Verified XML entity escaping for characters (`&`, `<`, `>`, `"`) in both attributes and directive bodies. Verified primary sort `priority DESC` and secondary tie-breaker `String(a.key).localeCompare(String(b.key))` prevents cache churn across restarts.
   - Tool Execution & Transcript Protection Audit: Verified `manage_core_memory` bounds `list` results to `MAX_TOOL_LIST_RESULTS` (100 items), preventing transcript bloat and LLM provider timeouts. Verified structured JSON return with `{ success, action, ... }` and error containment for invalid actions or parameters.
   - Concurrency & Storage Safety Audit: Verified synchronous SQLite operations (`DatabaseSync`) on in-memory and persistent databases; added `{ inMemory: true }` constructor options support.
9. Implement Cordis Service (`ctx.memory`), standalone/integrated HTTP REST server (`http://127.0.0.1:3180`), and MCP tools [COMPLETED — plugin.js + route.js implemented; deferred webServer mount; standalone server fallback; agent tools registered; code review passed (Task 9)]
10. Code review Service and MCP interfaces [COMPLETED — service exposes store/search/searchMemories/searchReference/getMemory/updateMemoryStatus/deleteMemory/core CRUD/status; REST endpoints bounded; standalone server available; tool results capped at 20; pure dispatcher with Buffer body verified]
11. Implement pre-turn passive recall and post-turn background harvester hooks [IN PROGRESS — agent/pre-step (waterfall, bounded 5-item recall injection) and agent/turn-stopping (serial, non-blocking harvest pipeline with setTimeout) implemented in plugin.js]
12. Code review pre-turn and post-turn lifecycle hooks [COMPLETED — waterfall mode verified (next called, message injection bounded at 3 items), serial mode verified (no next, non-blocking setTimeout harvest, bounded 1200-char content, provisional status)]
13. Implement Core Memories Web UI component [COMPLETED — `client.js` registered under `settings.plugins.tab`, uses `React.createElement`, inline styles with `--dsw-alias-*`, REST `/core` fetches, defensive error handling]
14. Code review Core Memories Web UI component [COMPLETED — tab registration verified (`settings.plugins.tab`), React.createElement, inline styles, `--dsw-alias-*` tokens, REST interface, bounded fetching, defensive error handling]
15. Run integration tests and verify full memory lifecycle [COMPLETED — `integration.mjs` covers service init, core/episodic lifecycle, search bounds, REST dispatcher, plugin exports, client module load; suite has since grown to 44 assertions]
16. Implement the embedder setup mechanism (download on demand instead of a hardcoded path) [COMPLETED]
   - Files: `plugins/dsh-memory/assets.json` (new), `plugins/dsh-memory/download.js` (new), `plugin.js`, `client.js`, `route.js`, `integration.mjs`
   - Manifest: real sha256 for every pinned file at revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`; LFS entries use the tree API `oid`, non-LFS files were fetched from that revision and hashed locally. Four variants (`q8`, `q4f16`, `fp16`, `fp32`), each pairing its graph with the `.onnx_data` weights the graph cannot load without.
   - Download: size check before hashing, streamed `.part` file with an overrun abort, atomic rename on publish, and an unverified digest is refused rather than trusted.
   - Cache: `$DSH_HOME/models/embeddinggemma-2-ONNX/`, overridable with `config.modelsPath`.
   - Interfaces: `GET /api/memory/status` (phase, reason, pin state, per-file counts, variant catalogue) and `POST /api/memory/prepare-embedder` (202, fire-and-forget).
   - Verified against the live pin: all five `q8` assets downloaded and digest-verified (346 MB), a second call served from cache, a wrong digest refused as `integrity`, and a partial cache reported as `incomplete cache (n/m files)`.
17. Code review embedder setup mechanism [COMPLETED]
   - Non-blocking audit: preparation is fire-and-forget; `apply` never awaits it, so no turn can be delayed by a download.
   - Bounding audit: one download per variant at a time (a second call joins the run), no unbounded arrays, per-file progress only.
   - Cache-isolation audit: live preparation state is matched on variant **and** cache root, so a status poll for `q4f16` cannot inherit `q8`'s download.
   - Defect found and fixed during review: the mounted route's `embedderStatus` arrow dropped its `variant` argument, so every panel read the default variant's cache. Now forwarded, with a regression assertion that drives the real mount path.
   - Defect found and fixed during review: `ENOENT`/`EACCES`/`EROFS` classified as `unknown`; filesystem failures now report `storage`.
   - Defect found and fixed during review: `readFileSync` was not imported, so the manifest silently failed to load and every asset read as unpinned.
   - Verification: 44/44 integration assertions, 70/70 unit tests, standalone HTTP checked end to end.

18. Wire the downloaded weights into the live service [COMPLETED]
   - `apply` attaches a real `EmbeddingEngine` when the cache is complete; construction stays synchronous and the ONNX session loads on first embed.
   - A download finishing after `apply` returns swaps the engine in through a module-level service reference, so the weights take effect without a restart.
   - An empty or partial cache leaves the deterministic embedder in place: a half-downloaded model never becomes the active embedder.
   - Verified: 47/47 integration assertions, 70/70 unit tests.

19. Ingestion substrate: content-hash registry, chunker, and engine [COMPLETED]
   - `schema.js` (v2): `corpus_sources` registry — one row per ingested source holding
     `content_hash`, `origin`, `namespace`, `bytes`, `chunk_count`. Additive DDL, so an
     existing database picks it up without a table rewrite.
   - `storage.js`: `getCorpusSource`, `upsertCorpusSource`, `deleteCorpusSourceRecord`,
     `listCorpusSources`; `deleteCorpusSource` now clears the registry row too, so a
     source with no chunks cannot keep a hash that makes the next run skip it.
   - `chunker.js`: ~1,800-char chunks with ~200-char overlap, cut on paragraph then
     sentence then word boundaries; a piece too small to stand alone rides with its
     neighbour instead of becoming a 12-character chunk; `deriveTitle`, `looksBinary`,
     and a 500-chunk ceiling.
   - `ingest.js`: `ingestText`, `ingestFile`, `ingestPaths`, `walkFiles`, `hashContent`,
     `isTextFile`. Re-ingestion is decided by sha256 of the content, replace-not-merge on
     change, per-source failure records, a 2 MB source cap, and a 2,000-file walk cap.
   - `service.js`: corpus-source passthroughs.
   - Verified: 28 new unit tests, 98 total unit tests, 47 integration assertions.
20. Code review of the ingestion substrate [COMPLETED]
   - Defect found and fixed: `service.storeCorpusChunk` called `storage.upsertCorpusChunk`,
     which does not exist. Every corpus write would have thrown; no prior test reached it.
   - Defect found and fixed: `createDeterministicEmbedder` received `{ dimensions: 256 }`
     where it expected a number, so it built a zero-length vector. Dense retrieval was
     silently contributing nothing and every dense score read 0. It now accepts both
     shapes, and a test asserts 512-byte vectors on disk.
   - Defect found and fixed: an implicit per-target root gave the same file two identities
     (walked vs named directly), which would double-index it. Paths are now relative only
     when the caller supplies `root`, and absolute otherwise.
   - Defect found and fixed: the dry-run summary reported neither `would-ingest` nor
     unsupported files, so a dry run looked like it had found nothing.
   - Defect found and fixed: a lone heading became its own 12-character chunk; a
     minimum-standalone rule now merges it forward.

21. Workspace-level ingestion CLI [COMPLETED]
   - `scripts/ingest-corpus.mjs`: named paths plus the defaults (`docs/`, `corpus/`), and
     the configured inbox (`$DSH_HOME/memory-inbox`) with `--inbox` / `--inbox-only`.
   - Flags: `--collection`, `--root`, `--origin`, `--namespace`, `--storage`, `--models-path`,
     `--force`, `--dry-run`, `--json`, `--list`, `--help`. Hand-rolled parsing, no dependency.
   - Re-runs skip unchanged content by hash; a dry run plans chunks without embedding them.
   - Verified: 16 CLI unit tests.
22. Code review of the workspace CLI [COMPLETED]
   - Defect found and fixed: a run with no cached model silently indexed with the
     deterministic embedder. It now warns, and `--models-path` selects the cache.
   - Defect found and fixed: `MemoryService` swallowed embedding failures with a bare
     `catch`, so a broken model looked like a working one. The first failure is now
     reported once, and the chunk is stored without a vector rather than lost.
   - Defect found and fixed: a dry run printed `?` for the chunk count; it now chunks to
     report the real number.
   - Defect found and fixed: a path the caller named but which does not exist exited 0.
   - Verified end to end: dry run, real run, skip-on-rerun, `--json`, `--list`, inbox
     ingestion, exit codes, and the FTS-only fallback when the model is corrupt.

23. Session-level ingestion [COMPLETED]
   - `ingest_reference` agent tool: indexes a document the model or user supplies during a
     session, into a named collection (default `session`), under namespace `session:<id>`.
     Identity is a caller label or `session:<id>/<hash12>`; identical content is a no-op.
     Input is capped at 200,000 characters and the chunker caps a document at 500 chunks.
   - Transcript capture on `agent/turn-stopping`: one completed turn becomes one source in
     the `transcripts` collection, `session:<id>/turn-<n>`, namespace `session:<id>`,
     origin `transcript`. Only genuine player input is captured — an injected recall block
     is excluded — and the document is capped at 16,000 characters with the truncation
     stated in the body. Disable with `captureTranscripts: false`.
   - Verified: 18 tests covering the tool contract, hashed labels, replacement, size
     refusals, transcript identity, injected-context exclusion, repeat skips, the config
     switch, aborted turns, truncation, and searchability.
24. Code review of session-level ingestion [COMPLETED]
   - Defect found and fixed: the post-turn hook fired for subagent sessions, which would
     have indexed child-agent scaffolding as both episodic memories and transcripts. Both
     paths now return early when `session.header.origin === 'subagent'`, matching the rule
     the dd35 preset already documents.
   - Bounding audit: one ingest per turn, chunk count bounded at 500, transcript bounded at
     16,000 characters, tool input bounded at 200,000 characters.
   - Non-blocking audit: transcript capture runs from `setTimeout`, so no turn waits on it.
   - Identity audit: per-turn and per-session keys make the content hash decide repeats,
     so re-deriving an unchanged turn is a skip rather than a duplicate.

25. Manual document ingestion through the UI [COMPLETED]
   - `inbox.js`: `writeUpload` writes the document into the configured ingestion folder
     first and indexes it second, so an indexing failure still leaves a durable file that
     the workspace CLI picks up on its next run. `listInbox`, `removeInboxFile`,
     `sanitizeUploadName`, `sanitizeCollection`, `defaultIngestFolder`.
   - REST: `POST /api/memory/corpus/upload` (text or base64, 201 on success, 400 on a
     refused upload, 503 when unwired) and `GET /api/memory/corpus/sources` (sources plus
     inbox contents, capped at 100).
   - Client: a Reference documents card with a file picker, a collection field, an upload
     status line, and the indexed-source list.
   - Verified: 19 inbox and REST tests, plus 11 integration assertions covering the
     workspace, session, and upload paths together.
26. Code review of the UI upload path [COMPLETED]
   - Security audit: a traversal filename is reduced to its basename before it is used, so
     `../../escape.md` lands inside the inbox and cannot reach a parent directory; a
     traversal collection falls back to `uploads`. A delete refuses a name carrying a path
     outright, rather than silently acting on its basename.
   - Bounding audit: uploads are capped at the 2 MB source limit, the supported-extension
     list is enforced before anything is written, and both new endpoints cap their lists.
   - Defect found and fixed: the corpus routes only matched their full `/api/memory/...`
     form, so the short paths the integration suite exercises answered 404.
   - Verified end to end over HTTP: upload, base64 upload, refused extension, missing
     fields, unwired handler, source listing.

27. End-to-end verification and documentation [COMPLETED]
   - Verified over HTTP against a live standalone server: the CLI indexed a workspace file as
     `docs/notes.md`; a UI upload wrote `uploads/handout.md` into the configured inbox and
     indexed it; hybrid search returned the uploaded document with score 2.00; and
     `/api/memory/corpus/sources` listed it with origin `upload` alongside the inbox contents.
   - `docs/global-plugins.md`: new "Corpus Ingestion (four entry points, one engine)" section
     — the entry-point table, content-hash re-ingestion, the `corpus_sources` registry,
     chunking parameters, the bounds, the ingestion folder, and the commands/endpoints.
   - Suite totals: 151 unit tests across seven files, 59 integration assertions.
28. Transcript shape adopted from the dd35 preset [COMPLETED]
   - A captured turn now reads `# Turn NNNN — <title from the player's first line>`, with
     one-line metadata beneath it (`Session`, `Captured`, `Tools`, `Player-Message`) and the
     exchange under `## User` / `## Assistant`. Turn numbers are zero-padded so a plain-text
     reader sorts them lexicographically, and the header sits at the front so it survives a
     truncation. Tool names are de-duplicated in call order and read defensively, since the
     field has moved before.
   - Decision recorded: transcripts are meant to accumulate for the life of a session. No
     retention or pruning policy is wanted, so its absence is not a gap.
   - Verified: 20 session tests, including the full header and the case where metadata is
     absent — nothing renders as `undefined`.

29. Vector provenance: tag, filter, report, offer [COMPLETED]
   - Decision (recorded below): tag each vector with a model id, filter on read, and offer
     re-embed or purge; report the mismatch, never act on it automatically.
   - `schema.js` v3 adds `embedding_model` to `memories` and `corpus_chunks`, with an
     idempotent `PRAGMA table_info` migration so a v2 database opens as v3 with its rows
     intact.
   - `embedding.js`: `embeddingModelId(modelType, dimensions)` names the network and the
     dimension and deliberately excludes the quantisation file, so `q8` to `q4f16` keeps
     every vector. Both embedders expose `modelId`.
   - `storage.js`: writes tag the vector; both vector-candidate queries take an optional
     `model` and filter on it; new `listVectorModels`, `countForeignVectors`,
     `findUnembedded`, `setEmbedding`, `purgeForeignVectors`.
   - `service.js`: `activeModel`, `vectorStatus` (foreign and missing reported separately,
     because the remedies differ), `reembedMissing` (bounded steps), `purgeForeignVectors`;
     `status()` carries the report.
   - Interfaces: `POST /api/memory/vectors/reembed`, `POST /api/memory/vectors/purge`, CLI
     `--vector-status` / `--purge-vectors` / `--reembed`, and the settings card's Vector
     index panel with both buttons.
   - Verified: 24 new unit tests, 9 new integration assertions, and a live CLI run showing
     status, a foreign tag, purge, re-embed, and a clean index.

30. Code review of vector provenance [COMPLETED]
   - Correctness audit: dense candidates never cross spaces — the queries filter on
     `embedding_model`, and a test stores the *same* vector under two tags to prove each
     encoder sees only its own rows.
   - Non-destructive audit: purge and re-embed both leave text, tags, status, and
     provenance fields intact; tests assert row counts and content survive a purge, and
     that a re-embed changes only the vector and its tag.
   - Honesty audit: an untagged legacy vector counts as foreign rather than trusted, since
     its space is unknown; `vectorStatus` reports foreign and missing separately because
     only one of them can be purged.
   - Failure audit: a throwing embedder records the first failure, leaves the item pending
     for the next attempt, and reports `ok: false` rather than half-writing.
   - Bounding audit: `findUnembedded` and `reembedMissing` are capped (500 / 1000), so one
     call is a step rather than a marathon; the CLI loops until `remaining` is zero.
   - Defect found and fixed during the work: `createDeterministicEmbedder` had been
     receiving an options object where it expected a dimension count, so every fallback
     vector was zero-length and dense retrieval silently contributed nothing. Caught while
     wiring the model tag, which is the first code that read the vector's identity.
   - Defect found and fixed during the work: the three `ALTER TABLE`-style queries were
     hand-written against a v2 schema; the migration now adds the column idempotently and
     a test proves a v2-shaped table opens with its rows.
   - Verified: 177 unit tests, 68 integration assertions, all passing.

31. Pre-restart review: gaps that would have shown up live [COMPLETED]
   - **The bundle was never registered.** `package.json` declared
     `dsh.bundle.patch: ./cordis.patch.yml`, and that file did not exist; the `web`
     profile listed neither the dependency nor the bundle. A restart would have loaded
     nothing. Fixed: the patch file now exists (no `!!js` tags, so the TTS bundle's
     "expression did not survive the profile override" trap cannot recur), and
     `scripts/register-memory-bundle.py` registered the dependency, the bundle, the
     `node_modules/@local` symlink, an override row carrying a generated API token, and
     an HMR watch entry. Profile files were backed up as `*.pre-memory`.
   - **The HTTP surface was open by default.** `enabled` defaulted true and an empty
     token skipped the bearer check, so `GET /status`, `POST /vectors/purge`, and
     `POST /prepare-embedder` were served to any caller that could reach the port, on a
     host the harness binds to the network. Proven, then fixed: no token now answers 503
     with the instruction, `apiAllowAnonymous: true` is the explicit opt-out, and the
     comparison is constant-time. Five integration assertions pin it.
   - **The browser half had no credential.** The settings panel sent no bearer, so it
     would have 401'd the moment a token was configured. The host now injects
     `window.__DSH_MEMORY__` through `tapIndex`, as TTS does, and the client reads it.
   - **Recall ran on every model step, not every turn.** `agent/pre-step` fires per step,
     so each one re-embedded the query and searched. Now guarded to `step === 1`, the
     idiom the shipped context plugins use.
   - **Transcript capture could stack.** It runs off the turn, so a slow embedder let
     turns queue behind each other. Guarded per session: one capture at a time for a
     session, never one session queued behind another.
   - Verified: 179 unit tests, 73 integration assertions, all passing.

32. Activation failure on first live start: undeclared service [COMPLETED]
   - **Symptom:** the row failed to activate — `memory (…/plugin.js): Error: cannot get
     property "systemPrompt" without inject` — and the launcher reported it as
     "1 entry did not activate".
   - **Cause:** `plugin.js` read `ctx.systemPrompt` and `ctx.tools` while declaring
     `export const inject = []`. A direct property read on an undeclared service throws;
     optional chaining does not soften it (docs/lessons-learned.md §1.1). The TTS bundle
     declares `['tools']` and the dd35 preset declares `['systemPrompt']` for exactly this
     reason.
   - **Fix:** `export const inject = ['systemPrompt', 'tools']`. `webServer` stays out of
     the list on purpose: it may arrive after this row applies, so it is awaited through
     `ctx.inject(['webServer'], ...)` and only ever looked up optionally through
     `ctx.get('webServer')`.
   - **Guard added:** `tests/plugin-load.test.mjs` scans the source (comments stripped)
     for every `ctx.<name>` read and asserts each one is declared in `inject`, plus that
     `webServer` is never declared or read as a property. Verified to fail with the exact
     message above when `inject` is emptied, and to pass when restored.
   - Verified: 184 unit tests, 73 integration assertions.

33. Right-pane Memory tab, and the endpoints it needs [COMPLETED]
   - `client.js` now registers three things: the existing configuration panel
     (`settings.plugins.tab`, id `memory-core`), and a tab **type** for the right
     Sidebar — `ctx.sidebarRightTabs.register({ id: '@local/dsh-memory', kind: 'memory',
     title, keepMounted: true, guide: [...] })` — with a body seat
     (`sidebar.right.pane.tab`, keyed by the type id) and a title seat
     (`sidebar.right.pane.tab.title`). Client `inject` grew to
     `['slots', 'sidebarRight', 'sidebarRightTabs']`.
   - The tab is the working surface: corpus search over `POST /search`, upload into a
     named collection, the ingestion folder with per-file Re-index and Delete, the indexed
     sources with Forget, and the vector report with Re-embed and Drop. The settings panel
     stays as the configuration surface, as chosen.
   - New routes: `POST /api/memory/corpus/remove` (forget a source; `inbox: true` also
     deletes the file, so the default is the reversible one) and
     `POST /api/memory/corpus/reindex` (force one inbox file back through the engine).
   - Behaviour fix found while wiring them: `ingestUpload` recorded the file's **absolute**
     path, so a source could not be removed by the name the UI showed. Uploads now record
     `collection/file.md`, relative to the inbox, matching what `--root` produces for the
     CLI.
   - Verified: 26 inbox/route tests, 9 client contract tests, 200 unit tests in total.
34. Code review of the right-pane tab [COMPLETED]
   - Contract audit: the body and title seats are keyed by the tab type's `id`, and the
     test asserts that equality — a mismatch renders nothing, silently. Proven by
     introducing the mismatch and watching the test fail.
   - Reachability audit: a page type needs a `guide` entry to be openable by a person, so
     the test requires one; `patterns` must be absent, or the type would contend for file
     addresses the browser type already claims.
   - Silent-failure audit: the client suite evaluates the real bundle against a
     `window.__ModuleLoader__` shim and asserts the declared `inject`, the two surfaces,
     the tab type, and that no token literal is embedded.
   - Service-declaration audit: `plugin-load.test.mjs` covers the host half; the client
     half is covered by the same idea in `client.test.mjs`.
   - Reversibility audit: removing an indexed source and deleting the uploaded file are
     separate actions, and the default only does the first.

35. Memory tab styling rebuilt on real tokens [COMPLETED]
   - **Symptom:** the tab rendered as pale cards behind dark form controls.
   - **Cause:** every `var()` named a token that does not exist
     (`--dsw-alias-surface-subtle`, `--dsw-alias-text-muted`, `--dsw-alias-border-subtle`,
     `--dsw-alias-text-danger`, `--dsw-alias-surface-interactive`,
     `--dsw-alias-font-monospace`), so each one fell through to its hard-coded **light**
     fallback. Form controls were left at user-agent styling, so the browser drew them in
     its own theme on top of those pale cards.
   - **Fix:** the 103 tokens the harness actually defines were extracted from
     `packages/client` and `apps/web` and are recorded in
     `docs/dsh-memory-right-pane-tab.md`, with a mapping table. The client now uses
     `bg-layer-2`, `border-l2`, `separator-primary`, `label-primary`/`-secondary`/`-tertiary`/
     `-caption`, `label-error`, `state-success-primary`, `button-primary-fill`,
     `button-elevated-fill`, and `fill-l1`, and every form control carries explicit
     `background`, `color`, and `border`.
   - **Layout fixes:** the duplicated "Memory" heading and the prominent session id are
     gone; sections share one `Panel` shape with a header, a count, and optional actions;
     empty states are a single muted line instead of a full-height card; the Search button
     has a visible primary fill and label; row actions use a consistent small button.
   - **Guard added:** `client.test.mjs` renders every exported component and asserts none
     draws `undefined` — the symptom of a mistyped field name, which is invisible until
     someone reads the pane. A token check was run against the recorded list, and no
     invented name remains.
   - Verified: 201 unit tests, 73 integration assertions.

36. Chat memory is canon, recall is chronological, and the layer is off by default [COMPLETED]
   - **Harvest writes `canon`.** The post-turn record is the turn's exchange
     (`Player: …` / `Assistant: …`), not just the reply, with the turn number and date in
     its tags and `turn_ref`. `provisional` remains in the schema for a future explicit
     proposal flow, but nothing writes it by default.
   - **Recall shows chronology.** The injected block is sorted oldest-first and each line
     carries `[turn N · YYYY-MM-DD]`; core directives are dated from `updated_at`. A
     memory's uuid no longer leaks into the block, since it is not something the model can
     act on.
   - **The passive layer is off by default.** `recallEnabled` in the plugin config is a
     fallback; the real decision is a per-preset table in `$DSH_HOME/memory-recall.json`,
     read through its mtime so an edit lands without a restart. Precedence: the preset's own
     entry, then the document default, then the config. A missing file is off; a **malformed**
     file is off too, because a broken file is not consent.
   - Preset rather than workspace: the layer changes what the agent sees, and a preset is the
     agent's identity while a workspace is only a folder.
   - A disabled layer costs one boolean test per turn: `agent/pre-step` returns the
     downstream decision untouched, so no search, no embedding, no message is built. The row
     stays mounted, so enabling it later needs no restart.
   - Interfaces: `GET`/`POST /api/memory/recall-policy`, `status.presets` from the live
     `agentPresets` registry, and a Passive recall card in Settings with a checkbox per
     preset.
   - Verified: 212 unit tests (12 new for the policy, 3 new for canon and chronology),
     73 integration assertions.

## Remaining work
- Only `q8` has been downloaded and digest-verified on this host (346 MB, all five assets). `q4f16`, `fp16`, and `fp32` share the same code path but have not been fetched end to end.
- Retrieval quality with a real encoder has not been measured on this 2-core host. The deterministic embedder exercises the plumbing, not the model.
- Re-embedding has no progress channel: `reembedMissing` returns after one bounded step, so a large corpus is many calls with only a count to go on, not an estimate of the remaining cost.
- A crash-orphaned `.part` file is left behind after an interrupted download (the normal error path removes it). Neither this plugin nor `dsh-tts` sweeps stale `.part` files on startup.
- `removeInboxFile` exists in the module and is covered by tests, but no route or UI control calls it, so an inbox file cannot be deleted from the product surface yet.

## Decision record — re-embedding when the encoder changes

Settled in task 29, after weighing three shapes:

- **Chosen: tag, filter, offer a scoped purge.** Every embedding records
  `network@dimension`; retrieval joins only matching vectors; the two remedies are
  explicit actions. Switching `q8` ⇄ `q4f16` costs nothing because they share a space.
- **Rejected: a database per model variant.** It would discard good vectors on a
  precision change, and would make a core memory set under one encoder disappear under
  another — which contradicts Tier 1's purpose.
- **Rejected: a separate vector database per model id.** Workable and non-destructive,
  but a second file with its own consistency rules for no benefit the tag does not
  already provide.

## Process note — a self-inflicted wound worth remembering

Rebuilding the tab's render, I twice replaced the wrong region of `client.js`: my slice
bounds were computed from the first line matching a style literal, which occurred earlier
in the file than the component I meant. The first attempt silently clobbered `MemoryRow`
and left an unbalanced brace. Recovery cost several edits and most of a context window.

Two rules follow, and they are cheap:

1. Anchor a replacement on a line that is **unique to the target** (a function's own
   opening line, not a style literal several components share) and assert the anchor before
   writing.
2. Balance-check generated code before writing it. A regex that strips string literals and
   compares `(` against `)` caught the second attempt's error before it reached the file;
   without it, both attempts looked plausible.

The public API of the file (`__components`, the three registrations) is what the tests
assert, so a clobbered component was only visible as a syntax error rather than as a wrong
behaviour. Widening `client.test.mjs` to render every exported component closes that gap.

## Decisions taken after the first live test

### 1. Nothing from the chat is provisional

The post-turn episodic harvest currently writes `status: 'provisional'`, and recall
requires `status: 'canon'` — so the automatic layer was **write-only**. The decision:

> If it exists in the chat, it is a memory. If the model wrote a memory by hand, it wants to
> recall it later. There is no need for anything to be provisional by default.

So:

- the harvester writes `canon`, the same as the explicit `store_memory` tool;
- the harvested record captures the **turn's exchange** (the player's message and the
  reply), not just the reply, because the exchange is what "exists in the chat";
- `provisional` stays in the schema and in `updateMemoryStatus`, but nothing writes it by
  default. It remains available for a future explicit proposal flow.

### 2. Recall must show chronology

Retrieved items need their order and date visible, because a memory's meaning depends on
when it happened. The injected block is to carry a turn reference and a date per item and
read in chronological order, rather than as an unordered list of scores.

### 3. The passive layer is off by default, switched per preset

`recallEnabled` defaults to **false**. It is enabled from Settings, per preset, following
the `dsh-tool-result-policy` pattern already in this repo:

- the policy lives in a JSON file under `$DSH_HOME`, keyed by preset id;
- the shipped `agentPresets` registry supplies the preset list, so a new preset appears
  without editing the plugin;
- the hook resolves the agent's preset from `session.header.agentPreset` (the idiom
  `plugins/dsh-tool-result-policy/pass.js:93` uses) and returns early when it is off;
- a plugin row that is mounted but disabled must do nothing and cost nothing — no
  unmounting required, just an early return from `agent/pre-step`.

Preset rather than workspace: the passive layer changes what the *agent* sees, and a
preset is the agent's identity. A workspace is a folder, and two sessions in one folder can
run different presets.

## Open question — forks, and what "session-specific memory" means

Asked at the end of the live-test round: *"for the session-specific memory configs and
databases and such, how are we dealing with forks?"* Honest answer: **there is no
fork-specific handling, and there are no session-specific databases.**

### What exists, verified in code

- **One database.** `$DSH_HOME/storages/memory.db` (`config.storagePath` overrides it).
  Nothing is per session. One profile, one file.
- **One namespace for episodic memory.** The harvester and the explicit `store_memory` tool
  both write the plugin's single `config.namespace` (default `global`). Recall searches that
  same namespace. So memory is profile-global and shared by every session, fork or not.
- **Session identity appears in the corpus only.** Transcript capture writes
  `sourcePath: session:<id>/turn-<n>` and `namespace: session:<id>` as a *corpus source* row,
  and recall never searches corpus, so that namespace is currently bookkeeping.
- **Lineage is available.** `session.header.parentSession` is a real, validated field
  (`packages/core/session/src/types.ts:107,153`), and a subagent session is created with
  `parentSession: liveSource.id` (`index.ts:1251`). So a fork or a derived session can be
  detected from the header without guessing.

### The risks a fork creates today

1. **Duplicate transcripts.** A fork's `agent/turn-stopping` fires with the inherited
   history in `deriveMessages()`. Content-hash skipping is keyed on
   `(collection, source_path)`, and `source_path` contains the session id, so the child's
   copy of an inherited turn is a *new* source: chunks and embeddings are written twice, and
   both copies match in search. Corpus dedup is per `source_path`, so it does not help.
2. **Duplicate episodic memories.** The same inherited exchange is harvested again as a new
   `canon` memory under the child's turn number.
3. **Recall is not session-scoped at all**, so a fork sees the parent's memories. That may be
   right for a profile-global memory, but it is currently an accident of the single
   namespace rather than a decision.
4. **No cleanup.** Nothing removes a session's memories when the session is deleted or
   abandoned, and there is no route or tool that does.

### The fork cut, verified

A forked session inherits an **event prefix**: `buildForkSeed`
(`packages/core/session/src/fork.ts`) copies the source log up to an inclusive boundary, marks
it with a `session/end-seed` whose data is `{ inherited: true }`, and closes the open tail
with `{ kind: 'forked' }` turn closers. The session then exposes
**`readonly inheritedEventCount: SessionLogOffset`** (`packages/core/session/src/index.ts:465`)
— the durable fork cut, decoded from storage on reload.

So `deriveMessages()` on a fresh fork returns the whole inherited conversation, and the
child's first `agent/turn-stopping` sees the parent's last exchange as "the latest assistant
message". That is the exact mechanism by which a fork duplicates:

- the transcript source (`session:<child>/turn-<N>` is a new identity for old words), and
- the episodic memory (the same exchange stored again, as `canon`).

`inheritedEventCount` is the field a fix keys on. A turn whose events all fall inside the
inherited prefix is the parent's, not the child's, and must not be captured. The check
belongs in the `agent/turn-stopping` hook before either the harvest or the transcript write.

### Options, not yet chosen

- **A. Ignore lineage; keep one shared memory.** Defensible: memory is profile-global by
  design. Requires only fixing the duplication (skip capture for turns inherited from a
  parent) and saying so in the docs.
- **B. Scope by session lineage.** Episodic namespace becomes the *root* session id, so a
  fork shares its parent's memory while an unrelated session does not. Needs a root-id walk
  up `parentSession`, and a decision about whether recall unions root + child.
- **C. Scope by session strictly.** Namespace is the session id; a fork starts empty. Most
  isolation, least useful for a fork that was made to continue the same work.

Recommendation: **A plus the duplication fix**, then revisit if per-session isolation is
actually wanted. The duplication is a defect either way, and it is independent of the
scoping choice.

## Decided — fork semantics

The user's answer, verbatim: *"A fork should inherit the transcript memories up to the
forking point. No sharing memories between forks."* and, for cleanup, *"an explicit
forget-session action to pair with a re-ingest message history action."*

### The split that makes this coherent

**Reference material (corpus) stays profile-wide, addressed by collection.** `search_reference`
and `search_memories` reach it by collection today; a session boundary there would be
fiction, because the same document serves every session. Inherited transcripts therefore
stay under the parent's `session:<parent>/turn-<n>` identity and are *not* copied.

**Episodic memory becomes per session.** Namespace is `session:<sessionId>`. Nothing is
shared between forks, which is what was asked for. Passive recall reads the session's own
namespace plus core memories (core stays `global`: a preference is not a session fact).

### Inheriting up to the cut

At fork creation the child receives a **copy** of the parent's episodic memories belonging
to turns at or before `inheritedEventCount`'s boundary, written into
`session:<childId>`. Copy rather than reference, because "no sharing between forks" rules
out a union view.

- Detection: `session.header.parentSession` (lineage) plus `inheritedEventCount > 0` (a real
  fork rather than an ordinary session).
- Where: `ctx.on('agent/created', ...)` runs before the child's first turn, so recall on
  that first turn already sees the inherited memory. Needs `inheritedEventCount` reachable
  from the session object and a turn→offset mapping to know which memories fall inside the
  prefork prefix.
- Idempotence: a marker on the child (a `meta` row or a namespace-scoped flag) so a resume or
  a second `agent/created` cannot copy twice.
- Failure is non-fatal: a child that inherits nothing is merely forgetful, so an error here
  must log and continue rather than refuse the session.

### The duplication defect, fixed independently of the above

`agent/turn-stopping` must not capture a turn whose events all fall inside the inherited
prefix. Today it does, for both the transcript and the episodic write, because
`deriveMessages()` returns the whole inherited conversation and the hook reads the latest
assistant message from it.

### Two explicit actions, to be built

1. **Forget session** — remove one session's episodic namespace and its transcript corpus
   sources. Route plus a Memory-tab action, with the session id supplied by the tab's own
   session prop so nobody has to type one.
2. **Re-ingest message history** — walk the session's own event log from the fork cut
   forward and rebuild its transcripts and episodic memories. Pairs with the above: forget,
   then re-ingest, is the repair path for a session captured badly or by an older build.

Neither runs automatically. Deleting or rebuilding a session's memory is not something a
plugin should infer from a timeline.

### Status

Not yet implemented. The next round should do them in this order, because each is
independently verifiable:

1. per-session episodic namespace + recall reading it (+ `global` core), with tests;
2. the `inheritedEventCount` guard in `agent/turn-stopping`, with a test that a forked turn
   writes nothing;
3. inheritance-at-fork on `agent/created`, with an idempotence test;
4. forget-session and re-ingest actions, route plus tab, with tests.
