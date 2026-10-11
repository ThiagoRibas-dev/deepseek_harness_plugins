# D&D 3.5e DM Preset — Memory Model Improvement Specification

**Document:** `docs/dd35/memory-model.md`  
**Date:** October 8, 2026 (rev 4 — direction revised after prior-art comparison; see §9)  
**Status:** `SPECCED`  
**Target Preset:** `plugins/dsh-dd35-preset/` (`dd35-prompt`, `dd35-state`, `dd35-memory`)  
**Backlog Links:** [FI-1](future-improvements.md#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories), [FI-9](future-improvements.md#fi-9--automatic-turn-start-state-injection), [FI-14](future-improvements.md#fi-14--semantic-retrieval-for-concepts-and-style), [FI-16](future-improvements.md#fi-16--entity-extraction-and-entity-linked-memory)

> **Rev 2 scope.** The first draft was written from the FI-9/FI-1 notes rather than from the code.
> This revision corrected three false or provider-conditional claims, replaced the invented
> entity fields with the fields the sheets actually have, moved the swarm's output out of
> `memory_index.json` and `dm_notes.md` into a derived layer with its own ownership rules, replaced
> the estimated metrics with a known/unknown split, and added a failure model (§7) and open
> questions (§8). Sections marked **[REVISED]** or **[NEW]** changed substantively; §4.1.3 is the
> important one.
>
> **Rev 4 scope — the order changed, not just the numbers.** Phase 0 was re-measured (§6.0) and the
> field of comparable systems was read (§9.5). Both point the same way: **the hydration channel is
> solving a latency problem while the confirmed bugs are on the write path.** Three additions follow:
> **[§4.3](#43-canon-admission-adjudication-and-promotion-new)** specifies how anything becomes canon —
> `update_scene` adjudication, provisional entities, and promotion by player uptake, with the model
> forbidden to certify its own evidence; **[§4.4](#44-widening-the-entity-projection-new)** widens the
> `briefEntity` projection, which is the change that removes the second read rather than the
> round-trip; and **[§9](#9-implementation-order-supersedes-6-new)** supersedes §6's phase order,
> putting the `doctor` diagnostic and the write-path gate first. **§9.2 is the actionable list.**

---

## 1. Executive Summary

The DSH D&D 3.5e DM preset currently relies on a **reactive, tool-dependent memory model**:
1. At turn start, the model receives only `dm_notes.md` via `systemPrompt.context()`; it has no awareness of the active scene, clock, or present entities until it spends Step 1 executing `get_state`.
2. Turn memory capture ([FI-1](future-improvements.md#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories)) passively records raw markdown transcripts, but does not index entities, plot hooks, or narrative summaries.
3. Mid-campaign factual recall relies on the model proactively guessing search keywords via `grep_memories`.

This specification formalizes an enhanced **multi-tier passive memory and turn-lifecycle model**. Rev 4
reorders it: the two cheapest changes fix *confirmed, observed* problems, so they come first (§9.2).

* **Canon admission (§4.3):** the gate that decides how anything becomes canon — `update_scene`
  adjudication for ids with no sheet, provisional entities for walk-ons, and promotion by player
  uptake for machine-derived proposals. This closes a **live, confirmed bug** (`maude` is in the
  current scene with no sheet) and it is a prerequisite for everything below, not an optimization.
* **Widened entity projection (§4.4):** `briefEntity` drops `conditions[].effect`, `resources`, and
  `notes` — 75% of a measured PC sheet, and exactly where the mechanics are. Widening it is the change
  that removes the *second read*; hydration ([FI-9](future-improvements.md#fi-9--automatic-turn-start-state-injection))
  only removed the *round-trip*, which §5 measures as the cheap inference.
* **Turn-Start State & Cast Hydration ([FI-9](future-improvements.md#fi-9--automatic-turn-start-state-injection)) — deferred, not deleted:**
  injects live scene state and briefings for `state.scene.entities` into the runtime-context snapshot
  channel. Since the snapshot carries no more information than `get_state` (§5, *Information content*),
  this is now sequenced behind §4.3 and §4.4, and open question 1 may retire it.
* **Asynchronous Post-Turn Worker Swarm (Tiny Generative SLMs) — sequenced last:** dispatches
  off-cycle, non-blocking background workers (e.g. Qwen2.5-0.5B / 1.5B via `llama-server`) after
  `turn/end`. These workers *propose* entities ([FI-16](future-improvements.md#fi-16--entity-extraction-and-entity-linked-memory)),
  summaries, and unresolved plot promises, and calculate embeddings ([FI-14](future-improvements.md#fi-14--semantic-retrieval-for-concepts-and-style)).
  Their output lands in derived sidecar files, never in the files the DM or the commit path owns
  (§4.2.5), and **nothing they produce reaches canon until §4.3.4 promotes it**. §9.5 records why no
  comparable system runs this shape of swarm, and §9.6 names the evidence that would kill it.

> **Revision note (this version).** Three claims in the first draft did not survive contact with the code: "stale snapshots are not retained" is false (superseding is a *delivery* filter, applied by one provider only); "~300 input tokens" was a guess at the `get_state` result; and "~50% faster" conflates a cheap tool-call inference with the full narration inference. **Phase 0 has since measured the payload at 1,205 B ≈ 344 tokens** — near the original guess, not the "2–3× low" this note first claimed — and found the finding that matters more than any of these: the projection both paths use is **lossy exactly where mechanics are narrated** (§5, *Information content*), which inverts the premise of open question 1. Rev 4 then took that finding to its conclusion and **reordered the plan around it** (§9): the hydration channel moves behind a write-path gate (§4.3) and a projection widening (§4.4). The affected sections are marked **[REVISED]** or **[NEW]**; a derived-layer failure model has been added (§7). The channel choice itself — `systemPrompt.context()` — is unchanged and correct; what changed is *when* it is worth building.

---

## 2. Before vs. After Architecture Overview

| Dimension | Baseline Architecture (Current) | Enhanced Memory Architecture (Proposed) |
| :--- | :--- | :--- |
| **Canon Admission** | **No gate.** `update_scene` accepts any string as an entity id, so a mention becomes scene canon unchecked — `maude` is in the live scene with no sheet anywhere. | **§4.3.** A mention is not yet an entity: unresolved ids return `needs_adjudication` and the scene is not written. Walk-ons become `kind: "provisional"` stubs; machine proposals reach canon only by player uptake. |
| **Entity Detail Available to the DM** | `briefEntity` drops `conditions[].effect`, `resources`, and `notes` — **75% of a measured PC sheet**, and the part that holds the mechanics. | **§4.4.** The shared projection is widened under a byte budget, so the DM stops needing a second read of the sheet to narrate mechanics. |
| **Turn-Start Passive Injection** | Injects only `dm_notes.md` at order 200 via `prompt.js`. | Injects `dm_notes.md` **plus** live scene state, clock, mode, and entity sheets for all entities in `state.scene.entities`, joined into the same snapshot. **Sequenced behind §4.3/§4.4 by §9.2** — it buys latency, not information (§5). |
| **Step 1 Model Action** | **Mandatory tool call:** Model must emit `get_state` and wait for the result. | **Direct narration/action:** Model has complete context on token 0 of Step 1; resolves action immediately. *Conditional on the snapshot landing; §4.4 may make the mandate unnecessary before then.* |
| **Inference Cycles per Turn** | **2 inferences minimum** (1 to call `get_state`, 1 to generate narrative reply). | **1 inference** for standard roleplay/dialogue turns (additional steps only when rolling dice or mutating state). |
| **Per-Turn Token Overhead** | Pays ~40 output tokens (tool call) + the `get_state` JSON result on every turn. | Zero tool-call token overhead for routine state inspection. See §5 for the measured result size (1,205 B ≈ 344 tokens on the Phase 0 campaign) and for why the snapshot is *not* more informative than the read it replaces. |
| **Snapshot Retention** | `dm_notes.md` changes only when the DM writes it, so a new snapshot is rare. | **A scene state that changes every turn means a snapshot every turn**, and *superseding affects delivery, not storage* — see §4.1.3. Cost is provider-dependent. Measured: 20 of 40 transitions are byte-identical, so the real rate is about half. |
| **NPC & Scene Recall** | Relies on DM guessing when to call `grep_memories` if it forgets an NPC's background or secret. | Deterministic hydration of whatever `state.scene.entities` lists — but only if the DM remembered to list them, and the entity sheet has no secret/role/disposition fields yet (§4.1.2). §4.3.2 makes the listing reliable; §9.3 makes the gaps visible. |
| **Post-Turn Commit** | Commits raw markdown transcript and records bare scene title in `events/memory_index.json`. | Commits transcript, then fires an **asynchronous worker swarm** off the reply path, into files of its own (§4.2.5). **Last in the sequence (§9.2, Step 6).** |
| **Entity & Hook Extraction** | Manual; DM must remember to write notes into `dm_notes.md` using `edit`. | **Automated harvesting:** Tiny SLM proposes new NPCs, promises, items, and debts into a derived sidecar — proposals, never authoritative edits (§4.2.5), gated by §4.3.4. |
| **Turn Index Richness** | `events/memory_index.json` tracks `total_turns`, date span, and scene segments only. | Derived summaries and tags live in a sidecar keyed by turn, not inside a file the rebuild path discards. |
| **Diagnosability** | None — no `doctor`, no rollback, no repair path anywhere in the preset (verified by grep). | **§9.3** adds a read-only `doctor` reporting unresolvable ids, provisional debt, duplicate sheets, and unparsed turns. **Step 1 of the revised order.** |
| **User Latency Impact** | High (delayed by extra inference step). | **No added reply latency** — but not zero cost: the swarm competes for the same CPU and must finish inside the player's think-time (§4.2.3). |

---

## 3. Detailed Turn Lifecycle Walkthrough

### Baseline Lifecycle (Current)

```
[1. Player Input] 
       │
       ▼
[2. Prompt Assembly] ─── Injects dm_notes.md only (no scene state, no NPC stats)
       │
       ▼
[3. Inference Step 1] ── DM model cannot answer yet; emits {"name": "get_state"}
       │
       ▼
[4. Tool Execution] ──── DSH executes get_state (its compact JSON result; size in §5)
       │
       ▼
[5. Inference Step 2] ── DM re-reads entire context, plans response, resolves checks, narrates
       │
       ▼
[6. Response Sent] ───── Player receives narrative text
       │
       ▼
[7. Turn End] ────────── memory.js writes events/transcripts/NNNN_turn.md
```

### Enhanced Lifecycle (Proposed)

```
[1. Player Input] 
       │
       ▼
[2. Automated Passive Hydration (systemPrompt.context())]
       ├── Scene State (FI-9): Mode, clock, location, micro-state, pending action
       ├── Deterministic Cast Hydration: entity sheets for state.scene.entities + Party PCs
       └── Campaign Scratchpad: Active dm_notes.md
       │
       ▼
[3. Inference Step 1 (Single Pass)]
       ├── DM sees complete scene, entity stats, and objectives immediately
       ├── DM resolves skill checks / rolls if needed, calls update_scene
       └── DM outputs narrative response directly
       │
       ▼
[4. Response Delivered to Player] (one inference cycle earlier)
       │
       ▼
[5. Post-Turn Async Maintenance Hook (turn/end)]
       ├── Step A: memory.js commits events/transcripts/NNNN_turn.md (1 ms)
       └── Step B: Non-blocking dispatch to Tiny SLM Swarm (via llama-server / background jobs):
             ├── Worker 1 (Entity Harvester - FI-16): Proposes newly met NPCs, items, promises
             ├── Worker 2 (Summarizer): Generates 2-sentence summary for the derived sidecar
             ├── Worker 3 (Thread Tracker): Proposes unresolved promises for dm_auto_threads.md
             └── Worker 4 (Dense Embedder - FI-14): Embeds turn with all-MiniLM-L6-v2 (15 ms ONNX)
```

Note that step 2 runs again at every **step**, not merely every turn: `preStep` assembles the
snapshot per step (`agent.ts:266-285`), so a mid-turn `update_scene` produces a second snapshot inside
the same turn. That is harmless for correctness and material for §4.1.3.

---

## 4. Technical Design & Component Breakdown

### 4.1. Turn-Start State & Cast Hydration (`dd35:scene-state`) **[REVISED]**

Registered in `plugins/dsh-dd35-preset/prompt.js` alongside the existing `dd35:dm-notes` contributor.
The two contributions are joined into **one** runtime-context message — `joinContextSections` renders
every context in ascending order into a single snapshot (`packages/core/system-prompt/src/index.ts:291-307`)
— so `dd35:scene-state` at 150 and `dd35:dm-notes` at 200 arrive together, and a change to *either*
re-emits the *whole* joined block. That is the second reason the state half must stay small and
volatile-last.

```javascript
ctx.effect(() => ctx.systemPrompt.context({
  name: 'dd35:scene-state',
  order: 150, // Directly before dm-notes (200)
  interpolate: false, // campaign prose must never be scanned for {{variables}}
  text: (assemble) => sceneStateContext(assemble, opts),
}), 'dd35-prompt.sceneState()')
```

#### 4.1.1 Snapshot Structure

The block is bounded and ordered **stable-first, volatile-last, freshness-last** (§4.1.3 explains why
the ordering is load-bearing: a changed byte anywhere in the snapshot costs a new snapshot message):

```markdown
## Active Game State (as of turn 42)
- **Mode:** Exploration
- **Location:** Boar's Rest Tavern, Back Parlor
- **Micro-State:** Kenna is nursing an ale in the corner; Thiago is guarding the cellar door.
- **Pending Action:** Player approaches Kenna with the silver medallion.
- **Clock:** 14 Ches 1374 DR, 18:45

### Present Scene Entities
- **Kenna** (npc | HP 18/18 | AC 15 | position: corner booth): *Conditions:* none
- **Thiago** (npc | HP 24/34 | AC 18 | position: cellar door): *Conditions:* fatigued
- **Vess** (pc | HP 31/31 | AC 17): *Conditions:* none

_Party members and non-PC scene entities, rendered from the existing `briefEntity` projection
(`state.js:43-53`). Class levels, allegiances, dispositions, secrets, and debts are **not on the
sheet** — narrative detail lives in the campaign notes, injected in the same snapshot (see §4.1.2)._
```

The freshness line and the volatile tail exist because of §4.1.3: on a provider that sends retained
history, this is one of several snapshots the model can see, and it must be able to tell which one is
current without counting messages.

#### 4.1.2 What the entity sheets can actually supply **[REVISED]**

The first draft's example rendered `Role`, `Disposition`, `Secret`, and `Owes` per entity. **Those
fields do not exist.** `defaultEntity` (`state-store.js:170-178`) defines only:

```
id, kind, name, hp, max_hp, temp_hp, ac, touch_ac, flat_footed_ac,
initiative_bonus, conditions, resources, position, notes
```

and `briefEntity` (`state.js:43-53`) already projects the useful subset for the model. Consequences
for Phase 1:

* **Render what exists, via the existing projection.** Reuse `briefEntity`'s shape rather than
  inventing a second one; `get_state` and the snapshot must not disagree about what an entity is.
* **Narrative fields come from `dm_notes.md`.** That file is already the designated home for
  campaign truth, already injected, and already written by the DM. Do not parse it structurally —
  read it as the second half of the same snapshot and let the model join the two.
* **`notes` on a sheet is not a secret store.** It exists, but it is player-authored OOC notes.
* **`secret` is a privacy decision, not a schema decision.** The campaign directory sits inside the
  player's own workspace and the file sidebar lists every file except dotfiles — there is no campaign
  filter (`packages/api/workspace-files/tests/list.spec.ts` asserts a `.hidden` file is listed). A
  `secret` written to `actors/<id>.json` is therefore readable by the player. **Keep secrets in
  `dm_notes.md`** (already the documented home, already injected), and if a per-entity secret really
  is needed later, put it in a file that is documented as GM-facing and name the exposure in the
  README rather than leaving it implicit.
* **There is no `dramatis_personae.json` and no `entities/` directory yet.** Those are
  [FI-16](future-improvements.md#fi-16--entity-extraction-and-entity-linked-memory) deliverables;
  Phase 1 must not assume them.

#### 4.1.3 How the snapshot is read and retained **[REVISED]**

Three structural properties, as verified against the code — one of the original three claims was wrong:

1. **No system-prompt prefix damage.** ✅ The block is a `user`-role message with
   `source.kind: 'runtime-context'`, appended to the message list (not interpolated into the system
   prompt at byte 0), so the cached prompt prefix is untouched.
2. **Superseding is a delivery filter, not a form of removal.** ❌ *Corrected.*
   `RuntimeContextProjection` (`packages/core/agent-loop/src/runtime-context.ts:114-163`) is a
   **token that decides when to append**, not a garbage collector. `project()` returns `undefined`
   while the rendered text is unchanged and otherwise appends a **new** `user/message`; every
   superseded snapshot remains in session history. Whether the model ever sees the old ones is the
   **provider's** choice:
   * `dsh-meridian-antigravity` filters them — `filterNoticeMessages` with
     `keepLatestRuntimeContext` (default `true`, `lib/serialize.js:56-76`).
   * The **native path does not**. DeepSeek's own adapter serializes user-role history verbatim; the
     plugin-owned history fixture asserts a producer's `user` message survives into the wire request
     (`packages/llm/llm-deepseek/tests/fixtures/input-history.ts:36-40`).

   So on the primary provider the model receives *N stacked snapshots* by turn N, each headed
   "This snapshot supersedes earlier runtime-context snapshots." Today this is invisible because
   `dm_notes.md` changes only when the DM writes it. **A scene state that changes every turn converts
   "a snapshot sometimes" into "a snapshot every turn"** — which is why the snapshot must be small,
   volatile-last, and freshness-labelled, and why §5 now carries a history-growth row. Compaction is
   the only thing that ever removes old snapshots.

   Also note that assembly runs **per step**, not per turn (`agent.ts:266-285`), so a mid-turn
   `update_scene` or `set_mode` emits an additional snapshot within the same turn.
3. **No collision with memory capture.** ✅ `memory.js` filters on `isPlayerMessage(m)`
   (`role === 'user' && source.kind === 'user' && typeof source.rpcId === 'string'`), and the
   existing suite already asserts that injected kinds — `runtime-context` among them — are never
   player input (`tests/memory.test.mjs:124-129`).

Two further implementation constraints, both because context rendering sits on the request's error path:

* **Read defensively.** Use `loadState`, never `requireState` (which self-heals by *creating*
  `state.json` — a write on a read path — and throws when the campaign directory is absent). An
  absent campaign, absent `state.json`, unparseable JSON, or an entity id with no sheet must
  contribute `''` or be skipped. A throw here aborts prompt assembly and kills the session, which is
  the one failure mode this channel must never have.
* **Cap the block.** Reuse `prompt.js`'s existing `cap(text, maxBytes, label)` so the contribution
  degrades with a visible truncation notice instead of growing without bound. Suggested budget:
  `sceneStateMaxBytes: 6144`, with the volatile tail last so truncation eats the least useful part
  first.

The original "Why This Works Structurally in DSH" list is superseded by §4.1.3, which states the same
three properties with the corrections and code citations. The corrected summary: the cache-safe
placement and the capture-immunity both hold; the third claim — that stale snapshots are not
retained — does not.

---

### 4.2. Asynchronous Post-Turn SLM Swarm **[REVISED]**

#### 4.2.1 Why tiny generative SLMs (Qwen2.5-0.5B / 1.5B via `llama-server`)?
* **Why not generic token-classification ONNX NER?** As noted in [FI-16](future-improvements.md#fi-16--entity-extraction-and-entity-linked-memory), standard NER models fail on fantasy proper nouns (*"Mithraelis"*, *"The Weeping Eye"*). A tiny generative SLM prompted with JSON schemas understands fantasy syntax, relationships, and context.
* **Why `llama-server` over ONNX Runtime for the swarm?**
  * `llama-server` provides **sequence slot management** (`-np 4`) and prefix caching. ⚠️ *Corrected:* prefix caching only amortizes across calls that share a literal prefix. Entity extraction, summarization, and promise detection carry **different instructions**, so they occupy different slots and share almost nothing. Only repeated calls to the *same* worker amortize a prefill.
  * Native support for JSON Schema constrained sampling (grammar-based decoding) guarantees clean JSON parsing every time.
  * Quoted footprints are the weights only: Qwen2.5-0.5B Q4_K_M **~350 MB**, Qwen2.5-1.5B **~950 MB**. Add the runtime's own overhead and one KV cache **per slot** — budget 1.5–2× the quoted figure for a 4-slot server, and note that it competes for RAM and CPU with the main model on the same host.

#### 4.2.2 Worker tasks (executed concurrently off-cycle)

1. **Entity & Relationship Harvester ([FI-16](future-improvements.md#fi-16--entity-extraction-and-entity-linked-memory)):**
   * **Input:** latest turn transcript (`events/transcripts/NNNN_turn.md`).
   * **Task:** propose any new characters, faction allegiances, items transferred, or promises made.
   * **Target:** the derived sidecar (§4.2.5). *Not* `dramatis_personae.json` — that file does not
     exist yet, and creating it is an FI-16 deliverable, not a Phase-3 side effect.
2. **Turn Summarizer:**
   * **Input:** player message + DM narrative.
   * **Task:** generate a 1-to-2 sentence objective summary of actions and mechanical outcomes.
   * **Target:** the derived sidecar under `summaries[NNNN]`. *Not* `events/memory_index.json` — see
     §4.2.5 for why that file cannot hold it.
3. **Promise & Plot Hook Sentinel:**
   * **Input:** factual dialogue commitments made by PCs or NPCs.
   * **Task:** detect commitments (e.g. *"Meet me at the bell tower at midnight"*).
   * **Target:** `campaign/<id>/dm_auto_threads.md`, a machine-written file with its own header. The
     DM's `dm_notes.md` is read-modify-written by the DM all session; a background writer appending
     to it is a lost-update race against the DM's own `edit`, and it is also the file whose 16 KB cap
     already truncates silently (`prompt.js`'s `cap()` drops the overflow with a notice). If a single
     notes file is preferred anyway, the worker must append only to a fenced
     `## Machine-proposed threads` section, re-read the file immediately before writing, and abort on
     a content-hash mismatch.
4. **Auxiliary Dense Embedder ([FI-14](future-improvements.md#fi-14--semantic-retrieval-for-concepts-and-style)):**
   * Uses local `all-MiniLM-L6-v2` via ONNX Runtime (22M parameters, ~15 ms on CPU, no KV cache).
   * Writes 384-dimensional float32 vectors to a **packed binary sidecar** (`events/embeddings.bin`),
     not inline in a JSON index. 384 floats is ~3 KB per turn as JSON; 200 turns turns
     `memory_index.json` into a ~600 KB blob that `list_memories` must parse in full on every call.

#### 4.2.3 Operations: lifecycle, races, and the window nobody described

* **Track the jobs.** Fire-and-forget must still be *observable*. Register workers as tracked
  background jobs so they are awaited on plugin unload, cancelled on unmount, and re-fired on the
  next `turn/end` if they died — otherwise a crash silently drops a turn's extraction forever, with
  no record that it happened.
* **Serialize per campaign.** Turn `commitTurnToIndex` has a rebuild path
  (`memory-store.js:231`: a gap makes the incremental view wrong, so it rebuilds), and two concurrent
  writers to one JSON file have no compare-and-swap. The commit path and the swarm must not both
  write the same file — resolved structurally by §4.2.5, but worker-to-worker writes to the sidecar
  still need one writer per campaign at a time.
* **Worker wall-clock must fit inside player think-time.** The swarm does not delay the *reply*, but
  it does compete for the same CPU the *next* request needs. The design constraint is
  `worker_wall_clock < player_think_time`, and if it is violated the next turn's prompt assembly
  may or may not see that turn's findings. When the race is lost, the outcome must be *"the summary
  is missing"*, never *"the summary is half-written"* — atomic per-turn sidecar files give that for
  free, and it makes the resulting continuity bugs reproducible instead of mysterious.
* **Switchable, including off.** A single config flag must be able to disable the whole swarm. The
  DM must never be worse off for the workers having run.

#### 4.2.4 Alternatives to weigh before building this

* **Reuse the harness's own subagent with a cheap model.** `tool-subagent` already exists, already
  emits `subagent-settled` notices the capture path understands, and needs no second server, no
  binaries, no model download, and no platform packaging. The trade is per-call tokens and API
  latency. Price both before committing to a C++ server sharing the DM's CPU.
* **Do less, later.** The summarizer alone (worker 2) delivers most of the continuity value at a
  fraction of the risk: summaries are additive, never authoritative, and trivially discardable. Entity
  extraction and promise tracking are the parts that can corrupt canon — sequence them after the
  summarizer has proven itself over a long campaign.

#### 4.2.5 Data ownership: the derived layer **[NEW]**

This is the correction that matters most. The first draft had the swarm writing into
`events/memory_index.json` and `dm_notes.md`. Both are wrong, for the same reason: **a file may have
exactly one authoring rule.**

* `memory_index.json` is deliberately *derived and rebuildable from the transcripts* — that property
  is stated at the top of `memory-store.js` and is load-bearing. `readMemoryIndex` rebuilds itself
  whenever it lags the transcripts, and `commitTurnToIndex` rebuilds on any turn-number gap. Anything
  a worker adds that is *not* derivable from transcripts — a summary, an embedding, a set of tags —
  **is destroyed by the next rebuild**, including rebuilds triggered by unrelated repairs.
* `dm_notes.md` is the DM's scratchpad, read-modify-written by the DM with `read`/`edit` all session,
  and it is the file the prompt instructs the DM to treat as campaign truth.

The corrected layout:

```
campaign/<id>/
  state.json                     session facts        ← tools only (single writer)
  dm_notes.md                    DM scratchpad        ← the DM only
  dm_auto_threads.md             machine-proposed threads
  events/
    transcripts/NNNN_turn.md     canonical record     ← memory.js only
    memory_index.json            scene index          ← memory.js only, still rebuildable
    derived/
      NNNN.json                  {summary, entities[], tags[], provenance}  ← workers only
      embeddings.bin             packed float32       ← embedder only
```

Rules that make the layout safe:

1. **One writer per file.** Derived files are written by no one else; canonical files are never
   written by workers. This removes the need for locking rather than adding it.
2. **Derived output is a proposal, not a fact.** Every derived file records provenance — the turn it
   came from, the worker, and the verbatim span each claim was drawn from. A claim that cannot be
   matched back to the turn text is dropped before it is written, not after it has been injected.
3. **The snapshot labels it.** Whatever derived content reaches the model must arrive under a heading
   that says it is machine-derived and possibly wrong. Provenance in a file nobody reads is not
   enough; the label has to be in the prompt.
4. **Discardable by design.** Deleting `events/derived/` must cost only recomputation — never canon.
   That is what makes the failure model in §7 survivable.
5. **A byte budget and dedup.** One derived entry per turn, deduped by content hash, so a promise
   repeated across five turns does not become five notes and then thirty.

#### 4.2.6 Consequence for worker 3

Thread tracking is the only worker whose output the DM is *expected* to act on, so it carries the
most authority and the most risk. It therefore writes to `dm_auto_threads.md`, which is injected next
to the notes under its own heading, and its entries are proposals the DM may delete. `dm_notes.md`
remains the DM's alone.

---

### 4.3. Canon Admission: Adjudication and Promotion **[NEW]**

Everything above says *where* derived data may live. This section says **how anything becomes canon** —
the gate every other part of this design has to pass through, and the one that is missing today.

#### 4.3.1 The two fact classes

The design has been treating "facts" as one category. They are two, and only one of them has a
hallucination surface:

| Class | Examples | Who authors it | Admission rule |
| :--- | :--- | :--- | :--- |
| **A — mechanically witnessed** | HP, damage, conditions, initiative, kills, who is in the room, dice outcomes | The dice/state tools (`apply_damage`, `roll_attack`, `init_combat`, `next_turn`) | **None needed. Canon is the sheet.** There is nothing to approve because nothing was generated. |
| **B — narrated** | A new NPC, a promise, a threat's exact wording, a plot fact, a location | The DM's prose, or a derived worker | **Promotion required** (§4.3.2 gate, §4.3.4 promotion). |

This split dissolves most of §7's failure model. The feedback-loop row, the duplicate-extraction row,
and the "SLM hallucinates a fact" row all concern **Class B only** — and Class A is the large majority
of what a 3.5e sheet actually tracks. A design that treats every fact as Class B invents an approval
problem where none exists, and then has to solve it with machinery.

#### 4.3.2 Gate 1 — `update_scene` adjudication (the DM's write path)

`update_scene` (`state.js:116`) is the single call that decides who is *present*, and presence is what
§4.1 hydration reads. Today it accepts any string as an entity id. That is how `maude` entered
`state.scene.entities` with no sheet anywhere and stayed for 9 consecutive turns (§6.0): the model
supplied an id, the tool wrote it, and every subsequent read silently dropped her.

The rule to adopt is **a mention is not yet an entity** — an id in the scene must resolve to a sheet,
or the call must say so. `loadAnyEntity` is already imported in `state.js:14-20`, so this is a small
local change inside the existing `execute`:

```javascript
// state.js — update_scene (existing tool; only the entities path changes)
execute({ campaign, date, time, entities, create_provisional, ...scene }) {
  const id = requireCampaign(campaign)
  const state = requireState(id)

  // NEW: a mention is not yet an entity. Reject before writing anything.
  const unresolved = (entities ?? []).filter((entityId) => !loadAnyEntity(id, entityId))
  if (unresolved.length > 0 && !create_provisional) {
    return {
      status: 'needs_adjudication',
      // Named so the DM can choose without another call. suggestEntities is the
      // existing resolver/grep helper — reuse it, do not write a second matcher.
      unresolved: unresolved.map((entityId) => ({ entityId, matches: suggestEntities(id, entityId) })),
      how_to_resolve: [
        'existing entity:  re-call update_scene with the canonical id',
        "new character:    call create_entity({ id, kind: 'npc', name, hp, ac, ... }), then re-call",
        'walk-on bit part: re-call with create_provisional: true (see §4.3.3)',
      ],
      // Deliberately NOT written. A half-applied scene is the bug being fixed.
      note: 'scene unchanged — resolve the ids above first',
    }
  }

  if (create_provisional) {
    for (const entityId of unresolved) {
      // Minimal stub: no hp/ac/conditions, so combat cannot silently draft it (§4.3.3).
      saveEntity(id, entityId, 'npc',
        { id: entityId, kind: 'provisional', name: entityId, provisional_since_turn: state.last_turn?.number ?? 0 })
    }
  }

  // …existing clock + scene merge, unchanged…
}
```

Note what this does *not* do: it does not create a sheet from a name. Creating canon from prose is
exactly the behaviour §4.3.5 forbids, and the DM already has `create_entity` for the case where a
character is genuinely being introduced.

Three properties make this the right gate rather than a new subsystem:

1. **It is the write path that already exists.** No new store, no new file, no second inference.
2. **It fails closed.** The scene is not updated until the ids resolve, so canon cannot drift ahead of
   the sheets — the failure mode is a question, not a silently-empty block.
3. **It is testable in the existing style.** Unknown-id-in-scene, known-id, mixed, and
   `create_provisional` are four cases against `state` test fixtures.

**Gate 1 has three entry points, not one.** An entity can enter `state.scene.entities` by three routes,
and a gate on only the first is decorative:

| Route | Location | Today |
| :--- | :--- | :--- |
| `update_scene` | `state.js:116-142` | writes `entities` through unchecked |
| `init_combat` | `mechanics.js:260` | unions combatant ids into the scene, **fabricating a sheet** via `defaultEntity` (hp 1, ac 10) for any miss |
| `add_combatant` | `mechanics.js:534` | unions one id into the scene |

All three must adopt the same rule. The *inline-stats* form (`init_combat`'s
`{ entity_id, hp, ac, initiative_bonus }`, `add_combatant`'s object form) stays legal and is the
explicit way to say "this is a real combatant with these numbers" — the gate rejects a **bare id** that
resolves to nothing, not a deliberate stat block.

**Backwards compatibility is required.** `seventh_moon` currently has `maude` in its scene, so a
strict reading would make the next live turn fail. Ship the gate with (a) a `create_provisional`
escape that keeps the turn playable, and (b) a one-time migration that writes provisional stubs for
already-unresolved scene ids, so existing campaigns do not open on an error. §9.2 carries the
checklist.

#### 4.3.3 Provisional entities

A walk-on — the barmaid who serves one drink — should not require a full sheet, and should not be
silently dropped either. A **provisional entity** is the third option:

```jsonc
// campaign/<id>/actors/<slug>.json — a provisional stub is deliberately minimal
{
  "id": "maude",
  "kind": "provisional",     // NOT "npc" — this matters, see below
  "name": "Maude",
  "provisional_since_turn": 133,
  "notes": ""                // no hp, no ac, no conditions, no resources
}
```

`kind: "provisional"` is load-bearing rather than cosmetic — but note that **two of the three
properties below are changes this spec has to make, not behaviours that already exist:**

* **Combat must refuse it — today it does the opposite.** `init_combat` (`mechanics.js:238-247`) calls
  `loadAnyEntity`, and on a miss calls `defaultEntity(entityId, { kind: 'npc', name })`. `defaultEntity`
  (`state-store.js:170-178`) defaults to **`hp = 1, ac = 10`**. Verified:

  ```jsonc
  // defaultEntity('maude', { kind: 'npc', name: 'Maude' })
  { "id": "maude", "kind": "npc", "name": "Maude", "hp": 1, "max_hp": 1, "ac": 10 }
  ```

  So an unknown id passed to `init_combat` **silently acquires a stat block and can be killed by a
  stray roll** — the barmaid scenario, already live in the code. The fix is to make the sheet-creating
  path *ask instead of inventing*: refuse (`needs_adjudication`) when the caller passed a bare id with
  no sheet, and keep the inline-stats form (`{ entity_id, hp, ac, ... }`) as the explicit way to say
  "this really is a combatant". That also preserves the legitimate use — a monster that appears for one
  fight and never gets a file.
* **The snapshot renders it distinctly** — `- **maude** (provisional — no sheet yet)` — which is the
  §6.1 "name unresolvable scene entities" requirement, satisfied by construction rather than by a
  special case in the renderer.
* **`doctor` can count them** (§9.3), so a campaign that has accumulated 30 provisional walk-ons
  becomes visible as the authoring debt it is.

A provisional entity is promoted to `kind: "npc"` by `create_entity` (or `update_entity`) with a real
sheet — either because the DM chose to, or because §4.3.4 required it. Deletion is the other legal
outcome and must be as easy: an unadopted walk-on should be removable without ceremony.

#### 4.3.4 Gate 2 — promotion for derived proposals

The DM is the narrator. When the DM writes a sheet, that is authorship, not a machine claiming canon
— so Gate 1 plus id discipline is sufficient for the DM's path. The layer that genuinely needs
promotion rules is the **swarm**, because a worker proposing an entity is a machine asserting
something the table never established.

The mechanism to adopt, taken from [`sneq-engine`](https://github.com/JeanDes-Code/sneq-narrative-system)
(see §9.5 for why), is **promotion on player uptake, with the model forbidden from supplying its own
evidence**:

1. A worker writes a proposal to `events/derived/NNNN.json` with `status: "provisional"` and a
   `surface_tokens` array — the literal strings by which the thing was named in the turn.
2. **The engine, not the model, decides promotion.** Each turn, `memory.js` already computes
   `{ player: { text }, dm }` from the derived history, and the player message is the one class that
   cannot be model-injected — `isPlayerMessage` requires a client-minted `rpcId` (`memory.js:71-76`).
   The player's verbatim text in `events/transcripts/NNNN_turn.md` (`## Player`) is therefore
   trustworthy evidence in a way no model output is.
3. A proposal whose surface token appears in the **player's** text is marked
   `status: "promoted", promoted_turn: N`. A proposal that is never taken up stays provisional
   forever and is eventually expired — never injected as though it were canon.
4. **A model may not certify its own evidence.** No tool may set `promoted` directly; the flag is
   derived from the transcript. This is the one structural guarantee in the whole derived layer, and
   it is what makes the §7 feedback-loop row survivable.

**What promotion writes, and what it does not.** Promotion does not itself create a sheet. It marks
the proposal as table-established, and the next turn's snapshot lists it under a heading that says so,
so the DM — who is the author — can ratify it into `actors/` with `create_entity`. Canonical files are
never written by the promotion path. The invariant from §4.2.5 stands: **a proposal never writes to a
canonical file.**

#### 4.3.5 The invariant

> **A proposal never writes to a canonical file, and the model never certifies its own evidence.**

Both halves are currently violated, and not by the derived layer — which does not exist yet — but by
the paths already in use:

* `update_scene` writes `state.scene.entities` from model-supplied strings (Gate 1, §4.3.2).
* `create_entity` / `update_entity` let the DM write `actors/` directly, with no record of whether the
  entity was ever established at the table.

So the failure §7 lists as a *future* risk of the derived layer is **already live on the canonical
path**. Gate 1 closes the first; the `doctor` report (§9.3) makes the second visible, because a
provisional entity that has survived N turns is exactly the signal that a table-established thing was
never written down — the Maude case, generalized into a metric.

#### 4.3.6 Honest limits

* **Player uptake may be a weaker signal for us than for SNEQ.** In a solo campaign one player
  narrates nearly everything, so a bare mention (*"I ask Maude about the Black Frost"*) is much
  weaker evidence than uptake at a multi-player table. The threshold may need to be *used or returned
  to* rather than merely *named*. This is a tuning question, not a design one, and it should be
  settled by play before the rule is relied on.
* **Substring matching needs normalisation.** Case, punctuation, and definite articles (*"the Black
  Frost"* vs *"Black Frost"*) will otherwise produce false negatives. The normaliser should be shared
  with the entity-resolution helper rather than written twice.
* **None of this is needed for the game to work today.** `dm_notes.md` is human-authored and already
  trusted. This section is a prerequisite for Phase 3, not for Phase 0 — but Gate 1 is cheap enough
  to land on its own, and it fixes a confirmed live bug.

---

### 4.4. Widening the Entity Projection **[NEW]**

This is the change that fixes the problem §4.1 hydration was built to solve, and it does so without a
new channel, a retention cost, or a guardrail removal.

`briefEntity` (`state.js:43-53`) drops `conditions[].effect`, `resources`, and `notes`. On the measured
campaign that is **75% of a PC sheet** (1,901 B → 471 B), and it is precisely where the mechanics live:

| Dropped | Example (`player/thiago.json`) | Why it matters |
| :--- | :--- | :--- |
| `conditions[].effect` | `"Divine Power": "Str 23, BAB +15, 20 temp HP"` | AC 37 is largely *from* these. Names alone cannot produce the number. |
| `resources` | `"spells_lost_today": "Summon Monster IV, Adoration of the Frightful, …"` | Whether a spell is still available is a mechanical fact the DM narrates. |
| `notes` | `"attack +23, damage 1d8+17, crit 17-20/x2"` | The combat math, verbatim. |

**Design.** Widen `briefEntity` to include the three fields, under a byte budget, ordered so the
budget truncates the least mechanical content first:

```javascript
const briefEntity = (entity, { includeDetail = true } = {}) => ({
  id: entity.id, name: entity.name, kind: entity.kind,
  hp: entity.hp, max_hp: entity.max_hp, temp_hp: entity.temp_hp ?? 0, ac: entity.ac,
  ...(entity.position ? { position: entity.position } : {}),
  // names stay cheap and always render
  conditions: (entity.conditions ?? []).map((c) => (typeof c === 'string' ? c : c.name)),
  // NEW — the mechanical detail, budgeted last so truncation eats it first
  ...(includeDetail ? {
    condition_effects: (entity.conditions ?? [])
      .filter((c) => typeof c === 'object' && c.effect)
      .map((c) => `${c.name}: ${c.effect}`),
    resources: entity.resources ?? {},
    notes: entity.notes ?? '',
  } : {}),
})
```

Constraints, because this sits on the per-turn path:

* **One projection, two consumers.** Both `get_state` and any snapshot must call it, so they cannot
  disagree about what an entity is — the property §4.1.2 called for, achieved by widening the shared
  function rather than by duplicating it into a second channel.
* **Budget it.** `notes` is unbounded prose and `resources` is an open map. Cap per entity and in
  aggregate (the same `cap()` helper as `sceneStateMaxBytes`), and keep the widened fields last so a
  truncation notice eats them rather than the HP/AC line.
* **`notes` is player-authored, not a secret store.** §4.1.2 already establishes this; widening the
  projection does not change it.
* **Measured cost.** Widening returns the 471 B projection toward the 1,901 B sheet for one PC. That is
  a real per-turn cost and must be measured on a party of four before it is enabled by default — the
  same discipline §5 now applies to every figure in this document.

**Why this replaces Phase 1 rather than supplementing it.** If the DM must still read the sheet to
narrate mechanics accurately, then moving the *lossy* projection into a snapshot saves a round-trip
and nothing else. Widening the projection removes the second read. Once it lands, open question 1
answers itself: there is no information argument left for hydration, only a latency one — and §5 has
already identified that latency as the cheap inference.

---

### 4.5. Turn Memory Capture (unchanged)

The capture path (`memory.js`, [FI-1](future-improvements.md#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories))
is unaffected by all of the above, and §4.1.3 property 3 still holds: injected kinds are never
mistaken for player input. It is in fact the mechanism §4.3.4 depends on, since `isPlayerMessage` is
what makes player uptake trustworthy evidence.

---

## 5. Quantitative Impact & Token Savings **[REVISED]**

The first draft's numbers were estimates that overstated the win and understated the cost. What follows
separates what is *known from the code* from what must be *measured in a spike* — the honest state of
this design today.

| Metric | Baseline Turn | Enhanced Turn | Assessment |
| :--- | :--- | :--- | :--- |
| **Model inferences per turn** | 2 (tool call, then reply) | 1 for routine turns | **Real, and the headline win.** The saved inference is *not* an average one, though — see latency below. |
| **Saved inference's character** | — | — | The saved step is a short one: prefill over a mostly-cached prefix plus ~40 decode tokens. The step that happens either way prefills the whole context and decodes the full ~450-token narration. |
| **Output tokens** | tool call (~40) + narration | narration | ~40 output tokens saved. Accurate. |
| **Input tokens** | `get_state`'s compact JSON | same content, delivered as a snapshot | **Not "zero".** The state tokens are paid either way. The draft guessed "~300 tokens" and the measurement lands close to it: `compact()` (`state.js:56-72`) returns mode, clock, initiative, the whole `scene` object, every PC sheet, and every non-PC scene entity, pretty-printed as JSON. **Measured** on `seventh_moon` (1 PC, no scene NPCs): **1,205 B ≈ 344 tokens**. The 4-PC-and-3-NPC scenario was not measured — treat any larger figure as an estimate. |
| **History growth** | ~0 per turn — `dm_notes.md` changes only when the DM writes it, so no new snapshot is emitted | **+1 snapshot message per turn** whenever any rendered field changes (HP, conditions, clock, position) | **New row, and the real cost.** Every superseded snapshot is retained in session history; it is only *filtered from delivery* by some providers (§4.1.3). On the native path, turn N ships N snapshots, each prefixed "this snapshot supersedes earlier ones". **Measured on `seventh_moon`:** 41 transcripts, 40 transitions, **20 byte-identical** → a per-turn snapshot emits 41 times where change-only would emit 21. So accumulation is real but *not* the ~1-per-turn the earlier draft assumed, and the rate is corpus-specific (this campaign has long static stretches; per-field counts were date 6, location 12, entities 1, micro-state 8, pending-action 8). Mitigations: small block, stable-first/volatile-last ordering, a byte cap, and a freshness line so the model can identify the current one. |
| **System-prompt prefix** | untouched | untouched | Accurate: the snapshot is a history message, not a prompt edit. |
| **Reply latency** | baseline | one round-trip + one short prefill less | **Not "~50%".** A flat halving implicitly treats both inferences as equal. Publish it as `saved ≈ round_trip + prefill(state_prefix) + decode(40 tokens)`, and measure each term. Expect a meaningful but smaller fraction of total turn time — plausibly 20–40%, varying with prefix-cache hit rate. |
| **Active-cast recall** | Depends on the DM choosing to search | Deterministic for entities the DM remembered to list | **"0% failure" was overstated.** Hydration keys on `state.scene.entities`, which `update_scene` populates at end of turn. Forget that call and the block is quietly empty — and a block the DM is told to trust makes this failure *worse* than no block. It also reinforces NPCs already tracked rather than surfacing forgotten ones; consider a compact roster of all known NPCs as well (§6, open question 2). |
| **Information content** | `get_state` returns `briefEntity`-projected sheets | The same projection, one round-trip earlier | **The snapshot is not more informative than the read it replaces.** Both paths run the same `briefEntity` projection (`state.js:43-53`), which drops `conditions[].effect`, `resources`, and `notes` — and on the measured campaign those dropped fields carry the mechanics (measured: a PC's full sheet is 1,901 B, the projection 471 B, **−75%**). Hydration therefore buys *latency*, not *information*: it removes the round-trip, it does not remove the lossiness. The snapshot is also **narrower** than `get_state` in one respect — it renders `state.scene.entities` only, whereas `compact()` renders *every* PC via `loadEntities(id,'pc')`, so a party member off-scene is in the read but not in the snapshot. This is what inverts open question 1 (see §8). |

**What is genuinely established without further measurement:** the routine tool round-trip disappears,
the prompt prefix stays cache-safe, turn memory capture is provably unaffected, and the saved step is
the cheap one.

**What Phase 0 has now measured** (offline, against `seventh_moon`; method and figures in §6.0):

* **The `get_state` payload is 1,205 B ≈ 344 tokens** for a 1-PC scene — *below* the 1–3 KB the
  earlier estimate guessed (the guess assumed a larger party).
* **Snapshots fire on 20 of 40 transitions.** The lever in open question 3 is worth roughly a 2×
  reduction on this corpus, not the 1–3% the earlier draft implied.
* **The entity projection is lossy exactly where mechanics are narrated** — see the new
  *Information content* row above.

**What still must be spiked:** the real latency split; accumulation over a longer campaign on the
primary provider; and whether dropping the mandatory `get_state` is safe *by itself* (open question 1,
whose premise the information-content finding has inverted).

---

## 6. Implementation Checklist & Migration Steps **[REVISED]**

> **⚠️ Superseded by [§9.2](#92-the-revised-sequence) (rev 4).** This section is retained because the
> *content* of most items is still correct and referenced elsewhere, but the **order is wrong**: it
> sequences hydration (6.1) before the write-path gate that fixes the confirmed bug, and before the
> projection widening that removes the second read. Follow §9.2; treat the checkboxes below as a
> catalogue of the work, not a sequence.

### 6.0 Phase 0 — the free spike, do this first

- [ ] **Remove the mandated resync from `dd35-gameplay-loop`.** It lives at
      `D&D35/.agents/skills/dd35-gameplay-loop/SKILL.md`, section **"## 1. Resync"** (verified): *"Call
      `get_state`… `get_state` is the truth — not chat memory. Never narrate mechanics you haven't read
      this turn."* That second sentence is a deliberate behavioural guardrail, not a procedural step, so
      the experiment is *removing a guardrail* — treat the result accordingly. Note also that
      `dd35-fresh-session/SKILL.md` §1 and §7 route through `get_state`; **`dd35-encounter-mode` does
      not** mandate it (verified — line 28 is a descriptive bullet). The mandate is in
      `dd35-gameplay-loop` §1 alone, but every mode skill's `whenToUse` triggers on *"when `get_state`
      reports mode X"*, so check whether routing still works without the resync; see §8 open
      question 1. This file is outside the harness workspace, so the edit needs the wider sandbox or
      the player's own editor.
- [ ] **Run the baseline session first.** One session *with* the resync intact, one *without*, and compare
      (a) how often `get_state` is called anyway out of habit and (b) whether narration drifts from
      `state.json`. A single session without a baseline is an anecdote, not an answer.
- [x] **Measure, on a real campaign, before designing further.** Done offline against
      `seventh_moon` with `tmp/dd35-phase0-analysis.mjs` (read-only; untracked scratch). Invoke it on
      the **campaign directory**, not the workspace root:
      `node tmp/dd35-phase0-analysis.mjs "<campaignDir>/campaign/seventh_moon"`. **Corpus:** 41
      transcripts, turns 1–142 with gaps at 10, 12–95, and 97–112 (76 turns pruned), 1 PC sheet, 10
      actor sheets. Results:
      - **`get_state` payload:** 1,205 B ≈ 344 tokens (1 PC, 0 scene NPCs). PC sheet brief vs full:
        471 B vs 1,901 B, i.e. **−75%** under `briefEntity`.
      - **Snapshot deltas:** 40 transitions, **20 byte-identical** → 41 snapshots per-turn vs 21
        change-only (**50% reduction**). Per-field changes: date 6, location 12, entities 1,
        micro-state 8, pending-action 8. *Lower bound* — clock time is not in the transcript header.
      - **Hydration coverage:** `state.scene.entities` is `["thiago","maude"]`; **`maude` has no
        sheet anywhere** (`find -iname '*maude*'` is empty). 50% of the current scene is unresolvable.
- [ ] **Still unmeasured:** the wall-clock split of a two-step vs. a one-step turn (needs a live
      session, not an offline pass), and snapshot accumulation on the primary provider beyond this
      corpus. The retention question the accumulation bears on is structural and is settled in
      §4.1.3 regardless of the count.
- [ ] **Decide the provider question.** If superseded snapshots are retained and delivered on the
      primary provider, decide whether the per-turn snapshot is still worth it, or whether the block
      should be emitted only when it *materially* changes (e.g. scene boundary, combat start/end).
      Phase 0 now gives the lever a size: on this corpus it halves emissions, against a worst case of
      ~14 k retained tokens over 41 turns at ~344 tokens each.

### 6.1 Phase 1 — state & cast hydration ([FI-9](future-improvements.md#fi-9--automatic-turn-start-state-injection))

- [ ] Implement `sceneStateContext()` in `plugins/dsh-dd35-preset/prompt.js`, registered at order 150
      as `dd35:scene-state`, `interpolate: false`.
- [ ] Read with `loadState` (never `requireState`) and **return `''` on every failure path**: no
      campaign, no `state.json`, unparseable JSON, entity id with no sheet. Prompt assembly must not
      be able to throw because a campaign file is missing or corrupt.
- [ ] Hydrate entities from `state.scene.entities` reusing the existing `briefEntity` projection
      (`state.js:43-53`) so the snapshot and `get_state` cannot disagree about what an entity is.
- [ ] **Name unresolvable scene entities; never drop them silently.** An id in `state.scene.entities`
      with no sheet is a real case, not a defensive one: `seventh_moon` currently has `maude` on stage
      with no sheet anywhere (§6.0). Render `- **maude** (no sheet on file)` — one line, no data — so
      the DM can see the gap and write the sheet. A silently omitted entity is the failure §4.1.3 and
      §7 both warn about.
- [ ] Emit **only fields that exist** on the sheet. Narrative detail comes from `dm_notes.md`, which
      is already injected in the same snapshot.
- [ ] Order the block stable-first, volatile-last, with a freshness line (`as of turn N`) so the model
      can identify the current snapshot among retained ones.
- [ ] Cap the block with `prompt.js`'s existing `cap()` helper (`sceneStateMaxBytes`, suggested 6144).
- [ ] Update the `dd35:dm-notes` prose: it currently says turn-to-turn details "are already retrieved
      fresh from `get_state`" — that instruction and its test (`tests/prompt.test.mjs:117-127`) must
      name the snapshot instead.
- [ ] Add unit tests in the `prompt.test.mjs` style for: no campaign; corrupt `state.json`; entity id
      with no sheet (asserted to render the named placeholder, not to vanish); empty `scene.entities`;
      truncation notice; and the freshness line.
- [ ] Keep `get_state` as a mid-turn refresh tool and say so in the encounter skill — after
      `apply_damage`, `roll_attack(apply: true)`, or `next_turn`, entity sheets have changed and the
      snapshot will not re-render until the next step.

### 6.2 Phase 2 — post-turn hook

- [ ] In `plugins/dsh-dd35-preset/memory.js`, dispatch after `commitTurnToIndex()` inside `turn/end`,
      and only on `reason.kind === 'completed'`.
- [ ] Keep the dispatch non-blocking, but **track the jobs**: register them so they are cancelled on
      unmount, awaited on teardown, and re-fired on the next `turn/end` if they died. A silent drop is
      not acceptable; a logged, retried drop is.
- [ ] One writer per file. Nothing in the swarm touches `state.json`, `dm_notes.md`, or
      `memory_index.json`.

### 6.3 Phase 3 — worker swarm

- [ ] Choose the runner: `llama-server` on loopback, **or** the harness's own subagent with a cheap
      model (§4.2.3). Record the decision and the reason; do not let the choice be implicit.
- [ ] Bear the real resource cost: weights + runtime + one KV cache per slot, sharing CPU and RAM with
      the main model. Measure worker wall-clock against player think-time.
- [ ] Define JSON schemas for summary, entity proposals, and promise proposals; use grammar-constrained
      decoding so parse failures cannot happen.
- [ ] Write derived output to `events/derived/NNNN.json` (+ `events/embeddings.bin`), each entry
      carrying provenance and each claim verified against the turn text before it is written.
- [ ] Dedup by content hash; enforce a per-entry byte budget.
- [ ] Inject derived content only under a heading that states it is machine-derived and may be wrong.
- [ ] **Do not** extend `events/memory_index.json` with summaries or tags. It stays a small,
      transcript-derived, rebuildable index with a `schema_version`; derived data lives beside it.

---

## 7. Failure Modes of the Derived Layer **[NEW]**

The derived layer is the only part of this design that can put text the DM did not write, and the
player never saw, into authoritative context. It needs a failure model before it needs a model choice.

| Failure | Consequence if unhandled | Required behaviour |
| :--- | :--- | :--- |
| **SLM hallucinates a fact** (invents a debt, a name, a secret) | The claim is written to a notes-like file, injected every turn, and treated as canon. It can outlive the session; nothing marks it as false. | Provenance check against the turn text before writing; machine-derived label in the prompt; proposals only; one-line deletion by the DM. |
| **Duplicate extraction** | The same promise appended on turns 40, 41, and 44; the notes file grows monotonically into the 16 KB cap and then truncates silently. | Content-hash dedup; a byte budget; a cap that is enforced by the writer, not only by the reader. |
| **Worker crashes or the app exits mid-swarm** | A turn's extraction vanishes with no trace; the DM cannot know which turns are covered. | Tracked jobs, a per-turn completion marker in the derived file, re-fire on next `turn/end`, and a startup sweep for turns missing their derived entry. |
| **Turn N+1 races the swarm** | The next snapshot may or may not include the findings — nondeterministic continuity that is painful to reproduce. | Atomic per-turn sidecar files so a partial write is impossible, plus an assumption stated everywhere: derived content is *best effort*, never required for correctness. |
| **Concurrent writes to one campaign** | `commitTurnToIndex` can trigger a full rebuild; a worker's read-modify-write can drop the DM's edit. | One writer per file; serialized per campaign; canonical files never written by workers. |
| **Index rebuild discards derived data** | Summaries and embeddings silently lost when an unrelated repair rebuilds `memory_index.json`. | Derived data lives in `events/derived/`, outside the rebuild path. Deleting it costs recomputation only. |
| **Runner unavailable** (`llama-server` down, model missing, no disk) | If the turn depends on it, the campaign stops. | Entire swarm is switchable off with one flag; every worker is optional; the DM's reply path never awaits a worker. |
| **Feedback loop** | Derived text enters the snapshot → the DM narrates from it → the worker extracts from that narration → the error is laundered into canon. | Dedup; provenance; a per-turn extraction cap; and never feeding a derived file back in as a *source* for extraction. |
| **Player-visible leakage** | Any secret written to `actors/*.json` or a derived file is browsable by the player, who owns the workspace. | Secrets stay in `dm_notes.md`; the README documents exactly which files are GM-facing-by-convention only, and that this is not enforcement. |
| **Parser brittleness on format drift** | `parseTranscript` expects the current header shape. **Confirmed in the live campaign:** turns 1–7 use `# Session 1: The Rising Shadow` / `## User Prompt` and turn 123 uses `### Turn 123` / `**Player:**`, so `memory_index.json` records them as **"Untitled Scene" with null dates** — visible in the index today. | Parse defensively and *record* the failure (a per-turn `parse_warning`) instead of silently emitting a null-dated entry; add a header-shape regression fixture per historical format; surface unparsed turns in the index so they can be repaired rather than silently absent. |
| **Extraction over a corpus that never wrote the cast down** | Entity extraction cannot recover entities no file records. **Confirmed:** `actors/` holds only hound_archon, remi, dire_wolves, dire_wolf_1/2, vance, gareth, kenna, thorn — **Maude (9 consecutive turns on stage), Wick, and the Council have no sheet at all.** Running the swarm here would invent structure and then, per this table, inject it as authoritative. | Do not start Phase 3 against this corpus. Treat the missing cast as an authoring gap for the DM to close, not an extraction problem; if extraction runs anyway, proposals must be marked unverified and never enter the injected block unflagged. |
| **The runtime fabricates a stat block for an unknown id** *(already live, not derived-layer)* | `init_combat` / `add_combatant` call `defaultEntity` on a lookup miss, which defaults to **hp 1, ac 10** (`state-store.js:170-178`, verified). Any bare id passed to combat silently acquires a sheet — so a walk-on NPC can be drafted and killed by a stray roll, and the fabricated numbers are indistinguishable from authored ones afterwards. | Gate 1 across all three scene-entry points (§4.3.2): refuse a bare id with no sheet, keep the inline-stats form as the explicit path. `doctor` should also report sheets whose entire stat line matches `defaultEntity`'s defaults, since that is the fingerprint of a fabrication. |

---

## 8. Open Questions **[NEW]**

Recorded rather than answered, because each one changes what to build:

1. **Is hydration load-bearing, or is deleting the mandate enough?** *Phase 0 has inverted the
   premise; a session is still needed to confirm it.* The original framing assumed the snapshot
   carries information the DM would otherwise have to fetch. It does not: both paths run the same
   `briefEntity` projection (`state.js:43-53`), which drops `conditions[].effect`, `resources`, and
   `notes` — and on `seventh_moon` the PC's full sheet is 1,901 B against a 471 B projection, so the
   **75% that is dropped is where the combat math and buff effects live** (AC 37 is largely *from*
   the dropped condition effects; attack and damage live in the dropped `notes`). The snapshot
   therefore saves a round-trip, **not** a read: the DM must still consult the sheet to narrate the
   mechanics the projection omits. Two consequences worth stating plainly:
   - **Dropping the mandate is probably safe — but for the opposite reason the design assumed.** Not
     because `get_state` is slow, but because *the snapshot would not have covered the gap anyway*.
   - **The lossiness is in `get_state`'s contract, not its delivery.** If mechanics must be narrated
     accurately, the fix is to widen the projection (or surface `dm_notes` more aggressively), not to
     move the same projection into a snapshot. Note this is a *separate* change from hydration and
     can be evaluated on its own.

   Note what the mandate actually is before removing it: `dd35-gameplay-loop` §1 says *"`get_state` is
   the truth — not chat memory. Never narrate mechanics you haven't read this turn."* Removing it is
   removing a guardrail, and the failure it guards against (narrating a stale HP total) is exactly the
   failure the snapshot would have to cover instead. Phase 0 says it does not currently cover it.
   **A correction to an earlier claim here:** `dd35-encounter-mode/SKILL.md:28` does **not** mandate
   `get_state`. It lists it in a bullet under "Running the round" as one of three options — *"shows the
   current order, round, and whose turn it is"* — with no imperative; the surrounding prose is about
   `next_turn`/`next_round`, and the only imperative nearby is *"Never skip an NPC's turn."* The
   earlier reading mistook a line number for a mandate. So the mandate lives in `dd35-gameplay-loop`
   §1 alone, and the experiment is a single-skill edit.
   **The coupling to watch** is that every mode skill's `whenToUse` reads *"when `get_state` reports
   mode X"* (`encounter-mode:4`, `exploration-mode:4`, `downtime-mode:4`), and `mode` is a field of
   `state.json` rather than something only `get_state` can produce — so the router is not literally
   removed, but the DM's reliable way to *learn* the current mode is. Decide whether routing then
   needs another signal.
2. **Should the snapshot carry a compact roster of every known NPC, not just scene entities?** The
   failure the DM actually suffers is *"I forgot this NPC exists"*, which scene-keyed hydration cannot
   fix — it only reinforces NPCs already in `state.scene.entities`. A one-line-per-NPC roster is
   bounded, cheap, independent of `update_scene` discipline, and probably the higher-value half of
   FI-9. It costs bytes every turn, so it needs its own budget and ordering. **Phase 0 sizes the
   cost:** only 2 of the 10 actor sheets on `seventh_moon` are in the current scene, so a full roster
   roughly **doubles** the 1,205 B payload — about **+344 tokens/turn** here, which is the number the
   budget decision needs. Note the roster cannot fix the *Maude* case: she is on stage and has no
   sheet, so no roster of known NPCs would list her either (§7, extraction row).
3. **Should the block be emitted only on material change?** If superseded snapshots are delivered on
   the primary provider, a per-turn snapshot is a real cost. **Phase 0 measures the lever at 2×:**
   20 of 40 transitions are byte-identical, so change-only emission would fire 21 times instead of 41.
   That is a meaningful reduction, not the order-of-magnitude the earlier draft guessed, because the
   volatile fields do change often when the scene is moving — the 2× is this corpus's long static
   stretches, not a general rate. It also cuts against question 4: a change-only rule keyed on
   *rendered text* would suppress exactly the mid-turn refresh the HP problem needs. Depends on
   question 1: if the DM narrates correctly without a per-turn read, the mandate was already doing
   less work than it appears to, and sparse emission becomes cheap to justify.
4. **What is the mid-turn refresh contract?** The snapshot renders per step, and `apply_damage` /
   `roll_attack(apply: true)` / `next_turn` change entity sheets without touching `state.json`, so the
   rendered text is unchanged and **no new snapshot is emitted**. The model can therefore be acting on
   HP it has already changed. Either require `get_state` after every mutating roll (prose, unenforced),
   or have the mutating tools write a state revision that the snapshot renders (code, enforced). The
   second is more work and strictly better; the first is what happens by default if this is not decided.
5. **Does the swarm run at all on the primary provider?** If a cheap model is already reachable through
   the configured providers, the subagent route may dominate `llama-server` on every axis except
   per-call cost. Decide with numbers.
6. **What is the retention policy for `events/derived/`?** It is discardable, but "discardable" is not
   "discarded": without a policy, a 500-turn campaign accumulates 500 sidecar files and a binary
   embedding store nobody prunes.
7. **Is player uptake the right promotion threshold for a solo campaign?** §4.3.4 adopts SNEQ's rule,
   but one player narrates nearly everything here, so a bare mention may be too weak an endorsement.
   Test against a real session before relying on it; the fallback is "used or returned to" rather than
   "named".

---

## 9. Implementation Order (supersedes §6) **[NEW]**

### 9.1 Why the order changed

§6 sequences Phase 1 (hydration) before everything else, on the assumption that hydration is the
load-bearing correctness mechanism. Phase 0 and the reading in §4.3–§4.4 say otherwise:

* **Hydration buys latency, not information** (§5, *Information content*). Widening `briefEntity`
  (§4.4) is what removes the second read; the snapshot only removes the round-trip.
* **The bug that motivated it is a write-path bug, not a read-path one.** `maude` is in the scene
  because `update_scene` accepted an id with no sheet (§4.3.2). Hydration would not have prevented
  that; it would have silently dropped her, which is the failure §4.1.3 warned about.
* **The failure modes §7 theorizes about are already preventable with a diagnostic** (§9.3), not with
  a swarm. Two of the five coverage failures found in the live campaign are detectable by reading the
  files — no inference required.

So the order below puts the two cheap changes that fix *confirmed, observed* problems first, and moves
the hydration channel and the swarm behind the canon-admission gate that has to exist anyway.

### 9.2 The revised sequence

* [x] **Step 1 — `doctor` diagnostic (§9.3).** **Implemented:** `plugins/dsh-dd35-preset/doctor.js`
  (`dd35_doctor`, read-only), registered in `cordis.patch.yml`, with 17 tests in
  `tests/doctor.test.mjs`. Run against `seventh_moon` it reports 5 findings: `maude` unresolvable
  (error), the `thiago` duplicate (error), 4 transcripts with no parseable header, 1 unexpired
  condition, and the expected pruning gaps as a note. No LLM, no writes — a test asserts every campaign
  file is byte-identical after a run.
* [ ] **Step 1b — Migration for live campaigns.** Not yet done. Write provisional stubs for
  already-unresolved scene ids (today: `maude`), and resolve the `thiago` duplicate (`player/` wins, so
  the `actors/` copy is dead data — decide whether to delete it or make it the canonical one). **Do
  this before Step 2,** or the next live turn hits a gate with no way through. `dd35_doctor` reports
  exactly the two items this step needs to clear.
* [ ] **Step 2 — Gate 1 across all three entry points (§4.3.2) + provisional entities (§4.3.3).** Fails
  closed, keeps the turn playable via `create_provisional`, and is testable against existing `state`
  and `mechanics` fixtures. **`init_combat` and `add_combatant` matter as much as `update_scene`** —
  they are where `defaultEntity` fabricates an `hp 1, ac 10` sheet for any unknown id today (§7). This
  is the change that closes the **confirmed live bugs**.
* [x] **Step 3 — Widen `briefEntity` (§4.4) and inject the live state passively (§11).**
  **Implemented.** `briefEntity` moved to `state-store.js` so `get_state` and the injected block render
  entities through one function; `scene-state.js` adds a capped runtime-context snapshot (2.60 KB / ~760
  tokens) carrying scene, party detail, present NPCs, and a known-cast roster, plus the player's own
  prose as a cached prompt section. 16 tests in `tests/scene-state.test.mjs`; suite total **87, all
  passing**. Measured cost and the falsification condition are in §11.3.
* [ ] **Step 4 — Repair affordances.** There is currently no way to revise narration or roll back a
  scene (`rollback`/`regenerate`/`undo` do not exist anywhere in the preset — verified by grep). Even
  a minimal "rewrite the last turn's transcript and re-derive the index" path closes the largest
  functional gap identified in the prior-art comparison (§9.5). Scope this separately; it is not
  memory-model work, but it is the thing that makes every other mechanism recoverable.
* [ ] **Step 5 — Promotion for derived proposals (§4.3.4),** only once the swarm exists to produce
  them. Engine-side, transcript-derived, model cannot self-certify.
* [ ] **Step 6 — Swarm, in §4.2.4's reduced form.** Start with the summarizer alone (worker 2), which
  is additive and discardable. Entity extraction and promise tracking come last, behind Gate 1 and the
  §7 failure model, and only if `doctor` shows the authoring debt is real rather than a one-campaign
  artifact.

### 9.3 The `doctor` diagnostic, specified

A read-only tool (`dd35_doctor`) and a matching CLI path, in the style of `sneq-engine doctor`. It
reports; it never writes. Every check below is currently failing somewhere in `seventh_moon`.

| Check | Detects | Evidence it is real |
| :--- | :--- | :--- |
| **Unresolvable scene ids** | `state.scene.entities` entries with no sheet | `maude` — on stage 9 consecutive turns, no sheet anywhere |
| **Provisional entities** | Stubs older than N turns, with the turn count | none yet; becomes a metric once §4.3.3 lands |
| **Duplicate entity ids** | Same id in `player/` and `actors/`, with a value diff | `thiago` — differs in conditions, resources, position, notes, and initiative (22 vs 14) |
| **Unparsed transcripts** | Turns `memory_index.json` recorded as `Untitled Scene` or with a null date | turns 1–7 (`# Session 1:` header) and 123 (`### Turn 123`) |
| **Index/transcript divergence** | Turns on disk that the index does not cover, or vice versa | gap-triggered rebuilds make this silent today |
| **Stale scene** | `state.scene.entities` non-empty but `last_turn.number` far behind the newest transcript | detects a campaign whose scene was never updated |
| **Expiring conditions** | `expires_round` values on conditions in a scene with no active combat | 9 of Thiago's conditions have `expires_round: null`; the ones that do not are invisible |
| **Fabricated sheets** | Any sheet whose whole stat line equals `defaultEntity`'s defaults (`hp 1, max_hp 1, ac 10`, empty conditions/resources/notes) | the fingerprint of a `defaultEntity` fabrication from `init_combat`/`add_combatant` (§7). Distinguishing these from an authored 1-HP rat is impossible by inspection alone, which is the point — the fix is to stop creating them (§4.3.2), and the report is how we find the ones already written. |

Output contract: a list of findings, each naming the file and the turn, plus a one-line remedy. Exit
non-zero when any check fails, so it can run as a pre-session gate. **It must never throw** — a missing
campaign or corrupt JSON is a finding, not an exception, for the same reason §4.1.3 requires the
snapshot path to return `''`.

### 9.4 What this direction explicitly does *not* do

* **No `llama-server` swarm for extraction at this stage.** §9.5 records the comparison that motivated
  this; the reduced form in Step 6 preserves the option without paying for it up front.
* **No new canonical files.** §4.3 adds no store. Provisional entities live in `actors/` alongside real
  sheets, distinguished by `kind`, so there is nothing new to synchronize.
* **No approval UI.** §9.5 explains why a human review queue was rejected in favour of evidence-based
  promotion.
* **No removal of the `get_state` guardrail** as a prerequisite. Step 3 makes that experiment
  unnecessary rather than pending.

### 9.5 Prior-art comparison (why these choices)

Recorded because the direction changed on the strength of it, and a future session should be able to
re-litigate it rather than re-derive it.

| Project | Core move | What we take | What we decline |
| :--- | :--- | :--- | :--- |
| [`sneq-engine`](https://github.com/JeanDes-Code/sneq-narrative-system) | Append-only ledger; current state is a **projection**; inventions provisional until promoted; `doctor` for authoring gaps; **promotion from the player's raw words, model forbidden to self-certify**; **a verb changes nothing — canon only via explicit `sets`**; needs-adjudication instead of silent near-duplicate creation | Promotion on player uptake (§4.3.4); id discipline and adjudication (§4.3.2); provisional-until-promoted (§4.3.3); `doctor` (§9.3); the invariant (§4.3.5) | The full event-ledger rewrite, holder-relative knowledge, and news-routing model — a much larger architecture than this preset needs today |
| [`NarrativeEngine-P`](https://github.com/Sagesheep/NarrativeEngine-P) | Verbatim scene archive + two-phase retrieval (chapter scan → vector scene retrieval); conditional injection ("injected for that turn only, so recalling the same costume fifty times doesn't stack fifty copies"); lore-check QA; staged changes the player confirms; rollback that cascades world state | The conditional-injection principle as the answer to §4.1.3's accumulation problem; the repair/rollback gap as Step 4 | Its full NPC-psychology and world-arc simulation layers |
| [`llmdm`](https://github.com/andr1an/llmdm) | Per-campaign SQLite; session briefs; context-window rotation; session-log compression | Nothing structural — cited as evidence that **session-level** briefs are sufficient in practice, which is what makes per-turn hydration hard to justify | — |
| [`dnd-ai`](https://github.com/chungs10/dnd-ai) | mem0 + ChromaDB + Neo4j entity graph | Nothing | Graph database for a one-player campaign |

The convergent finding across all four: **none runs a background fleet of small models in a separate
runtime to produce memory.** Where they use background AI at all it is tiers of the same provider
configuration, and where they need judgement they make a targeted call rather than a standing swarm.
That is the main reason §9.2 sequences the swarm last.

### 9.6 What would change this plan

* If `doctor` on other campaigns shows the authoring debt is specific to `seventh_moon`, Step 6's
  extraction is solving a one-campaign problem and should be dropped in favour of Step 3 alone.
* If measurement shows the four-PC widened projection costs more than ~1,000 tokens/turn, Step 3 needs
  a tighter budget (effects only, no `notes`) rather than abandonment.
* If play shows the DM narrates mechanics correctly *without* the `get_state` mandate, then Gate 1 and
  Step 3 are sufficient and the whole retention/accumulation thread in §4.1.3 becomes moot.

---

## 10. Measured Interaction Shape — Why This Work Exists **[NEW]**

This section is the evidence base for the whole specification, replacing argument-from-first-principles
with what 88 real sessions actually did. It is placed last because it answers *why*, after the design
has been stated — but it is the reason the design exists at all.

### 10.1 Method

Session logs are the only complete record: `events/transcripts/NNNN_turn.md` stores **only the player's
message and the DM's reply** — no tool calls, no step boundaries. Tool usage therefore had to be read
from the harness session logs under
`~/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--/`, filtering to the 88
sessions whose first event carries `"agentPreset":"dd35"`.

* `tmp/dd35-usage-analysis.mjs` — tool calls, skill loads, step counts.
* `tmp/dd35-usage2.mjs` — the above plus per-inference token usage, `read` targets, and the static
  advertised-tool-schema cost.

Both are read-only and re-runnable. Every figure below comes from them.

### 10.2 The routine turn

**Corpus:** 88 sessions, **4,072 inference steps**.

| | Calls | Share |
| :--- | ---: | ---: |
| **Preset tools** (`dd35-*`) | 2,168 | 49% |
| **Harness built-ins** (fs, skills, misc) | 2,266 | 51% |

The preset tools that carry a routine turn:

| Tool | Calls | Role |
| :--- | ---: | :--- |
| `update_scene` | 310 | scene capture |
| `draw_keyword` | 300 | oracle |
| `get_state` | 290 | resync |
| `roll_solo_oracle` | 284 | oracle |
| `list_memories` | 252 | recall |
| `draw_focus` | 205 | oracle |
| `fetch_memories` | 167 | recall |
| `grep_memories` | 131 | recall |
| `route_turn` | 105 | mode routing (**≈1 per session**, not per turn) |

So a turn is roughly: *route → get_state → draw/lookup → update_scene*. **The dominant activity by
volume is divination and recall, not mechanics** — the entire combat toolset
(`roll_attack`, `apply_damage`, `roll_check`, …) is called **zero times** across all 88 sessions,
because the campaign has not been in combat. That is a fact about this corpus, not evidence the tools
are unused; §9.2 still keeps them.

### 10.3 The finding: the model compensates for lossy recall by reading files

**Half of all tool traffic is filesystem work**, not game mechanics:

| Tool | Calls |
| :--- | ---: |
| `read` | **1,113** |
| `bash` | 312 |
| `edit` | 261 |
| `glob` | 131 |
| `grep` | 122 |
| `write` | 81 |

`read` alone is **more than any single preset tool**, and its targets are the campaign's own history —
transcripts and backstory:

| Path | Reads |
| :--- | ---: |
| `player/backstory.md` | 99 |
| `events/transcripts/0001_turn.md` | 76 |
| `events/transcripts/0003_turn.md` | 59 |
| `events/transcripts/0002_turn.md` | 50 |
| `player/character.md` | 30 |
| `events/transcripts/0004_turn.md` | 29 |
| `events/transcripts/0113_turn.md` | 29 |

**The DM re-reads the story it already played, because the memory layer does not surface it.** This is
the concrete form of the problem this specification exists to fix: 550 memory-tool calls coexist with
1,113 file reads, which is what a retrieval layer that under-delivers looks like from the inside.

### 10.4 Why that becomes a context problem

Measured over 3,950 assistant inferences:

| Metric | Value |
| :--- | ---: |
| Input tokens, **median** | 4,128 |
| Input tokens, **p90** | 51,111 |
| Input tokens, **max** | 581,781 |
| Cache-read tokens, **median** | 48,980 |

The median turn is cheap. The tail is not: p90 is **12× the median**, and the maximum is two orders of
magnitude beyond it. The feedback loop that produces it:

```
model cannot recall X  →  reads a transcript  →  that content joins the history
        ↑                                                     │
compaction drops it  ←  context balloons  ←  history grows past the cap
```

Every read is a durable addition to history, so a read performed to *recover* lost context **causes**
the context growth that triggers the compaction which loses it again. The preset already carries the
scar of this loop: `dsh-compaction-guard` exists because *"a 31-character non-answer replaced 1840
events"* (`cordis.patch.yml:150-184`).

### 10.5 What this does *not* say

* **The 43 advertised tools are not the main problem.** All 43 ship every request (~6,250 tokens of
  schema, from `tmp/dd35-usage-analysis.mjs`'s sibling measurement), of which **14 were never called**
  and the top 6 account for 78% of preset calls. But schemas sit in the cached system prefix — median
  cache-read is 48,980 tokens — so an unused tool costs a selection decision, not much context.
  Tool-count reduction is second-order; **the p90 is the problem.**
* **Adding channels would make this worse.** Hydration, the swarm, and promotion all add surface area
  to a model already spending half its calls on filesystem compensation.
* **The fix is subtractive.** Widening `briefEntity` (§4.4) and making the memory tools return enough
  that a `read` is unnecessary are the two changes that *reduce* file traffic. That is why §9.2 orders
  them ahead of everything additive.

### 10.6 A note on the oracle

`roll_solo_oracle` (284 calls) accepts a `likelihood_modifier` — *"Shift the d20 result up (likely) or
down (unlikely)"* — chosen by the model, answering a question also chosen by the model. Applied at the
extremes it sweeps the whole table. The roll is genuinely random; the *framing around it* is not
independent. This is recorded as an observation, not a defect: it is out of scope for the memory work,
but it is the single heaviest mechanic in the corpus and it deserves its own look.

---

## 11. The Passive Recall Layer — Implemented **[NEW]**

§10 established the problem; this is the fix for the half of it that is passive. Scope: what the DM
should never have had to ask for. Retrieval *tools* are not changed here.

### 11.1 What was built

Two new contributions from `plugins/dsh-dd35-preset/scene-state.js`, split deliberately by volatility:

| Contribution | Channel | Cadence | Measured cost |
| :--- | :--- | :--- | ---: |
| **Scene & cast state** | `systemPrompt.context` (order 300, after `dm-notes`) | re-rendered per step, byte-capped | **2.60 KB ≈ 760 tokens** |
| **Player character prose** | `systemPrompt.section` (order 120, `interpolate: false`) | cached in the system prefix | **23.06 KB ≈ 6,746 tokens** |

**The split is the design decision worth keeping.** `backstory.md`, `character.md`, and `companions.md`
are *structural* — they change maybe once a campaign — so as a prompt section they are paid for once.
The same bytes in the runtime snapshot would be re-sent on every step, because
`joinContextSections` renders every context into one message. Conversely the live scene is *volatile*,
so it belongs in the snapshot and is capped so it cannot grow.

The snapshot renders, in truncation order:

1. A **freshness line** — `State as of turn 142, 2026-10-06 18:46` — because the channel wraps every
   snapshot in the fixed string *"This snapshot supersedes earlier runtime-context snapshots."* and one
   provider delivers all of them. Without the turn number the model cannot tell which is current.
2. Mode (with round and whose turn, in combat), location, clock, micro-state, pending action.
3. **Party** — full mechanical detail: HP/temp/AC, condition names, and then the `condition_effects`,
   `resources`, and `notes` that §4.4 restored.
4. **Present (non-party)**, and **Known cast, not present** — one line per `actors/` sheet, which is the
   answer to *"who have I forgotten?"* that scene-keyed hydration cannot give (§8, question 2).
5. A closing note that the block is rebuilt **per step, not per tool call**, so `apply_damage` /
   `roll_attack(apply: true)` / `next_turn` still require `get_state`.

An entity named in the scene with no sheet renders as `**maude** — no sheet on file` rather than being
dropped, satisfying the §6.1 requirement by construction.

### 11.2 Three defects found while implementing

All three were silent, and two would have produced the exact failure this work exists to prevent.

1. **Prompt assembly cannot use `loadState`.** The module-level workspace binding is set by *tool*
   execution (`bindWorkspaceFromExec`) and is unset during assembly, so `loadState(id)` threw and the
   protective `catch` returned `''` — the block rendered empty with no error anywhere. Fixed by adding
   root-taking `listEntityIdsIn` / `loadEntityIn` to `state-store.js`, matching the existing
   `readActiveCampaignIn` / `campaignFilePath` pattern. **Any future assembly-time read must take its
   root as an argument.**
2. **A tight byte cap silently deleted the block.** When the budget was at or below the truncation
   notice's own length, `cap()` returned an empty body, and the empty-body guard turned that into `''`.
   An over-tight cap erased the state rather than shrinking it. `cap()` now returns the notice.
3. **A partial options object blanked the block.** `sceneStateContext(at, { sceneStateMaxBytes: N })`
   left the other budgets `undefined`; `slice(0, NaN)` threw; the `catch` swallowed it. The function now
   merges its own defaults instead of trusting the caller. Each defect has a named regression test.

### 11.3 Cost, stated honestly

**~7.5 k standing tokens** (760 per step + 6,746 cached once), against roughly 344 tokens for the
`get_state` call it partly replaces. That is a large increase and it is deliberate, so the numbers
behind it should be re-checked rather than assumed:

* It replaces **1,113 `read` calls** and the transcript re-reads in §10.3. If file traffic does not
  fall measurably in the next sessions, this trade was wrong and `playerFilesMaxBytes` should drop —
  the config accepts `playerFiles: []` to disable the prose section entirely.
* The player prose is **23.3 KB of a 142-turn campaign**. A long campaign's `character.md` will grow,
  and the section is cached by content identity, so it is re-read only when the file changes.
* The snapshot is capped at 6,144 B and currently renders 2.6 KB, so there is headroom for a larger
  party before truncation begins.

### 11.4 What this does *not* fix

The other half of §10's finding is **retrieval quality**: `grep_memories` requires the model to already
know the keyword, and `list_memories` (252 calls) is the closest thing to a browsable index but is a
tool call, not passive. A DM that has genuinely forgotten a name has no passive way to rediscover it —
the known-cast roster covers *entities*, not *events*. That is the next piece of work, and §8's open
questions still govern its shape.

---

### 11.5 Cast Tiering, and a Parser Bug That Was Eating the Campaign **[NEW]**

### The roster cannot grow without bound

The first version listed every `actors/` sheet in full. That is linear in cast size, so a 300-actor
campaign would inject 300 detailed lines on every step — a second party block, most of it concerning
characters three story-arcs stale. Two signals grade it, cheapest first:

| Signal | Source | What it can and cannot answer |
| :--- | :--- | :--- |
| **Recency** | derived from the transcripts (`lastSeenByActor`) | Answers *"who has the story been about lately?"* Free — no authoring. **Cannot** answer *"who have I forgotten?"*, because a character absent for 60 turns is invisible to recency by definition. |
| **`npc_tier`** | optional field on the sheet, `'main'` promotes | Exactly the forgotten-character case. The only signal that survives a long absence. |

Rendering: active cast (seen within `castRecentTurns`, default 30, **or** marked `main`) get a full line
with recency (`seen 13 turn(s) ago`, `seen this turn`, `never on stage`); everyone else collapses to
`### Also on file` as name + id + age, capped at `castDormantLimit` with an explicit `…and N more`.

**Names are never dropped, only detail.** That is deliberate: the roster's original purpose was knowing
who exists *without having to remember them first*, so the collapsed form is a findability index whose
per-entry cost is near-constant, not a filter that hides people.

**Matching detail that matters:** actor ids are almost never what the prose uses. Searching transcripts
for `dire_wolf_1` finds nothing while "Dire Wolf (Alpha Pair, male)" occurs in five turns. The recency
map therefore matches an actor's id **and** its display name with any parenthetical qualifier stripped.
Recency is computed against `loadTranscriptsIn`, whose parse cache is keyed on directory stamp, so it is
one regex pass over in-memory text per assembly rather than a re-read.

### The parser bug

Building the recency map exposed a defect that had been silently destroying the campaign's own history.

`parseTranscript` extracted the two message bodies with:

```js
const playerMatch = text.match(/^##\s*Player\s*\n([\s\S]*?)(?=\n##\s|$)/m)
const dmMatch = text.match(/^##\s*DM\s*\n([\s\S]*?)$/m)
```

Lazy `[\s\S]*?` followed by `$` under `/m` stops at the **first line ending**, and the lookahead variant
stops at any blank or `#`-leading line. Measured on `seventh_moon`:

| | Before | After |
| :--- | ---: | ---: |
| DM narration parsed | ~10,000 chars | **100,815 chars** |
| Transcripts with truncated DM prose | **37 of 41** | 0 (the 4 that remain are the known format-drift files with no `## DM` heading at all — §9.3 already reports them) |
| Transcripts with truncated player text | **25 of 41** | 0 |

Roughly **27k tokens of the campaign's narration were invisible to every memory tool** — `grep_memories`,
`fetch_memories`, `list_memories`, and the recency map all read through this function. The DM was
`read`-ing raw transcript files (§10.3) partly because the indexed copy of those files was truncated to
its first line.

**Why this matters beyond the fix.** It is the strongest evidence yet for §10's conclusion: the measured
symptom was "the DM re-reads its own files", and the root cause was not a missing channel but a broken
one. A snapshot or a swarm built on top of this parser would have embedded the truncation.

The replacement anchors on **section order** rather than heading counting:

* the player body runs to the `## DM` heading — *not* to the next heading of any kind, because a player
  message may contain `## ` markdown of its own;
* the DM body runs to **end of file**, because a turn routinely closes on the DM's own `###` subsection
  (turn 142 ends on `### 📍 Current Situation`) and bounding it there would discard the prose;
* the heading match takes the **last** occurrence, because turn 1's preamble contains `## User Prompt`.

Known limit, documented in the code: a player message containing a literal `## DM` line is
indistinguishable from the real heading. That is inherent to a markdown transcript and not worth a
sentinel.

Nine tests in `tests/transcript-parse.test.mjs` cover this, including the blank-line case, the `###`
subsection, player-supplied `## ` markdown, and the `## User Prompt` preamble.

---

## 12. The Contextual Record **[NEW]**

### 12.1 What this is, and what it is not

A **contextual record** is one turn described factually: *who was there, where, when, what happened,
what is unresolved.* Retrieval over these records answers questions of the form "these people, this
place, that business" — **exact, explainable, and derived entirely from files already on disk.**

This is deliberately **not** semantic search. Two different things have been conflated in discussion
and the distinction is load-bearing:

| | Contextual (this section) | Semantic (deferred, §4.2) |
| :--- | :--- | :--- |
| Query | *Did these two appear together? At this place? How long ago? Is it unfinished?* | *Show me moments that feel like this one* |
| Mechanism | exact match + counting | embeddings |
| Cost | **zero** — no model, no inference | a model call per unit indexed |
| Failure mode | misses a connection nobody named | plausible-but-wrong recall, unexplainable |

### 12.2 The record

```jsonc
{
  "turn": 113,
  "date": "3 Years Ago Dusk (Entering Night)",   // transcript header
  "where": "Inside Hurstwood Gates / Eastern Wall",
  "actors": ["thiago", "gareth", "hound_archon", "kenna", "remi", "vance"],
  "label": "…",                                   // what happened, one line
  "unresolved": "…",                              // what the turn left open
  "actor_source": "prose",                        // 'scene' | 'prose'
  "label_source": null                            // 'scene' | 'narration' | null
}
```

Both provenance fields are **part of the record, not implementation detail**, and the implementation carries
them (`context-index.js`). `actor_source` matters because presence is a fact in only 9 of 41 turns: when the
header has no `- Entities:` line the actors are inferred from prose, which over-reports (a character
*discussed* is not necessarily *present*) and under-reports (an unrostered walk-on is invisible). A consumer
that cannot tell the two apart will treat a guess as a fact.

**Provenance fields are part of the record** because the two sources differ in trustworthiness and the
reader must be able to tell them apart:

* `actor_source: "scene"` — the header carried `- Entities:`, i.e. the DM recorded who was present.
* `actor_source: "prose"` — no `- Entities:` line, so presence was inferred by matching the campaign's
  entity roster against the turn text. This can over-report (a character *discussed* is not necessarily
  *present*) and under-report (an unrostered walk-on is invisible). A good candidate signal, a poor fact.
* `label_source: "scene"` — the header's `- Micro-State:`, the DM's own summary.
* `label_source: "narration"` — derived from the narration's opening sentence, because no micro-state
  was recorded that turn.

### 12.3 Why the label needs a fallback

Measured on `seventh_moon`, the scene-derived fields are sparse:

| Header field | Turns carrying it |
| :--- | ---: |
| `Date` | 37 / 41 |
| `Location` | 33 / 41 |
| `Entities` | **9 / 41** |
| `Micro-State` | **9 / 41** |
| `Pending Action` | **0 / 41** |

`state.json` keeps only current values, so the historical scene cannot be recovered. **The capture path
is not at fault** — `writeTranscript` already receives `microState` and `pendingAction` from
`state.json` and writes them when truthy; on those 32 turns `state.json` itself held no scene data.
Nothing retroactive can be done, so the record derives its label from the narration's opening sentence
when the scene has none, and **says which source it used.**

Actor presence, by contrast, is available for **every** turn, because it is derived from prose:

```
106 distinct actor–turn edges across 41 turns
vance co-occurs with: thiago (24), kenna (13), remi (11), gareth (9), hound_archon (4)
```

### 12.4 The trigger

Retrieval must not run every turn — that is the §11.4 mistake in a new costume. It fires when the
record changes shape:

* **Actor re-entry** — an entity in the current scene whose last appearance was `≥ actorGap` turns ago
  (default 8). This is the case the section exists for.
* **Location change** — the scene's location differs from the previous record's.
* **Scene change** — `scene.title` changed.

### 12.5 Ranking

Candidates are ranked by counting, not by a model, and **each carries the reason it was retrieved** so
the DM can judge it:

```
score = 3·(shares ≥2 actors with the current scene)
      + 2·(same location)
      + 1·(a re-entering actor appears here)
      + 1·(unresolved business)
      + recency bonus (nearer turns score higher)
```

Turns inside the recent-context window are **excluded** — surfacing what the DM can already see is
noise. Output is capped (`maxCandidates`, default 6) and rendered compactly: turn, date, place, actors,
label. No narration is injected wholesale; a candidate is a pointer the DM may follow with
`fetch_memories`.

### 12.6 Interface

`buildContextRecords` and `findContextCandidates` are **pure functions over parsed transcripts and the
entity roster** — no writes, no model, no state — exposed as a read-only tool
(`dd35_context_index`) so the DM can ask *"what do I know about Vance?"* directly. They are also what a
future passive injection would call.

### 12.7 What is explicitly not built

* **No embeddings and no model call anywhere in this section.** The semantic layer stays deferred behind
  §12.1's evidence test and behind the cost constraint that produced this design: both providers
  configured in this profile are external (`llm-meridian-antigravity` at `openmediavault:3457`,
  `llm-deepseek` with no `baseURL` override and therefore the metered default), so per-turn inference is
  a recurring bill rather than a one-off cost.
* **No new store.** Records are recomputed from the transcripts, which are already the canonical turn
  record (`memory-store.js` says so explicitly). `loadTranscriptsIn` is cached on directory stamp, so
  this is one pass over in-memory data.
* **No backfill.** The 32 label-less turns stay label-less rather than receiving generated retroactive
  summaries, which would put machine-written text where a DM-written record is expected.

### 12.8 Implemented **[NEW]**

`plugins/dsh-dd35-preset/context-index.js`, registered as `dd35-context-index`, with 21 tests in
`tests/context-index.test.mjs`. Suite total: **121 tests, all passing.**

Measured against `seventh_moon`:

| | Result |
| :--- | :--- |
| Model calls to build the index | **0** |
| Actor–turn edges derived | 106 across 41 turns |
| Turns the `entity` lookup returns for `vance` | 15, with co-actors, place, and label for each |
| Trigger on the live campaign today | *none* — correct: the scene is static (Thiago appears in the newest turn; Maude has no sheet) |

The entity lookup returns, for example, `turn 129 — The Boar's Rest - Back Room / Bath`, with
`thiago, dire_wolves, gareth, hound_archon, kenna, remi` and the DM's own opening line as the label.

**Three decisions the tests pinned down, each after getting it wrong first:**

1. **A player character is never reported as "returning".** The PC is present by definition; absence
   from the record means the DM stopped listing them, not that they left. Without this exclusion the
   real campaign's trigger fired on `thiago` — noise that would have made the feature untrustworthy
   immediately.
2. **A location change needs two comparable records.** Comparing against a null prior place made the
   campaign's first located turn report a change *from nothing*. The trigger now requires
   `previous.where != null` as well as a difference.
3. **`actor_source` is part of the record, not an implementation detail.** Nine of 41 turns carry a
   DM-written `- Entities:` line; for the other 32, presence is inferred from prose, which over-reports
   (a character *discussed* is not necessarily *present*) and under-reports (an unrostered walk-on is
   invisible). A consumer that cannot tell the two apart will treat a guess as a fact.

**Known limit, stated rather than hidden:** the label for 32 of 41 turns is the narration's opening
sentence, not a summary. On the live campaign turn 4's label is `"Welcome back to *Chronicles from the
Seventh Moon*!"` — the opening line of an early session, which is a poor description of the turn. It is
factual and free, but it is not a summary, and `label_source: "narration"` says so.
