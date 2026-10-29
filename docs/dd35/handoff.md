# DD35 Memory Model — Session Handoff

> **Before writing or debugging plugin code, read [`lessons-learned.md`](../lessons-learned.md).**
> It collects every error class this project has hit — Cordis service access, loader dialect,
> client-bundle rules, the Meridian continuation failures, result-shape bugs — each with symptom,
> cause and rule. The `fiberPhase: failed` incident alone cost three wrong diagnoses that it
> would have prevented.


**Purpose:** migrate this work to a normal session (this one ran under the DM preset, so it had no shell tool and its edits were split across two workspaces).
**Written:** 2026-10-08 · **Status:** spec at **rev 8**, plus two new specs. Implemented: `dd35_doctor`, the passive recall layer (§11), cast tiering (§11.5), the contextual record (§12), the oracles (FI-18/19). **In progress: the tool-result retention bundle** (Path A). Suite: **157 tests passing**.

> **⚠️ Rev 4 changed the plan, not just the numbers.** See **spec §9** first; it supersedes §6's phase
> order. The short version: Phase 0 plus a survey of comparable systems (`sneq-engine`, NarrativeEngine-P,
> llmdm, dnd-ai — spec §9.5) both point at the same conclusion — **the hydration channel was solving a
> latency problem while the confirmed bugs are on the write path.** Three things were added:
> - **§4.3 Canon admission** — `update_scene` (and `init_combat` / `add_combatant`) must refuse an id
>   with no sheet instead of accepting it; provisional stubs for walk-ons; promotion by **player
>   uptake** for anything machine-derived, with the model forbidden to certify its own evidence.
> - **§4.4 Widened `briefEntity`** — this is the change that removes the *second read*; hydration only
>   removed the round-trip.
> - **§9.2 revised order** — `doctor` diagnostic and the write-path gate come first; hydration is
>   deferred; the swarm is last.
>
> **A new live bug was confirmed while writing §4.3:** `init_combat`/`add_combatant` call `defaultEntity`
> on a lookup miss, which defaults to **hp 1, ac 10** — so any unknown id passed to combat silently
> acquires a fabricated sheet and can be killed by a stray roll. Verified by running `defaultEntity`
> directly. This is in the spec §7 failure table and in §9.3's `doctor` checks.

> **⚠️ Superseded in part (2026-10-08, second session).** The next session ran
> `tmp/dd35-phase0-analysis.mjs` and it **disagreed with §4 below**. Per §7's own rule, the script is
> right and §4's hand-derived prose was wrong on three counts:
> 1. **Corpus is 41 transcripts, not 54** (verified: `ls transcripts/ | wc -l` = 41; numbering is
>    1–9, 11, 96, 113–142). The "54" was arithmetic over the turn range, not a file count.
> 2. **`micro_state`/`pending_action` do *not* change every turn.** They change in **8 of 40**
>    transitions each. **20 of 40 transitions are byte-identical**, so change-only emission is a
>    **2×** lever, not the ~1–3% §4 claimed.
> 3. **`get_state` payload is 1,205 B ≈ 344 tokens**, not ~1,400 B / ~400 — and the "~300 token"
>    original estimate was therefore *near-correct*, not "2–3× low".
> 4. **`dd35-encounter-mode/SKILL.md:28` does not mandate `get_state`** — it is one of three bullets
>    under "Running the round", not an imperative. The mandate is in `dd35-gameplay-loop` §1 alone
>    (see §4, *Verified about the skills*). Same failure mode as the bad globs: reading a citation
>    without its context.
> 5. *(Understatement, not error.)* §4 finding 4's "conflicting values" — the two `thiago` files differ
>    in conditions, resources, position, notes, *and* initiative (22 vs 14), not just initiative.
> The correct figures are now in the spec (§5, §6.0, §7, §8). **Prefer the spec over §4 below.**


---

## 1. What this session actually did

Three things, in order:

1. **Reviewed the enhanced memory-model spec** against the real code and corrected its false claims (rev 2).
2. **Corrected cross-referenced docs** that repeated the same false claims.
3. **Ran the Phase 0 offline analysis** on the live campaign, producing hard numbers for open questions Q2 and Q3 and a partial answer to Q1.

Nothing was implemented. No plugin code was touched.

### 1b. What the second session did (this document is rev 3)

1. **Re-ran the Phase 0 analysis** (`tmp/dd35-phase0-analysis.mjs`) and found it **disagreed with §4's
   hand-derived figures** — three corrections, listed in the banner above. The script was right.
2. **Folded the measured numbers into the spec** (§5, §6.0, §7, §8, plus §1's revision note and §2's
   table), as §6-A recommended. Added the *Information content* row that carries the Q1 inversion, and
   a Phase 1 item requiring unresolvable scene entities to be **named, not silently dropped**.
3. **Caught a fourth bad claim** while verifying: `dd35-encounter-mode:28` does not mandate
   `get_state` (§4, *Verified about the skills*). The Q1 experiment is a single-skill edit, not two.
4. **Corrected the same stale figures in `docs/dd35/future-improvements.md`** (the FI-9 pointer and its
   problem statement still carried "1–3 KB / ~400–900 tokens" and "not ~300").

Still nothing implemented; no plugin code touched, and the campaign workspace was **read only**.

### 1c. What the third session did (spec rev 4)

Asked "are we overengineering / on the wrong path?", then read the prior art and revised the direction.

1. **Surveyed comparable systems** (spec §9.5): `sneq-engine` (append-only ledger, provisional-until-promoted,
   `doctor`, promotion by player uptake), NarrativeEngine-P (verbatim archive + two-phase retrieval,
   conditional injection, lore-check, rollback), `llmdm`, `dnd-ai`. **None runs a background fleet of
   small models for memory** — that is the main reason the swarm moved to last.
2. **Verified our own gaps by grep:** the preset has **no** `rollback`, `regenerate`, `undo`, or
   diagnostic tool anywhere. Every comparable has some repair affordance; we have none.
3. **Added spec §4.3** (canon admission: fact classes, Gate 1 adjudication, provisional entities,
   promotion on player uptake, the invariant) and **§4.4** (widened projection).
4. **Added spec §9** — supersedes §6's phase order; §9.2 is the actionable list; §9.3 specifies the
   `doctor` diagnostic; §9.6 names what would falsify the plan.
5. **Found a new live bug** (see banner): `defaultEntity` fabricates `hp 1, ac 10` for any unknown id
   drafted into combat.
6. **Corrected a claim mid-write:** §4.3.3 first asserted combat already refuses provisional entities.
   It does not — `init_combat` invents a sheet instead. Fixed, and Gate 1 widened to all three
   scene-entry points (`update_scene`, `init_combat`, `add_combatant`).

**Next action is spec §9.2 Step 1: the `doctor` diagnostic.** It is read-only, needs no LLM, and tells
us whether the later steps are even needed.

### 1e. What the fifth session did (spec rev 6) — the passive recall layer

Goal: stop the DM re-reading its own files. Spec **§11** documents this.

