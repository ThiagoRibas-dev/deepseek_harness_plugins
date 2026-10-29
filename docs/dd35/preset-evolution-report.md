# D&D 3.5e Solo DM Preset Evolution: Comparative Analysis, Architectural Recommendations & State Matrix

## 1. Executive Summary & Core Architectural Invariants

This document establishes the architectural baseline, comparative evaluation, and phased evolution plan for [`plugins/dsh-dd35-preset`](plugins/dsh-dd35-preset/). It synthesizes design patterns from three reference repositories:
- [`open-tabletop-gm`](tmp/ttrpg-ref/open-tabletop-gm/README.md)
- [`NarrativeEngine-P`](tmp/ttrpg-ref/NarrativeEngine-P/ARCHITECTURE.md)
- [`claude-dnd-skill`](tmp/ttrpg-ref/claude-dnd-skill/README.md)

All recommended evolutions adhere strictly to the following harness invariants:

1. **Subtractive Zero-Inference Architecture**: All game mechanics, PRNG dice rolls, tension calculations, relationship extractions, and diagnostic checks run deterministically in Node.js / SQLite. Zero secondary LLM calls, background autonomous agents, or embedding model calls occur on the live player turn path.
2. **Mid-Turn State Immutability**: Context snapshots injected into the model remain frozen during a turn. Dynamic context providers use `createTurnFrozenContext` keyed to `state.last_turn.number`. Mutations commit strictly at turn and scene boundaries (`agent/turn-stopping` and `session/event` with `turn/end`).
3. **Wire Payload Safety**: All tool responses traversing the Cordis RPC bridge are constrained by `capToolOutput(payload, 16384)` with safe boundary truncation markers to prevent Meridian HTTP 409 `MERIDIAN_PENDING_REPLAYABLE` transport timeouts.
4. **Strict Prompt Budgeting & Staggered Branching**: The resting system prompt prefix is preserved at ~2,300 tokens. Detailed mechanics, spell rules, and chapter guidance are accessed on-demand through tools (`dd35-mechanics`, `dd35-reference`) or modular files rather than living in the static prompt prefix.
5. **Memory Scoping & Prefork Protection**: Episodic memories are isolated by `session:<id>`. The turn recording hook inspects `session.inheritedEventCount` so forked sessions do not re-ingest and duplicate parent timeline history.

---

## 2. Comparative Analysis of Reference Repositories

### 2.1 open-tabletop-gm

[`open-tabletop-gm`](tmp/ttrpg-ref/open-tabletop-gm/README.md) is a model-agnostic tabletop framework designed for local engines and cloud endpoints without vendor-specific extensions.

