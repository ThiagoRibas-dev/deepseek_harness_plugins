# Passive RAG for D&D Campaign — State & Architecture Resume

**Date:** October 7, 2026  
**Source Session:** `Passive RAG for D&D Campaign` (`session-2af693e5-4872-4c71-b826-bb124b389161`)  
**Workspace:** `/export/DownloadsSSD/SHARED/harnesses/dsh`  
**Related Campaign Workspace:** `/export/DownloadsSSD/Projects/Writing/TTRPG/D&D35`

---

## 1. Executive Summary & Objective

In long-running TTRPG campaigns (specifically D&D 3.5e under DeepSeek Harness), conversational history grows rapidly, leading to lost narrative context, forgotten NPC promises, and rules friction. Traditional heavy vector RAG plugins from marketplaces introduce external infrastructure dependencies, high latency, and poor precision on fantasy proper nouns.

The objective is to establish a **multi-tier passive RAG architecture** tailored to DSH:
1. Passive context delivery with zero tool roundtrips via DSH's native runtime context snapshots (`systemPrompt.context()`).
2. Deterministic entity hydration tied to active scene state (`state.scene.entities`).
3. Turn-start state injection (FI-9) replacing the manual `get_state` step-1 tool roundtrip.
4. Tiny asynchronous worker swarms (e.g. Qwen2.5-0.5B / 1.5B via `llama-server`) running off-cycle post-turn to harvest entities, summarize turns, and update ledgers without blocking the DM's reply.
5. Lightweight local ONNX-based semantic retrieval and reranking for deep campaign memory and rules concepts (FI-14, FI-15) without external vector databases.

---

## 2. Current Implementation Status (Audited in Codebase)

### A. Already Implemented & Shipped
* **FI-1 — Turn Memory & Recall Engine** (`plugins/dsh-dd35-preset/memory.js`, `memory-store.js`):
  * **Auto Capture:** Hooks into `agent/turn-stopping` + `turn/end` when `reason.kind === 'completed'`. Transcribes exchanges and scene snapshots to `events/transcripts/NNNN_turn.md` and indexes them in `events/memory_index.json`.
  * **Active Recall Tools:** Shipped with `grep_memories` (regex/lexical search), `fetch_memories` (span retrieval), and `list_memories` (scene range index).
* **Passive Scratchpad Injection** (`plugins/dsh-dd35-preset/prompt.js`):
  * Campaign scratchpad (`dm_notes.md`) is read on every request and injected via `systemPrompt.context()` (order 200) as a runtime-context snapshot (`source.kind === 'runtime-context'`). It survives context compaction without invalidating prompt cache prefixes.