1. **Widened `briefEntity` and moved it to `state-store.js`** so `get_state` and the injected block
   render entities through *one* function (spec §4.1.2's requirement). It now carries
   `condition_effects`, `resources`, and `notes` — the 75% that §4.4 identified as where the mechanics
   live.
2. **Added `plugins/dsh-dd35-preset/scene-state.js`**, registered as `dd35-scene-state` with **two**
   contributions, split by volatility:
   - a **runtime-context snapshot** (order 300, after `dm-notes`): freshness line, scene, party with
     full mechanical detail, present NPCs, and a **known-cast roster** of every `actors/` sheet.
     Measured **2.60 KB ≈ 760 tokens**, capped at 6,144 B, currently not truncating.
   - the **player's own prose** as a *cached prompt section* (order 120): the three `player/*.md` files,
     **23.06 KB ≈ 6,746 tokens**, paid once rather than per step.
3. **16 new tests** (`tests/scene-state.test.mjs`); suite total **87, all passing**.
4. **Three silent defects found and fixed** (spec §11.2) — all three would have produced an empty block
   with no error anywhere:
   - prompt assembly **cannot use `loadState`**: the workspace binding is set by tool execution and is
     unset during assembly. Added root-taking `listEntityIdsIn` / `loadEntityIn` to `state-store.js`.
     **Any assembly-time read must take its root as an argument.**
   - a byte cap at or below the notice's own size made `cap()` return an empty body, and the guard
     turned that into `''` — an over-tight cap *deleted* the state instead of shrinking it.
   - a partial options object left budgets `undefined`, `slice(0, NaN)` threw, and the protective
     `catch` swallowed it.
5. **Cost:** ~7.5 k standing tokens, up from ~344 for the `get_state` call it partly replaces. §11.3
   states the falsification condition: **if file traffic does not fall measurably in the next sessions,
   this trade was wrong** — set `playerFiles: []` to disable the prose section, or lower
   `playerFilesMaxBytes`.

**Not fixed, and next:** §11.4 — *retrieval quality*. `grep_memories` needs a keyword the DM has
already forgotten; `list_memories` is browsable but is a tool call, not passive. The roster covers
entities, not events.

### 1f. What the sixth session did (spec rev 7) — tiering, and a parser bug

1. **Cast tiering (spec §11.5).** The roster was linear in cast size, so it would eventually inject a
   second party block. Now graded by two signals: **recency** derived from the transcripts (free, no
   authoring) and an optional **`npc_tier: 'main'`** field, which is the only signal that can answer
   *"who have I forgotten?"* — a character absent 60 turns is invisible to recency by definition.
   Active cast render in full with `seen 13 turn(s) ago`; everyone else collapses to
   `### Also on file` (name + id + age), capped, **names never dropped** — only detail withdrawn.
   `npc_tier` is settable through `create_entity` / `update_entity`.
2. **🔴 Found and fixed a parser bug that was destroying the campaign's own history.**
   `parseTranscript` used lazy `[\s\S]*?` with `$` under `/m`, which stops at the **first line ending**.
   Measured on `seventh_moon`:

   | | Before | After |
   |---|---:|---:|
   | DM narration parsed | ~10,000 chars | **100,815 chars** |
   | Transcripts with truncated DM prose | **37 of 41** | 0 |
   | Transcripts with truncated player text | **25 of 41** | 0 |

   **~27k tokens of narration were invisible to every memory tool.** The DM was `read`-ing raw
   transcripts partly because the indexed copy was truncated to its first line. A snapshot or swarm
   built on this parser would have embedded the truncation — the strongest evidence yet for §10's
   conclusion that the problem was a *broken* channel, not a missing one.
3. **The fix anchors on section order**, not heading counting: player runs to `## DM` (a player message
   may contain `## ` markdown of its own); DM runs to **end of file** (a turn routinely closes on the
   DM's own `###` subsection — turn 142 ends on `### 📍 Current Situation`); the heading match takes the
   **last** occurrence (turn 1's preamble has `## User Prompt`). Known limit, in the code: a player
   message containing a literal `## DM` line is indistinguishable from the real heading.
4. **9 parser tests** (`tests/transcript-parse.test.mjs`). Suite total: **99, all passing**.
5. **Also added root-taking `loadTranscriptsIn` / `transcriptFilesIn`** to `memory-store.js` — prompt
   assembly reads transcripts now, and assembly runs before any workspace binding exists.

### 1g. What the seventh session did (spec rev 8) — the contextual record

Goal: connect "this happened with these people, in this place" and surface it when relevant —
**without paying for inference.**

1. **Established the cost constraint.** No local inference exists in this deployment (no ollama, no
   `llama-server`, no GGUF), and both configured providers are external: `llm-meridian-antigravity`
   (`openmediavault:3457`) and `llm-deepseek` (no `baseURL` override → the metered default). So
   per-turn extraction is a recurring bill, and the design avoids it entirely.
2. **Spec §12** defines the **contextual record**: one per turn, holding who / where / when / what /
   unresolved, with **provenance fields** (`actor_source`, `label_source`).
3. **Implemented `context-index.js`** (`dd35_context_index`), 21 tests. **Zero model calls.** Measured:
   106 actor–turn edges over 41 turns; the `vance` lookup returns 15 turns with co-actors, place, and
   label; the trigger correctly does *not* fire on the current static scene.
4. **Three things the tests caught, each after a wrong first attempt:** the trigger fired on the
   **PC** (`thiago`) until player characters were excluded; a location change fired against a *null*
   prior place; and `actor_source` had to become part of the record because 32 of 41 turns have no
   DM-written entity list — presence there is inferred, not recorded.
5. **Honest limit:** for those 32 turns the label is the narration's *opening sentence*, not a summary
   (turn 4's is `"Welcome back to *Chronicles from the Seventh Moon*!"`). Factual and free, but weak,
   and `label_source` says which it is.

**Next:** the trigger is built but has never fired in real play — the campaign has been in one room for
many turns. It needs a scene change to demonstrate end-to-end.

### 1h. What the eighth session did — oracles shipped, retention in progress

1. **Spec `docs/plugins/dsh-tool-result-policy.md`** — the Path A design: a `@local/dsh-tool-result-policy`
   bundle providing its own `ToolResultPruner`, a policy table keyed by `session.header.agentPreset`,
   and a live settings page at the `settings.plugins.tab` slot.
2. **Spec FI-18/FI-19/FI-20** in `docs/dd35/future-improvements.md` — `ask_oracle`, `consult_oracle`,
   and the scene-change auto-injection.
3. **Shipped FI-18/FI-19.** `oracles.js` + `tables.js`; ten oracle tools retired, three remain
   (`roll_dice`, `ask_oracle`, `consult_oracle`); schema went ~1,900 → ~1,070 tokens. 36 oracle tests.
4. **🔴 Found a data bug that was silently breaking the oracles.** The printed range columns in
   `tables.json` do not cover their dice — `monster_reactions` covers **21 of 100**,
   `boon_table` 58/100, `bane_table` 55/100, `oracle_table` 7/20 — and the ranges that exist are
   shuffled and overlapping, so lookup order decided the answer. **`roll_monster_behavior` returned
   `null` on 79 of 100 mid-combat rolls.** Range lookup is now used only where coverage is complete;
   everything else draws uniformly. A `dd35_doctor` check for table coverage is owed.
5. **Both campaign skills updated** — `dd35-exploration-mode` and `dd35-encounter-mode` named five
   retired tools. Those edits required escalation: the campaign repo is outside this session's
   workspace.

**Next: implement the retention bundle.** The pruner is the work that matters most — 72% of
provider-bound bytes are retained tool output.

### 1d. What the fourth session did (spec rev 5)

Asked "are we walking toward feature bloat?", so the question was answered from **88 real sessions and
4,072 inference steps** rather than from reasoning. Then Step 1 of §9.2 was implemented.

1. **Mined the session logs** (spec **§10**, new): tool usage, file reads, per-inference token counts.
   Scripts: `tmp/dd35-usage-analysis.mjs`, `tmp/dd35-usage2.mjs` (both read-only).
2. **The headline finding:** **half of all tool traffic is filesystem work** (2,266 built-in calls vs
   2,168 preset calls; `read` alone 1,113 — more than any preset tool). The DM re-reads its own
   transcripts and backstory because memory recall under-delivers. Median input 4,128 tokens but
   **p90 51,111 and max 581,781** — a read-to-recover-context loop that grows the history which then
   triggers the compaction that loses it again.
3. **Conclusion recorded in §10.5:** tool count is *not* the main problem (schemas are cached; 14 of 43
   tools never called). **The fix is subtractive** — widen the projection (§4.4) and make recall
   sufficient — which is why §9.2 orders those ahead of every additive channel.
4. **Implemented `doctor` (spec §9.2 Step 1).** New files:
   `plugins/dsh-dd35-preset/doctor.js` + `tests/doctor.test.mjs` (17 tests); registered as
   `dd35-doctor` in `cordis.patch.yml`. Full suite: **68 tests, all passing.**
   On `seventh_moon` it reports: `maude` unresolvable · `thiago` duplicated across `player/`+`actors/` ·
   4 transcripts with no parseable header (1,2,3,123) · 1 unexpired condition · expected pruning gaps.
   A test asserts the diagnostic leaves every campaign file byte-identical.
5. **Two behaviours corrected while implementing**, both worth keeping:
   - The unparsed-transcript check first used `title === UNTITLED`, which flagged turn 7 — a *valid*
     header whose title is genuinely "Untitled Scene". Now it tests structure (turn header + date line),
     which yields exactly 1, 2, 3, 123.
   - `init_combat` does **not** refuse a provisional entity; it fabricates one (`defaultEntity` →
     hp 1, ac 10). §4.3.3 and §7 were corrected, and Gate 1 widened to all three scene-entry points.

---

## 2. Artifacts and where they live

Two workspaces are involved. This matters — the spec edits are **not** in the campaign workspace.

### Workspace A — the harness checkout
`/export/DownloadsSSD/SHARED/harnesses/dsh`

| File | Change |
|---|---|
| `docs/dd35/memory-model.md` | **The spec. Rewritten to rev 2.** Header, §2 table, §3 traces, §4.1 (new 4.1.1/4.1.2/4.1.3), §4.2 (new 4.2.1–4.2.6), §5, §6, new §7, new §8 |
| `docs/dd35/future-improvements.md` | FI-9 pointer carries the corrections; "Verification spike" rewritten (item 1 is now the retention measurement, item 4 new) |
| `docs/dd35/passive-rag-resume-state.md` | FI-9 summary + "Native Runtime Snapshot Channel" decision now state the limit of the guarantee; worker targets moved to the derived layer |
| `plugins/dsh-dd35-preset/README.md` | Snapshot-channel paragraph no longer implies superseding removes history; `dm_notes.md` row names it as the home for GM-only detail |
| `tmp/dd35-phase0-analysis.mjs` | The Phase 0 analysis script (read-only; **untracked scratch**) |

Markers to look for in the spec: sections tagged **[REVISED]** or **[NEW]**. The load-bearing one is **§4.1.3**.

### Workspace B — the campaign
`/export/DownloadsSSD/Projects/Writing/TTRPG/D&D35`

Not edited by this session, but read extensively. Campaign data at `campaign/seventh_moon/`; skills at `.agents/skills/dd35-*/SKILL.md`; harness persona at `.agents/AGENTS.md`.

---

## 3. The three false claims that were corrected

These were in draft 1 of the spec and are the substance of rev 2.

### 3.1 "Stale snapshots are not retained" — false

`RuntimeContextProjection` (`packages/core/agent-loop/src/runtime-context.ts:114-163`) is a **token that decides when to append**, not a garbage collector. It returns `undefined` when the rendered text is unchanged, otherwise it appends a **new `user/message`**. Superseded snapshots stay in session history forever.

Whether the model *sees* them is a **provider-side delivery filter**:
- `dsh-meridian-antigravity` filters them — `filterNoticeMessages` with `keepLatestRuntimeContext` (default `true`), `lib/serialize.js:56-76`.
- **The native path does not.** DeepSeek's own adapter serializes user-role history verbatim; the plugin-history fixture asserts it (`packages/llm/llm-deepseek/tests/fixtures/input-history.ts:36-40`).

Also: assembly runs **per step**, not per turn (`agent.ts:266-285`), so a mid-turn `update_scene` emits an extra snapshot.

What was *right* and is unchanged: the cache-safe placement (a history message, not a prompt edit at byte 0), and capture-immunity (`isPlayerMessage` keys on `role === 'user' && source.kind === 'user' && rpcId`; already unit-tested at `tests/memory.test.mjs:124-129`).

### 3.2 "`get_state` returns ~300 input tokens" — low

`compact()` (`state.js:56-72`) returns mode, clock, initiative, the whole `scene` object, every PC sheet, and every non-PC scene entity, pretty-printed JSON. Measured: **1,205 bytes ≈ 344 tokens** for one PC and zero scene NPCs. *The 4-PC / 3-NPC figure was never measured — it is an estimate, and the spec now labels it as one.*

### 3.3 "~50% faster" — conflates two unlike inferences

The saved step is the cheap one: prefill over a mostly-cached prefix plus ~40 decode tokens. The step that happens either way prefills everything and decodes the full narration. Publish it as `saved ≈ round_trip + prefill(state_prefix) + decode(40 tokens)`, and measure. Not a flat halving.

### 3.4 Also corrected
- The spec's snapshot example rendered `Role`/`Disposition`/`Secret`/`Owes`, **none of which exist** — `defaultEntity` (`state-store.js:170-178`) has only id, kind, name, hp/max/temp, ac/touch/flat, initiative, conditions, resources, position, notes. Narrative fields belong in `dm_notes.md`.
- **Secrets must not go on entity sheets.** The campaign folder is inside the player's own workspace and the file sidebar lists everything except dotfiles (asserted at `packages/api/workspace-files/tests/list.spec.ts:27-32`). `dm_notes.md` is the GM-only home.
- **`memory_index.json` cannot hold derived data.** It is rebuildable from transcripts by design; `readMemoryIndex` rebuilds when it lags and `commitTurnToIndex` rebuilds on any turn-number gap (`memory-store.js:231`). Anything not derivable from transcripts is destroyed by the next rebuild. Worker output therefore goes to a new derived layer: `events/derived/NNNN.json` + `events/embeddings.bin`, one writer per file, discardable.
- There is **no `dramatis_personae.json` and no `entities/` directory**; those are FI-16 deliverables, not existing paths.
- Prefix caching does **not** amortize across the swarm's workers — entity extraction, summarization and promise detection have different instructions and share almost no prefix.
- `llama-server` memory footprints quoted weights only; add runtime overhead plus one KV cache **per slot**.

---

## 4. Phase 0 measurements (the real numbers)

> **⚠️ Three figures in this section are wrong — see the banner at the top and the spec.**
> The corpus is **41** transcripts (not 54); `micro_state`/`pending_action` change in **8 of 40**
> transitions (not "essentially every turn"), with **20 of 40 transitions byte-identical**; the
> payload is **1,205 B ≈ 344 tokens** (not ~1,400 B / ~400). The retention *conclusion* below still
> holds — superseded snapshots are retained on the native path — but the accumulation estimate is
> **~14 k tokens over 41 turns**, not ~55 k over 142.

**Corpus:** `campaign/seventh_moon` — **41** transcripts, turns 1–142 with gaps at 10, 12–95, 97–112 (76 pruned), 1 PC sheet, 10 actor sheets.

### Q3 — `get_state` payload: measured

| Scenario | Bytes | ~Tokens |
|---|---|---|
| Today (1 PC, 0 scene NPCs) | **1,205** | **344** |
| 4-PC party + 3 scene NPCs | *not measured* | *not measured* |

### Q2 — snapshot frequency: **about half** (corrected)

- **Turns 134→135 are byte-identical** in every rendered field — a genuinely suppressed snapshot. So the projection does work sometimes.
- **20 of 40 transitions are byte-identical**, so change-only emission fires 21 times instead of 41 — a **2×** reduction. Per-field changes: date 6, location 12, entities 1, micro-state 8, pending-action 8. *(The earlier claim here that `micro_state`/`pending_action` change "on essentially every turn" was wrong. The turns cited — 137/138, 140/141, 141/142 — really do differ; they are simply not representative of the corpus.)*
- `state.json` keeps only current values, so `micro_state` history exists **only** in the transcript headers.
- **Consequence:** on the native path, retained snapshots accumulate — **~41 over the 41-transcript corpus at ~344 tokens each, order 14 k tokens**, removable only by compaction. The *structural* point (they are retained, not removed) is independent of the count.

### Q1 — partial, and it inverts the premise

Drift cannot be computed: sheets hold only current values, so per-turn HP arithmetic can't be recomputed against the record.

But `briefEntity` drops **three** fields, not one:

| Dropped | Example (Thiago) |
|---|---|
| `conditions[].effect` | 9 conditions flattened to **names only** |
| `resources` | `"spells_lost_today": "Summon Monster IV, Adoration of the Frightful, Manifestation of the Deity, Calm Emotions"` |
| `notes` | `"attack +23, damage 1d8+17, crit 17-20/x2. Turn Undead as Cleric 15 (uses 15)"` |

Thiago's AC 37 is largely *from* those buffs; his combat math lives in `notes`. **So `get_state` is already lossy exactly where mechanics get narrated.**

**This inverts the design's premise.** Dropping the mandate is probably safe — not because `get_state` is slow, but because **the snapshot carries no more information than `get_state` did**. Hydration removes a round-trip; it does not remove the need to read the sheet. `get_state`'s *contract* is the lossy part, not its delivery.

### Coverage failures found in the live campaign

1. **`maude` is in `state.scene.entities` with no sheet.** Hydration silently drops her — 9 consecutive turns of her being present. This is the silent-failure mode §4.1.3 predicted, confirmed in a real campaign.
2. **Only 2 of 10 actor sheets are in the current scene**, so a "roster of every known NPC" (spec §8 Q2) would roughly **double** the block.
3. **`actors/` has no cast.** It holds hound_archon, remi, dire_wolves, dire_wolf_1/2, vance, gareth, kenna, thorn. **Maude has no sheet at all**; Wick and the Council have none. The cast the story needs was never written down. Entity extraction cannot fix a corpus nothing wrote to — it would invent structure and then, per §7, inject it as authoritative.
4. **`thiago` exists as both `player/thiago.json` and `actors/thiago.json` with conflicting values** (initiative_total 22 vs 14). `loadAnyEntity` checks `player/` first, so the `actors/` copy is invisible — a duplicate-file trap.
5. **Format drift breaks the parser.** Turns 1–7 use old headers (`# Session 1: The Rising Shadow` / `## User Prompt`); turn 123 uses `### Turn 123` / `**Player:**`. `parseTranscript` expects the current shape, so `memory_index.json` records turns 1–7 and 123 as **"Untitled Scene"** with null dates — visible in the index today. Worth folding into §7 as a parser-brittleness row.

### Verified about the skills (a correction to a correction I made mid-session)

The six skills **do exist** at `D&D35/.agents/skills/dd35-*/SKILL.md`, plus `.agents/AGENTS.md` — matching `docs/dd35-preset-architecture.md:170`. I briefly claimed otherwise on the strength of two bad globs; that was wrong and is fixed in the spec.

- `dd35-gameplay-loop/SKILL.md` **§1 "Resync"** mandates `get_state`, with a deliberate guardrail: *"`get_state` is the truth — not chat memory. **Never narrate mechanics you haven't read this turn.**"*
- ❌ **`dd35-encounter-mode/SKILL.md:28` does NOT independently mandate `get_state`.** *(Corrected in the second session.)* Line 28 is a bullet in the "Running the round" list — `- **get_state** — shows the current order, round, and whose turn it is.` — one of three options alongside `next_turn`/`next_round`, with no imperative. The earlier reading took a line number for a mandate. The mandate is therefore in `dd35-gameplay-loop` §1 **alone**, so the Q1 experiment is a single-skill edit. **Coupling to watch:** every mode skill's `whenToUse` says *"when `get_state` reports mode X"* (`encounter:4`, `exploration:4`, `downtime:4`). Since `mode` is a `state.json` field, the router isn't literally lost — but the DM's reliable way to learn the mode is.
- Removing the mandate is therefore **removing a guardrail**, not deleting a procedural step. Treat accordingly.

---

## 5. Open questions (spec §8)

1. **Is hydration load-bearing, or is dropping the mandate enough?** Needs a session. Given §4 above, expect the answer to be "the snapshot adds latency savings, not information."
2. **Should the snapshot carry a roster of every known NPC?** Measured cost if yes: ~+420 tokens/turn today.
3. **Emit only on material change?** Depends on 1. Measured upside is a **2×** reduction (20 of 40 transitions are byte-identical), not the ~1–3% of turns an earlier pass claimed.
4. **What is the mid-turn refresh contract?** `apply_damage` and `roll_attack(apply: true)` change entity sheets **without touching `state.json`**, so the rendered text is identical and **no new snapshot is emitted**. The model can act on HP it already changed. Interacts with the encounter-mode finding.
5. **Swarm runner: `llama-server` vs the harness's own subagent with a cheap model?** The latter needs no second binary, port, model download, or CPU contention.
6. **Retention policy for `events/derived/`?**

---

## 6. Suggested next steps

**A. Fold the Phase 0 numbers into the spec.** ✅ **Done** (rev 3), with corrected figures. §5 gained an *Information content* row (the Q1 inversion) and measured figures in the input-token and history-growth rows plus a "what Phase 0 has now measured" block; §6.0's measurement item is checked off with the real numbers and the corrected script invocation; §7 gained the parser-brittleness and *actors-has-no-cast* rows; §8 Q1 carries the inversion, Q2 the measured roster cost (+~344 tokens/turn, since only 2 of 10 sheets are in scene), Q3 the corrected 2× lever. §6.1 also gained a **"name unresolvable scene entities"** item, because the Maude case shows the design as written would silently drop an on-stage NPC. The §1 revision note and §2 table were corrected too — both still asserted the "2–3× low" framing that the measurement disproved.

**B. Then run the real Q1 experiment** — but only after deciding whether it is worth removing a deliberate guardrail to answer a question whose answer is now half-known.

**C. Do not start the swarm yet.** §4's finding 3 means automated entity extraction would be codifying a cast that was never recorded, then injecting it as canon. That is the §7 feedback-loop row, live.

---

## 7. Caveats for the next session

- **No number in §4 was computed by running the script.** This session had no shell tool (DM preset), so every figure was derived by hand from the files. `tmp/dd35-phase0-analysis.mjs` encodes the same method — run it with `node tmp/dd35-phase0-analysis.mjs <campaignDir>` to reproduce, and treat disagreements as the script being right.
- The script's Q2 figure is a **lower bound**: clock *time* is not in the transcript header, and `state.json` carries only current values.
- Turn numbering has gaps (9→11, then 96, 113) because 76 turns were pruned. The scene index only sees what survives.
- Workspace A edits are in the harness checkout; if that tree is git-tracked, the rev-2 spec changes are uncommitted.

---

# SESSION STATE — tool-result retention (Path A), mid-build

**Appended because context was near its limit. Read this first if resuming mid-task.**

## Verified current state (measured, not recalled)

- **Test suite: 165 tests, all passing** (`plugins/dsh-dd35-preset`, `node --test`).
  Per file: context-index 22 · doctor 17 · memory 16 · oracles 36 · prompt 14 · roll 15 ·
  scene-state 30 · transcript-parse 9 · workspace 6.
- **Patch registers 18 plugin rows** and parses as valid YAML (checked with python yaml).
- `plugins/dsh-dd35-preset/` files: `context-index.js` `dice.js` `doctor.js` `mechanics.js`
  `memory-store.js` `memory.js` `oracle-core.js` `oracles.js` `prompt.js` `reference.js`
  `scene-state.js` `state-store.js` `state.js` `tables.js` `tools.js`.

## Shipped this session

1. **Oracles (FI-18/19/20) — DONE.** `tables.js` (table layer + seeded RNG), `oracle-core.js`
   (pure logic, no harness imports), `oracles.js` (tool layer, 95 lines). Ten old oracle tools
   retired → three remain (`roll_dice`, `ask_oracle`, `consult_oracle`); schema ~1,900 → ~1,070 tok.
   - `ask_oracle({options})` | `{preset}` — presets: `solo`, `gm_move_pacing`, `gm_move_failure`,
     `magic_boon`, `magic_bane`, `random_dc`, `monster_tactic`, `monster_reaction`.
     `likelihood_modifier` capped ±2; interrupts read off the RAW roll before the shift.
   - `consult_oracle()` → vectors (3 keywords + action/detail/topic + muse);
     `{vectors:N}`; `{tables:[...]}`; `{coherent:'plot_hook'|'dungeon_room'|'hex'|'npc'}` → one whole row.
   - **FI-20 scene-change injection** in `scene-state.js`: `oracleBlock()`, seeded by turn number
     (stable per step), fires on `scene.title != previous turn's transcript title`, never on the
     first turn, own budget `oracleMaxBytes: 640`, toggle `oracleOnSceneChange`.
2. **Layering fixed:** `scene-state.js` is pure, so it imports `oracle-core.js`, **not** `oracles.js`.
   Do not reintroduce that import — it drags `@deepseek-ai/dsh-tools` onto the assembly path and
   breaks `scene-state.test.mjs` (which has no harness stub).
3. **Two campaign skills updated** (`dd35-exploration-mode`, `dd35-encounter-mode`) — they named five
   retired tools. Those edits needed **escalation**; the campaign repo is outside this workspace.

## 🔴 Data bug found, worth remembering

`tables.json` range columns **do not cover their dice**, and the ranges are shuffled/overlapping:

| table | rows | coverage |
|---|---:|---:|
| `monster_intentions` | 10 | 100/100 |
| `boon_table` | 29 | 58/100 |
| `bane_table` | 50 | 55/100 |
| `monster_reactions` | 6 | **21/100** |
| `oracle_table` | 4 | 7/20 |

**`roll_monster_behavior` returned null on 79 of 100 mid-combat rolls.** Uniform row selection is now
the general draw; range lookup only where coverage is complete. **Still owed: a `dd35_doctor` check
for table coverage.** Also note `npc_generator.csv` carries a literal `"null"` column on some rows —
handled in `contentColumns` and `RESULT_COLUMN`.

## IN PROGRESS — the Path A retention bundle

Spec: **`docs/plugins/dsh-tool-result-policy.md`**. Motivation measured: **72% of provider-bound bytes are
retained tool output** (4,479 results, ~3.03 M tokens; `read` alone 1,775 k).

**Built so far** in `plugins/dsh-tool-result-policy/`:
- `policy.js` — DONE. Policy table read/normalise/resolve, `STRIPPED_TOOLS` classification
  (transient read / entropy / mutation), `shouldStrip` (**unknown tool ⇒ keep**), `elisionMarker`,
  `isElided`, `createPolicyCache` (mtime+size keyed).
- `prune-core.js` — DONE. `toolNamesByCallId` (maps `tool/call` → name, since a result records only
  `toolCallId`), `textOf`, `truncateContent`, `planPrune` (pure, returns per-node decisions),
  `commitPlan` (**descending seq order**, mirrors the shipped shadow-price protocol:
  `compaction/prune` then `tool/result` with `surfaceOp: replace`).

**Built since this note was first written (204 tests total: 165 preset + 39 bundle):**
- `plugins/dsh-tool-result-policy/index.js` — `PolicyToolResultPruner extends ToolResultPruner`,
  `static inject = ['tokenMeter']`, own `Config` (parent keys filtered before `super` — the parent
  **throws on unknown keys**), public `policy` field (not `#private`; Cordis invokes service methods
  through a shadow receiver). Imports `shouldDeferPrune`/`resolvePruneGuard` from
  `../dsh-compaction-guard/lib/pending-batch.js` rather than duplicating the deferral.
- `package.json` (bundle + `dsh.client` web half) and `cordis.patch.yml` (disable the shipped
  `tool-result-pruner` row, insert this one) for the bundle.
- `tests/policy.test.mjs` (18) and `tests/prune-core.test.mjs` (21).
- **Preset swapped:** `plugins/dsh-dd35-preset/cordis.patch.yml`'s compaction group now mounts
  `dsh-tool-result-policy/index.js` instead of `dsh-compaction-guard/pruner.js`. A note explaining
  the swap was added to `dsh-compaction-guard/README.md`.
- **Loader dialect lesson (cost an hour, do not relearn):** a **relative** plugin name is anchored
  only inside an `insert` list (`anchorInsertedPluginNames`). Inside a *preset declaration* it
  resolves against the root entry list's base, where `./index.js` does not exist, so the preset
  activates broken. **Rows inside `preset-dd35` must use absolute `file:///` URLs** — the guard's
  patch documents this at `cordis.patch.yml:113-119`.

**Bundle is INSTALLED in the profile** (`plugin_manager install_bundle`): `link:` dependency,
`dsh.profile.bundles` entry, and `node_modules/@local/dsh-tool-result-policy` symlink are all present.
**But nothing is live until the harness restarts** — profile bundles load at startup.

**Two things learned on contact, both now documented in the bundle patch:**
1. A bundle row must **not** claim `toolResultPruner` at the Host plane — the `dd35` preset
   already mounts it inside its isolated group, and the second claim fails activation with
   `service "toolResultPruner" has been registered at <GuardedToolResultPruner>`. So the bundle
   mounts **only the route** (`plugin.js`); the preset mounts the service (`index.js`).
2. Do **not** disable the shipped host-plane `tool-result-pruner` row: its `disabled` flag reaches
   the Host plane only, so every other preset would silently lose pruning.

**Still to build:**
1. ~~`index.js`~~ — done.
   (import from `@deepseek-ai/dsh-compaction-tool-result-pruner`), `static inject = ['tokenMeter']`,
   own `Config` (thresholdChars/headChars/tailChars/policyPath/deferWhenBatchPending/contractProviders),
   `pruneSession(session)` → read policy for `session.header.agentPreset` → `planPrune` → `commitPlan`.
   - **Public field, not `#private`**, for anything read through the service shadow — the guard's
     pruner documents this trap (Cordis invokes service methods with a shadow receiver).
   - Preserve the **`deferWhenBatchPending`** mid-turn deferral. The guard implements it with
     `shouldDeferPrune` from `plugins/dsh-compaction-guard/lib/pending-batch.js`, fed by the exported
     `toolPairingBalancedBefore/After` from `@deepseek-ai/dsh-compaction`. Meridian conflicts are real
     (~12 unexplained `dd35` cases), so a mid-turn rewrite must stay deferred.
2. ~~`cordis.patch.yml` + `package.json`~~ — done.
3. `client.js` + the host read/write route — **DONE** (`route.js`, `plugin.js`, `client.js`; 11 route tests). The
   settings page at the **`settings.plugins.tab`**
   slot (inspect proved this exists: *"One page inside the Plugins settings section"*, registration
   `id`/`order`/`label`). Theme tokens `--dsw-alias-*` only; **no Harness Client package imports**;
   own controls; `role="switch"`+`aria-checked`; register via
   `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`.
4. **Preset edit:** in `plugins/dsh-dd35-preset/cordis.patch.yml`'s compaction group, stop mounting
   `dsh-compaction-guard/pruner.js` and mount this bundle's pruner instead. **Update
   `plugins/dsh-compaction-guard/README.md`**, which documents that pruner as part of its own group.
5. ~~Tests for `policy.js` + `prune-core.js`~~ — done (39 tests).

**Client-half notes gathered from the shipped bundles:** a client bundle is a plain-JS closure
factory registered via `window.__ModuleLoader__.load({ id, factory })` where `id` **must equal the
package name**; React is in the shell's shared module table, and JSX/TSX/CSS-modules are *not*
available on this path — use `React.createElement` and inline styles. `dsh-tts/client.js` is the
closest working model (621 lines), and it talks to the host over a **token-guarded HTTP route**
(`webServer.register`, `window.__DSH_TTS__` injected into the page) rather than typert Remote,
because "a route is far less machinery". Mirror that: a small read/write route for the policy file,
then the table UI.

**Deliberate decision:** persistence is a **plain JSON file** (default at `$DSH_HOME`), not
`ctx.storageDomain`. The storage domain is real (`open()` → `domain.global.get/set`, needs
`defineDomain` + async lifecycle) but awkward on a hot prune path. Documented as a tradeoff in the spec.

## Not live

`cordis.patch.yml` is read at **startup**. Everything from the last four sessions — `dd35_doctor`,
the passive state block, the parser fix, the contextual index, the oracles, the scene injection —
needs a **harness restart / reload** to appear in a session.

## Open threads from earlier sessions

- **Step 1b (spec §9.2):** write a provisional stub for `maude` (in scene, no sheet) and resolve the
  `thiago` duplicate (`player/` wins; decide delete vs promote the `actors/` copy). Needed **before**
  the `update_scene` gate lands, or the next live turn hits a gate with no way through.
- **Owed doctor check:** table range coverage (see the data bug above).
- Deferred by design: embeddings / semantic retrieval (spec §12.7 — evidence test is wanting
  *"something like this but thematic"*).

---

# SESSION STATE — investigating "tool call removed at the wrong time"

**Appended 2026-10-08 late. Read this before continuing the investigation.**

## The open question

The user reports a problem in the session titled **"Continuing Previous Session with Sophie (17)"** and asks
whether *"the tool call is being removed at the wrong time"*.

**Candidate session found by title:** many sessions share a title beginning "Hello Sophie…". The **most
recently active** is
`/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--/session-63c97e22-7036-4328-ac13-a8373ad19e29/session.v4.jsonl.zstd`
(mtime **2026-10-08 23:45**, i.e. today — the others are 10-07 and older). Start there.
Titled sessions found: `08a6900d`, `0ed2cce9`, `217f8cda`, `28c6a9c3`, `35e4c8cb`, `38c1665d`, `3faebd09`,
`49e22a31`, `5023eed5`, `63c97e22`, `7003cefe`, `75a8a009`, `82b7dff3`, `88d180d0`, `8d2519c0`,
`97ac59de`, `bceadd6f`, `d88822f9`, `db3b92f2`, `e92eef6f`.

**RESOLVED — the finding (see below), then the hypothesis list retained for context.**

### The finding

Session `63c97e22`, dd35 preset, 12 turns, **50 `tool/call` and 50 `tool/result`, all correctly paired**.
**One turn failed; eleven completed.** Turn 3:

- steps 1–3 made 6 tool calls (`skill`, `get_state`, `read`, `update_scene`, `draw_focus`, `draw_keyword`)
  and all 6 results landed;
- **step 4 produced an `assistant/attempt` and then nothing** — no `assistant/message`, which is why the
  session has 44 `step/start` against 43 `assistant/message`;
- turn 3 ended `reason.kind = "error"`, `code = MERIDIAN_BATCH_SPENT`, caused by
  `UNAVAILABLE (code 503): No capacity available for model gemini-3.6-flash-medium on the server`;
- the connector's `repairSpentBatch` then committed a **synthetic assistant message** whose own words are
  the diagnosis: *"The batch of 3 tool results for this turn was consumed by a generation the backend
  blocked and never completed, so no reply exists for it. This notice stands in for that missing reply…
  re-issue your last instruction."*

**No tool call was removed, and nothing pruned.** There are **zero `compaction/*` events** in the session
and no elision markers. The tool calls and their results are all present and in order. What was lost is the
**reply** — and with it the entire point of that turn's oracle draws: `draw_focus` (47 B) and
`draw_keyword` (24 B) executed, were consumed, and were never rendered into narration, because the
generation that would have used them died before producing any text. `update_scene` had already written the
scene, so the turn was recorded as played while being unnarrated to the player.

Turn 4 then re-issued the instruction and narrated normally (2,817 chars, complete). So the cost is one
wasted turn and **two spent oracle draws**.

**Design implication worth carrying:** entropy delivered by a *tool call* is lost whenever the batch is
spent — the roll was consumed and no reply consumed it. Entropy delivered by **FI-20's scene-change
injection** cannot be lost that way, because it rides the runtime-context snapshot rather than a tool
result. That is an argument for the automatic path that did not exist before this observation.

### ✅ THE ACTUAL CAUSE — a MODEL CHANGE, not the fork. (Supersedes the analysis below.)

Measured on the fork `e72bd3ce`. Timeline of the model used per assistant message:

```
t1 … t9   gemini-3.6-flash-medium      (37 messages, all fine)
          >>> MODEL SELECTION -> gemini-3.6-flash-high  at 2026-10-09T02:52:40.903Z
t10 s1    gemini-3.6-flash-high
t10 s2    gemini-3.6-flash-high   <-- REFUSAL NOTICE
t11 s1    gemini-3.6-flash-high
t11 s2    gemini-3.6-flash-high   <-- REFUSAL NOTICE
```

**The model was switched from `flash-medium` to `flash-high` between turn 9 and turn 10, and every turn
after the switch was refused.** The fork was created at `02:52:34.796Z`; the model selection is at
`02:52:40.903Z` — six seconds later. So the coincidence that made forking look guilty is just that.

The connector documents this precisely (`lib/continuation.js`):

> *"Meridian's continuation model assumes it issued the tool call whose result it is receiving: it keeps a
> flat map of tool id to the run that delivered it (`antigravityRuntime.ts:391`) and a persisted set of ids
> it has already consumed… Ids it did not issue are in neither, so the request is not a continuation it can
> recognise, and it answers 409 with a message that reads like a transcript conflict. **That happens when
> the model is changed while a tool batch is open**: the batch was issued by the previous provider, and the
> harness routes its continuation to the newly selected one."*

And its prescription, from `continuationHint`: *"Let the batch finish on the provider that issued it, or
**switch models when no tool call is awaiting a result**."*

**Fix, and it is a UI action, not a code change: switch the model back to `gemini-3.6-flash-medium`.** The
turn-3 `MERIDIAN_BATCH_SPENT` is a separate, already-repaired, one-off 503.

**Why it looked permanent:** each refused turn commits a notice-shaped assistant message and records
`reason.kind = "completed"`. So the turn "succeeds", the tool batch closes behind the notice, and the next
turn presents a *fresh* batch — which is issued and continued by `flash-high` and should be fine. If refusals
continue after switching back, that is a new fact and worth re-measuring; do not assume it from this log.

# ✅✅ ROOT CAUSE FOUND — "Client tool result deadline expired" (found in Meridian's own logs)

`/root/.gemini/antigravity-cli/` holds the Antigravity CLI's own state, including a **`brain/<uuid>/`** directory
per conversation with `.system_generated/logs/transcript.jsonl` and a `.system_generated/steps/N/` trace. For the
stuck conversation (`brain/584e3e23-a153-48dd-a896-e0eb86594f84`, created `2026-10-09T03:00:29Z` — the turn-12
attempt), the step log says, verbatim:

```
Encountered error in step execution: calling "tools/call": Error: Client tool result deadline expired;
completed history can be replayed
```

**That is the real failure.** Not a fork, not a model switch, not a transcript rewrite, not the system prompt.
The CLI dispatched a client tool call (`tools/call` over the `meridian_client` MCP bridge) and the **client
result did not arrive before the deadline**, so the step aborted and no reply was produced.

The connector already documents this 409 family (`README.md:52`, `lib/errors.js:21-35`):

| Provider message | Code | Retryable |
| :--- | :--- | :--- |
| `completed history can be replayed` (**expired tool deadline**, idle process reclaimed) | `MERIDIAN_PENDING_REPLAYABLE` | **yes** — Meridian released the waiting process, so a retry replays saved history and runs no tool twice |
| `without a saved response` / `reused with a different request` | `MERIDIAN_UNCERTAIN_OUTCOME` | no |
| anything else | `MERIDIAN_CONTINUATION_CONFLICT` | no |

### Why the deadline was missed — and this is the actionable part

The same transcript shows the client history that Meridian handed the CLI containing:

```
[truncated 38218 bytes]
NOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range…
```

**A client tool result was ~38 KB and got truncated.** Across the failing turns the pattern repeats:
`fetch_memories` returning **7,513 B**, **9,970 B**, **5,015 B**; `read` 2,231 B; `list_memories` 1,904 B. The DM
was calling `fetch_memories` *and* `list_memories` *and* `grep_memories` in the same turn, repeatedly.

**So the campaign's memory tools are producing results large enough to blow the client tool deadline.** The
harness knows this shape already: `docs/dd35/future-improvements.md` FI-1 records *"Observed in live play
(2026-10-02)"* — the logs say the memory tools' own output is the problem.

**This reframes the retention bundle from an optimisation into a correctness fix.** Stripping transient and
entropy results is not primarily about token cost; oversized/duplicated tool results are what makes Meridian's
deadline miss. Priorities, in order:

1. **Check the deadline's value and whether the CLI can raise it** (config or flag) — cheapest mitigation.
2. **Cap what the memory tools return.** `fetch_memories` returning 7.5 KB per call is the direct trigger.
3. **Then** the retention bundle, whose `strip` pass removes exactly this material.

**Caveat, stated honestly:** I inferred "deadline missed *because* the results are large" from the size evidence
plus the CLI's own error text; I did not measure the deadline duration or time the calls. The error text and the
38 KB truncation are facts; the causal link is the obvious reading, not a proven one.

### ❌ The model-change theory is ALSO wrong — turn 12 failed on the original model

After switching back to `gemini-3.6-flash-medium` at `2026-10-09T03:00:12.416Z`, turn 12 made two tool
calls and was refused again, on the same model that had worked for turns 1–9. So the model did not cause it.

**Two theories, both falsified. What is actually established:**

| Check | Result |
| :--- | :--- |
| Tool ids | Every id is `toolu_agy_…` — Meridian's own. No foreign batch. |
| Call/result pairing | Clean in every failing turn. |
| Model | Turn 12 failed on `flash-medium`, so not the switch. |
| Fork | Parent and fork both stuck; but **only 2 of 90 dd35 sessions have ≥3 notices** — it is not forking in general. |
| Compaction / prune | **Zero `compaction/*` events** in either session. The harness never rewrote anything. |
| Context window | 200 000; the session is nowhere near it. |
| **System prompt** | **19 163 → 19 281 (turn 7) → 44 106 chars (turn 10).** |

**The one live correlation:** the system prompt **more than doubled at turn 10**, which is exactly the turn
the refusals begin. It was stable at ~19.2 k for turns 1–9 (all fine), then 44.1 k from turn 10 (10, 11, 12 all
refused). Meridian's 409 names *"the delivered history, the tool batch, or the model and execution
**controls**"* — and a doubled system prompt is a control change, not a history rewrite. **This is a
correlation, not a proven cause**, and I have already been wrong twice here; treat it as the next thing to
test, not as the answer.

**What to test next:** find what fed the 44 k prompt at turn 10 (the block starts `"You are an AI agent
powered by DeepSeek Harness."` — a `system/message`, so it is the assembled prompt in history). Compare the
44 106-char block against the 19 281-char one and see which section appeared. If a growing *system* prompt is
what breaks Meridian continuations, that is a far more consequential finding than this one stuck session: the
`dd35` preset's own state block and skills grow as a campaign does.

**Practical workaround, and it is the only one that has held up:** stop continuing this session. Start a
**new** session and seed it with the campaign's current state (the scene, the cast, what is in play) so the
first request is small and clean. Meridian cannot accept a long divergent continuation, but it accepts a
fresh conversation without complaint. That is the same advice the parent's own error message gives — *"fork
the session from before this turn"* — which is what the user tried and what does not work for a
post-divergence fork.

### ⚠️ The earlier analysis below blamed the fork. That was wrong — kept as the record of a bad inference.

Reported symptom: *"every time I try to continue the conversation"*. Confirmed in the fork `e72bd3ce`
(`Continuing Previous Session with Sophie (18)`).

**~~Forking does not help… it is the trigger.~~ WRONG — see the correction above.**
`e72bd3ce` re-inherits the parent's turns 1–9 **with their original timestamps to the millisecond**, error
included. Its *new* turns then fail:

```
turn 10 step 2: 480 chars  "[Meridian Antigravity] This turn's batch of 1 tool result was delivered,
                             but Meridian refused the continuation: what it had already delivered no longe…"
turn 11 step 2: 481 chars  (same shape)
```

Both turns are recorded as `reason.kind = "completed"`, so **the DM produces no narration and the session
looks healthy** while actually being permanently stuck.

**Mechanism, from the connector's own README (`plugins/dsh-meridian-antigravity/README.md`):**

> *"Meridian requires a tool-result continuation to carry the exact prefix it already delivered, so a harness
> that prunes or summarises an earlier message between a `tool_use` and its result gets
> `MERIDIAN_CONTINUATION_CONFLICT` before any generation. That is a deterministic transcript conflict… and
> re-sending cannot repair it… A deployment that hits it can disable the tool-result pruner… so the delivered
> prefix stays stable."*

So: a fork **rebuilds the transcript**, and the rebuilt prefix no longer matches what Meridian delivered.
Every subsequent continuation is then refused — deterministically, for the life of that session, which is
exactly why it happens *every time*. Errored turns across the 90 dd35 sessions: **41 sessions have at least
one**, and `MERIDIAN_CONTINUATION_CONFLICT` is the dominant code (one session has 4 in 9 turns).

### 🔴 This is a warning about the retention bundle I just built

The connector names **the tool-result pruner** as the thing that causes this, and the shipped pruner only
**truncates results over 8 KB**, at compaction. `PolicyToolResultPruner` **strips far more**: every result
from a classified tool, at turn boundaries, under a policy that defaults to on for `dd35`.

`planPrune`/`commitPlan` rewrite surface nodes with `surfaceOp: replace`, and `deferWhenBatchPending` only
defers while a batch is *pending*. Whether a turn-boundary rewrite is safe depends on whether Meridian pins
its prefix between batches or only during one — **the README's "between a tool_use and its result" wording
suggests mid-turn is the danger**, and the existing pruner runs at compaction (a turn boundary) without
being blamed for this. But that is an inference, not a measurement.

**Before enabling the strip on `dd35`, either confirm that or leave the policy off.** The policy file
default is `false`, so the safe path is already the default — do not turn it on for a Meridian session until
this is settled. The escape hatch the README offers (disable the pruner for the deployment) is a bigger
hammer than disabling one boolean.

**HYPOTHESIS LIST — retained for context; the first item is confirmed irrelevant here.** The symptom has three plausible causes in
this system, and they are easy to confuse:

1. **The new pruner I just mounted.** `PolicyToolResultPruner` (`plugins/dsh-tool-result-policy/index.js`)
   replaces tool results with a one-line marker. It is **not yet live** (profile bundles load at startup and
   the harness has not been restarted since the install), so it **cannot** be the cause of anything observed
   today. Rule this out first — it is the newest thing and the most tempting answer.
2. **The shipped/guard pruner + Meridian's continuation contract.** `MERIDIAN_CONTINUATION_CONFLICT` /
   `MERIDIAN_BATCH_SPENT`: a prune rewrites surface nodes, Meridian compares the delivered prefix and answers
   409 when it moved. The guard's README states the flags reach the Host plane only, and each preset
   isolates its own `toolResultPruner`; the guard's patch records four consecutive turns lost to this in a
   `standard` session. `plugins/dsh-dd35-preset/cordis.patch.yml` used to mount the guard's pruner for
   `dd35`; **as of this session it mounts `dsh-tool-result-policy/index.js` instead** — but again, not live
   until restart. If the reported session predates the restart, the guard's pruner was in force.
3. **`dsh-compaction-guard`'s `deferWhenBatchPending`** deciding *not* to defer when it should — i.e. the
   removal happening mid-turn rather than at a turn boundary. `lib/pending-batch.js` decides "mid-turn" from
   the injected `toolPairingBalancedBefore/After` cuts.

**Method:** read `63c97e22`'s event stream and look for, in order: a `MERIDIAN_*` error code; a
`compaction/prune` event immediately before a `tool/result` replacement; the `surfaceOp` ops on those;
whether the replacement landed while a tool call had no matching result (an unbalanced pairing); and any
`compaction/…` event whose position looks mid-turn. `tool/call` events carry `{turn, step, callId, name}`;
`tool/result` events carry `{turn, step, message:{source:{callId},…}}` — pairing is by `callId`.

Useful one-liners (zstdcat the file, then a node one-liner over the JSONL — the shapes are in
`plugins/dsh-tool-result-policy/prune-core.js`, `toolNamesByCallId`/`textOf`):

```
zstdcat <file> | node -e "…count event types…"
zstdcat <file> | node -e "…print compaction/* and any error codes…"
```

## Everything else, unchanged and verified

- **215 tests passing**: 165 in `plugins/dsh-dd35-preset`, 50 in `plugins/dsh-tool-result-policy`.
- The Path A retention bundle is **built, tested and installed in the profile**, but **not live** until a
  harness restart. See the previous session-state block for the two lessons (the bundle row must not claim
  `toolResultPruner` at the Host plane; do not disable the shipped host-plane pruner row).
- **Rule out the new bundle first for anything observed before the restart.**

---

# The 188 KB block — identified

From `brain/584e3e23-…/.system_generated/logs/transcript_full.jsonl`, the request Meridian handed the CLI was
**191,779 characters**, containing **two** truncation markers: `[truncated 188063 bytes]` and
`[truncated 38218 bytes]`.

**It is `fetch_memories`.** The client history shows one turn making **seven** of them in a row:

```
list_memories  {from_turn:120, to_turn:135, limit:40}
grep_memories  {query:"\"Boar's Rest\" OR bath OR Maude OR Kenna", from_turn:120, to_turn:135, limit:20}
grep_memories  {query:"Thiago", …}                      grep_memories {query:"a OR the", …}
fetch_memories {ids:["0126:player","0127:player","0130:player","0133:player"], context:2}
fetch_memories {ids:["0128:dm","0131:dm","0133:dm","0135:dm"], context:1}
fetch_memories {ids:["0133:player","0133:dm","0134:player","0134:dm","0135:player","0135:dm"]}
fetch_memories {ids:["0133:dm"], context:0}
```

The user's prompt that turn was *"Can you replay the last few turns so that I know exactly what transpired and
how?"* — so the DM went looking for the recent transcript, repeatedly.

**Why it is that big — a hole in `memory.js`:**

| Tool | Cap |
| :--- | :--- |
| `grep_memories` | `limit: 20` hits; snippets clipped; neighbours clipped to 120 chars |
| `list_memories` | `limit: 40` turns; `opening: clip(turn.dm, 160)`; nearby `clip(…, 400)` |
| **`fetch_memories`** | **none.** `text: message.text` is returned **verbatim and unbounded**, and it has no `limit` parameter at all |

So `fetch_memories` is the one memory tool with no ceiling, and it returns *whole messages*. **This got
strictly worse when the transcript parser was fixed**: the DM's narration used to be parsed as ~100 characters
per turn (the truncation bug), so `fetch_memories` was cheap by accident. Now a turn's `dm` is the real ~3,180
characters, so seven calls × several ids × ~3 KB is exactly the 188 KB observed.

**Also visible:** `read` was being used on
`/root/.gemini/antigravity-cli/brain/<other-uuid>/.system_generated/steps/…/output.txt` — one conversation
reading **another conversation's CLI internals**. That is the filesystem-archaeology pattern of §10.3 in a
particularly unproductive form.

**Actionable, in order:**
1. **Cap `fetch_memories`** — a `limit`/byte budget, and clip `text` the way `nearby` already is. This is the
   single highest-value fix in the whole preset right now.
2. Then the retention bundle, which removes the accumulated copies of these.

---

# Where the 12–16 s is NOT — measured

The user asked whether the box is under load. **It is not**, and the memory tools themselves are **fast**.

**Machine at the time of measurement:** load average **1.41 / 1.50 / 1.60 on 4 CPUs**, 5.9 GB available of 11 GB,
591 MB swap used, no process above 0.0 % CPU. Nothing is contending.

**The memory tools, timed directly** (rig, real campaign, `node --input-type=module`):

| Call | Cold | Warm |
| :--- | ---: | ---: |
| `list_memories {}` | 353.7 ms | **139.8 ms** |
| `list_memories {rebuild:true}` | 322.2 ms | — |
| `list_memories {from_turn:120,to_turn:135}` | — | **209.2 ms** |
| `grep_memories {query:"Kenna",120–135}` | — | **179.5 ms** |
| `fetch_memories {4 ids, context:2}` | — | **99.6 ms** |
| `fetch_memories {6 ids}` | — | **93.1 ms** |

**Every memory tool is under 360 ms cold and under 210 ms warm.** So the 12–16 s turn gap is *not* tool
execution, and a `fetch_memories`-output cap will not fix the latency.

**Where the 12–16 s actually is — a correction.** The turn trace shows `assistant` (the decision to call) →
`tool/call` → `tool/result`, and I previously read that whole span as "the tool took 16 s". It does not. That
span is the **entire round trip**: the CLI dispatching `tools/call` over the `meridian_client` MCP bridge,
Meridian relaying it, the harness executing and logging the result, and the result travelling back. The CLI's
own error — *"Client tool result deadline expired"* — is the CLI's deadline on that round trip, not a measure of
our tool.

Candidate causes, none yet measured:
1. **The MCP bridge round trip** (CLI ↔ Meridian ↔ harness). Most likely, and outside our code.
2. **Harness tool pre/post machinery** around execution (guards, result observers, logging).
3. **The CLI's own dispatch/overhead.**

Note also that the gaps *between* turns are large too (turn 10 began 26 s after turn 9 ended; turn 12 began
almost 6 minutes after turn 11). Something in this loop is slow in more than one place.

**Implication for priorities:** capping `fetch_memories` is still worth doing — the 188 KB result is real and
transcript amplification is caused by a missing ceiling — but **it will not fix the missed deadline.** That
needs the round-trip latency understood first, and it may not be ours to fix.

---

# Meridian / AGY logs — what they do and do not contain

**Meridian is healthy:** `GET /health` on `openmediavault:3457` returns
`{"status":"healthy","version":"1.76.1","backend":"antigravity","mode":"passthrough","support":{"verifiedCliVersion":"1.2.7"}}`.
Its `/v1/models` needs the API key (`authentication_error`), so it is not an open diagnostic surface.

**The AGY CLI's logs are not a latency record.** `/root/.gemini/antigravity-cli/log/` holds **50,976** files, only
**47** from the failure day. Reading them: they contain process startup, browser/Playwright setup, cache refresh,
`errorreport.go` telemetry, and `file_watcher.go` noise. The recurring errors are all
*"error getting token source: You are not logged into Antigravity"* — affecting **telemetry, quota and
experiment polling only**, not model calls. **Nothing logs `tools/call` bridge timing**, and a recursive grep for
it is impractical (50 k files).

**The one useful artifact is the step trace**, `brain/<uuid>/.system_generated/steps/N/output.txt`. The stuck
conversation's trace contains exactly **one** step directory — `steps/2/output.txt` — holding the deadline error
and nothing else. No duration is recorded. (A second, earlier attempt at the same turn would explain why the
harness's `assistant/attempt` count exceeded its `assistant/message` count, but that trace was not preserved.)

**What this means:** the 12.6 unaccounted seconds (turn gap 12.8 s minus ~0.2 s of measured tool time) sit in the
CLI→Meridian→harness round trip, and **neither side logs that leg**. It is not falsifiable from local artifacts
alone. To go further we would need either a trace on Meridian itself or an instrumented run (timestamp at tool
entry and exit in `bounded()`), which is the cheap next step if this matters.

**Also relevant:** the CLI's own `steps/2/` timestamp and the harness's `turn/start`/`tool/call` timestamps are
both ~00:0x local / 03:00Z, and the CLI raised its deadline error partway through the harness's step — so the
deadline that fired is the **CLI's**, on a round trip that had not completed.

---

# Settings page for the tool pruner — HALF LIVE, one failure to fix

**The user asked to confirm the per-preset enable/disable settings exist. Answer: the backend works, the
frontend does not load, and the plugin that mounts both reports `Failed to start` in the Plugin Manager.**

## Verified by probe

```
GET http://127.0.0.1:3080/tool-result-policy  → HTTP 200
{ "path": "/root/.dsh/tool-result-policy.json",
  "policy": { "version": 1, "presets": {}, "defaults": { "stripTransientResults": false } },
  "knownPresets": ["cordis","dd35","minimal","ptc","standard"] }

GET http://127.0.0.1:3080/@local/dsh-tool-result-policy/client.js → HTTP 404
```

So: **the read/write route is mounted and answering**, and it discovers every preset in the profile
automatically. **The client bundle is not served**, so the settings page cannot render.

## The failure

`plugin_manager list_plugins` reports:

```
entryId   include:tool-result-policy-route
module    @local/dsh-tool-result-policy/plugin
enabled   true
fiberPhase FAILED
```

The route answers *anyway*, which is unexplained — either the route was mounted before the fiber failed, or
something else serves it. Either way **the page is the user-visible gap** and the plugin row is in a failed
state that should be fixed, not left.

## Most likely cause, and the fix to try first

`plugin.js` declares `export const inject = ['webServer']`. The shipped `dsh-tts` bundle — a working example
with its own HTTP route — does **not** hard-inject it. It comments:

> *"`webServer` is NOT guaranteed to exist when this plugin applies… The scoped `ctx.inject(deps, cb)` form is
> how the rest of the harness waits"*

and registers through `ctx.inject(['webServer'], (webCtx) => { … webCtx.effect(() => webServer.register(…)) })`.

**`plugin.js` already has that pattern in the class-based version's `#mountRoute()`, and uses `ctx.effect` for
the registration — but its `inject = ['webServer']` is a hard dependency.** Make `webServer` optional: drop it
from `inject` and mount inside `ctx.inject(['webServer'], …)` only, exactly as `dsh-tts` does. Then the row
should reach `active` and the client half should be served.

## FIXED (in the file) — needs a restart to take effect

`plugin.js` declared `export const inject = ['webServer']` **and** never used the deferred form. That hard
dependency is what put the row in `fiberPhase: failed`. The shipped `dsh-tts` bundle documents the rule:

> *"`webServer` is NOT guaranteed to exist when this plugin applies… The scoped `ctx.inject(deps, cb)` form is
> how the rest of the harness waits"*

**Applied:** `inject` removed, and registration moved inside
`ctx.inject(['webServer'], (webCtx) => { … webCtx.effect(() => webServer.register(…)) })`. Syntax checked; the
bundle's 50 tests still pass. **The running process still has the old module, so the row will stay `failed`
until the harness restarts.**

## The client-bundle 404 is NOT diagnostic — do not chase it as if it were

`GET /@local/dsh-tool-result-policy/client.js → 404`, but **that URL was my guess**, not a known route
pattern. A 404 on an invented path proves nothing. Before concluding the client half is broken:

1. Restart, then re-check `fiberPhase` for `tool-result-policy-route` — `active` means the row is healthy.
2. Find how a *working* client bundle is actually fetched. `dsh-tts` has a functioning client half in this same
   profile: inspect the page's network requests or its `dsh.client`/`exports` block, and use **its** URL shape
   rather than guessing one.
3. Only then decide whether the page is missing because of the bundle or because of the client code.

**Do not "fix" the client half on the strength of the 404.** It may well be fine.

## Everything else about the bundle is fine

- Pruner **mounted** for `dd35` (`dsh-dd35-preset/cordis.patch.yml:213` → `dsh-tool-result-policy/index.js`),
  and `index.js` default-exports the service class correctly.
- **Strip is OFF**: no policy file at `$DSH_HOME/tool-result-policy.json`, and both the file default and the
  config default are `false`. **Nothing is being removed from history today.**
- 50 tests pass in the bundle; 165 in the preset.

## Do not forget, before enabling the strip

The Meridian connector names **the tool-result pruner** as a cause of `MERIDIAN_CONTINUATION_CONFLICT`, and
41 of 90 dd35 sessions already have one. Test the strip on a throwaway session before enabling it on the
Sophie campaign. See the earlier section on that failure.

---

# `tool-result-policy-route` still FAILS after restart — narrowed, not solved

**The hard-inject theory was wrong.** The user restarted the harness; the row is still `fiberPhase: failed`
(Plugin Manager → Built-in plugins → Global plugins → *tool-result-policy/plugin*, Status "Failed to start").

## What has been ruled out, by test

| Check | Result |
| :--- | :--- |
| Module loads | ✅ `import('./plugin.js')` → exports `apply`, `defaultPolicyPath`, `name` |
| `inject` hard dependency | ✅ removed — `inject` is now `undefined`; still fails |
| `createPolicyCache()` | ✅ returns a function-bearing object |
| `createRouteHandler(...)` | ✅ returns a function |
| `defaultPolicyPath()` | ✅ `/root/.dsh/tool-result-policy.json` |
| **`apply` against a mock ctx** | ✅ **runs clean** — calls `effect`, `timer.interval`, `inject:webServer` in order |
| Client package `@deepseek-ai/dsh-client-ui-slots` | ✅ exists in the checkout, and `dsh-tts` declares the same one |
| Client code | not the cause — this is a **host** fiber failure |

So the plugin's own code path executes correctly given a plausible `ctx`. The failure is therefore in the
**real harness context**, in something the mock did not reproduce.

## Narrowing the remaining candidates

The mock provided `effect`, `timer.interval`, `inject`, `get`, `logger`. The real context differs in at least
these ways, in the order I would test them:

1. **`ctx.timer.interval` may not exist, or not with that signature.** This is the one call whose shape I
   assumed. It is wrapped as `ctx.timer?.interval?.(refresh, 60_000) ?? (() => {})`, so a *missing* timer is
   safe — but a `timer` service that exists and rejects the arguments would throw.
2. **`ctx.effect(...)` returning a disposer contract.** My outer
   `ctx.effect(() => ctx.timer?.interval?.(…) ?? (() => {}))` is a guess at the expected shape, taken from
   `dsh-tts`. Compare against `dsh-tts/plugin.js` directly rather than from memory.
3. **`ctx.inject` availability on this context.** Used by `dsh-tts`, so probably fine, but unverified here.
4. **A second `toolResultPruner` claim.** The bundle row no longer provides the service, but confirm the preset
   group has not also been loaded into the global plane.

## The fastest way to finish this

`fiberPhase` reports only "failed" and **no log file with the stack was found** (`/root/.dsh/logs/` does not
exist; the launcher's stdout is not captured anywhere readable from here). Two options:

- **Break the plugin to get a reaction**: delete the `ctx.timer` line entirely, and separately the
  `ctx.inject` block, restarting between. Whichever removal flips the row to `active` identifies the culprit.
  Crude but decisive, and each step is one line.
- **Find the launch stdout.** The harness was started by the user; whichever terminal or service captured it
  holds the stack trace. That is faster than bisecting if it is accessible.

**Do not guess again.** The previous two attempts at this (fork, model change; then the inject theory) were
both confident and both wrong. Bisect or find the log.

---

# ✅ SOLVED — `cannot get property "timer" without inject`

The launcher console had the stack the whole time:

```
tool-result-policy-route (@local/dsh-tool-result-policy/plugin):
  Error: cannot get property "timer" without inject
    at plugin.js:70  →  ctx.timer?.interval?.(refresh, 60_000)
```

**Cordis refuses to *read* an undeclared service.** `ctx.timer?.interval?.(…)` looks defensive, but optional
chaining does not save it: the property *get* itself is what throws. My two earlier theories (the fork, then the
hard `webServer` inject) were both wrong; the previous `inject = ['webServer']` removal was still correct and
necessary, just not the cause.

## The fix

The timer was only refreshing the preset list for the settings page. That does not need a heartbeat:

- **removed the timer entirely** — the preset list is now resolved lazily, refreshed on the GET that needs it
  (as often as the page is opened, far less often than a 60 s interval);
- `ctx.timer` is no longer touched anywhere, so no `timer` injection is needed.

Verified: `apply` against a mock ctx runs clean and calls only `inject:webServer`; syntax checks; 50 tests pass.

## The user's standing request — errors must be logged to the filesystem

> *"We really should program our plugins in such a way that errors are always caught and logged to the file
> system before throwing the error back to the harness."*

**Implemented in `plugin.js`, and it is the new house pattern:**

- `logPluginError(plugin, stage, error)` appends `ISO timestamp [plugin] stage: stack` to
  `$DSH_PLUGIN_LOG_DIR` (default `$DSH_HOME/plugin-errors/`). It **never throws** — a read-only home must not
  become a second error.
- `guard(ctx, stage, body)` runs a stage, logs on throw, then **rethrows deliberately**: swallowing the error
  would leave a half-registered row, which is worse than one that refuses to start.
- `apply` wraps its body in `guard(ctx, 'apply', …)`, and the route mount in `guard(ctx, 'mountRoute', …)`.

A caught error now also goes to `ctx.logger.error`, but the file is the durable record — the whole point is
that `fiberPhase: failed` and a console we cannot read are not enough.

**Verified working:** `logPluginError` writes correctly to a temp dir (direct test). Note a false alarm along the
way: a mocked-ctx test appeared to show the guard not firing. It was the mock's fault, not the code's — the
logger was fine.

**To do elsewhere:** this pattern belongs in every plugin of ours, not just this one. `dsh-dd35-preset`,
`dsh-meridian-antigravity`, `dsh-compaction-guard`, `dsh-context-pressure` all report failures the same opaque
way. A shared helper would be better than four copies.

---

# Settings page never appeared — SOLVED (bundle row was a scoped subpath)

**Symptom:** the user could not find the per-preset toggle anywhere in the UI; the Plugin Manager card for
`tool-result-policy` is read-only, and `settings.plugins.tab` showed only `all` and `dsh-market`.

**Measured, not guessed:** live `cordis_inspect_query` → client `Slots.listSubTree` for
`settings.plugins.tab` listed exactly two occupants — `all` (order 10) and `dsh-market` (order 60). Ours was
absent. The host route was healthy at the same time (`GET /tool-result-policy` → 200), so this was purely
the client half not loading.

## Root cause, from the harness source

`ClientModuleRegistry` (`packages/client/modules/src/index.ts`) discovers a web half by scanning **root
Loader rows** and resolving each row's module to its owning `package.json`. `resolveMeta` gates on:

```js
const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
if (!pathLike && expectedPackageName === undefined) return undefined   // row is not a client row
```

and `exactPackageSpecifier` (`…/client/manifest.ts`) accepts a scoped name only when it has **exactly two
segments**. Our bundle row was:

```yaml
name: '@local/dsh-tool-result-policy/plugin'    # three segments -> undefined -> dropped
```

So the row never reached `dsh.client`; the client bundle was never composed, never served, never registered
the slot. No error, no log — a silent drop. `dsh-meridian-antigravity` and `dsh-context-pressure` use the
bare package name, which is why they work.

## Fix

- `plugins/dsh-tool-result-policy/cordis.patch.yml` — row renamed to `@local/dsh-tool-result-policy`.
- `plugins/dsh-tool-result-policy/package.json` — `exports["."]` moved from `./index.js` to `./plugin.js`
  (the route/apply form) and `./pruner` added for `./index.js` (the Service class). Direct `file:///`
  imports bypass `exports`, so the preset's mount of `…/index.js` is unaffected.
- `plugins/dsh-tool-result-policy/tests/bundle-discovery.test.mjs` — 5 tests pinning both gates (row name is
  an exact package specifier; the bundle registers the package name) plus the entry-point split.

## Verification done offline

Replayed the exact discovery path from the profile with Node: `exactPackageSpecifier` resolves the new row,
the manifest owns the module, `dsh.client.platform === 'web'`, `clientPath` exists, and the row loads
`./plugin.js`. Suites: **165 preset + 55 bundle = 220 pass.** YAML re-parsed with the `!!js` tag handled.

**Not yet verified live:** the bundle patch is read at **startup**, so the settings page appears only after
a harness restart. Then re-run the `Slots.listSubTree` probe — `tool-result-policy` must be an occupant
before believing the page renders.

## Two things still open about this page

1. **It lists presets the policy does not govern.** `knownPresets` comes from the live registry (cordis,
   dd35, minimal, ptc, standard), but only `dd35` mounts `PolicyToolResultPruner`; the others keep the
   shipped host-plane pruner and ignore the policy file. Toggling them writes a file that nothing reads.
   Either label them "not mounted here" or add the policy pruner at the Host plane by replacing the shipped
   row (a real behaviour change for every preset — decide first).
2. **Strip is still OFF.** No `$DSH_HOME/tool-result-policy.json` exists. The page is the intended way to
   turn it on for `dd35`, and the Meridian continuation-conflict caveat still applies: test on a throwaway
   session first.

---

# rev 2 — the strip became a Host-plane pass, so every preset toggle is real

The user's request: the settings page should list every preset with a working toggle. The
service design could not deliver that, and the reason is structural.

## Why the service form could not work

The shipped `web-app` bundle **disables** the host-plane `tool-result-pruner` row
(`packages/bundle/web-app/cordis.patch.yml:494`) and gives each preset its own copy inside an
isolated realm:

```yaml
- id: compaction
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

`standard` (146 lines), `ptc` (152) and `cordis` (154) each do this; `minimal` has no
compaction at all. Consequences:

- a `PolicyToolResultPruner` mounted in `dd35` governs **`dd35` only** — every other preset's
  toggle wrote a file nothing read;
- mounting it at the Host plane is not an option: the presets own the service in their realms
  and the claim collides;
- overriding each shipped preset to swap its pruner row replaces the preset's **complete**
  `config.plugins` — ~450 lines of harness config copied into our bundle, silently shadowing
  every upstream change.

## What replaced it

`plugins/dsh-tool-result-policy/pass.js` — a Host-plane `agent/pre-step` listener. That hook
is visible to Host-plane plugins for every session; `dsh-context-pressure` (`index.js:70`)
already proves it. `planPrune`/`commitPlan` are pure `session` operations, so one mount
applies the per-preset policy everywhere.

- `plugin.js` is now the whole Host entry: it registers the pass **and** mounts the settings
  route. One row, one package — which also matters because two rows from one package make the
  client-module scan throw `resolves from multiple active Loader sources`.
- `index.js` (`PolicyToolResultPruner`) is **deleted**; the class is superseded.
- `plugins/dsh-dd35-preset/cordis.patch.yml` mounts `dsh-compaction-guard/pruner.js` again —
  the truncation-at-compaction safety net, exactly as before this work. Stripping is no longer
  mounted there.
- `package.json` exports are `"."` → `./plugin.js`, `./plugin`, `./client`.

## The turn boundary is the correctness rule

A tool result is load-bearing until the turn that produced it is narrated. `isMidTurn` — the
guard's own pairing test — gates the pass, and it applies to **every** provider, not just
`contractProviders`. The service form deferred only on Meridian; stripping a live turn's
inputs is wrong on all of them. A mid-turn deferral is deliberately **not** recorded in the
high-water mark, so the next completed boundary still does the work.

**Measured cost** (synthetic 4,479-result history, `planPrune` only):

| | |
| :--- | ---: |
| first pass, 4,479 × 3.2 KB (toggle just switched on) | **245 ms** |
| every pass after, all results already elided | **13.4 ms** |

`agent/pre-step` fires every step, so `pass.js` keeps a per-session high-water mark: an
unchanged surface tail skips the walk (`reason: 'unchanged'`). Policy-off returns before
planning, which is the default state.

## Page

`client.js` now warns that the strip removes `read`/`grep`/`bash`/`write`/`edit` contents and
every roll — it is safe for the DM preset and destructive for a coding preset. The toggle is
live for every preset because the pass is host-plane.

## Verified

- **240 tests pass**: 165 `dsh-dd35-preset`, 75 `dsh-tool-result-policy` (18 new in
  `tests/pass.test.mjs` — policy resolution, cross-preset isolation, the turn boundary, the
  high-water mark, marker idempotence, kept-tool truncation).
- Both patches parse as YAML (with the `!!js` tag handled); all modules pass `node --check`.
- Client discovery replay still passes (row name unchanged); `plugin.js` now imports
  `@deepseek-ai/dsh-compaction`, resolvable only through the runtime Loader — the same import
  style `dsh-context-pressure`, `dsh-meridian-antigravity` and `dsh-tts` use.

## Not verified

1. **That a turn-boundary strip on a Meridian session does not produce
   `MERIDIAN_CONTINUATION_CONFLICT`.** This is the one open risk and the reason the policy
   still defaults to `false`. Test on a throwaway session.
2. **That the pass fires live for a dd35 session at all** — needs a restart and one real turn.
   The `agent/pre-step` hook is proven by another Host-plane plugin, not by this one yet.
3. The campaign's on-disk transcripts are written at turn end, before the next pre-step strip,
   so the strip should not touch the campaign record. Not independently confirmed.

---

# The "Resuming Previous Session" live test — the strip never fired, and pruning breaks Meridian

Session `4ba1929e-d221-4100-a070-f7090b9dfcdf`, `dd35`, provider `meridian-antigravity`,
model `gemini-3.6-flash-high`, 2 turns. The policy file was written at **12:25** with
`presets.dd35.stripTransientResults: true`; the session ran 12:27–12:35. This is the first
session that ran with the strip enabled.

## How the two turns actually went

| | |
| :--- | :--- |
| Turn 1 | 11 steps. Setup reads: `route_turn`, `skill`, `get_state`, `list_memories`×3, `read`×5, `dd35_context_index`, `get_entity`, `fetch_memories`×3. Narrated **2,801 chars**. `turn/end reason=completed`. |
| Turn 2 step 1 | The pass fired at the pre-step — **correct timing**, the first completed-turn boundary. It appended 2 `compaction/prune` + 2 replacement results (seqs 86–89) and then `step/start`. The model made 2 calls: `update_scene`, `ask_oracle`; both results returned. |
| Turn 2 step 2 | The assistant message is the **Meridian refusal notice**, 481 chars, not narration. `turn/end reason=completed` — the silent-failure trap (§3.4). The turn produced nothing. |

So the answer to "within expectations" is **no, on both counts**.

## Bug 1 — the strip had never classified anything

`planPrune` classifies a result by the name of the call that produced it, and `toolNamesByCallId`
read `session.events`. **The `Session` class has no `events` property.**
`packages/core/session/src/index.ts:444` exposes `surface`, `eventAt(seq)`, `append`,
`ownEvents()`, `snapshotEvents()`. The map was empty on every real session, `shouldStrip(null)`
was false for every result, and the pass only ever did the over-budget truncation.

That is exactly what the two prune events were: `fetch_memories` at 29,198 and 10,940 chars
(> 8,192), truncated to ~5,139. **Zero of the 14 strip-eligible results were elided.**

Replayed against the real session log with the fix in place:

```
names resolved from surface: 18
strip: route_turn, skill, get_state, list_memories×3, read×5, get_entity, update_scene, ask_oracle   (14)
truncate: fetch_memories ×2        keep: fetch_memories ×3, dd35_context_index ×1
chars that would be removed: 60,303
```

Fixed: `toolNamesByCallId` now reads `surface.nodes` + `eventAt` and takes the names from the
`tool-call` blocks of `assistant/message` — the real shape, and the same access pattern the
shipped pruner uses. `callIdOf` reads `source.callId` first.

## Bug 2 — every shadow price was zero

`commitPlan` read `session.tokenMeter?.estimateMessage`. **`Session` has no `tokenMeter`
either** — the meter is the Host-plane `ctx.tokenMeter` service (`TokenMeter.estimateMessage`,
`packages/llm/token-meter/src/index.ts:214`), the same one the shipped pruner injects. Every
`compaction/prune` in this session recorded `shadowedTokenCount: 0`, so the meter never got
credit for the bytes removed.

Fixed: `commitPlan(session, plan, { estimateTokens })` requires the caller's price;
`plugin.js` resolves `ctx.get('tokenMeter')` lazily and forwards `estimateMessage`. Without a
meter it falls back to a character estimate rather than silently writing zero.

**Why 240 tests missed both:** the hand-written doubles offered `events` and `tokenMeter`. The
doubles now model the real class and expose neither, so a regression fails the suite
(`lessons-learned.md` §6.8). Suite is now **79 tests** in this bundle.

## Bug 3 — a Meridian conflict whose cause is NOT established

Turn 2 was refused with `MERIDIAN_CONTINUATION_CONFLICT`. The connector intercepted it and committed
its notice, so no error code is in the log; the notice text is generic by design
(`lib/failure.js:99`, commit 7708f66).

**First pass at this was wrong, and the correction matters.** I claimed the pass's prune caused it
because pruned Meridian sessions conflict more often:

| Group | Sessions | Conflicted |
| :--- | ---: | ---: |
| Meridian, ≥1 `compaction/prune` | 12 | 10 |
| Meridian, no prune | 63 | 22 |
| non-Meridian (deepseek/antigravity), ≥1 prune | 11 | 0 |

That is confounded. **The pruner only runs under context pressure**, so "pruned" selects for long
sessions with many steps and many mid-turn state mutations, which independently raise the conflict
rate. Three facts kill the simple story:

1. In `4ba1929e` the prune ran at a **turn boundary**, before step 2.1's request, with **no batch
   pending** — outside the window the connector documents ("must not be rewritten while a tool batch
   is pending", `docs/README.md:27`).
2. The request immediately after the prune (step 2.1, a new user turn) was **accepted**; the refusal
   came at step 2.2, the continuation carrying that turn's batch. A rewrite invalidating the prefix
   should have failed the first request, not the second.
3. The connector's own catalogue (`docs/README.md:35`) splits its 52 conflicts three ways: 21 from
   pruned sessions, 16 correlating with a model change inside the turn, ~12 with neither (mostly
   `dd35`). It refuses to choose, because the connector cannot see which of Meridian's three causes
   moved.

**The other candidate I could not rule out.** The `dd35` runtime-context block is re-appended
whenever `state.json` changes, so `update_scene` at step 2.1 produced a *different* runtime-context
user message at step 2.2 — inside the batch window. The two blocks (seq 92 and seq 101) differ exactly
in the `Micro-state` / `Pending action` lines that `update_scene` wrote:

```
seq 92 : Micro-state: Maude cuddles with Thiago and explains the origins of the supernatural …
seq 101: Micro-state: Maude chats with Thiago about the villagers of Hurstwood and Kenna's …
```

Both are plain `surfaceOp: "append"`, so nothing was rewritten in place; turn 1 had **one**
runtime-context block across 11 steps precisely because it performed no mutations. A corpus scan could
not separate the two hypotheses: mid-batch runtime-context injection is neither necessary nor
sufficient for a conflict (many conflicted sessions have zero; some clean sessions have three).

**What is actually true:** rewriting delivered history is a documented Meridian hazard, the connector
recommends disabling the pruner, and **nobody can name the cause of one conflict from the session
log**. The policy stays off as precaution, not as a verdict. Recorded in `lessons-learned.md` §3.2 and
the spec's rev 3 banner.

## Open

1. **Settle the cause with the dispatched body.** Capture is already on — `captureRequestBodies: true` in
   `plugins/dsh-meridian-antigravity/cordis.patch.yml` and again in the web profile — so this needs no setup.
   The first measured diff is in `lessons-learned.md` §3.2: `session-dc7217e4` moved its **last user turn**
   (4,263 -> 31,946 bytes) when a new user message merged into a `tool_result` left over from a spent batch.
   Meridian names three possible causes and the connector cannot tell them apart; only the bodies can.
2. **If the runtime-context block is the cause**, the fix is in the preset, not the connector: a state
   change mid-turn must not re-append a runtime-context user message between a tool call and its
   result. Check `dsh-dd35-preset`'s scene-state injection ordering.
3. **The two code fixes are live-untested.** They pass 79 offline tests and replay against this
   session's log, but no session has run them.
4. `fetch_memories` is still uncapped and unclassified: 29,198 chars in one call above, the largest
   single result in this session. Independent of the above.

---

# The runtime-context snapshot is now frozen per turn

Follow-up to the `4ba1929e` analysis, and a change made on its own evidence rather than on the
unproven Meridian link.

## The problem

The harness renders every registered `systemPrompt.context()` on **every step** and appends a new
user message whenever the joined text changed (`RuntimeContextProjection.project`,
`packages/core/agent-loop/src/runtime-context.ts`). The old one is never replaced. Two of our
contributions are volatile because a tool can rewrite their input mid-turn:

- `dd35:scene-state` re-reads `state.json`, which `update_scene` rewrites;
- `dd35:dm-notes` re-reads `dm_notes.md`, which `write`/`edit` rewrite.

Measured on `4ba1929e`: **3 snapshots, 28 KB, in a 2-turn session**, two of them appended
**after a tool result** — between a tool call and its result. The two mid-turn snapshots both
carried `State as of turn 143` and differed only in the `Micro-state` / `Pending action` lines
`update_scene` had just written. `git`-visible check: the only `surfaceOp: replace` events in that
whole session were our two prunes, so every snapshot was still live.

## The change

- **`plugins/dsh-dd35-preset/context-freeze.js`** (new) — `createTurnFrozenContext({ keyOf, render })`
  memoises a context renderer per session, and `campaignTurnKey(assemble)` supplies the key:
  `"<campaignId>:<last_turn.number>"`. `last_turn` is written only by the turn-capture path
  (`memory.js:219`), so the key is stable for the whole of a turn and changes exactly at the
  boundary. A campaign with no captured turn keys on `0`, which still freezes.
- **`scene-state.js`** and **`prompt.js`** — both `context()` registrations now go through the
  wrapper. Freezing only one would leave the other churning.
- The cache is a `WeakMap` keyed by the **session object**, because one preset scope serves every
  session that selects it; a module-level variable would leak one session's snapshot into another's.
- `campaignTurnKey` catches: `readJson` is a bare `JSON.parse(readFileSync(...))` and this runs
  during prompt assembly, so a malformed `state.json` must yield no key (no caching) rather than
  throw and kill the session.

**Cost, accepted:** mid-turn, the injected block shows the state as of the turn's start. The mutation
tool's own result carries the new numbers, `get_state` still answers mid-turn, and the next turn's
block is current. A mid-turn reminder is not worth a mid-batch transcript append.

## Verified

- **258 tests pass** (179 preset + 79 bundle). 14 new: 12 in `tests/context-freeze.test.mjs`
  (turn stability, per-session isolation, null key, malformed state, campaign switch) and 2
  integration tests that drive the **real** `sceneStateContext` / `notesContext` through the wrapper
  and assert that a mid-turn rewrite is suppressed and the next turn picks it up.
- Syntax-checked; `context-freeze.js` imports only `state-store.js`, so it stays unit-testable
  offline.

## Not verified, and one thing to do

- **The preset is not in the profile's HMR watch roots** (only `dsh-tts` and
  `dsh-meridian-antigravity` are), so this needs a **harness restart** to take effect. A new session
  after that is the first live test.
- **Still unproven:** that the mid-batch snapshot was what Meridian refused. This change removes the
  mid-batch append but does not prove the link. Settle it by diffing captures on a reproduction — capture
  is already on, and the freeze makes that reproduction cleaner, since the runtime-context churn will no
  longer be one of the moving parts.
- **Check the same pattern elsewhere:** any other `context()` contributor that reads a
  tool-writable file needs the same treatment. `dd35:dm-notes` and `dd35:scene-state` were the two.

---

# Per-session campaign binding — the fresh-chat fix (BUILT, not live)

**The user's report:** starting a brand-new chat in the D&D profile, the DM continues the
existing campaign instead of offering a choice. Two requirements:

1. a brand-new chat has **no active campaign**;
2. the user **chooses** — start a new campaign, or continue an existing one.

**The cause.** `campaign/campaign_registry.md` holds **one global `**Identifier:**`**, and every
consumer resolves the campaign from it against the session's *cwd*. So a brand-new session in the
D&D35 folder is already inside `seventh_moon`: `dd35:scene-state`, `dd35:dm-notes` and the
campaign persona are injected on the first request, and `route_turn({first_message:true})` sees an
active campaign and returns `fresh_session`. Nothing is attached to a session — only to a folder.

**The fix.** `campaign/session_campaigns.json` maps session id → campaign id. Resolution
(`resolveSessionCampaignIn(root, session)` in `state-store.js`), in order:

1. an explicit entry for `session.header.id` → that campaign (`bound`);
2. no entry, `session.header.parentSession` has one → inherit it (`inherited`);
3. no entry, `session.header.createdAt < SESSION_BINDING_SINCE` → the registry's active
   campaign (`legacy`) — **this is what keeps live sessions playing**;
4. otherwise → `null` (`none`). A new chat starts unbound.

`SESSION_BINDING_SINCE` is a code constant (the moment this shipped), so no write is needed to
establish it and no session created after it is ever silently handed a campaign. Forks created
after it inherit through rule 2.

**`route_turn` grows a fourth phase.** Bound → `fresh_session`/`gameplay` as before. Unbound with
campaigns on disk → **`choose_campaign`** (returns the list; the DM greets and asks). Unbound with
no campaigns → `session_zero`. `route_turn` pins a `legacy` resolution to an explicit binding so
registry drift cannot move a live session, and `create_campaign` / `set_active_campaign` bind the
calling session. **Prompt assembly stays read-only.**

**Where the session id comes from:** `assemble.agent.session.header.id` (and `exec.agent.session`).
`SessionHeader` is deep-frozen, so a plugin cannot write session metadata — a workspace file keyed
by session id is the only available mechanism. Do **not** walk `session.snapshotEvents()` /
`ownEvents()` to detect a "new" session: both are deprecated and forbidden for new calls, which is
why the rule is `createdAt`-based.

**Files:** `state-store.js` (binding store + resolver), `prompt.js`, `scene-state.js` (×2),
`context-freeze.js`, `state.js` (`route_turn`/`create_campaign`/`set_active_campaign`/
`list_campaigns`), `memory.js` (`capture`), `doctor.js`, the `dd35-fresh-session` skill and the
`AGENTS.md` procedure table, plus a new `tests/session-binding.test.mjs`.

## Status: built, 203 tests pass, needs a restart

**Verified offline.** 203 preset tests (24 new in `tests/session-binding.test.mjs`): the resolver's four
sources, fork inheritance, a deleted campaign directory, a corrupt bindings file, per-session isolation,
the registry fallback for an identity-less caller, and — the point of the exercise — that an unbound
session contributes **no** state, persona or notes while the same session sees them the moment it is bound.
The tools are driven end to end: `route_turn` → `choose_campaign`/`session_zero`/`fresh_session`,
`set_active_campaign` touching only the calling session, `detach_campaign`, and `create_campaign` attaching.

**The migration is the part that needed measuring.** The first cut used
`SESSION_BINDING_SINCE = 2026-10-09T00:00:00Z`. Scanning the store showed **10 `dd35` sessions created
after midnight**, including the live campaign — every one of them would have detached. Two fixes:

1. `SESSION_BINDING_SINCE` is now **the deploy instant** (`2026-10-09T18:59:35Z`), so all 107 existing
   sessions resolve as `legacy`.
2. `campaign/session_campaigns.json` was **seeded** with every `dd35` session that existed at ship time:
   **96 sessions bound to `seventh_moon`** in the D&D35 workspace (the other 11 are test sessions in
   other workspaces with no registry, correctly left unbound).

Re-verified against the real file: a seeded session → `bound`; a new id → `none`; a fork of a seeded
session → `inherited`. The seed covers any workspace the constant misses, and the constant covers a
workspace whose seed file is later deleted.

**Gap, stated honestly.** A session created between the seed and the harness restart played under the old
code and so is in neither; it resolves unbound and needs one `set_active_campaign`. Nothing else does.

## Files

`state-store.js` gains the binding store, `resolveSessionCampaignIn`, `bindSessionCampaign` /
`unbindSessionCampaign`, and binds the session alongside `workspaceRoot` in `bindWorkspaceFromSession` —
so `requireCampaign()` is session-scoped for every tool that already used `bounded()`, with no per-tool
edit. Consumers switched to the resolver: `prompt.js` (`personaSectionText` / `notesContextText` are now
exported for testing), `scene-state.js` ×2, `context-freeze.js`, `memory.js` (`capture` now files a turn
only under the campaign the session is playing), `doctor.js` (reports `attached_campaign` **and**
`registry_active`). `state.js` gains the `choose_campaign` phase, `detach_campaign`, and a session-aware
`list_campaigns`. Campaign repo: new `dd35-campaign-choice` skill, updated `dd35-fresh-session` and
`dd35-session-zero`, and the `AGENTS.md` procedure table keyed on `route_turn`'s `phase`.

## To verify live

Restart, then in the D&D profile open a **brand-new** chat and call `route_turn({first_message:true})`.
It must answer `choose_campaign` with `seventh_moon` in the list, and the first request must carry no
`## Active Game State` block. Then open an existing campaign session and confirm it still plays.

## Forks and renames

**Renames are a non-issue by construction.** A rename appends a `session/title` event
(`packages/core/session/src/known-event-types.ts:56`). It changes neither `header.id` nor the storage
directory, which is named `session-<id>` — verified against a real store entry. The binding keys on
`header.id`, so renaming cannot orphan it.

**Forks were broken at generation two, and are now fixed.** `SessionStore.fork()` writes exactly one
thing about lineage: `parentSession: liveSource.id`, plus the source's `cwd`
(`packages/core/session/src/index.ts:1251`). Nothing records a grandparent. The first implementation
checked only the immediate parent, so `A` bound → `B` inherits → `C` (fork of `B`) resolved to
**nothing**. Measured before the fix:

```
A                {"id":"seventh_moon","source":"bound"}
B (fork of A)    {"id":"seventh_moon","source":"inherited"}
C (fork of B)    {"id":null,"source":"none"}        <-- chain dropped
D (fork of C)    {"id":null,"source":"none"}
```

Two mechanisms now cover it:

1. **`setSessionLookup`** — `state.js` injects `sessions` and wires `ctx.sessions.get`, so the resolver
   walks the whole chain (depth-capped at 32, with a `seen` set so a hand-edited cycle terminates rather
   than spins). `dsh-compaction-guard`'s engine already injects `sessions` inside this same preset, so
   the service is proven present in this scope. This is what handles a link that was forked but never run.
2. **`route_turn` pins anything not `bound`** — previously only `legacy`. So a fork that *has* run has
   its own entry, and its children resolve with no lookup at all.

Verified through the real wiring with all three sessions never run but the root bound: `A` bound,
`B` and `C` inherited, and `route_turn` on `C` answers `fresh_session` and pins it to `bound`.

A fork of a genuinely unbound session stays unbound — that property is still asserted, because it is
what stops a fork of a fresh chat from silently acquiring the registry's campaign.

---

# Diagnosing a refused continuation (BUILT, needs a restart)

The `New C7L` interruption (`session-c418df75`, turn 3, 20:21:01) was a
`MERIDIAN_CONTINUATION_CONFLICT`: the connector committed a notice instead of the narration the DM was
about to write. The investigation took an afternoon because **the reason was thrown away** — the session
held no `MERIDIAN_*` code, no provider text and no `requestId`, and `.dsh/` has no log directory, so the
`logger.warn` line went to a console nobody kept.

## What was wrong

`lib/errors.js` builds a good `MERIDIAN_CONTINUATION_CONFLICT` error carrying Meridian's words, the
status and the request id. `lib/transport.js` then replaced it with
`rewrittenContinuationNotice(continuation?.results)` — results only. Everything else was dropped on the
floor. Worse, the notice's cause list opened with the tool-result pruner, which the measurements say is
not the cause: the pruner count does not predict the conflict, and every conflict sat in a session with
two or more runtime-context messages (8 of 34 against 0 of 76).

## What changed

- **`lib/failure.js`** — `rewrittenContinuationNotice(results, detail)` now quotes Meridian verbatim,
  carries `status` and `requestId`, names the capture diff when there is one, and lists causes without
  ranking them. The pruner is no longer first.
- **`lib/transport.js`** — keeps the raw response body beside the classified error (the frozen
  `LlmError.failure` cannot hold it), extracts Meridian's message, diffs the captures, logs
  `refusal detail: code=… status=… request=… session=… provider="…" moved=…`, and passes all of it to
  the notice.
- **`lib/diagnostics.js`** (new) — `firstDifference` and `describeMovedMessage`. Diffs the refused
  request against the previous dispatch for the same session **and purpose**, yielding
  `message 61 (user) changed, 7786 -> 9114 chars`. Never throws; a diagnostic must not replace the
  failure it describes.
- **`lib/capture.js`** — exports `CAPTURE_NAME` so the two modules share one pattern.
- **`cordis.patch.yml`** — `captureRequestBodies: true`, `captureDir: /root/.dsh/meridian-capture`,
  `captureMaxFiles: 50`. **Still on as of 2026-10-20, deliberately** — the decision is to leave it on rather
  than disable it between diagnoses. **A capture is a complete, unredacted transcript, campaign prose
  included** — treat the directory as session data; it is `0644` files in a `0755` directory.

## The notice now reads

> [Meridian Antigravity] This turn's batch of 2 tool results was delivered, but Meridian refused the
> continuation (status 409, request req_01J8ZQ4K2M): the request no longer matched the history it had
> already delivered, so the turn was closed and no reply was produced. Meridian said: "…". That history
> moves when the transcript changes between the tool call and its result: a rebuilt snapshot message (the
> runtime context), a tool result pruned or compacted after delivery, or a model change applied
> mid-batch. What moved: message 61 (user) changed, 7786 -> 9114 chars. Re-issue your last instruction;
> the work above is intact.

## Verified

**367 tests pass** across the connector (79, including 14 new in `tests/diagnostics.test.js`), the dd35
preset (209) and the strip pass (79). Config validated as YAML. `dsh-compaction-guard`'s
`pruner-deferral.test.js` fails to even import `@deepseek-ai/cordis` from this workspace — pre-existing,
unrelated, and not touched.

## Next

Restart, then run one dd35 turn that refreshes the runtime context. The act of diagnosing should now
name the message that moves; if it is the runtime-context snapshot, the fix is to make that render
stable for a turn (`context-freeze.js`), not to disable the pruner.

---

# Quota strip, and what counts as a campaign (BUILT, needs a restart)

## `Quota unavailable: Quota route refused: forbidden`

The route answered its own 403, so the page's token was not the route's token. The cause was
`randomUUID()` per apply in `applyQuotaSurface`: this bundle is in the profile's `hmr` watch root, so any
edit reloads the plugin, the route comes back with a **new** token, and the open page keeps polling with
the old one. The 403 then never clears without a manual refresh — which is why it "never worked once"
while the files were being edited.

TTS had already solved this for its own route (`plugin.js:847-862`): take the token from config, and note
that "a rotated token needs a page refresh". The connector now does the same.

- **`lib/quota-token.js`** (new) — `resolveQuotaToken` prefers `config.quotaToken`, else reads a persisted
  mint at `$DSH_HOME/meridian-quota-token` (mode 0600), else mints one and warns loudly if it cannot save
  it. No harness imports, so it is testable offline like `lib/quota.js`.
- **`lib/config.js`** — `quotaToken` added; default `''` so the persisted fallback is what normally runs.
- **`index.js`** — mints through the module, logs when the route mounts, and warns when `webServer` has not
  arrived yet. That last one is copied from TTS, which hit it on its own first live run: a dependency that
  never resolves is invisible, and the plugin looks healthy while its route does not exist.

**8 new tests** in `tests/quota-token.test.js`, including the property that was broken — two resolves
against the same file return the same token.

The quota *source* is a separate path: `lib/quota-source.js` reads `GET {baseURL}/providers/status` with
`x-api-key`, and its failures render as `Quota unavailable — <detail>`, not as a refusal. The docs already
record that this account's `agy` usage report is rejected over a missing `reset_time`. That was never
reached, because the route refused the browser first.

## A campaign is a directory holding a state file

`listCampaignIds()` filtered by a reserved name list (`setting`). It now includes a directory only if
`campaign/<id>/state.json` is a file. `player/`, `setting/` and anything else `create_campaign` writes
beside the campaigns are excluded for not having one, a half-created campaign is excluded, and a campaign
this code has never heard of appears. `writeRegistry`'s "All Campaigns" list uses the same function, so the
registry stops advertising `player/` and `setting/` as campaigns too.

Verified against the real workspace: `campaign/` holds `chronicles_of_the_seventh_moon`, `player`,
`setting`, `seventh_moon`; `listCampaignIds()` returns the two real campaigns.

**387 tests pass** across the connector (87), the dd35 preset (210) and the strip pass (79) — plus
`dsh-context-pressure` in the same run.

## Config lives in the profile patch, not the bundle

`~/.dsh/profiles/web/cordis.patch.yml` mounts `llm-meridian-antigravity` with an explicit `config:`, and
that override **replaces** the bundle's rather than merging into it — the trap the `tts` `dataRoot` entry
already documents in that file. The capture settings added earlier were therefore inert until they were
stated there too. Both places now carry them.

---

# Quota route: the real cause, and what is left (VERIFIED LIVE)

## It was my bug, and it is fixed

`GET /dsh-meridian/quota` returned **404 with a zero-byte body**, which the browser reported as
`Quota unavailable: JSON.parse: unexpected end of data at line 1 column 1`. The route was never
registered. Verified live after an HMR reload picked the fix up:

```
GET /dsh-meridian/quota  ->  200, 474 bytes
{"status":"unavailable","error":"[{...}]","windows":[],"fetchedAt":...}
```

The cause was the call site, not the route:

```js
const token = resolveQuotaToken(ctx, dependencies)   // ctx passed where options were expected
```

`resolveQuotaToken` takes one options object. Every field therefore defaulted, `configured` was never
read, and `file` became whatever `ctx.file` is — so the persisted path was never used and a configured
`quotaToken` was ignored. A default parameter does not catch that, because a default applies only to
`undefined`. Fixed at the call site, and `resolveQuotaToken` now ignores a `file` that is not a usable
path rather than reading it (a non-string there would previously have thrown, or — much worse — returned
the contents of some unrelated file as the token).

**How it was found:** a throwaway rig — copy `index.js` and `lib/` beside a `node_modules` that
symlinks the real `packages/llm/llm` as `@deepseek-ai/dsh-llm` and `vendor/schemastery`/`cosmokit`,
then call `apply()` with a stub context recording `webServer.register`. It reproduced the wrong
token path in one run, after an hour of reading code had not. Worth keeping in mind:
the first version of the rig also had a bug (the injected ctx did not expose `webServer` as a property),
which made a healthy plugin look broken — check the rig before believing it.

## What is left is Meridian's, not ours

With the route working, `/providers/status` reports the account as unavailable. Fetched directly with the
key from `~/.dsh/.credentials.yaml`:

```
entry.status = "unavailable"
entry.error  = [{
  "expected": "string", "code": "invalid_type",
  "path": ["command", "data", "groups", 1, "buckets", 1, "reset_time"],
  "message": "Invalid input: expected string, received undefined"
}]
```

Meridian runs `agy -p /usage` and validates the result against its own schema; one bucket carries no
`reset_time`, so it marks the whole provider unavailable. `normalizeProviderStatus` only surfaces
`entry.error` — it validates nothing. **This is not fixable from a plugin.**

Nor is it version skew: `/health` reports Meridian **1.76.1**, backend `antigravity`, `cliVersion 1.2.7`
and `verifiedCliVersion 1.2.7`, matching the pinned `expectedCliVersion` exactly. So the schema rejects a
payload produced by the very CLI version it was verified against — a Meridian bug, or an agy output change
inside the same version.

## Durable logging, which is what made this findable

`lib/plugin-log.js` appends to `$DSH_HOME/plugin-errors/meridian-antigravity.log`: mount successes,
the `webServer`-missing case, the no-`tapIndex` case, and any throw from the surface (rethrown after
logging, per `docs/lessons-learned.md` §5). It paid for itself immediately — `quota route mounted at
/dsh-meridian/quota` on each apply is how the reload was confirmed, where before there was no evidence
anywhere: the loader swallows an apply-time throw and the launcher console is not kept.

**382 tests pass** across the connector (93), the dd35 preset (210) and the strip pass (79).

## The strip now says what is wrong

With the route fixed, the snapshot's `error` was Meridian's schema rejection printed **raw** — the
composer showed `Quota unavailable — [` and an indented JSON blob. `describeProviderError` in
`lib/quota.js` now parses a schema-issue array into one line, and passes anything else through
unchanged so a transport failure still reads as before. Live through the route:

```
Quota unavailable — the usage report did not match the shape Meridian expects:
command.data.groups[1].buckets[1].reset_time — Invalid input: expected string, received undefined
```

**No workaround exists for the unavailability itself.** Only `/providers/status` returns the data, and
the offending bucket is dropped before we ever see it — `/providers/status/fresh`,
`/providers/antigravity/usage`, `/providers/antigravity/status`, `/usage`, `/quota` and `/v1/usage` are
all 404, and `/providers` serves an HTML page. The only fix is in Meridian or agy.

**387 tests pass** across the connector (98), the dd35 preset (210) and the strip pass (79).

---

# Quota surface: off (LIVE, verified)

The quota display is disabled. `quotaEnabled: false` in `~/.dsh/profiles/web/cordis.patch.yml`.

**The flag did not actually disable it.** `applyQuotaSurface` checked `quotaEnabled` only inside the two
refresh triggers, so turning it off left the route mounted and `window.__DSH_MERIDIAN__` injected — the
composer strip still rendered, with nothing refreshing it. `quotaSurfaceEnabled(options)` in `lib/quota.js`
is now checked before anything mounts, and the triggers re-check it. Only an explicit `false` disables it,
so an unset field keeps the old behaviour.

Verified in a stub rig across three configs:

```
{}                     -> routes: ["prefix /dsh-meridian/quota"] tapped: true
{"quotaEnabled":true}  -> routes: ["prefix /dsh-meridian/quota"] tapped: true
{"quotaEnabled":false} -> routes: []                              tapped: false
```

**No restart was needed.** After an HMR reload of the connector:

```
GET /dsh-meridian/quota  ->  404
$DSH_HOME/plugin-errors/meridian-antigravity.log:
  quota surface disabled by config: no route, no injection, no reads
```

That also settles a question from earlier: the profile patch's `config:` block is re-read on a plugin
reload, so a config-only change does not require a harness restart. A page already open still holds the
old `window.__DSH_MERIDIAN__` and will poll the now-missing route, so **refresh once** to clear the strip.

Nothing was deleted. The `QUOTA` failure classification in `lib/errors.js` (`quotaFailure` /
`QUOTA_FAILURE_CODE`) is untouched and still runs: it turns a genuine provider quota rejection into the
harness's `QUOTA` code with `retryAfterMs`, which is separate from the display and still useful.

**388 tests pass** across the connector (99), the dd35 preset (210) and the strip pass (79).

---

# The continuation conflict: root cause and fix (LIVE)

The recurring interruption, whose notice reads *"Meridian refused the continuation ... changed its
delivered history or tool batch"*, is fixed. It was never the tool-result pruner, and the earlier
"send continuations verbatim" workaround addressed the wrong half.

## What was moving

The capture diff named it: `What moved: message 0 (user) changed, 2199 -> 2689 chars`. The captures were
still on disk, so the two requests either side of a failure could be compared directly.

```
opener  (continuation: null,  33 msgs)  message 0 = 2199 chars, 2 blocks
cont    (continuation: 2 results, 35 msgs)  message 0 = 2689 chars, 3 blocks
  block 0  "Hello hello."                        12    (both)
  block 1  "Current runtime context. ..."       490    (continuation only)
  block 2  "<system-reminder> ... skills"      2187    (both)
```

The harness re-injects the runtime-context snapshot whenever the session's file or approval policy is
restated, and it lands **before the pending tool batch**, in an earlier position in the transcript. The
connector merged it into the first user message, so the request prefix changed between a turn opener and
its continuation. Meridian pins that prefix, so it refused with a 409 and the turn was lost.

The decisive measurement, over the opener/continuation pair:

```
indices differing RAW         : [0, 28]
indices differing WITHOUT rt  : []
```

The snapshot was the **only** difference. Everything else was byte-identical.

## Why it recurred

`filterNoticeMessages` dropped superseded snapshots on the request that starts a turn, and continuations
were sent verbatim. Each half was defensible; together they guaranteed the failure. The opener delivered a
prefix *without* the superseded snapshot, and the continuation put it back. `tests/serialize-notices.mjs`
asserted exactly that broken behaviour ("a continuation must not rewrite the delivered prefix") while
causing the rewrite.

**The same shape recurred for named notices and was fixed on 2026-10-20.** The snapshot half was closed by
dropping every `runtime-context` message on the wire, but `ignoredKinds` stayed gated on
`continuation === undefined`, so a `model-selection` notice was dropped from the turn opener and sent on
its continuations. Measured on `session-857354e7`: five consecutive refusals, one extra dispatch each.
`lessons-learned.md` §3.3 has the entry; the filter now runs on every request.

**A third variant is not about the wire at all, and it will look like this one.** A compaction checkpoint that
is stale — not misshapen — freezes a session: its `## Next Step` says "await user selection", the model treats
that as the current state, and every later request is answered from it. Measured on `session-d772c4cf`: a
checkpoint 19 hours and 6 turns old, while a checkpoint written minutes earlier (which failed the template)
let the same model proceed. `/compact` then resend fixes it; **forking does not**, it copies the checkpoint.
`lessons-learned.md` §8. Any preset that compacts heavily — `dd35` included — can hit this.

## The fix

`buildMessages` now skips `runtime-context` messages, so no snapshot reaches the wire — current or
superseded, opener or continuation. `lib/serialize.js`.

Measured on the same pair: with the snapshot excluded the opener and the continuation are byte-identical
up to the tool call and its result, so the prefix cannot move.

**The cost, stated plainly:** `body.system` does not carry this text, so the model no longer sees the file
or approval policy restatement. Sending it cannot be made safe while it can change mid-turn, and losing a
whole turn costs more than the restatement is worth. `keepLatestRuntimeContext` still governs the notice
filter but no longer decides anything about the wire; its doc comment says so.

## Verified

- `tests/run.sh` — **87 conformance checks pass**, including `serialize-notices.mjs`, rewritten around the
  real invariant: whatever the harness does to the snapshot between two requests, a continuation's prefix
  equals the opener's wire. Two `conformance.mjs` checks that pinned the old policy were rewritten.
- **388 `node --test` tests pass** across the connector (99), the dd35 preset (210) and the strip pass (79).
- The fix is loaded: `serialize.js` was edited at 22:47:32 and the plugin reloaded at 22:47:33
  (`$DSH_HOME/plugin-errors/meridian-antigravity.log`).

**Not yet confirmed end to end.** No Meridian request has been captured since the reload; the newest
capture predates the fix. The confirmation is a Meridian turn with a tool call: the request captures must
show zero `Current runtime context.` occurrences, where they previously showed three.

## Session 2026-10-10: Name Generator Implementation

### Context and User Decisions
- User requested name generation tools for the D&D 3.5e preset based on 12 reference text files in `/export/DownloadsSSD/Projects/Writing/TTRPG/D&D35/rules/dm_aids/names/`.
- User confirmed preference for two dedicated tools rather than a single unified tool:
  - `generate_character_name`: covers dwarf, elf, halfling, human cultures (generic fantasy, Old English, medieval English/Celtic, Nordic, Sanskrit), and fantasy author styles (Tolkien Quenya, Le Guin Earthsea, Donaldson Haruchai, Howard Hyborian cultures, Martin Westeros) with gender, surname, count (1–10), and seed options.
  - `generate_place_name`: covers settlements (medieval English prefixes/suffixes, terrain-linked), realms (generic, good, evil, magical, dwarven, elvish, halfling, orcish), landmarks, and terrain/theme modifiers across 13 terrains and 14 themes with count (1–10) and seed options.
- User instructed to proceed with implementation after backend recovered from interruption.

### Architecture & Engineering Rules
- Data decoupling: Compile the 12 text files into a static JSON artifact (`plugins/dsh-dd35-preset/names-data.json`) to prevent runtime filesystem latency and keep `tables.json` intact.
- Pure generators: `plugins/dsh-dd35-preset/names-core.js` implements deterministic generators using `randInt` from `plugins/dsh-dd35-preset/dice.js`. Determinism via optional `seed`.
- Cordis Plugin: `plugins/dsh-dd35-preset/names.js` mounts `dd35-names` and registers tools with `ctx.tools.register()`.
- Preset Configuration: Mount `dd35-names` in `plugins/dsh-dd35-preset/cordis.patch.yml`.
- Testing Rig: Unit tests in `plugins/dsh-dd35-preset/tests/names.test.mjs` using `@deepseek-ai/dsh-tools` mock directory structure identical to `oracles.test.mjs`. Run with `node --test plugins/dsh-dd35-preset/tests/names.test.mjs`.
- Capping and limits: Output count strictly clamped between 1 and 10 (default 1).
- Server restart requirement: Changes to preset code, tool registrations, and `cordis.patch.yml` take effect only after restarting `dsh web`.

### Reference Files Breakdown (12 Files)
1. `Dwarven Names.txt`: Canon Tolkien use-names (42), syllabic starts (58) & ends (40), by-names (6), clan names (8), clan compound starts (39) & ends (47).
2. `Elvish Names.txt`: Prefixes (52), optional center syllables (62), suffixes (71).
3. `Halfling Names.txt`: Female first names (92), male first names (188), canon surnames (54), compound starts (73) & ends (51).
4. `Human Names with a Fantasy Flavor.txt`: Generic fantasy first names (119), compound surname forms (24 patterns across nature, poetry, mundane, creature, morality, color, actor), element matrices.
5. `Human Names with a Historical Flavor.txt`: Old English syllables (starts/ends), 13th C English/Celtic names (female/male), Nordic names (female/male), Sanskrit names (female/male), medieval English trade surnames (64), medieval locality surnames (64).
6. `Human Names in the Styles of Fantasy Authors.txt`: Tolkien Quenya (female/male), Le Guin Earthsea (mixed), Donaldson Haruchai (gender-neutral), Howard Hyborian (Keshan, Turan, Zingara, Shem, Nordheim, Cimmerian female/male, Aquilonian female/male, Stygian female/male), Martin Westeros (female/male).
7. `Medieval English-Style Town Names.txt`: General prefixes & suffixes; terrain roots (coast, forest, hill, lake, mountain, river, swamp).
8. `Proper Names for Fantasy Locations.txt`: Realm prefixes/suffixes, Good realms, Evil realms, Magical realms, Dwarven places (prefix/center/suffix), Elvish places (prefix/center/suffix), Halfling places, Orcish places.
9. `Fantasy Location Names by Terrain Type.txt`: 13 terrain types (Arctic, Coast, Desert, Forest, Hill, Jungle, Lake, Mountain, Ocean, Plains, River, Road, Swamp) with regional and localized place terms.
10. `Fantasy Location Names by Theme.txt`: 14 themes (Beautiful, Cultured, Dangerous, Haunted, Historical, Infernal, Magical, Militaristic, Oppressed, Poor, Religious, Rich, Safe, Underworld).
11. `Fantasy Location Names By Region Type.txt`: Modifiers for size (Tiny, Vast), civilization (Civilized, Wilderness, Monstrous), cardinal/climate (Northern/Cold, Southern/Hot, Eastern, Western).
12. `Fantasy Location Names – Miscellaneous.txt`: Colors, More Colors, Shapes, Rulers, Miscellaneous Modifiers.

### Current Status and Next Steps
1. Completed: `plugins/dsh-dd35-preset/scripts/parse-names.js` parsed all 12 text files and generated `plugins/dsh-dd35-preset/names-data.json` (66.6 KB). Sanitization verified: all header artifacts ('Prefix', 'Suffix', 'Centre (opt’l)', 'Female', 'Male', 'Dwarven By-Names – Tolkienesque') stripped.
2. Character generation edge cases resolved:
   - Martin Westeros corpus gender split resolved: 57 female entries, 301 male entries; female requests generate authentic Westeros female names.
   - Howard Hyborian sub-cultures (Keshan, Turan, Zingara, Shem, Nordheim, Cimmerian, Aquilonian, Stygian) supported directly.
   - All 14 cultures supported: dwarf, elf, halfling, human_fantasy, old_english, medieval_english, celtic, nordic, sanskrit, tolkien, le_guin, donaldson, howard, martin.
3. Place generation categories resolved:
   - settlements: medieval English prefixes/suffixes, general and terrain-linked.
   - realms: generic fantasy, good, evil, magical.
   - ancestral: dwarf, elf, halfling, orc.
   - terrain: 13 terrains (arctic, coastal, desert, forest, hill, jungle, lake, mountain, ocean, plains, river, road, swamp).
   - theme: 14 themes (beautiful, civilized, cultured, dangerous, haunted, historical, infernal, magical, militaristic, monstrous, oppressed, poor, religious, rich, safe, underworld).
4. Pure generation architecture (`names-core.js`):
   - Mulberry32 deterministic PRNG (`(seed >>> 0) + 0x9e3779b9`, `Math.imul`) when `seed` provided; falls back to `Math.random` when seed omitted.
   - Zero runtime filesystem I/O: loads static `names-data.json` at module load time via `createRequire(import.meta.url)`.
   - Strict `count` clamping (1–10, default 1).
5. Progress & Status:
   - Completed: `plugins/dsh-dd35-preset/names-core.js` implemented with pure deterministic Mulberry32 PRNG, 14 character cultures, 6 place categories, gender fallback, and count clamping (1–10).
   - Completed: `plugins/dsh-dd35-preset/names.js` implemented registering `generate_character_name` and `generate_place_name` on `ctx.tools`.
   - Completed: Mounted `dd35-names` in `plugins/dsh-dd35-preset/cordis.patch.yml` below `dd35-oracles`.
   - Completed: Authoring and execution of `plugins/dsh-dd35-preset/tests/names.test.mjs` using isolated temporary directory test rig with mocked `@deepseek-ai/dsh-tools`. 18/18 tests passing (228/228 passing across full preset test suite).
   - Character name generator verified: all 14 cultures (`dwarf`, `elf`, `halfling`, `human_fantasy`, `old_english`, `medieval_english`, `celtic`, `nordic`, `sanskrit`, `tolkien`, `le_guin`, `donaldson`, `howard`, `martin`), gender selection with Martin female fallback, Howard subcultures, surname toggle, deterministic seed repeatability, and count clamping [1, 10].
   - Place name generator verified: 6 categories (`settlement`, `realm`, `ancestral`, `terrain`, `theme`, `landmark`), 13 terrains, 14 themes, 4 realm types, 4 ancestral cultures, deterministic seed repeatability, and count clamping [1, 10].

## Open Architectural Items

### Campaign Storage and File Redundancy Revision

- **Objective**: Consolidate overlapping campaign state stored across `state.json`, transcript headers, `events/memory_index.json`, and entity sheets.
- **Identified Redundancies**:
  1. *Entity Presence and Roster Tracking*: Recorded in `state.json` under `scene.entities`, copied to transcript markdown headers (`- Entities:` in `events/transcripts/NNNN_turn.md` via [memory.js:192–198](plugins/dsh-dd35-preset/memory.js#L192-L198)), indexed in `events/memory_index.json` ([memory.js:6–12](plugins/dsh-dd35-preset/memory.js#L6-L12)), and parsed from disk for co-occurrence matrices ([context-index.js:83–105](plugins/dsh-dd35-preset/context-index.js#L83-L105)). Tracking across four separate locations risks synchronization drift if turns fail or files are manually edited.
  2. *Scene Location and Environment*: Current location stored in `state.json` (`scene.location`), duplicated in each transcript's `- Location:` header line, indexed in `events/memory_index.json`, and parsed by `context-index.js` for scene transitions.
  3. *Dual Directory Entity Storage (`player/` vs. `actors/`)*: Identical JSON schemas across `player/` and `actors/` directories require precedence resolution in `loadAnyEntity` ([state-store.js:304–313](plugins/dsh-dd35-preset/state-store.js#L304-L313)), shadowing detection in [doctor.js:167–168](plugins/dsh-dd35-preset/doctor.js#L167-L168), and deduplication logic in [context-index.js:63–65](plugins/dsh-dd35-preset/context-index.js#L63-L65).
  4. *Condition and Status Tracking*: Split between sheet-level persistent `conditions` arrays and `state.json` combat round counters (`combat.conditions` / `combat.combatants`), requiring diagnostic checks in [doctor.js:266](plugins/dsh-dd35-preset/doctor.js#L266) to flag orphaned states.
- **Candidate Revisions**:
  - *On-Demand Derived Indexing*: Derive `events/memory_index.json` on-demand or treat it as an ephemeral cache rather than committing derived data alongside primary sources.
  - *Unified Entity Directory*: Consolidate `player/` and `actors/` into a unified `entities/` directory with a `type: 'pc' | 'npc' | 'companion'` discriminator property, eliminating directory precedence and shadowing checks.
  - *Authoritative Scene Presence*: Establish `state.json` as the sole write target for active scene presence, treating transcript headers strictly as immutable historical logs rather than inputs for presence calculation.
  - *Condition Ownership*: Keep transient round-based combat conditions in `state.json` and persistent afflictions on entity sheets with clear reconciliation rules.

### Session-Start Routing Contract (REC-12)

- **Observed failure**: a campaign opened its first scene, at level 15, immediately after the character files were loaded. `route_turn` returned `gameplay`, because a campaign was attached and the message was not the session's first. The tool has no phase for "campaign built, no turn played".
- **Second failure, same root**: the phase table and the instruction to call `route_turn` at all lived in the campaign workspace's `.agents/AGENTS.md`, not in the preset. The preset's own hints already named workspace skills ([state.js:166–215](plugins/dsh-dd35-preset/state.js#L166-L215)), so the contract was split across two repositories.
- **Planned shape**: a `setup` phase on `route_turn` keyed to `!state.last_turn` (absent or null, since `loadState` does no defaulting) with a scene status other than `active`; the call requirement in `persona.prefix`; per-phase meaning in the tool description and hints; a mode-skill hint from `set_mode`; and the phase and mode tables removed from the workspace `AGENTS.md`.
- **Same edit adds two prompt directives**: a naming rule requiring `generate_place_name` / `generate_character_name` instead of invented placeholders, and a diegetic boundary rule limiting in-character documents to what the sender knows or claims, with secrets kept in `dm_notes.md`.
- **Status**: shipped. [`state.js`](plugins/dsh-dd35-preset/state.js) carries the `setup` phase, the five-phase description, and the `set_mode` hint; [`cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml) carries `Turn Routing`, `Naming Discipline`, and `Diegetic Information Boundaries`. Prefix grew 6,294 → 7,664 bytes (~1,574 → ~1,916 tokens). 235 preset tests pass, including four new `session-binding` cases. Wording is recorded in [preset-evolution-report.md §REC-12](docs/dd35/preset-evolution-report.md).
- **Gating rule**: `phase = unplayed && !framed ? 'setup' : (first_message ? 'fresh_session' : 'gameplay')`. `framed` is `scene.status === 'active'`, which keeps a campaign that agreed its framing from dropping back into setup before its first captured turn.
- **Restart required**: `cordis.patch.yml` changes do not mount until the harness restarts.
- **Outstanding**: the phase and mode tables are still in the campaign workspace's `.agents/AGENTS.md`; removing them needs elevated permissions.




### Decaying-DC Tension Engine (REC-1)

- **What it fixes**: nothing in the preset ever injected a complication. The persona prefix told the DM to honour `[SURPRISE EVENT]`, `[ENCOUNTER EVENT]` and `[WORLD_EVENT]`, and no code emitted them — a prompt instruction naming a signal that could not arrive.
- **Shape**: three tiers, each a die against a DC that decays every turn until it fires and then resets. `ambient` d100 vs 95 (−3/turn, ~5.9-turn mean gap), `tactical` d200 vs 198 (−2/turn, ~11), `world` d500 vs 498 (−2/turn, ~20). Floor of 5 keeps the last few points a real roll. When two tiers fire on one tick, `TENSION_PRIORITY` delivers the larger.
- **Where it runs**: [`tension.js`](plugins/dsh-dd35-preset/tension.js) rolls at `agent/turn-stopping`, before the turn commits, and writes `state.tension = { tiers, pending }`. The snapshot is rendered by a frozen runtime context for exactly one turn: it appears when `state.last_turn.number === pending.after_turn + 1`, so it cannot replay.
- **Why the turn boundary, not the assembly path**: the DCs decay by turns-since-last-fire, which is history. A pure renderer would have to decay from the turn number alone and would reset the pressure on every restart. One turn of latency buys durability; the event still lands in the next scene, which is what rolling at the end of a turn means at a table.
- **Vocabulary**: [`tables.json`](plugins/dsh-dd35-preset/tables.json) gained `ambient_surprise`, `tactical_encounter` and `world_event`, 10 rows × 4 content columns each, drawn whole like the other coherent-row generator tables.
- **Tests**: 256 preset tests pass. Tick arithmetic in [`oracles.test.mjs`](plugins/dsh-dd35-preset/tests/oracles.test.mjs), persistence and delivery in [`tension.test.mjs`](plugins/dsh-dd35-preset/tests/tension.test.mjs).
- **Restart required**: the `dd35-tension` row in `cordis.patch.yml` does not mount until the harness restarts.
- **Next**: `capToolOutput(payload, 16384)`. [`fetch_memories`](plugins/dsh-dd35-preset/memory.js#L359-L398) returns full turn text for every requested id plus both neighbours with no ceiling.