- **Script-First Rule ([SKILL.md:118](tmp/ttrpg-ref/open-tabletop-gm/SKILL.md#L118))**: All dice rolls, HP calculations, combat initiative lists, and calendar advances run via standalone deterministic scripts. The LLM acts purely as narrator and arbiter on calculated data.
- **Narrative Craft & Discipline ([SKILL.md:9-75](tmp/ttrpg-ref/open-tabletop-gm/SKILL.md#L9-L75))**:
  - *Pure Table Prose*: Prohibits markdown headings (`#`, `##`, `###`) and bullet points within narrative fiction to preserve immersion.
  - *Sensory Economy*: Constrains room and scene descriptions to 2–3 sharp sensory details.
  - *Commitment to Specifics*: Prohibits vague phrasing; requires named NPCs, concrete locations, and observable actions.
  - *Re-engagement Toolkit*: When momentum slows, introduces an immediate concrete hook: an urgent NPC arrival, a visible faction move, a surfacing backstory hook, or an escalated consequence.
- **Table Dials ([SKILL.md:78-86](tmp/ttrpg-ref/open-tabletop-gm/SKILL.md#L78-L86))**: Non-mechanical session-level tuning flags:
  - `difficulty`: `easy` | `standard` (default) | `hard` | `deadly`.
  - `spotlight`: `dm_led` | `balanced` (default) | `player_led`.
  - `pacing`: `adventure` | `mixed` (default) | `downtime`.
- **Deterministic Relationship Graph ([scripts/gm_graph.py](tmp/ttrpg-ref/open-tabletop-gm/scripts/gm_graph.py))**:
  - Typed-edge graph (`loyal_to`, `opposes`, `allied_with`, `knows_about`) with temporal validity (`since_session`, `until_session`).
  - Extracted without LLM inference using verb tables ([scripts/graph_extract_deterministic.py](tmp/ttrpg-ref/open-tabletop-gm/scripts/graph_extract_deterministic.py)).
  - Scene-context queries return only the active local subgraph.
- **Declarative Companion Display ([display/gm-display-app.py](tmp/ttrpg-ref/open-tabletop-gm/display/gm-display-app.py))**:
  - Flask web app powered by a declarative `ui.json` manifest specifying system-specific stat blocks and meters.

### 2.2 NarrativeEngine-P

[`NarrativeEngine-P`](tmp/ttrpg-ref/NarrativeEngine-P/ARCHITECTURE.md) is a TypeScript engine emphasizing deterministic turn pipelines, decaying-DC tension loops, and schema-bounded entity tracking.

- **Mid-Turn State Immutability ([ARCHITECTURE.md:603-660](tmp/ttrpg-ref/NarrativeEngine-P/ARCHITECTURE.md#L603-L660))**:
  - Turn execution runs across a 9-stage pipeline.
  - Context assembly reads from an immutable snapshot. State mutations commit strictly via `commitPendingTurn()` upon turn settlement.
- **Deterministic Decaying-DC Tension Engine ([packages/engine/src/rolls/engineRolls.ts:75-155](tmp/ttrpg-ref/NarrativeEngine-P/packages/engine/src/rolls/engineRolls.ts#L75-L155))**:
  - Eliminates LLM pacing drift by evaluating three independent PRNG checks every turn:
    1. *Tier 1 Ambient Surprise*: d100 vs DC (initial 95, decay -3/turn, floor 5). Output: `\n[SURPRISE EVENT: <type> (<tone>)]`. Resets to 95.
    2. *Tier 2 Tactical Encounter*: d200 vs DC (initial 198, decay -2/turn, floor 5). Output: `\n[ENCOUNTER EVENT: <type> (<tone>)]`. Resets to 198.
    3. *Tier 3 World Event*: d500 vs DC (initial 498, decay -2/turn, floor 5). Output: `\n[WORLD_EVENT: <who> <what> <why> <where>]`. Resets to 498.
  - Governed by discrete taxonomies (10 types × 8 tones for Ambient; 10 types × 8 tones for Tactical; 10×10×10×10 slots for World).
- **NPC Signature Kits & Gate 1 Validation ([src/services/npc/signatureKit.ts](tmp/ttrpg-ref/NarrativeEngine-P/src/services/npc/signatureKit.ts))**:
  - Enforces schema bounds on NPC equipment (≤ 4 items in prompt serializations, max 48 characters each) and abilities (≤ 8 items).
  - Gate 1 admission diagnostics drop unvetted inventory mutations, preventing hallucinated equipment inflation.

### 2.3 claude-dnd-skill

[`claude-dnd-skill`](tmp/ttrpg-ref/claude-dnd-skill/README.md) is a campaign management framework for Claude Code with persistent markdown storage and procedural chapter routing.

- **Six-Beat Three-Act Narrative Arc ([README.md:220-255](tmp/ttrpg-ref/claude-dnd-skill/README.md#L220-L255))**:
  - Act 1 (Setup): Beat 1 Inciting Incident, Beat 2 Complication.
  - Act 2 (Confrontation): Beat 3 Midpoint Shift, Beat 4 All Is Lost.
  - Act 3 (Resolution): Beat 5 Final Confrontation, Beat 6 Resolution.
  - *Beats as Consequences, Not Events*: Beats dictate what narrative milestone must land, not the specific physical scene.
  - Pre-emption handling provides defined landing paths (`cost_path`, `secondary_consequence`, `deferred`) when a player bypasses a telegraphed beat.
- **Prompt Budget & Compaction Resilience**:
  - Resting system prompt kept at ~2,300 tokens. Detailed procedures reside in branch files (`SKILL-commands.md`, `SKILL-scripts.md`), read on demand.
  - Live State Flags stored in `state.md` preserve crucial volatile flags (active disguises, immediate hazards, faction stances) across compaction boundaries.
- **Scene-Boundary Micro-Saves**:
  - Silent serialization of state and timeline progression at scene boundaries and rest checkpoints.
- **Dual Ruleset Delta Architecture**:
  - Core mechanics remain invariant while delta tables support switching between mechanical variants (e.g. 2014 vs. 2024 D&D).

### 2.4 Cross-Repository Matrix

| Dimension | `open-tabletop-gm` | `NarrativeEngine-P` | `claude-dnd-skill` | Target for `dsh-dd35-preset` |
|---|---|---|---|---|
| **Mechanical Runtime** | Python scripts (CLI) | TypeScript engine package | Python scripts + Bash tools | Pure deterministic Node.js / SQLite |
| **Live Turn Inference** | Zero | Zero on engine rolls | Zero on engine tools | **Zero (strictly offline)** |
| **Tension & Pacing** | Manual GM re-engagement + table dials | 3-tier decaying-DC loops (`rollEngines`) | 6-beat 3-act narrative arc tracker | **Decaying-DC loops + 6-beat arc tracking** |
| **Entity Drift Control** | Entity markdown files | NPCSignatureKit schema bounds (≤ 4 items) | `npcs.md` + Live State Flags | **Signature kit bounds + Gate 1 diagnostics** |
| **Scene Graph & Scope** | SVO deterministic verb parser | Vector search + archive IDF | Live State Flags + relationship graph | **Witness vs. mentioned actor boundaries** |
| **Wire Payload Limits** | Terminal output slicing | Output token limits | Script stdout limits | **`capToolOutput(16384)` with safe truncation** |
| **Companion UI** | Flask web app + `ui.json` | React/Zustand client | None (CLI text) | **Declarative `ui.json` sidebar manifest** |

---

## 3. Architectural Recommendations for `plugins/dsh-dd35-preset`

The following recommendations (REC-1 through REC-12) adapt these patterns to Cordis and DeepSeek Harness:

### REC-1: Deterministic Decaying-DC Tension Engine
- **Files**: [`plugins/dsh-dd35-preset/tables.json`](plugins/dsh-dd35-preset/tables.json), [`plugins/dsh-dd35-preset/oracle-core.js`](plugins/dsh-dd35-preset/oracle-core.js), [`plugins/dsh-dd35-preset/tension.js`](plugins/dsh-dd35-preset/tension.js).
- **Implementation**:
  - Populate `tables.json` with the `ambient_surprise`, `tactical_encounter`, and `world_event` vocabularies.
  - Implement `evaluateTensionTick(state, seed)` in `oracle-core.js`. Uses PRNG seeded by `state.last_turn.number` or provided seed.
  - Decrements DCs on failure (Surprise: 95/-3, Encounter: 198/-2, World: 498/-2; floor 5); resets DC on trigger.
  - Persist the three DCs and the pending event in campaign state.
- **Status**: shipped. Wording, the delivery decision, and the measured rates follow.

#### Shipped shape

Each vocabulary is 10 rows of four content columns, in the coherent-row style the other generator tables use: the whole row is drawn together because the cells describe one situation.

| Table | Columns | Drawn by |
|---|---|---|
| `ambient_surprise.csv` | Stimulus, Detail, Complication, Opportunity | d100 vs a DC of 95, −3/turn |
| `tactical_encounter.csv` | Encounter, Terrain, Motive, Twist | d200 vs a DC of 198, −2/turn |
| `world_event.csv` | Event, Scope, Consequence | d500 vs a DC of 498, −2/turn |

`evaluateTensionTick(state, seed)` is pure: same state and seed, same result. It returns `{ tiers, event }` where `tiers` holds each tier's next DC, die, roll, the DC that roll was compared against (`dc_at_roll`), and `triggered`; `event` is null on a quiet turn. When more than one tier fires on the same tick, `TENSION_PRIORITY` decides which one is delivered — world, then tactical, then ambient.

Measured over 400 seeded turns, with a firing resetting its own tier:

| Tier | Fires | Mean gap |
|---|---:|---:|
| Ambient | 67 | 5.9 turns |
| Tactical | 36 | 11.0 turns |
| World | 20 | 20.0 turns |

#### Delivery: roll at the boundary, render for one turn

The tick runs in the `agent/turn-stopping` handler in [`tension.js`](plugins/dsh-dd35-preset/tension.js), which fires before the turn is committed. It reads the state as the turn ended, evaluates, and writes back:

```json
"tension": {
  "tiers": { "ambient": { "dc": 95, "die": 100, "roll": 97, "dc_at_roll": 92, "triggered": true }, "...": {} },
  "pending": { "tier": "ambient", "tag": "[SURPRISE EVENT]", "line": "...", "after_turn": 7 }
}
```

`pending` carries the turn it was rolled *after*. The runtime-context snapshot renders only when `state.last_turn.number === pending.after_turn + 1`, so the event appears for exactly the turn that follows and cannot replay.

The alternative — evaluating inside the frozen projection — was rejected. The DCs decay by "turns since this tier last fired", which is history. A pure renderer would have to reconstruct that history, or decay from the turn number alone, which would reset the pressure on every restart. Writing at the boundary costs one turn of latency and keeps the state durable.

The event is delivered through [`createTurnFrozenContext`](plugins/dsh-dd35-preset/context-freeze.js) for the same reason the scene snapshot is: `update_scene` and `apply_damage` rewrite `state.json` between a tool call and its result, and a context that re-renders per step appends a fresh user message in that window.

Two guards keep the tick away from campaigns that should not have one. A campaign with no captured turn is never rolled — a `setup`-phase campaign has no scene for an event to interrupt. And the whole handler is wrapped: a malformed `state.json` logs a warning rather than raising into the harness's turn-stopping path.

### REC-2: NPC Signature Kits & Gate 1 Diagnostic Bounds
- **Files**: [`plugins/dsh-dd35-preset/doctor.js`](plugins/dsh-dd35-preset/doctor.js), [`plugins/dsh-dd35-preset/context-index.js`](plugins/dsh-dd35-preset/context-index.js).
- **Implementation**:
  - Bound NPC signature equipment to ≤ 4 items, max 48 characters each, in prompt context serializations.
  - Add Gate 1 diagnostic rules in `doctor.js` flagging entity equipment inflation or unregistered stat modifications.

### REC-3: Witness vs. Mentioned Actor Boundaries & Scene Hysteresis
- **Files**: [`plugins/dsh-dd35-preset/context-index.js`](plugins/dsh-dd35-preset/context-index.js).
- **Implementation**:
  - Partition extracted actors into `witnesses` (physically present in the active scene) and `mentioned_actors` (referenced in dialogue or narration).
  - Apply scene detection hysteresis (`_SCENE_INCUMBENT_BONUS = 2`, `_SCENE_SWITCH_MARGIN = 3`) to prevent fluctuating scene assignments from passing dialogue keywords.

### REC-4: DM Narrative Craft Directives & Prompt Overhaul
- **Files**: [`plugins/dsh-dd35-preset/cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml), [`plugins/dsh-dd35-preset/prompt.js`](plugins/dsh-dd35-preset/prompt.js).
- **Implementation**:
  - Prune 68 lines of static BAB/Save progression tables from `persona.prefix` in `cordis.patch.yml`.
  - Inject explicit narrative craft constraints:
    1. Pure table prose (no `#`/`##` headings or bullet lists in narrative fiction).
    2. Sensory economy (limit descriptions to 2–3 sharp sensory details).
    3. Strict player sovereignty (never narrate player actions, emotions, or dialogue).
    4. Transition bangs (end scenes on clear prompts or immediate complications).

### REC-5: 6-Beat Dynamic Arc Tracking with Pre-emption Landing Paths
- **Files**: [`plugins/dsh-dd35-preset/state-store.js`](plugins/dsh-dd35-preset/state-store.js), [`plugins/dsh-dd35-preset/state.js`](plugins/dsh-dd35-preset/state.js).
- **Implementation**:
  - Add narrative arc state tracking the current beat (1 through 6) and act (1 through 3).
  - Support pre-emption landing paths (`cost_path`, `secondary_consequence`, `deferred`) when players bypass telegraphed plot beats.

### REC-6: Non-Mechanical Table Dials
- **Files**: [`plugins/dsh-dd35-preset/state.js`](plugins/dsh-dd35-preset/state.js), [`plugins/dsh-dd35-preset/prompt.js`](plugins/dsh-dd35-preset/prompt.js).
- **Implementation**:
  - Track `state.dials = { difficulty: 'standard', spotlight: 'balanced', pacing: 'mixed', scope: 'regional' }`.
  - Canonical values: `difficulty` `casual` | `standard` | `gritty`; `spotlight` `focused` | `ensemble`; `pacing` `deliberate` | `brisk`; `scope` `local` | `regional` | `national` | `planar` | `continental`. The upstream `open-tabletop-gm` values quoted in §2 (`easy`/`hard`/`deadly`, `dm_led`/`player_led`, `adventure`/`downtime`) are the source vocabulary, not the preset's.
  - Inject dial settings into `dd35:dm-notes` or runtime context so the model modulates tone and consequence severity accordingly.
  - **`scope`** sets the campaign's intended dramatic and political scale, and is the counterpart to party level: `local` for district or village affairs, `regional` for a march or city-state, `national` for a realm, `planar` for other planes and high-tier faction play, `continental` for world-spanning threats. It is context the DM reads, not a validator — the Arbiter role keeps the authority to place any encounter anywhere. Its purpose is to prevent a level-15+ premise from being restated as routine local errands, and to give the DM one stated answer to "how big is this story" across sessions.
  - `scope` is set once at campaign initialisation (the Session Zero confirmation step) and changed with the same tool that changes the other dials.

### REC-7: Scene-Boundary Micro-Saves
- **Files**: [`plugins/dsh-dd35-preset/context-freeze.js`](plugins/dsh-dd35-preset/context-freeze.js), [`plugins/dsh-dd35-preset/scene-state.js`](plugins/dsh-dd35-preset/scene-state.js).
- **Implementation**:
  - Detect scene boundary changes on turn completion.
  - Automatically checkpoint state and scene summaries to disk without requiring manual tool invocations.

### REC-8: Declarative Companion UI Manifest
- **Files**: [`plugins/dsh-dd35-preset/ui.json`](plugins/dsh-dd35-preset/ui.json).
- **Implementation**:
  - Create a declarative `ui.json` defining stat widgets, resource tracks (HP, spell slots), and condition badges for rendering in the DSH Web GUI sidebar.

### REC-9: Wire Payload Safety & Safe Truncation
- **Files**: [`plugins/dsh-dd35-preset/memory.js`](plugins/dsh-dd35-preset/memory.js), [`plugins/dsh-dd35-preset/context-index.js`](plugins/dsh-dd35-preset/context-index.js).
- **Implementation**:
  - Wrap all unbounded tool return payloads with `capToolOutput(payload, 16384)`.
  - Safe truncation at UTF-8 character boundaries with explicit marker: `\n[truncated: output exceeded 16KB wire safety limit]`.

### REC-10: Cordis Lifecycle Hook Hardening
- **Files**: [`plugins/dsh-dd35-preset/memory.js`](plugins/dsh-dd35-preset/memory.js), [`plugins/dsh-dd35-preset/state.js`](plugins/dsh-dd35-preset/state.js).
- **Implementation**:
  - Register `agent/turn-stopping` and `session/event` (`turn/end`) with explicit session guards.
  - Add turn-start tension evaluation tick so decaying DCs decrement automatically each turn.

### REC-11: Session-Scoped Memory Isolation & Fork Protection
- **Files**: [`plugins/dsh-dd35-preset/memory.js`](plugins/dsh-dd35-preset/memory.js), [`scratch_state.md`](scratch_state.md).
- **Implementation**:
  - Check `session.inheritedEventCount` in `agent/turn-stopping` to prevent duplicate turn capture on forked sessions.
  - Partition episodic memories by `session:<id>` with fallback to `global`.
  - Provide administrative `forget-session` and `re-ingest` actions.

### REC-12: Preset-Owned Session-Start Routing Contract

- **Files**: [`plugins/dsh-dd35-preset/cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml), [`plugins/dsh-dd35-preset/state.js`](plugins/dsh-dd35-preset/state.js), [`plugins/dsh-dd35-preset/tests/session-binding.test.mjs`](plugins/dsh-dd35-preset/tests/session-binding.test.mjs).
- **Origin**: a live campaign opened its first scene, at level 15, immediately after the character files were loaded. `route_turn` reported `gameplay` because a campaign was attached and the message was not the session's first; it has no way to say "this campaign has been built but never played". The phase table that would have caught it lived in the campaign workspace's `.agents/AGENTS.md`, not in the preset, so the tool that decides the phase and the table that explains it were in different repositories.
- **Implementation**:
  - Add a `setup` phase to `route_turn`, returned when a campaign is attached, `state.last_turn` is absent or null, and the scene status is not `active`. The test is `!state?.last_turn`, not `=== null`: `loadState` is a raw JSON read with no defaulting, so a hand-authored `state.json` may omit the key entirely. The scene-status guard keeps a campaign that agreed its framing from falling back into setup before its first turn lands.
  - Move the phase contract into the preset: the requirement to call `route_turn` in the persona prefix, the per-phase meaning in the tool description and hints, and the mode-skill hint in `set_mode`. The workspace `AGENTS.md` keeps folder- and machine-specific procedure only.
  - Skill names stay in hints as pointers, phrased action-first. The harness publishes each skill's `whenToUse` in the `<available_skills>` catalog, so a workspace that omits a skill simply does not list it.
- **Status**: implemented in [`state.js`](plugins/dsh-dd35-preset/state.js) and [`cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml); 235 preset tests pass. `cordis.patch.yml` changes take effect on the next harness restart.

#### Wording, as shipped

Prefix block, placed after `Solo-Oracle Discipline` and before `Available Toolsets`:

```
Turn Routing
Call `route_turn` on the first message of every session and follow the returned phase before generating narrative fiction:
- `setup`: The campaign has no recorded history. Do not invent an opening scene or assume the adventure is underway. Establish and agree on the starting framework with the player first — character level, scenario premise, initial location, and party composition. Only call `update_scene` and begin narration after the player confirms.
- `fresh_session`: Recap prior events and unresolved threads from memory logs before prompting for new action.
- `gameplay`: Continue the active scene under the current play mode.
```

Prefix text appended to role 1 (World Builder), after the secrecy sentence:

```
Naming Discipline: Avoid generic fantasy placeholders (such as Oakhaven, Blackwood, or Ironforge). For every new settlement, landmark, NPC, or faction, generate a setting-appropriate name using generate_place_name or generate_character_name. Commit generated names to state and memory, and maintain them consistently throughout the campaign.
```

```
Diegetic Information Boundaries: In-world dialogue, letters, and scout reports must reflect only what that specific character knows, suspects, or chooses to reveal — never objective truth, secret DM plots, or underlying villain motives. Keep true causes and unrevealed conspiracies strictly in dm_notes.md; let the player uncover them through investigation and gameplay.
```

Both directives sit inside role 1's paragraph rather than as separate sections, so they inherit the World Builder framing. Tool names appear bare there, matching the surrounding role text; the Turn Routing block uses backticks because it sits alongside the `Available Toolsets` lists, which quote tool names the same way.

`route_turn` description:

```js
'Determine the opening phase for the current turn. Evaluates session and campaign state to return one of five '
+ 'operational phases: "setup" (campaign attached but no turns played yet; establish the starting framework '
+ 'before opening a scene), "session_zero" (no campaign exists in this workspace yet), "choose_campaign" '
+ '(campaigns exist but none attached to this session; prompt the player to select or create one), '
+ '"fresh_session" (first message of a session with existing history; recap prior events first), or '
+ '"gameplay" (active turn loop in the current mode). Call this on the first message of every session.'
```

`route_turn` phase selection and hints:

```js
const unplayed = !state?.last_turn
const framed = state?.scene?.status === 'active'
const phase = unplayed && !framed ? 'setup' : (first_message ? 'fresh_session' : 'gameplay')
const hints = {
  setup: 'No turns have been played in this campaign yet. Settle the starting framework with the player '
    + 'first (character level, campaign premise, starting location, and party or cohort roster). Do not '
    + 'narrate the opening scene until the player confirms the setup. Once confirmed, initialize the '
    + 'environment with update_scene and set_mode. The `dd35-session-zero` skill covers the interview, '
    + 'the build, and the sheet fill-in.',
  fresh_session: 'Recap prior events and unresolved threads from memory logs (list_memories, then '
    + 'fetch_memories for the turns you need) before prompting for new action. The `dd35-fresh-session` '
    + 'skill carries the full procedure.',
  gameplay: 'Continue the active scene under the current play mode. The `dd35-gameplay-loop` skill '
    + 'carries the loop; get_state resyncs you first.',
}
```

`set_mode` return, adding the field the workspace mode table used to supply:

```js
const hint = `Entered ${mode} mode. Follow ${mode} procedures and action economy as defined in`
  + ` the \`dd35-${mode}-mode\` skill.`
return { campaign: id, mode, constraints: MODE_CONSTRAINTS[mode], hint }
```

Names inside hints are pointers. The harness publishes each skill's `whenToUse` in the `<available_skills>` catalog, so a workspace that omits a skill simply does not list it.

#### Cost

| Item | Bytes | ~Tokens |
|---|---|---|
| Turn Routing block | 654 | 145 |
| Naming Discipline | 341 | 76 |
| Diegetic Information Boundaries | 372 | 83 |
| **Total** | **1,367** | **304** |

Measured against the prefix as it stood: 6,294 bytes / ~1,574 tokens becomes 7,664 bytes / ~1,916 tokens. That stays under the ~2,300-token ceiling in §1 invariant 4. The ~1,570-token figure earlier in this document predates the `Turn Routing`, naming, and boundary directives and no longer describes the prefix.

#### Test impact

- [`session-binding.test.mjs:405`](plugins/dsh-dd35-preset/tests/session-binding.test.mjs#L405) asserted a freshly created campaign routes to `fresh_session`. `create_campaign` writes `defaultState`, whose `last_turn` is `null`, so that assertion became `setup`. Every other `route_turn` fixture sets `last_turn: { number: 143 }` and is unaffected.
- New cases: a campaign with no `last_turn` and an `inactive` scene returns `setup`; a `state.json` that omits the `last_turn` key also returns `setup`; a campaign whose scene is already `active` returns `fresh_session` rather than `setup`, because an active scene means the framing was already agreed; the same campaign after one captured turn returns `fresh_session` then `gameplay`; `set_mode` returns a hint naming the mode skill.
- `set_mode` had no test before this change.

---

## 4. The Before vs. After State Matrix

The following table provides a complete comparative breakdown of `plugins/dsh-dd35-preset` before and after the proposed implementation:

| Component / Area | Current State (Before) | Proposed Implementation (After) | Architectural Rationale & Reference Origin | Affected Files & Hook Points |
|---|---|---|---|---|
| **1. Preset System Prompt** | Hardcodes ~68 lines of static d20 progression tables (BAB, saves, skill formulas) in `cordis.patch.yml`. Consumes ~800 tokens of static prompt budget every turn. | Prunes mechanical tables; delegates rules lookups to `dd35-mechanics` and `dd35-reference`. Injects concise DM craft directives: pure table prose, sensory economy, strict player sovereignty, and transition bangs. | Resting token preservation (~2,300 budget) from `claude-dnd-skill`; narrative discipline rules from `open-tabletop-gm`. | [`cordis.patch.yml:17-95`](plugins/dsh-dd35-preset/cordis.patch.yml#L17-L95), [`prompt.js:189-203`](plugins/dsh-dd35-preset/prompt.js#L189-L203) |
| **2. Dynamic Context Assembly** | Mounts `campaign/<id>/dm_persona.md` (order 100) and `dm_notes.md` (order 200). Relies on manual edits to `dm_notes.md` for DM continuity. | Retains `dm_persona.md` and `dm_notes.md` with turn-freeze protection. Adds structured sections for active Table Dials (`difficulty`, `spotlight`, `pacing`) and narrative arc beat objectives. | Context freeze pattern (§1.8) prevents prompt churn; dials adapt `open-tabletop-gm` table standards. | [`prompt.js:130-185`](plugins/dsh-dd35-preset/prompt.js#L130-L185), [`context-freeze.js`](plugins/dsh-dd35-preset/context-freeze.js) |
| **3. Lifecycle Hooks & Pipeline** | Hooks `agent/turn-stopping` (stash turn) and `session/event` `turn/end` (commit turn). No hook at turn initialization. | Adds turn-start hook (or pre-step tick) to evaluate tension loops and update decaying DCs. Hardens turn-stopping with `session.inheritedEventCount` guard. Adds scene-boundary micro-save trigger. | Zero-inference turn execution inspired by `NarrativeEngine-P` `commitPendingTurn` pipeline; prevents fork pollution. | [`memory.js:260-285`](plugins/dsh-dd35-preset/memory.js#L260-L285), [`scene-state.js`](plugins/dsh-dd35-preset/scene-state.js) |
| **4. Pacing & Tension Generation** | Purely manual. The model must proactively invoke `ask_oracle` or `consult_oracle`. In practice, turns pass without complication checks. | Automated 3-tier Decaying-DC Tension Engine (`evaluateTensionTick`): Ambient (d100 vs 95, -3/turn), Tactical (d200 vs 198, -2/turn), World (d500 vs 498, -2/turn). Triggers append structured tags: `[SURPRISE EVENT]`, `[ENCOUNTER EVENT]`, `[WORLD_EVENT]`. | Deterministic decaying-DC mechanics adapted from `NarrativeEngine-P` (`engineRolls.ts`). Ensures events occur without LLM intervention. | [`oracle-core.js`](plugins/dsh-dd35-preset/oracle-core.js), [`tables.json`](plugins/dsh-dd35-preset/tables.json), [`oracles.js`](plugins/dsh-dd35-preset/oracles.js) |
| **5. Wire Safety & RPC Limits** | Memory search and context indexing return raw JSON/text without size caps. High-volume queries risk exceeding RPC limits. | All tool responses and indexing payloads pass through `capToolOutput(payload, 16384)`. Truncates safely at UTF-8 boundaries with explicit truncation notice. | Mitigates Meridian HTTP 409 `MERIDIAN_PENDING_REPLAYABLE` timeouts caused by oversized payloads (`docs/lessons-learned.md` §3, §4.1). | [`memory.js`](plugins/dsh-dd35-preset/memory.js), [`context-index.js`](plugins/dsh-dd35-preset/context-index.js) |
| **6. Entity & NPC Drift Control** | Basic entity validation in `doctor.js`. NPCs can accumulate unconstrained inventory and ability lists across turns. | NPC signature kits strictly bounded to ≤ 4 items (max 48 chars each) in prompt context serializations. Gate 1 diagnostic rules in `doctor.js` reject unvetted gear mutations. | NPC signature kit schema bounds from `NarrativeEngine-P` (`signatureKit.ts`). Prevents inventory bloat across long campaigns. | [`doctor.js`](plugins/dsh-dd35-preset/doctor.js), [`context-index.js`](plugins/dsh-dd35-preset/context-index.js) |
| **7. Scene Context & Actor Tracking** | Flat entity extraction. All mentioned entities in a turn are indexed without distinguishing scene presence from conversation references. | Partitions actors into `witnesses` (physically present in scene) vs. `mentioned_actors`. Implements scene hysteresis (`_SCENE_INCUMBENT_BONUS = 2`, `_SCENE_SWITCH_MARGIN = 3`). | Prevents room bouncing and context dilution; adapted from `open-tabletop-gm` relationship graphs and `NarrativeEngine-P`. | [`context-index.js`](plugins/dsh-dd35-preset/context-index.js), [`scene-state.js`](plugins/dsh-dd35-preset/scene-state.js) |
| **8. Narrative Arc Progression** | Open-ended sandbox. Quests are tracked as text in notes without structural dramatic pacing. | 6-Beat 3-Act structural arc tracker in session state. Pre-emption landing paths (`cost_path`, `secondary_consequence`, `deferred`) handle player plot bypasses. | Narrative consequence discipline and dramatic pacing adapted from `claude-dnd-skill` 6-beat framework. | [`state-store.js`](plugins/dsh-dd35-preset/state-store.js), [`state.js`](plugins/dsh-dd35-preset/state.js) |
| **9. Session State & Table Dials** | State stores only current scene, combatants, turn order, HP, and conditions. | Adds `state.dials` (`difficulty`, `spotlight`, `pacing`, `scope`) and `state.tension` (active DCs). Exposes tuning tools or notes commands to adjust dials. | Non-mechanical campaign modulation from `open-tabletop-gm`; `scope` adds the power-tier counterpart to party level. | [`state-store.js`](plugins/dsh-dd35-preset/state-store.js), [`state.js`](plugins/dsh-dd35-preset/state.js) |
| **10. Memory Partitioning & Forks** | Single episodic namespace. Forked sessions capture historical turns from parent sessions, causing duplicate memory records. | Episodic memories partitioned into `session:<id>` with global fallback. `agent/turn-stopping` checks `session.inheritedEventCount` to ignore turns before the fork cut. | Session memory isolation and fork cut semantics from `scratch_state.md`. | [`memory.js`](plugins/dsh-dd35-preset/memory.js), [`memory-store.js`](plugins/dsh-dd35-preset/memory-store.js) |
| **11. Scene Micro-Saves** | State is persisted only when specific tools (`set_state`, `advance_turn`) are explicitly called. | Automated continuity micro-saves serialize state and timeline markers to disk whenever scene transitions settle. | Compaction resilience and session persistence from `claude-dnd-skill`. | [`context-freeze.js`](plugins/dsh-dd35-preset/context-freeze.js), [`scene-state.js`](plugins/dsh-dd35-preset/scene-state.js) |
| **12. Client Companion UI** | No companion UI manifest. Preset relies entirely on chat transcript for all game state display. | Declarative `ui.json` manifest specifying stat meters (HP, Spell Slots) and condition chips for the DSH Web GUI sidebar. | Secondary display architecture adapted from `open-tabletop-gm` `ui.json` and display app. | `plugins/dsh-dd35-preset/ui.json` (new) |

---

## 5. Phased Implementation Roadmap

### Phase 1: Mechanical Stability, Tension Loops & Wire Safety
- [x] Analyze reference repositories (`open-tabletop-gm`, `NarrativeEngine-P`, `claude-dnd-skill`).
- [x] Document comparative analysis, recommendations, and Before/After matrix.
- [x] Populate `ambient_surprise`, `tactical_encounter`, and `world_event` vocabularies in [`plugins/dsh-dd35-preset/tables.json`](plugins/dsh-dd35-preset/tables.json).
- [x] Implement `evaluateTensionTick(state, seed)` in [`plugins/dsh-dd35-preset/oracle-core.js`](plugins/dsh-dd35-preset/oracle-core.js), plus the [`tension.js`](plugins/dsh-dd35-preset/tension.js) row that rolls it at `agent/turn-stopping` and renders the result for the next turn.
- [ ] Implement `capToolOutput(payload, 16384)` with safe truncation in [`plugins/dsh-dd35-preset/memory.js`](plugins/dsh-dd35-preset/memory.js) and [`plugins/dsh-dd35-preset/context-index.js`](plugins/dsh-dd35-preset/context-index.js).
- [x] Add unit tests verifying decaying DCs, floor clamping, reset behavior, and tier priority in [`plugins/dsh-dd35-preset/tests/oracles.test.mjs`](plugins/dsh-dd35-preset/tests/oracles.test.mjs), and persistence plus delivery in [`plugins/dsh-dd35-preset/tests/tension.test.mjs`](plugins/dsh-dd35-preset/tests/tension.test.mjs).
- [ ] Add the `capToolOutput` cases to those test files once the helper exists.

### Phase 2: DM Craft Directives & Entity Drift Diagnostics
- [x] Prune static d20 tables from `persona.prefix` in [`plugins/dsh-dd35-preset/cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml).
- [ ] Inject condensed DM craft directives (pure table prose, sensory economy, player sovereignty, transition bangs) into [`plugins/dsh-dd35-preset/prompt.js`](plugins/dsh-dd35-preset/prompt.js).
- [x] **REC-12** — add the `setup` phase to `route_turn`, add the Turn Routing block to `persona.prefix`, add the mode hint to `set_mode`. Wording is recorded in §REC-12.
- [x] **REC-12** — append the naming directive and the diegetic boundary directive to role 1 of `persona.prefix`.
- [ ] **REC-12** — remove the phase and mode tables from the campaign workspace's `.agents/AGENTS.md`, leaving folder- and machine-specific procedure. That file lives outside this repository and needs elevated permissions.
- [ ] Implement NPC signature kit bounds (≤ 4 items in prompt serializations) and Gate 1 diagnostic rules in [`plugins/dsh-dd35-preset/doctor.js`](plugins/dsh-dd35-preset/doctor.js).
- [ ] Add unit tests in [`plugins/dsh-dd35-preset/tests/prompt.test.mjs`](plugins/dsh-dd35-preset/tests/prompt.test.mjs) and [`plugins/dsh-dd35-preset/tests/doctor.test.mjs`](plugins/dsh-dd35-preset/tests/doctor.test.mjs).
- [x] Add `route_turn` and `set_mode` cases to [`plugins/dsh-dd35-preset/tests/session-binding.test.mjs`](plugins/dsh-dd35-preset/tests/session-binding.test.mjs), and update the `create_campaign` assertion to expect `setup`.

### Phase 3: Pacing Dials, Witness Tracking & Companion UI
- [ ] Partition actors into `witnesses` vs. `mentioned_actors` with scene hysteresis in [`plugins/dsh-dd35-preset/context-index.js`](plugins/dsh-dd35-preset/context-index.js).
- [ ] Implement Table Dials (`difficulty`, `spotlight`, `pacing`, `scope`) and 6-beat arc tracking in [`plugins/dsh-dd35-preset/state-store.js`](plugins/dsh-dd35-preset/state-store.js) and [`plugins/dsh-dd35-preset/state.js`](plugins/dsh-dd35-preset/state.js).
- [ ] Implement scene-boundary micro-save serialization in [`plugins/dsh-dd35-preset/context-freeze.js`](plugins/dsh-dd35-preset/context-freeze.js).
- [ ] Author declarative `plugins/dsh-dd35-preset/ui.json` manifest.
- [ ] Add unit tests in [`plugins/dsh-dd35-preset/tests/context-index.test.mjs`](plugins/dsh-dd35-preset/tests/context-index.test.mjs) and [`plugins/dsh-dd35-preset/tests/scene-state.test.mjs`](plugins/dsh-dd35-preset/tests/scene-state.test.mjs).

### Phase 4: Memory Isolation & Fork Protection
- [ ] Implement per-session episodic namespace (`session:<id>`) in [`plugins/dsh-dd35-preset/memory.js`](plugins/dsh-dd35-preset/memory.js).
- [ ] Add `session.inheritedEventCount` prefork guard in `agent/turn-stopping`.
- [ ] Implement inheritance-at-fork handler on `agent/created`.
- [ ] Add administrative `forget-session` and `re-ingest` actions.
- [ ] Add unit tests in [`plugins/dsh-dd35-preset/tests/memory.test.mjs`](plugins/dsh-dd35-preset/tests/memory.test.mjs) validating fork cut behavior.

---

## 6. Verification & Test Plan

All changes are validated using the native Node.js test runner:
```bash
node --test plugins/dsh-dd35-preset/tests/*.test.mjs
```

Specific test verifications include:
1. `oracles.test.mjs`: Verify `evaluateTensionTick` decrements DCs by exact amounts (-3, -2, -2), clamps at floor 5, resets on roll >= DC, and returns deterministic results for fixed seeds.
2. `memory.test.mjs`: Verify `capToolOutput` safely truncates at multi-byte UTF-8 boundaries and appends the 16KB wire limit marker; verify `inheritedEventCount` prevents turn capture on events before the fork cut.
3. `doctor.test.mjs`: Verify Gate 1 diagnostics flag NPCs exceeding 4 signature items or exceeding 48 characters per item name.
4. `prompt.test.mjs`: Verify that prompt assembly respects byte budgets and correctly injects DM craft directives and active table dials without variable interpolation syntax errors.