### B. Specced & In Backlog (`docs/dd35/future-improvements.md`)
* **FI-9 — Automatic Turn-Start State Injection (`Status: SPECCED`, Priority P1):**
  * Replaces the manual `get_state` step-1 tool call on every turn.
  * Injects active scene, location, active entities, and micro-state into `systemPrompt.context()`.
  * Saves one inference round-trip (the cheap one) per turn, plus the ~40-token tool call. The state
    tokens are paid either way, and the earlier "~300 input tokens" figure understated the `get_state`
    result by roughly 2–3× — see §5 of the spec.
  * **Correction (rev 2):** an injected snapshot is *retained in session history*; the
    `RuntimeContextProjection` token decides when to append, not what to forget. Only some providers
    (`dsh-meridian-antigravity`'s `keepLatestRuntimeContext`) filter superseded snapshots from
    delivery. A state block that changes every turn therefore costs a snapshot per turn.
* **FI-16 — Entity Extraction and Entity-Linked Memory (`Status: IDEA`, Priority P2):**
  * Solves the key question: *"What do I know about [Entity]?"*
  * Extracts persons, places, and organizations from completed turns to maintain a *dramatis personae* and allow `list_memories({ entity: "..." })`.
* **FI-14 — Semantic Retrieval for Concepts and Voice (`Status: IDEA`, Priority P2):**
  * Local 22M parameter ONNX sentence embedder (`all-MiniLM-L6-v2`, 384 dims, flat cosine scan in microseconds, zero external vector DB).
* **FI-15 — Cross-Encoder Reranking (`Status: IDEA`, Priority P3):**
  * Pairs with `grep_memories` and `search_reference`. Keeps lexical recall, then reranks top ~50 candidates with a local cross-encoder (`ms-marco-MiniLM-L-6-v2`).
* **FI-17 — Repetition & Continuity Detection (`Status: IDEA`, Priority P3):**
  * Compares turn embeddings against history to detect repeated tropes or contradictions.

---

## 3. Key Architecture Decisions & Insights

1. **No External Vector DBs:** Flat cosine scan across a few thousand 384-dim float32 vectors takes microseconds and requires only a few megabytes of memory.
2. **Native Runtime Snapshot Channel:** All passive injections must use `systemPrompt.context()` rather than modifying system prompt byte 0 or appending to step messages. DSH distinguishes these structurally (`source.kind === 'runtime-context'`), so they never collide with player messages or pollute turn memory capture. Note the limit of that guarantee: the channel protects *capture* and the system-prompt prefix. It does **not** remove superseded snapshots from history — that is a provider-side delivery filter, not a property of the channel.
3. **Deterministic Entity Hydration First:** Deterministic lookup (loading sheets/cards for entities currently in `state.scene.entities`) is strictly superior to fuzzy vector lookups for known scene participants.
4. **Model Selection for Generative Swarms vs Embeddings:**
   - **Generative Workers (Summaries, Entity Extraction):** `llama-server` hosting Qwen2.5-0.5B or 1.5B is vastly superior to ONNX Runtime because `llama-server` supports dynamic prefix caching, sequence slot forking, and continuous batching across slots.
   - **Auxiliary Encoders (Semantic Search, Reranking):** ONNX Runtime is ideal for `all-MiniLM-L6-v2` and `ms-marco-MiniLM-L-6-v2` (no KV cache, single forward pass in 15ms).

---

## 4. Turn Lifecycle Flow (User -> Assistant)

1. **Turn Start (Prompt Assembly):**
   - Player inputs message.
   - `systemPrompt.context()` compiles:
     - Runtime State (FI-9): active mode, clock, initiative, scene location, micro-state, pending action.
     - Hydrated Entity Dossiers: brief stat/personality cards for entities in `state.scene.entities` + party.
     - Campaign Notes (`dm_notes.md`): durable scratchpad.
     - Optional triggered exemplars / relevant rules concepts (FI-14).
2. **Inference (Single-Pass DM Response):**
   - The DM model sees full context immediately on Step 1.
   - No `get_state` tool call needed unless a mid-turn mutation occurs (`apply_damage`, `next_turn`).
   - DM directly resolves gameplay / narrates reaction, emits `update_scene` at end of turn.
3. **Post-Turn (Async Harvesting):**
   - `turn/end` triggers `memory.js` to commit transcript to `events/transcripts/NNNN_turn.md`.
   - Fire-and-forget sub-agent / tiny SLM swarm processes transcript off the critical path. **All
     worker output goes to a derived sidecar (`events/derived/`), never to `dm_notes.md`,
     `state.json`, or `events/memory_index.json`** — see §4.2.5 of the spec for why those three files
     each have exactly one authoring rule (and why `memory_index.json` in particular *discards*
     anything not derivable from transcripts on its next rebuild):
     - Worker 1: Propose newly mentioned entities -> `events/derived/NNNN.json`.
     - Worker 2: Turn summary -> `events/derived/NNNN.json`.
     - Worker 3: Unresolved plot hooks/promises -> `campaign/<id>/dm_auto_threads.md` (a
       machine-written file; the DM's `dm_notes.md` stays the DM's alone).

---

## 5. Artifacts & Deliverables
* **Formal Specification:** [`docs/dd35/memory-model.md`](memory-model.md) — Comprehensive before/after architectural comparison, turn traces, a known/unknown split on the token and latency metrics (rev 2), the derived-layer data-ownership rules, a failure model, and the implementation checklist.
* **Roadmap Backlog:** [`docs/dd35/future-improvements.md`](future-improvements.md) — FI-1 (shipped), FI-9 (specced), FI-14/15/16/17 (local inference & memory backlog).
