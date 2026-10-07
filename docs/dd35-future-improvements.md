# DSH D&D 3.5e Profile — Future Improvements

*Living backlog for the `dd35` agent preset. Each item records what the problem is, why it matters,
and enough design detail to implement it later without re-deriving the analysis.*

**Status legend** — `IDEA` not started · `SPECCED` design settled, ready to build · `WIP` in progress · `DONE` shipped · `DECLINED` considered and rejected
**Priority** — P1 wanted or needed now · P2 meaningful quality gain · P3 polish

| ID | Item | Priority | Effort | Status |
|---|---|---|---|---|
| [FI-1](#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories) | Turn memory: auto-capture + `grep_memories` / `fetch_memories` | **P1** | ~1–2 days | `DONE` |
| [FI-2](#fi-2--derived-stat-engine) | Derived-stat engine with bonus stacking | **P1** | ~1–2 days | `SPECCED` |
| [FI-3](#fi-3--monster-corpus-re-extraction) | Monster corpus re-extraction | P1 *(correctness)* | ~1 day | `IDEA` |
| [FI-4](#fi-4--position-and-distance-model) | Position and distance model | P2 | ~1 day | `IDEA` |
| [FI-5](#fi-5--resource-automation) | Resource automation (spell slots, uses/day) | P2 | ~1 day | `IDEA` |
| [FI-6](#fi-6--progression-automation) | XP and level-up automation | P3 | ~half day | `IDEA` |
| [FI-7](#fi-7--content-search-in-search_reference) | Content search in `search_reference` | P3 | ~half day | `IDEA` |
| [FI-8](#fi-8--encumbrance) | Encumbrance calculation | P3 | ~2 hours | `IDEA` |
| [FI-9](#fi-9--automatic-turn-start-state-injection) | Automatic turn-start state injection | **P1** | ~half day | `SPECCED` *(spike revised)* |
| [FI-10](#fi-10--the-onnx-inference-substrate) | ONNX inference substrate | P2 | ~1–2 days | `IDEA` |
| [FI-11](#fi-11--typed-decisions-as-a-second-oracle) | Typed decisions as a second oracle (Jev/Laya) | P2 | ~1 day | `IDEA` |
| [FI-12](#fi-12--prose-grading-llmisms-and-naturalness) | Prose grading: LLMisms and naturalness | P2 | ~half day | `IDEA` |
| [FI-13](#fi-13--constrained-rewriting) | Constrained rewriting | ~~P3~~ | ~1 day | `DECLINED` |
| [FI-14](#fi-14--semantic-retrieval-for-concepts-and-style) | Semantic retrieval for concepts and style | P2 | ~1–2 days | `IDEA` |
| [FI-15](#fi-15--cross-encoder-reranking) | Cross-encoder reranking | P3 | ~half day | `IDEA` |
| [FI-16](#fi-16--entity-extraction-and-entity-linked-memory) | Entity extraction and entity-linked memory | P2 | ~1 day | `IDEA` |
| [FI-17](#fi-17--repetition-and-continuity-detection) | Repetition and continuity detection | P3 | ~half day | `IDEA` |

FI-1 … FI-9 are **Part I: the preset as it stands** — state, mechanics, memory, and the corpus.
FI-10 … FI-17 are **Part II: local inference** — small ONNX models running beside the main model.
They share one prerequisite (FI-10) and one property (they are cheap enough to run every turn, in parallel).

---

## FI-1 — Turn memory: auto-capture + `grep_memories` / `fetch_memories`

**Priority P1 · Effort ~1–2 days · Status `DONE` — shipped**

### What shipped

> **Where the bundle lives.** The preset is no longer inside this repository. It is a profile-global bundle at
> `/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-dd35-preset`, installed into the `web` profile by a
> `link:` dependency, so the file paths below are written relative to it:
>
> ```sh
> DD35=/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-dd35-preset
> ```

| Piece | Where |
|---|---|
| Automatic capture + the three recall tools | `memory.js` (new plugin, mounted as `dd35-memory`) |
| Transcript I/O, the scene index, the search engine | `memory-store.js` (new shared library) |
| `log_turn` | **removed** — `dd35-state` went 11 → 10 tools; preset total 44 → 43 |

**Capture** is split across two events, which is what makes "completed only" enforceable:

1. `agent/turn-stopping` (serial, awaited) takes the snapshot — the last moment before the turn
   boundary commits, when no tool call is live and no steering is pending.
2. `session/event` → `turn/end` commits it **only** when `reason.kind === 'completed'`.

`turn-stopping` fires for `completed`, `blocked`, and `max-tokens` alike and carries no reason, so
stashing at one boundary and committing at the other is the only way to exclude the non-canonical
turns. Aborted and errored turns never reach `turn-stopping` at all.

Two filters guard the write:

- **Main agent only** — `session.header.origin !== 'subagent'`. Subagent sessions inherit the parent's
  composition opportunistically, so the hook genuinely fires for them.
- **Real player input only** — `message.role === 'user' && message.source.kind === 'user'`. The search
  walks back from the final assistant message, so injected context cannot be mistaken for the
  player's words.

**Deviations from the spec, and why:**

- **Transcript header gained `- Date:` and `- Location:`** (spec called for the date only). Location
  costs a line and makes a fetched hit self-locating.
- **`commitTurnToIndex` falls back to a full rebuild on a numbering gap.** The incremental fold is
  O(1) but assumes it is appending to a contiguous history; if a transcript is lost or the index is
  behind, writing the computed range would silently corrupt it. The gap check costs one integer
  comparison.
- **`list_memories` gained `rebuild: true`**, so the model can force a repair without a separate tool.
- **A missing index self-heals.** `readMemoryIndex` rebuilds whenever it is absent or behind the
  transcripts, which is also the migration path for campaigns played before this shipped.
- **Dedup by player message id**, not by turn number, so a turn that carries no fresh player input
  (an agent-initiated continuation) records nothing rather than re-recording the previous exchange.

**Verification:** 38-case standalone test against a scratch workspace — transcript/header/content
fidelity, the four-segment index for a scene that is left and returned to, the date span, replay
idempotence, aborted-turn and subagent exclusion, all four query syntaxes plus negation, range and
role filters, malformed-query handling, fetch with neighbours and unknown ids, bounded listing, index
deletion and auto-rebuild, and regression checks that `get_state`, `roll_dice`, and `lookup_rule`
still work.

### Observed in live play (2026-10-02)

Capture works end to end in a real session — turns 4–6 of `seventh_moon` were written by the plugin
with no `log_turn` call, transcripts carry the Date header, the campaign log was appended, and
`memory_index.json` was maintained incrementally. Turn numbering, dedup, and the memory write path
are all confirmed against the live runtime rather than a stand-in.

**But the index is degenerate, and the cause is the model, not the code:**

```json
{"total_turns": 6, "first_date": "Day 1 Morning", "last_date": "Day 1 Morning",
 "segments": [{"start": 1, "end": 6, "title": "Untitled Scene"}]}
```

Two disciplines the recorder depends on are not being exercised:

1. **No scene title is ever set.** `update_scene` is not being called with `title`, so every turn
   lands in one `Untitled Scene` segment and the index degenerates to a single useless row. The
   windowize fallback (25-turn groups) only exists for a *wholly* untitled campaign, so it hides the
   problem rather than fixing it.
2. **The clock never advances.** `Day 1 Morning` is frozen across all six turns, so the `Day 1 → Day
   40` span is meaningless as well.

The persona already tells the DM to set the title, which is evidently not sufficient — the same
lesson as [FI-11](#fi-11--typed-decisions-as-a-second-oracle): a prompt that asks is weaker than a
mechanism that reports. Candidates, cheapest first:

- Have the recorder **derive a fallback title** from the first assistant line of the turn, and mark it
  as derived, so the index is useful even when the DM forgets.
- Surface the omission in the turn-start snapshot ([FI-9](#fi-9--automatic-turn-start-state-injection)):
  *"turn 6 recorded under an untitled scene."*
- Ask the [FI-11](#fi-11--typed-decisions-as-a-second-oracle) `noul` question — "has the scene
  changed since the last turn?" — and prompt only when it fires.

### The problem

The DM has no memory beyond its context window. In a long campaign, detail from twenty turns ago is
simply gone — an NPC's name, a promise made, the exact wording of a threat, a wound that never
healed. The model can re-read whole transcript files, but that burns context and is unusable once
there are hundreds.

### Capture is automatic — `log_turn` is retired

Verification against the live runtime confirms DSH exposes a purpose-built hook:

```
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent, turn, signal }): Promise<void> | void
```

**mode: `serial`** — *"The turn is about to close: the model owes no response (no live tool calls, no
fresh steering)."*

Three properties make this exactly right:

1. **It is `serial`** — the turn *waits* for the listener, so a write inside it is guaranteed before
   the turn closes. This is precisely the durability the `log_turn` tool lacked.
2. **It is agent-scoped** — mounted in the `dd35` preset, it fires only for D&D sessions.
3. **No live tool calls remain** — so "the last assistant message" is unambiguously the final reply.

Message text comes from the `sessions` service (`ctx.sessions.get(id)`). The `Session` class exposes
`deriveMessages(): Message[]`, and `SessionEventMap` carries the turn structure directly:
`'user/message'`, `'assistant/message' { turn, step, message }`, `'turn/start'`, `'turn/end'`.

```js
ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
  const session = ctx.sessions.get(agent.id)
  const msgs = session.deriveMessages().filter(m => m.role === 'user' || m.role === 'assistant')
  const playerText = last(msgs.filter(m => m.role === 'user'))
  const dmText     = last(msgs.filter(m => m.role === 'assistant'))
  // → write the transcript + append the log, exactly as log_turn does today
})
```

**Decisions (settled):**

| Decision | Choice |
|---|---|
| `log_turn` tool | **Removed.** The plugin owns writing; keeping both would double-write. |
| Which turns to record | **Completed only.** `turn/end` carries `reason: completed \| aborted \| blocked \| error \| max-tokens \| interrupted \| forked`; only `completed` enters memory, so a half-finished turn never becomes canon. |
| Which sessions | **Main agent only.** Subagents fire `turn-stopping` too and must be filtered out — root sessions only. |
| Scene facts | Read from `state.json` at write time, so the log still gets micro-state, pending action, and location without the model calling a logging tool. |

The model's remaining job is **`update_scene`** — which it should be doing anyway.

### Storage layout

Unchanged from today's transcript format, so existing campaigns keep working:

```
campaign/<id>/events/transcripts/0001_turn.md
campaign/<id>/events/transcripts/0002_turn.md
...
```

each containing the player's exact input and the DM's exact response under `## Player` / `## DM`
headings, with the scene title, location, entities, micro-state and pending action in the header.
An `events/memory_index.json` is maintained alongside for the context index (below).

> **Superseded.** This section originally described a parallel `campaign_log.md` as well. That file is
> gone: it duplicated the same exchanges with the state snapshot appended, the two drifted (29 machine
> entries against 34 transcripts, with the index advertising ranges neither could answer), and every
> hand-written section in it turned out to be either state or a copy of a transcript. The state snapshot
> now lives in the transcript header, and `campaign_log.md` is archived in the campaign's `recycle_bin`.

### Proposed tools

#### `grep_memories`

Search the turn transcripts and return ranked snippets with stable ids.

```js
grep_memories({
  query: "Kenna",            // bare terms (AND) | "quoted phrase" | /regex/
  campaign: undefined,       // defaults to active
  role: undefined,           // "dm" | "player" | undefined (both)
  from_turn: undefined,      // bound the search
  to_turn: undefined,
  context: 1,                // neighbouring messages to include in the snippet
  limit: 20
})
```

Returns:

```js
{
  query: "Kenna",
  total_hits: 7,
  returned: 7,
  hits: [
    {
      id: "0012:dm",                                  // stable id for fetch_memories
      turn: 12,
      role: "dm",
      title: "Flashback: The Wolves of Hurstwood",
      snippet: "…Thiago is actively fucking Kenna, having positioned himself between her legs…",
      matched: "Kenna",
      score: 0.91
    }
  ]
}
```

The point of the snippet is that **the model gets a menu to choose from** — it sees enough to judge
relevance without loading the full text of twenty turns.

#### `fetch_memories`

Expanded read of the hits the model picked.

```js
fetch_memories({
  ids: ["0012:dm", "0031:player"],   // ids from grep_memories
  context: 1                          // also return the turn either side
})
```

Returns the full message text plus its metadata (turn number, role, scene title, timestamp).

#### `list_memories`

Two modes, one tool:

- **No arguments** → the scene index (the table above). This is how the model finds out what is in
  memory and which turn ranges to search.
- **`{ from_turn, to_turn, limit }`** → turn headers and opening lines for a bounded range, for when
  the model knows roughly *when* something happened but not what it was called.

### Implementation notes

- **Per-message granularity.** Split each transcript on its `## Player` / `## DM` headings so a hit
  points at a *message*, not a whole turn. That is what makes the id shape `NNNN:role` work.
- **Both a cache and an index, for different reasons.** Transcripts are a few KB each; even a thousand
  is a trivial linear scan, so the *search* needs no index — the parsed turns are cached in memory
  keyed by mtime and invalidated on write. The index exists only because the model cannot search what
  it does not know exists; it is the map, not the lookup structure.
- **Ranking.** Term frequency weighted by recency — a hit from turn 40 should outrank an identical
  one from turn 3, all else equal.
- **Query syntax.** Bare terms AND together; `"quoted phrases"` match exactly; `/regex/` for power
  use. Support negation (`-term`) since "find the scene with Kenna but not the tavern" is a real
  query shape.
- **Shared engine with [FI-7](#fi-7--content-search-in-search_reference).** Both are content search over
  local files. Build one `grepText()` helper and use it in both places.

### Surfacing the index: pull, not push

The model cannot search what it does not know exists. Something has to tell it that memory is there.

> **Correction (found while shipping FI-1).** The original reasoning here was wrong. It assumed
> `systemPrompt.context()` writes into the system prompt at **byte 0**, where any change invalidates
> the entire cached prefix. It does not. Context contributions are rendered into a separate
> **runtime-context snapshot delivered as a `user` message in the history**
> (`source.kind === 'runtime-context'`), and a superseding snapshot is appended rather than rewriting
> the prefix. That channel is cheap and is the right home for a small, slowly-changing block.

#### Why the *full index* is still a tool

Not placement — **size and frequency**. The rendered index is ~2 KB, and the model consults it a
couple of times per scene. Pushing it through the runtime-context snapshot would re-send those ~2 KB
on every request for the whole scene, paying for it hundreds of times to serve two reads. The narrow
summary — turn count, date span, scene count — is a different proposition: a few dozen tokens that
orient the model every turn, which is exactly what a snapshot is for.

**Decision: the full index stays behind `list_memories()`; only the summary is pushed.**

#### Delivery

| Piece | Delivery | Cost |
|---|---|---|
| Turn count + span + recent scenes | the **runtime-context snapshot** ([FI-9](#fi-9--automatic-turn-start-state-injection)) | a few dozen tokens, riding along with state the model already receives |
| Full scene index | `list_memories()` returns the table below | on demand only |
| Search | `grep_memories()` | on demand only |
| Read | `fetch_memories()` | on demand only |

**`get_state` is not modified.** Once [FI-9](#fi-9--automatic-turn-start-state-injection) publishes a
state snapshot at the start of every turn, that snapshot is the natural home for the memory summary —
it is already being sent. So `get_state` stays purely about game state, and the "reminder that memory
exists" costs nothing extra.

`list_memories()` returns:

```
## Turn Memory
512 turns stored · Day 1 → Day 40 · searchable by keyword

| turns   | scene                                |
|---------|--------------------------------------|
| 1–14    | Session 1: The Rising Shadow         |
| 15–38   | Flashback: The Wolves of Hurstwood   |
| 39–102  | The Road to Mithraelis               |
| …       | …                                    |
| 480–512 | The Siege of Ashkar                  |

Search with grep_memories; read hits with fetch_memories.
```

#### Why a scene index rather than the oldest turns

The original proposal was a list of the **oldest** few turns, each truncated to N characters. Two
problems with that:

1. **Wrong end of the pool.** The oldest turns are the *least* likely to be what the model needs, and
   the model already holds recent turns in its context window. What it lacks is a map of everything
   *before* the window — the oldest-N sample describes only the first few percent of it.
2. **Raw prefixes make a poor index.** A turn's opening characters rarely summarise its content.
   Scene titles, by contrast, are already maintained (they head every transcript and every `### `
   block in the campaign log) and are genuinely semantic.

A scene index costs about the same, covers the whole pool instead of one corner, and yields precise
fetch targets — `grep_memories({ from_turn: 39, to_turn: 102 })`.

#### Building it dynamically

Persisted at `events/memory_index.json`, **maintained incrementally** — never by rescanning.

```js
function recordTurn(index, { turn, title, date }) {
  index.total_turns = turn
  index.last_date = date ?? index.last_date
  const last = index.segments.at(-1)
  if (last && last.title === title) {
    last.end = turn                                          // extend the open segment
  } else {
    index.segments.push({ start: turn, end: turn, title })    // scene changed
  }
  writeJson(indexPath, index)
}
```

A row is appended only when the scene title changes, so a 40-turn scene costs one row. Comparing
against only the *last* segment is deliberate: leaving Mithraelis at turn 102 and returning at turn
300 correctly opens a second segment rather than merging two separate visits.

- **Rebuild path** — for existing campaigns and repairs, scan `transcripts/*.md` in sorted order and
  feed each header through the same `recordTurn`. Turn numbers come from the **filename**, not the
  array index, so gaps do not corrupt ranges.
- **Title and date** — parsed from the transcript header. The writer should stamp the clock as well
  (`# Turn 0001 — <title>` + `- Date: Day 1, Morning`), which makes the `Day 1 → Day 40` span
  derivable from the transcripts alone, with no second source of truth.
- **Budget** — cap `list_memories` output (~2 KB). Past the cap, show the first 3 scenes, the most
  recent 10, and an elision row counting the rest.
- **Untitled turns** — inherit the running title rather than opening a new segment, so one missed
  `update_scene` does not shatter the index into 1-turn rows. A wholly untitled campaign falls back
  to fixed windows (every 25 turns).

### Open questions

- ~~Should `grep_memories` also search `campaign_log.md` as a second source?~~ **Resolved: the file was
  retired.** Its unique content moved into the transcript header, so there is one corpus to search.
- Do we want a rolling summary layer — periodic "chapter" summaries that get grepped instead of raw
  turns once a campaign exceeds a few hundred turns?

---

## FI-2 — Derived-stat engine

**Priority P1 · Effort ~1–2 days · Status `SPECCED`**

### The problem

Sheets currently store **final** numbers — `"ac": 31`, `"attack_bonus": 23`. The tools read those
values but never compute them. The model is responsible for working out that a longsword attack is
`+17 BAB, +2 Str, +3 enhancement, +1 Weapon Focus` and writing `23` onto the sheet.

### Why it isn't blocking today

A competent model handles this fine *when it knows the modifiers* — and 3.5e arithmetic is not hard
for it. The reason to build an engine is not raw capability:

- **Determinism across a long combat.** Over 20 rounds with fifteen running buffs, code never
  forgets that *Recitation* lapsed on round 8. A model can.
- **Auditability.** The engine can print `+23 = +17 BAB, +2 Str, +3 enh, +1 Weapon Focus`, so the
  number can be checked rather than trusted.
- **Context capacity.** The model stops having to hold every modifier in its head.

The failure mode cuts both ways: a good model beats a naive engine, but a correct engine beats a
model on turn 18.

### The core algorithm — genuinely small

3.5e's stacking rule reduces to: *typed bonuses don't stack (highest wins); dodge, circumstance, and
untyped stack; penalties always stack.*

```js
const STACKS = new Set(['dodge', 'circumstance', 'untyped'])

function stack(mods) {
  const best = new Map()
  let total = 0
  for (const m of mods) {
    // penalties always stack, regardless of type
    if (m.value < 0 || STACKS.has(m.type)) { total += m.value; continue }
    const prev = best.get(m.type)
    if (!prev || m.value > prev.value) best.set(m.type, m)
  }
  for (const m of best.values()) total += m.value
  return total
}
```

That is the entire stacking engine. Everything else is bookkeeping around it.

### What makes it non-trivial

1. **Pools are per-target, not global.** `morale → attack` and `morale → saves` are separate pools.
   The key is `(statistic, bonus_type)`. Needs a target vocabulary: `ac`, `attack.melee`, `damage`,
   `save.fort`, `save.will`, `skill.spot`, `str`, `initiative`, …
2. **Ability bonuses cascade.** A `+4 enhancement to DEX` changes the *score*, which changes the
   *modifier*, which changes AC, Reflex, initiative, and every DEX skill. Requires ordered
   recomputation: scores → `floor((score − 10) / 2)` → derived stats.
3. **AC is component-based, not one pool.**
   `AC = 10 + armor + shield + DEX(capped by max-Dex) + size + natural + deflection + dodge + misc`.
   An *enhancement* bonus to armor and to a shield are different components despite sharing a type.
   Getting this wrong is the classic bug.
4. **Penalties have no "highest only" rule** — they all land.
5. **The same spell twice doesn't stack** — that is *source* overlap layered on top of type, not a
   type rule.
6. **Size modifiers differ per statistic** — AC, attack, grapple, and Hide each use different values
   per size category.
7. **Racial bonuses are typed** (they do not stack) — a very common error, since "racial" reads like
   "untyped".

**Bonus types to model:** alchemical, armor, circumstance, competence, deflection, dodge,
enhancement, inherent, insight, luck, morale, natural armor, profane, racial, resistance, sacred,
shield, size, synergy, untyped.

### The hard part — conditional bonuses

Bonuses like `+2 morale vs. fear`, `+1 vs. undead`, `+2 when flanking`, or `+4 dodge vs. one
designated target` **cannot fold into a scalar**. A character's AC is not a number; it is a function
of context.

So the output shape must carry both a base and its conditional adjustments:

```js
{
  base: 31,
  breakdown: [ /* +11 armor, +5 shield, +2 Dex, ... */ ],
  conditional: [
    { value: +3, type: 'sacred', condition: 'vs fear', source: 'Recitation' }
  ]
}
```

…and the roll tools gain a `context` argument:

```js
roll_check({ kind: 'Will save', dc: 22, context: ['fear'] })
```

This fits the existing boundary cleanly: **the model supplies the context** (judgment), **the code
computes the number** (arithmetic).

### Proposed design

**Schema change — base + modifiers, totals derived:**

```json
{
  "abilities": { "str": { "base": 15 } },
  "ac_components": { "armor": 8, "shield": 5, "natural": 2, "deflection": 2 },
  "base_attack": 17,
  "modifiers": [
    { "target": "ac",          "type": "morale",      "value": 3, "source": "Recitation" },
    { "target": "ac",          "type": "sacred",      "value": 3, "source": "Recitation" },
    { "target": "save.will",   "type": "resistance",  "value": 6, "source": "Superior Resistance" },
    { "target": "attack.melee","type": "enhancement", "value": 3, "source": "Keen Longsword +3" }
  ]
}
```

Totals become **derived and never stored**, which *strengthens* the no-duplication invariant rather
than fighting it.

**Conditions carry their own modifiers.** `apply_condition` should accept a modifier list so a buff
registers itself and its expiry removes the modifiers automatically — reusing the existing
round-based expiry machinery:

```js
apply_condition({
  target: 'thiago', name: 'Recitation', duration_rounds: 10,
  modifiers: [
    { target: 'attack.melee', type: 'sacred', value: 3 },
    { target: 'ac',           type: 'sacred', value: 3 },
    { target: 'save.all',     type: 'sacred', value: 3 }
  ]
})
```

**New tool:** `resolve_stats({ entity_id, context: [] })` returning base, breakdown, and conditional
adjustments for every statistic or a named one.

**Additive migration path.** `resolve_stats` computes totals when a sheet carries `modifiers`, and
falls back to the stored flat numbers otherwise. Existing sheets and the legacy campaign keep
working untouched; new campaigns get the stronger model.

### Effort

| Piece | Effort |
|---|---|
| Bonus-type registry + `stack()` | Trivial (hours) |
| Ability → modifier → derived chain | Small |
| AC component model + size tables | Small–medium |
| Conditional / context system | **Medium — the interesting part** |
| `resolve_stats` + `context` on roll tools | Small |
| Sheet schema change + backfill | Small–medium |

### Open questions

- Model **choice-based modifiers** (Power Attack, Combat Expertise, fighting defensively) as
  on-demand modifiers rather than persistent ones?
- How to represent **max-Dex caps** from armor — a cap on the DEX component, not a bonus.
- Should `get_state` show computed or stored totals for named buffs?
- Do we backfill `seventh_moon`'s sheets, or leave them flat and let new campaigns use the engine?

---

## FI-3 — Monster corpus re-extraction

**Priority P1 (correctness) · Effort ~1 day · Status `IDEA`**

### The problem

**All 975 files in `compendium/monsters/` are stubs with no stat block.** Measured directly:

| Corpus | Files | Substantive |
|---|---|---|
| `rules/` | 187 | 170 (91%) |
| `compendium/spells/` | 4,617 | 4,064 (88%) |
| `compendium/classes/` | 11 | 11 (100%) |
| **`compendium/monsters/`** | **975** | **0** |

Every file follows this shape:

```markdown
# GHOUL
*(Undead (—) — MMI)*

## Stats
| **Size/Type** | Medium Undead (—) |
| **Challenge Rating** | 01 |
| **Source** | MMI |

## Description
The GHOUL is a creature from the MMI sourcebook.
```

No ability scores, no AC, no hit points, no attacks, no special abilities.

### Why it matters

`get_monster` works correctly — it finds the file and returns its contents. The contents simply
contain nothing playable. **The DM cannot stat an encounter from the corpus**, and would have to fall
back on its own recollection of exact 3.5e values, which is unreliable for numbers.

Unlike everything else on this list, this one makes existing functionality *wrong* rather than
merely limited. It is an **ingestion bug, not a code bug** — the extraction step captured the header
and source but dropped the stat block. Fixing it requires no plugin changes.

**Caveat:** it depends on access to the original sourcebooks, so it may be blocked in practice even
though it is conceptually simple.

### Approach

- Re-run extraction against the original sourcebooks, capturing the stat block section.
- Normalise into the existing `## Stats` table: ability scores, AC (touch/flat-footed), HP, saves,
  BAB/grapple, attack and full attack, special attacks/qualities, feats, skills, organisation, CR.
- Keep `get_monster` unchanged — it already returns file contents verbatim.
- Partial credit: even a structured `**AC**`/`**HP**`/`**Attacks**` block would make encounters
  runnable via `add_combatant`.

### Open question

Should monsters be emitted as **markdown stat blocks** (human-readable, current convention) or as
**JSON entity sheets** (directly loadable by `add_combatant`)? A hybrid — markdown for display, with
a parseable front-matter block — may serve both.

---

## FI-4 — Position and distance model

**Priority P2 · Effort ~1 day · Status `IDEA`**

`position` is currently a free-text field. No grid, no distance, no line-of-sight, no flanking
detection. All of it is narrated by the model.

A lightweight model — zones or relative ranges (`melee` / `near` / `far`) rather than a true grid —
would let `roll_attack` apply range penalties and detect flanking automatically. A full grid is
almost certainly over-engineering for a solo text game.

---

## FI-5 — Resource automation

**Priority P2 · Effort ~1 day · Status `IDEA`**

`resources` is a free-form object the model manages by hand — spell slots, Turn Undead uses, Action
Points, per-day abilities. Nothing validates or decrements it.

Worth adding: a typed resource record (`{ used, max, refresh: 'day' | 'encounter' | 'never' }`) and
a `use_resource` / `refresh` pair, so a long rest can restore everything on a `day` cadence in one
call.

---

## FI-6 — Progression automation

**Priority P3 · Effort ~half day · Status `IDEA`**

No XP tracking, no level-up workflow. `get_class` exists to read progression tables, but nothing
applies a level: no new HP roll, skill points, feat slots, or BAB/save increases.

---

## FI-7 — Content search in `search_reference`

**Priority P3 · Effort ~half day · Status `IDEA`**

`search_reference` matches **filenames only**. `lookup_rule` has a content-scan fallback, but the
cross-corpus search does not — so `search_reference('gaze attack')` finds nothing unless a filename
happens to contain it.

Fix: scan file contents with a cached index. 187 rules + 975 monsters + 4,617 spells is small enough
to hold tokenised content in memory (~few MB).

**Shares an engine with [FI-1](#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories)** — build one `grepText()` helper and
use it for both.

---

## FI-8 — Encumbrance

**Priority P3 · Effort ~2 hours · Status `IDEA`**

`equipment` is a list of strings with no weights. Carrying capacity is a simple STR-indexed table
(`rules/equipment/`), so this is mostly a data-entry problem: items need weights.

---

## FI-9 — Automatic turn-start state injection

**Priority P1 · Effort ~half day · Status `SPECCED` — channel identified, live spike still owed**

### The problem

`dd35-gameplay-loop` instructs the model to call `get_state` as step 1 of every turn. That works, but
it costs a **tool round-trip on every turn**: the model emits a call (~40 output tokens), waits for
the result (~300 input tokens), then re-reads the whole context for a second inference. The state
tokens are unavoidable; the extra inference is not.

### The mechanism — use the runtime-context channel, not `agent/pre-step`

> **Revised while shipping [FI-1](#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories).**
> The original design hand-rolled an `agent/pre-step` waterfall listener and flagged a `UserMessage[]`
> wrinkle as an open problem. Both are unnecessary: DSH already has a purpose-built channel, and the
> wrinkle has a structural answer.

`systemPrompt.context({ name, order, text })` registers a named, dynamic contribution. On each
request the loop renders those contributions and commits them as a **runtime-context snapshot** —
a `user` message carrying `source.kind === 'runtime-context'`, with `systemPrompt` owning the
projection (`RuntimeContextProjection`) that tracks and supersedes the retained snapshot. Joining is
done by `joinContextSections`, which prefixes the body with a supersede notice:

```
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
```

So the state block is placed **in the message history as a snapshot**, not in the system prompt at
byte 0, and not as a hand-rolled append to a step's messages. `includeRuntimeContext` (default
`true`) controls whether snapshots reach model history at all.

**What this buys over the original design:**

| | `agent/pre-step` + manual append | `systemPrompt.context()` |
|---|---|---|
| Fires per | step (must special-case `step === 1`) | request; superseding is handled by the projection |
| Needs a marker string to avoid being read as player input | yes | no — `source.kind === 'runtime-context'` is already distinct from `{kind: 'user'}` |
| Collides with FI-1's capture | yes | **no** — FI-1 keeps only `role === 'user' && source.kind === 'user'` |
| Ownership | the plugin | the system-prompt service, which already owns assembly and variables |

### The `MessageBase` question, answered

`MessageBase` does carry `source: MessageSource` — a merge-extensible sum type where real player input
is `{ kind: 'user' }` and every producer declares its own kind (`runtime-context`, `compaction`,
`goal`, `time-context`, and so on). Producers' user-role messages are therefore distinguishable
*structurally*, not by string marker.

This is already load-bearing: **FI-1's capture path filters on exactly this**, and the new test suite
proves an injected `runtime-context` message between the player's input and the DM's reply is not
recorded as player text. Whatever produces the state block, it will not corrupt turn memory.

### What it saves

| | Tool call (today) | Injection |
|---|---|---|
| Tool-call block (output) | ~40 tok | — |
| State block (input) | ~300 tok | ~300 tok |
| **Model inferences per turn** | **2** | **1** |

The state tokens are paid either way. The saving is the call block plus **one full model inference
per turn** — the expensive part on a long campaign.

### Conditions

- **Keep `get_state` as a tool.** The snapshot is turn-start state; after `apply_damage` or
  `next_turn` the model still needs a mid-turn refresh. Injection replaces the *routine* call, not
  the tool.
- **Drop step 1 from `dd35-gameplay-loop`** — otherwise the model calls `get_state` anyway and the
  state arrives twice.
- **Carry the memory summary here.** Per [FI-1](#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories),
  this block is where the turn-count / span / recent-scene reminder lives — so `get_state` needs no
  change at all.
- **Register the contribution from an agent-scoped plugin** so it exists only for `dd35` sessions.

### Verification spike (before building)

1. **Confirm the snapshot's surface position and growth.** Each superseding snapshot should append a
   new `user/message` and leave the prefix cached; confirm that a scene-boundary change does not cost
   a full prefix miss, and measure how many stale snapshots accumulate in a long session (the
   supersede notice exists so the model ignores them, but they still occupy history).
2. **Confirm the snapshot is not visible to FI-1's capture** as player input — expected to hold via
   `source.kind`, but worth asserting in the live runtime rather than only in the stand-in test.
3. **Decide whether state changes mid-turn.** If the block only refreshes at request assembly, a
   `next_turn` mid-combat is reflected on the next step's request; confirm that is soon enough, or add
   the explicit `get_state` call back into the encounter skill.

---

## Local inference — small ONNX models (FI-10 … FI-17)

Every judgement this preset makes is made by the main model, in prose, on the way to a reply. That is right for
judgement and wrong for the things that only need to be *classified, scored, or retrieved* — and the main model is
expensive at all three: it costs a full inference, it is inconsistent between turns, and its reasoning leaves no
trace in the record.

Small ONNX models invert that. Tens to low hundreds of milliseconds on CPU, no network, no API key, calibrated
numeric output, and deterministic for a given input. Cheap enough to run **every turn** and **in parallel** with
the model call — which is the property that makes them worth a section rather than a footnote.

The centrepiece is [Laya](https://github.com/receptron/laya), an open-source **System 1 decision model** in the
[Jev](https://typesafe.ai) family, runnable from Node/TypeScript on ONNX Runtime with no Python at runtime. It does
not generate text. You hand it a state and typed questions; it answers all of them in **one forward pass**:

| Primitive | Returns |
|---|---|
| `choice` | one option, with a calibrated probability per option |
| `score` | an expected level on an ordered rubric, with the distribution |
| `noul` | a calibrated P(true) for a yes/no statement |

`noul` is the one worth pausing on. `noul("does this turn leave something for the oracle to decide?")` is a way to
enforce the oracle discipline **in code** rather than in prose — the same discipline the persona prefix currently
asks for politely, and asks are ignorable.

Facts that shape every item below, measured rather than assumed — the [edgejev](https://pypi.org/project/edgejev/)
zoo and the [Laya Node package](https://github.com/receptron/laya):

| Fact | Value | Consequence |
|---|---|---|
| Laya latency, 4-core CPU, per decision | **15.6 ms** INT8 / 32 ms fp32 | runs every turn; latency is not the constraint |
| Three questions batched | 44.8 ms (≈140 ms warm, Apple silicon) | ask several at once, not one |
| Published ONNX bundle | `receptron/laya-onnx`, **1.61 GiB** fp32, public and ungated | **fetch it yourself** — see below |
| INT8 quantization | 324 MB, 15.6 ms | a one-time offline build step, not a runtime dependency |
| RAM loaded | ~2 GB fp32 / ~0.4 GB INT8 | load lazily, once, keep warm; quantization also buys RAM |
| State truncation | **512 tokens** (English checkpoint) | **cannot feed a whole turn** — feed a condensed state |
| Options per question | ≤192 tokens, <~20 options | fine for the decisions we want |
| Accuracy, INT8 | AG News 4-way 91.2%, emotion 6-way 48.2% | good enough to route, not to trust |
| Output | probabilities + confidence | auditable and recordable, unlike a prose judgement |

**Fetch the weights yourself; do not let the library do it.** `Laya.load()` will download the published fp32 bundle on
first use, but that is the wrong layer to own the decision. `Laya.load({ modelDir })` takes a local directory
instead, and the published files are plain, unauthenticated HTTPS:

```
https://huggingface.co/receptron/laya-onnx/resolve/<revision>/laya.onnx
https://huggingface.co/receptron/laya-onnx/resolve/<revision>/laya.onnx.data
https://huggingface.co/receptron/laya-onnx/resolve/<revision>/laya_config.json
https://huggingface.co/receptron/laya-onnx/resolve/<revision>/tokenizer/tokenizer.json
https://huggingface.co/receptron/laya-onnx/resolve/<revision>/tokenizer/tokenizer_config.json
```

The repo is public and ungated (`gated: false`), so no token is needed, and pinning `<revision>` to the commit SHA
(`68f27dfe…` at time of writing) gives a reproducible artifact rather than a moving `main`. Owning the fetch means
owning the cache path, the checksum, the progress reporting, and — most importantly — the failure mode.

**1.61 GiB is the published size, not a floor.** Two tiers:

| Tier | Size | Runtime needs | Build needs |
|---|---|---|---|
| **fp32, as published** | 1.61 GiB | `onnxruntime-node` only | nothing |
| **INT8, quantized once** | ~324 MB | `onnxruntime-node` only | Python once, offline |

`onnxruntime.quantization` is Python-only, so the INT8 path is a **one-time offline build step** — quantize from the
published fp32 bundle, verify, then publish the result to your own repo or serve it locally. After that the runtime
is a plain HTTPS fetch plus `onnxruntime-node`, with no Python anywhere near the host. This is what
[edgejev](https://pypi.org/project/edgejev/) automates for the Python side, and it is worth copying rather than
reinventing.

Three findings from their bench worth inheriting, because each one is a day not spent rediscovering it:

- **Laya's readout head survives quantization well** (LayerNorm → Linear → GELU → Linear absorbs the noise): about
  3–4 points on AG News, and emotion actually *improves* in one of their tables. Contrast `kev`, whose bare
  `PointerHead` loses 6 points on AG News and collapses emotion from 44% to 21% — the option count amplifies it.
- **Dynamic quantization is batch-dependent.** Activation scales are computed per runtime tensor, so padding
  changes them: the same input alone versus in a batch differed by up to 2.43 logits (fp32 ONNX: 0.000). A service
  that batches must use a fixed batch of 1 or stay fp32.
- **Do not bother with the other two variants.** `int8-static` collapses to random-level accuracy and runs ~4×
  slower; `QUInt8` is pointless on x86 because AVX512-VNNI only fast-paths *signed* int8. Both were tried and
  measured; both should stay unbuilt.

**The 512-token ceiling is the load-bearing constraint.** A turn transcript is several times that, so every decision
call needs a *condensed* state. The preset already produces exactly the right shape: `get_state`'s compact
projection (mode, clock, scene, present entities, party HP/AC/conditions) plus the player's message. That is the
state string, and it is already written.

### What this section is not

- **Not content moderation.** This profile deliberately permits every theme it names. A safety classifier in the
  path would either fire constantly or force the persona to argue with a number.
- **Not a replacement for the main model.** Nothing here narrates, adjudicates, or rules on anything.
- **Not authoritative.** A naturalness score of 0.4 is *evidence*, not a verdict. The DM may overrule it, and the
  overrule should be visible in the record.

---

## FI-10 — The ONNX inference substrate

**Priority P2 · Effort ~1–2 days · Status `IDEA`**

### The problem

Nothing in the harness can run a local model. `onnxruntime-node` is not a dependency anywhere in the DSH checkout,
the profile has no native dependencies at all, and there is no model cache under `$DSH_HOME` (only `profiles/`,
`sessions/`, `storages/`).

### The shape

A preset plugin `dd35-inference` that:

- **lazy-loads on first use and keeps warm** for the process lifetime — the load is the only non-parallel step here
- resolves weights from a local directory (`$DSH_HOME/models/<model>/<revision>/` by default, overridable), and
  passes that directory to `Laya.load({ modelDir })` rather than letting the library download
- **fetches the artifacts itself** over plain HTTPS from a pinned Hugging Face revision, verifying a checksum
  against a manifest committed in the repo — the manifest is small, the weights are not, and this keeps the pin
  reviewable in git without the bytes
- exposes `decide(state, questions)` and `embed(texts)` as **services, not tools** — the model should not be
  choosing whether to run a classifier, any more than it chooses whether to write a transcript
- records which models and revisions are loaded, so a turn record can cite them

### Placement and isolation

Per the composition rules, a preset plugin that supplies a service must isolate the provider and all its consumers
in the same realm. So `dd35-inference` provides; `dd35-decisions`, `dd35-style`, and `dd35-retrieval` consume; all
four share one `isolate` realm. Getting this wrong produces a second, empty service instance rather than an error.

### Quantization is a build step, not a runtime concern

The published bundle is fp32 at 1.61 GiB. Getting to ~324 MB means running `onnxruntime.quantization` once, offline,
in Python — then the artifact is static and the runtime never touches Python again. Two ways to hold the result:

| Option | Trade-off |
|---|---|
| Publish the INT8 bundle to your own HF repo (or a release asset) | one-time publish; every host fetches 324 MB |
| Quantize on the host, once, into the cache | no external dependency; needs Python available exactly once |

Either is fine; the first is better if more than one machine will run the preset. What must **not** happen is
quantizing lazily at startup on a cold cache — that turns a fast first run into a multi-minute one and hides the
dependency inside the plugin.

### Costs and risks

- `onnxruntime-node` is native with install scripts. `plugin_manager install_bundle` surfaces it in
  `pendingBuilds` and needs explicit approval — a supply-chain decision, not a formality.
- **The download is the cost, and it is ours to control.** fp32 is 1.61 GiB / ~2 GB RSS; INT8 is ~324 MB / ~0.4 GB
  RSS. Quantizing removes roughly 80% of both, so the "1.7 GB objection" is really a question of whether the
  one-time Python step gets done. On a memory-constrained host without that step, only the small encoders
  (FI-14/FI-15, tens of MB) are viable and Laya should be dropped — that combination still delivers most of the
  value.
- **Pin the revision to a commit SHA and pin the checksum.** An unpinned `main` makes a campaign's recorded
  decisions irreproducible, which defeats the point of recording them, and a checksum mismatch is the only signal
  that an upstream artifact was re-uploaded.
- **A cold cache must fail loudly and actionably.** The first run needs a clear "model not present, run
  `<command>` to fetch" rather than a network timeout inside a turn.

### Verification

Load; run all three primitives against a fixture; measure latency **on this host** rather than trusting published
numbers; confirm the model survives a plugin reload without leaking a second session; confirm a cold start with no
cache produces a clear, actionable error rather than a stack trace; confirm the checksum check actually rejects a
corrupted file.

---

## FI-11 — Typed decisions as a second oracle

**Priority P2 · Effort ~1 day · Status `IDEA`**

### The problem

Several decisions the preset makes are classifications wearing prose. `route_turn` picks a phase with an `if`.
`mode` is a field the model sets by writing to it, and nothing checks whether `encounter` was the right call. Mode
detection, "is this a rules question or a declared action?", "does this scene need the oracle?", "has this scene
stalled?" are all cheap typed questions currently either answered by the main model at full price or not asked.

### The questions worth asking

| Question | Primitive | Consumed by |
|---|---|---|
| Which mode is this scene in? | `choice` (encounter / exploration / downtime) | cross-check `state.mode`; surface disagreement |
| Is the player asking a rules question, declaring an action, or speaking out of character? | `choice` | routing — a rules question should hit `lookup_rule` before narration |
| Does this turn leave something for the oracle to decide? | `noul` | enforces the persona's oracle discipline |
| How hostile is this NPC right now? | `score` (0–4) | dialogue tone, feeding `roll_monster_behavior` |
| Has this scene stalled? | `score` | pacing; prompts the DM to escalate |

### Design rules

**Evidence, not authority.** A disagreement between classifier and model is worth surfacing — *"mode is
exploration, but this reads as an encounter"* — and the model still decides. Never let a `choice` write `mode`.

**Record provenance.** Store `{model, revision, answers, probabilities}` with the turn. It makes the decision
auditable, and it is the raw material for calibrating criteria against the campaign's own history later.

### Why the `noul` question pays for the rest

The persona prefix now instructs the DM to roll rather than invent. That is a prompt, and prompts decay. A
per-turn calibrated probability that this turn contains an open question — surfaced in the turn-start snapshot —
is not a prompt. It is a number the DM has to see. This is the clearest case in the whole backlog for a checker
that is not the model checking itself.

---

## FI-12 — Prose grading: LLMisms and naturalness

**Priority P2 · Effort ~half day · Status `IDEA`**

### The problem

The DM's voice drifts. Over a long campaign it slides toward the register language models default to:
*"Certainly"*, *"It's not just X, it's Y"*, the tricolon, the em-dash pileup, *"in the realm of"*, hedged stakes,
and the summary sentence that restates what just happened as though the reader had not been there. Nothing catches
this, because the model producing it is the one grading it. `grep_memories` catches *known strings*; it cannot
catch register.

### Two layers, cheapest first

1. **Deterministic pre-filter.** A regex list of known offenders over the DM's reply. Free, exact, no model, and
   `grep_memories` already ships the engine. **Build this first and alone** — most LLMisms are literal strings, and
   this layer may be sufficient.
2. **Classifier pass.** `noul` and `score` questions over the same text:
   - `noul` — "does this read as machine-written?"
   - `score` — naturalness on an ordered rubric
   - `noul` per banned habit — "does this paragraph end by restating itself?"
   - `score` — "does this register match the campaign's established voice?", graded against the campaign's own
     earlier turns, which is the register the player actually signed up for

Criteria are the whole game, and criteria are cheap to iterate: a few lines of config, not training.

**The grader also replaces the rewriter.** The accepted response to a failing score is to feed it into the *next*
generation as an instruction — *"last turn drifted formal; keep it visceral"* — rather than to rewrite the flagged
text. That closes [FI-13](#fi-13--constrained-rewriting), which is `DECLINED` for the reasons recorded there. It
costs nothing, carries no corruption risk, and addresses drift, which is a multi-turn phenomenon that a per-sentence
rewrite cannot see anyway.

### Delivery

The score rides in the **next turn's** runtime-context snapshot ([FI-9](#fi-9--automatic-turn-start-state-injection)),
never in the reply. Grading the reply and regenerating it inside the same turn costs a second full inference;
grading it for the next turn costs nothing, and drift is a multi-turn phenomenon anyway.

> **Do not read zoo accuracies as reliability.** AG News 91% is four-way news classification. Emotion in the same
> zoo runs 48–54% across six classes. Test any threshold against this campaign's own transcripts before trusting
> it, and prefer reporting a score over gating on one.

---

## FI-13 — Constrained rewriting

**Priority P3 · Effort ~1 day · Status `DECLINED` — the alternative below is preferred**

> **Decision (2026-10-02): not building this.** [FI-12](#fi-12--prose-grading-llmisms-and-naturalness) closes the same
> problem at lower cost by feeding the grade into the next generation instead of rewriting this one. The analysis
> is kept because it is the reason for the decision, and because the idea will resurface.

### The problem

When grading flags a passage, the obvious next move is to fix it automatically.

### Honest assessment

This is the item most likely to waste a day, and it should be last. Rewriting is *generation*, which is exactly
where small models are worst: a 0.3–0.5B rewriter will either fail to remove the LLMism or introduce new ones, and
a bad rewrite in the transcript is worse than a flagged original. There is also a correctness hazard unique to this
system — a rewrite can silently change a mechanic (*"the blade bites deep"* → *"the blade barely grazes"*) in a
campaign where the prose **is** the record of what happened.

### If it is built at all

- **Post-hoc and opt-in.** Never in the reply path.
- **Only prose that carries no mechanics.** A turn whose text contains damage numbers, DCs, or conditions is not
  eligible.
- **Never silent.** The transcript keeps the original; a rewrite is offered and replaces it only on acceptance.
- **Narrow edits only** — strip a banned phrase, split a run-on — with a T5-small-class model. Not open-ended
  improvement.

### The better alternative

Feed the grader's score into the *next* generation as an instruction: *"last turn drifted formal; keep it
visceral."* Zero corruption risk, no second model, and it addresses the actual failure mode, which is drift rather
than any single bad sentence. **Prefer this unless the grader's output proves it insufficient.**

---

## FI-14 — Semantic retrieval for concepts and style

**Priority P2 · Effort ~1–2 days · Status `IDEA`**

### The problem

Everything the preset retrieves today is **keyword** or **scene-title** retrieval. `grep_memories` matches strings.
`search_reference` is an index over the corpus. `list_memories` maps turn ranges to scene titles. None can answer a
*conceptual* query: "find the rules for fighting in the dark" requires the model to guess the words, and "show me
how this campaign has written grief" has no keyword at all.

The second problem is distinct: **style anchoring.** The persona describes a voice with adjectives. Adjectives are
weak control; demonstrations are strong control. There is currently nowhere to put a demonstration.

Both are embeddings.

### The model

A small sentence encoder — `all-MiniLM-L6-v2` class, 22M parameters, 384 dimensions, tens of MB quantized. Note
this is **roughly two orders of magnitude smaller than Laya** and the one piece of this section that survives a
memory-constrained host. Retrieval is brute-force cosine over a flat index: 5,600 files at 384 dims is a few MB of
float32, and an exact scan is microseconds. No vector database is warranted and adding one would be the kind of
premature infrastructure this backlog exists to avoid.

### Two indexes, two jobs

| Index | Contents | Serves |
|---|---|---|
| **Concepts** | `rules/` + `compendium/` chunked, embedded offline at build time | semantic search: "fighting in the dark", "what breaks a grapple", "social intrigue mechanics" |
| **Voice** | the campaign's own turns, embedded as they are written | style anchors: the nearest *exemplars* of the register the current scene needs |

The voice index is the more interesting half. The query is the current scene described in prose, and the result is
not a fact to state but a passage to sound like — style steering by demonstration. It also composes with FI-12:
grade against retrieved exemplars instead of against adjectives.

### Delivery and budget

Exemplars go in the **runtime-context snapshot** ([FI-9](#fi-9--automatic-turn-start-state-injection)) — a message,
not the system prompt, for the reasons already established there. Three passages of ~150 tokens is ~450 tokens per
request, which is real money in a long session, so retrieve **on trigger** (a scene change, or a failing FI-12
grade) rather than every turn.

### Integrity

The index is derived, so it is rebuildable — but rebuild it whenever the encoder changes. Record the encoder id and
revision alongside the vectors, because embeddings from two different models are not comparable and a silent
mismatch produces confident nonsense rather than an error.

---

## FI-15 — Cross-encoder reranking

**Priority P3 · Effort ~half day · Status `IDEA`**

### The problem

`grep_memories` and `search_reference` both rank by term frequency, recency, or index heuristics. Recall is fine;
precision is mediocre. The top of the list is where the model's attention goes, and it is often the wrong three
results.

### The shape

Keep existing retrieval as the **recall** stage, then rerank the top ~50 candidates with a cross-encoder
(`ms-marco-MiniLM-L-6-v2` class, ONNX, tens of MB) scoring each `(query, passage)` pair directly. Cross-encoders
are materially better at this than bi-encoders and remain cheap at fifty pairs.

### Why this is the best value in the section

It improves **two shipped tools without changing their interface**, adds no new concept for the DM to learn, and
needs no large model. If only one thing here gets built, pair this with FI-14: a small embedder plus a small
reranker, tens of MB total, one native dependency, no Laya, and a measurable precision win on tools that already
exist.

---

## FI-16 — Entity extraction and entity-linked memory

**Priority P2 · Effort ~1 day · Status `IDEA`**

### The problem

[FI-1](#fi-1--turn-memory-auto-capture--grep_memories--fetch_memories) indexes turns by **scene**. That is the
wrong axis for the question the DM asks most often, which is *"what do I know about Kenna?"* Scene titles cannot
answer it, and a keyword grep answers it badly — and only if the DM guesses the spelling.

### The shape

Run a small ONNX NER model over each completed turn at the same point FI-1 already captures it, extract persons,
places, and organisations, and record them in the memory index beside the turn.

That buys three things:

- `list_memories({ entity: "kenna" })` — every turn Kenna appears in, with scene ranges
- an automatic **dramatis personae** per campaign, which doubles as a continuity check: an NPC introduced once and
  never mentioned again is a loose thread worth picking up or deliberately retiring
- alias resolution feeding `grep_memories`, so "Kenna", "the wolves' sister" and "K." can be one entity

Cost is ~10–50 ms per turn, entirely off the critical path. Retrieval by entity is a lookup in a small JSON, not a
model call.

### The risk that must shape the design

**NER on fantasy prose is out of domain.** A generic model will tag "Thiago" as a person, "Mithraelis" as nothing,
and "the Rising Shadow" as an organisation. Treat the extractor as a **candidate generator**: record what it
proposes, let the DM confirm or drop, and never let an unconfirmed entity silently influence a retrieval result.

---

## FI-17 — Repetition and continuity detection

**Priority P3 · Effort ~half day · Status `IDEA`**

### The problem

Two failures that appear only in long campaigns and that the model structurally cannot see, because both are
properties of the whole history rather than of the turn in hand. The DM reuses its own imagery — the same held
breath, the same ridge, the same shrug — and it contradicts a fact it established thirty turns ago.

### The shape

Both are embedding comparisons over FI-14's voice index.

- **Repetition** — embed the new reply, find its nearest neighbours among recent turns, and above a similarity
  threshold surface it: *"this passage closely echoes turn 12."* The DM then decides whether the echo is a motif
  (fine, even good) or laziness.
- **Continuity** — embed the facts established per scene (FI-16's entities plus the scene's `micro_state`) and flag
  a turn that sits far from everything established: a cheap *"this came from nowhere"* detector.

### Why not just ask the model

The DM has no access to its own history at generation time. FI-1 gives it *retrieval* — it can look things up if it
suspects they exist. This gives it *awareness*, which is different: a model cannot search for a repetition it does
not suspect, and cannot check a contradiction it has forgotten making.

### Threshold discipline

A fixed cosine threshold will be wrong in both directions. Calibrate on the campaign's own turns, and **start by
recording the nearest neighbours in the turn record rather than interrupting the turn** — build the measurement,
read it, then decide whether it is worth acting on.

---

### Parallelism

The requirement that these be usable *in parallel* is satisfied almost for free, and it is worth being explicit
about why.

None of these items touches the reply path. They are 10–150 ms of CPU against a multi-second model inference, so
they can run concurrently with the model call and with each other:

```
turn/end
  ├── FI-1   capture transcript          ~1 ms    (already shipped)
  ├── FI-12  grade prose                 ~40 ms  ─┐
  ├── FI-16  extract entities            ~50 ms   │
  ├── FI-17  nearest-neighbour check     ~20 ms   ├─ Promise.all
  └── FI-14  embed turn into voice index ~15 ms  ─┘
        ↓ written to the index
next turn's runtime-context snapshot (FI-9) carries the findings
```

Three rules that make it safe:

1. **Nothing blocks the turn.** Run after the turn closes; results are ready for the *next* turn's snapshot.
   Grading a reply inside the turn that produced it buys a second model inference; grading it for the next turn
   buys nothing and costs nothing.
2. **One load, many queries.** Warm at plugin init or first use, never per turn. The 1.7 GB load is the only thing
   here that is not parallel-friendly, and it is paid once.
3. **ONNX Runtime owns its own threads.** Set `intraOpNumThreads` deliberately — the default contends with the
   agent loop on a small host. Four models each spawning their own pool is worse than one bounded session.

At these latencies, in-process is correct, and a subagent would be absurd: a subagent is another LLM call, three
orders of magnitude more expensive than the classifier it would be wrapping. Reserve `subagent`/`jobs` for work
that genuinely exceeds the turn budget.

### What not to add

- **Content moderation or safety filtering.** This profile's persona permits every theme it names, deliberately.
  A moderation classifier in the path would either fire constantly or force the persona to argue with a score.
  Explicitly out of scope.
- **A small model as the DM.** Nothing in this section generates prose. "Run the DM on a local 0.5B model" fails
  not on latency but on the writing, and the writing is the entire point of the profile.
- **Model weights in the repository.** 324 MB–1.7 GB. Cache under `$DSH_HOME/models`, checksum-pinned, outside the
  campaign tree and outside git.

---

## Notes

- The architecture these items extend is documented in
  [`dd35-preset-architecture.md`](dd35-preset-architecture.md) — design rationale and corpus
  measurements; the plugin's contract and usage live in
  [`plugins/dsh-dd35-preset/README.md`](../plugins/dsh-dd35-preset/README.md).
- **FI-1 and FI-2 are the stated priorities. FI-1 is done; FI-2 is next.** FI-2 is `SPECCED` and can
  be picked up directly; its open questions are the only decisions outstanding.
- **FI-9 is now the cheapest remaining P1** — it is coupled to FI-1 (the memory summary rides in its
  snapshot, which is why `get_state` needs no change), and shipping FI-1 confirmed the channel it
  should use. It is also the item that retires the per-turn `get_state` round-trip.
- ~~**FI-1 replaces an existing tool.**~~ **Done.** `log_turn` was removed from `state.js`
  (`dd35-state` 11 → 10 tools, preset 44 → 43). Because capture runs on `turn/end`, an existing
  campaign needs no migration: old transcripts parse fine, and a missing `memory_index.json` is
  rebuilt from them on first read.
- **Campaign prompt files shipped, and they partly pre-empt FI-9.** `prompt.js` now reads two optional
  per-campaign files on every request: `dm_persona.md` as a system-prompt section directly after the
  persona prefix, and `dm_notes.md` as a **runtime-context snapshot** — the same
  `systemPrompt.context()` channel [FI-9](#fi-9--automatic-turn-start-state-injection) specced, so its
  verification spike is worth reading before wiring live state through it. The notes block is not the
  state block FI-9 wants: it carries what the DM chose to write, not a projection of `state.json`, and
  nothing marks it with an "as of" turn. In the first campaign to use it the notes froze at *"Morning
  (Flashback: 3 Years Ago)"* while play continued at night, and because the block is re-injected as
  authoritative on every request it kept re-anchoring the DM to a scene it had already left. Treat an
  unversioned injected snapshot as a freshness problem, not a formatting one.
- **Turn capture now requires a client-minted `rpcId`.** Capture accepted any `role === 'user'` message
  with `source.kind === 'user'`, which is exactly what `dsh-context-pressure` steered its
  pre-compaction notice as. The notice lands between the player's message and the reply, so
  `captureFrom` walked back and found it first: the turn record ends up with
  `**Player:** Context is at 82% …`, and that turn's transcript is not the player's words at all. The
  notice now declares `kind: 'context-pressure'` — source kinds are merge-extensible and consumers
  fall through unknown ones (`dsh-llm/src/message.ts:103`); the thing that cannot be added is an event
  *type*, per the poisoned-log section of [`global-plugins.md`](global-plugins.md) — and capture
  requires the rpcId as a second line of defence. Logs written before the fix still need repair by
  hand; nothing rewrites history.
- **Branching a session truncates its history without saying so.** The `C7L - Flashback` rewind was
  not compaction — neither session logged a single compaction event. The session had been forked from
  its parent at turn 2 (`isSeeded: true`, an explicit `atSeq` at that turn's `turn/end`), so the five
  turns after it do not exist in the child's log at all, and the head of that log is the parent turn
  whose instruction was *"write the last two turns verbatim"*. The DM re-ran it, and its own leaked
  reasoning block restates that instruction as the player's current request. Any "resume
  mid-campaign" work has to give the model a signal that its history is a truncated prefix.
- **The roll tools were unified.** One `dice.js` engine now backs every roll in the preset.
  `roll_d20` was absorbed into `roll_dice`, which gained `modifier`, `dc`, `kind` and `note`; and
  `roll_save` + `roll_skill` + `roll_opposed` collapsed into a single `roll_check`, where `opponent`
  selects the opposed form. `roll_attack` is unchanged. `dd35-mechanics` 17 → 14 tools, and the preset
  registers 43 in total — this recount also shows the `log_turn` entry above ("preset 44 → 43") as
  stale, so treat module-local figures as the reliable ones. The persona's oracle table was corrected
  in the same pass: it sent saving throws, skill checks **and** attack rolls to `roll_dice`, which
  bypassed the two tools that apply their results to the sheets. `get_monster_ai` was renamed
  `roll_monster_behavior`, and the table gained rows for `roll_check` and `roll_attack`.
- **Dead weight, inventoried but deferred.** Collected while implementing the campaign prompt files and
  the roll unification; deliberately not mixed into that work. Four of the fifteen tables parsed out of
  [`tables.json`](../plugins/dsh-dd35-preset/tables.json) are read by no tool — `boon_table.csv`,
  `bane_table.csv`, `dc_difficulty.csv`, `gm_moves.csv`. `renderActiveState()` in
  [`state-store.js`](../plugins/dsh-dd35-preset/state-store.js) is exported and called from nowhere.
  And `search_reference` matches file *names* only, which the built-in `grep` strictly dominates for
  content search — that one is [FI-7](#fi-7--content-search-in-search_reference) seen from the other
  side, so fixing it is already on this list. (`state.houserules` was vestigial too and was removed
  with the notes work rather than deferred.)
- **A lesson worth keeping.** Two of this backlog's earlier decisions rested on a wrong premise about
  DSH internals — that `systemPrompt.context()` writes into the system prompt at byte 0, and that
  runtime context has no source kind. Both were corrected only by reading the harness source while
  implementing. Budget for that reading: for FI-9 it changed the design entirely, and cheaper to
  discover on paper than in code.
- **FI-3 is a correctness item, not an enhancement.** It is the only entry that makes existing
  functionality *wrong* rather than merely limited, but it depends on sourcebook access, so it may
  stay blocked while FI-2 and FI-9 proceed.
- **Part II has one gate and one clear first move.** Every local-inference item depends on
  [FI-10](#fi-10--the-onnx-inference-substrate), and FI-10's cost is dominated by a 1.7 GB Laya
  download plus ~2 GB RSS — a decision to make deliberately, not by default. The cheapest entry that
  needs none of that is **FI-14 + FI-15**: a small embedder and a small cross-encoder, tens of MB
  together, improving two shipped retrieval tools. If the host is memory-constrained, that pair *is*
  Part II, and FI-11/FI-13/FI-17 wait.
- **FI-11 and the oracle discipline are the same idea twice.** The persona prefix now asks the DM to
  roll rather than invent. FI-11's `noul` question is the enforcement mechanism for that ask. They are
  worth reading together — the prompt states the norm, the classifier makes it visible per turn.
- **FI-16 is arguably a Part I item wearing a Part II costume.** Entity-linked memory is a memory
  concern that happens to use a model. If NER proves unreliable on fantasy prose, the fallback is a
  cheaper one: maintain an entity list from `update_scene`'s `entities` field and index turns by it,
  with no model at all. Worth trying that first, because it is a fraction of the work.
- **Nothing in Part II should become a tool the model calls.** These are services the preset consults
  at turn boundaries. Exposing a classifier as a tool invites the DM to ask itself questions it has
  already answered, and adds a round-trip to something measured in milliseconds.
