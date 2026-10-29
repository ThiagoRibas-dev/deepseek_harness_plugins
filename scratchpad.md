# TTRPG Evolution Roadmap & Scratchpad (dsh-dd35-preset)

## Active Mission & Context
- **Objective**: Evolution of `plugins/dsh-dd35-preset` incorporating zero-inference mechanics, DM craft, memory scoping, and companion UI inspired by 3 reference implementations (`open-tabletop-gm`, `NarrativeEngine-P`, `claude-dnd-skill`).
- **Core Invariants**:
  1. **Subtractive Zero-Inference Architecture**: Pure deterministic Node.js / SQLite execution; no secondary LLM calls, background agents, or vector embeddings on the live turn path.
  2. **Mid-Turn State Immutability**: State snapshots remain frozen during turn resolution; mutations commit strictly at turn/scene boundaries (`agent/turn-stopping`).
  3. **Wire Payload Safety**: Tool outputs across Cordis RPC bridge must enforce `capToolOutput(payload, 16384)` with safe boundary truncation to avoid Meridian client tool result deadline expiration (409 `MERIDIAN_PENDING_REPLAYABLE`).
  4. **Strict Prompt Budgeting**: Maintain resting system prompt ~2,300 tokens; procedural chapter routing via `SKILL-branches.md` prevents context ballooning.
  5. **Memory Scoping & Prefork Protection**: Guard `agent/turn-stopping` with `inheritedEventCount` to prevent duplicate turn capture on forked sessions; isolate episodic memories to session namespace + global fallback; explicit administrative repair actions (`forget-session`, `re-ingest`).

## Key Technical Concepts & Architectural Decisions

### 1. Deterministic Decaying-DC Tension Loops (REC-1)
Modeled after `NarrativeEngine-P` `rollEngines` with PRNG seeded by `turn` or caller seed:
- **Surprise Engine (Color/Ambient)**:
  - Roll: d100 vs DC (initial 95, decay -3 per turn, floor 5).
  - Trigger: Roll >= DC -> appends `\n[SURPRISE EVENT: <type> (<tone>)]`, resets DC to 95.
- **Encounter Engine (Challenges/Hooks)**:
  - Roll: d200 vs DC (initial 198, decay -2 per turn, floor 5).
  - Trigger: Roll >= DC -> appends `\n[ENCOUNTER EVENT: <type> (<tone>)]`, resets DC to 198).
- **World Engine (Seismic/Global)**:
  - Roll: d500 vs DC (initial 498, decay -2 per turn, floor 5).
  - Trigger: Roll >= DC -> appends `\n[WORLD_EVENT: <who> <what> <why> <where>]`, resets DC to 498.
- **Tension Tables Vocabulary (from `settingsHelpers.ts`)**:
  - `ambient_surprise`: 10 Types (`WEATHER_SHIFT`, `ODD_SOUND`, `NPC_QUIRK`, `EQUIPMENT_HICCUP`, `SCENERY_CHANGE`, `ANIMAL_BEHAVIOR`, `RUMOR_OVERHEARD`, `STRANGE_SENSATION`, `MINOR_MISHAP`, `UNEXPECTED_KINDNESS`) x 8 Tones (`CURIOUS`, `UNSETTLING`, `AMUSING`, `EERIE`, `MUNDANE`, `WHOLESOME`, `OMINOUS`, `BIZARRE`).
  - `tactical_encounter`: 10 Types (`AMBUSH`, `RIVAL_APPEARANCE`, `RESOURCE_CRISIS`, `MORAL_DILEMMA`, `UNEXPECTED_ALLY`, `TRAP_TRIGGERED`, `FACTION_CONFRONTATION`, `BOUNTY_HUNTER`, `SUPPLY_SHORTAGE`, `BETRAYAL_HINT`) x 8 Tones (`TENSE`, `DESPERATE`, `MYSTERIOUS`, `AGGRESSIVE`, `CHAOTIC`, `CALCULATED`, `GROTESQUE`, `EPIC`).
  - `world_event`:
    - Who (10): `a major faction/organization`, `a rogue splinter group`, `a powerful leader/executive`, `a dangerous anomaly`, `a fanatic cult/extremist group`, `a prominent conglomerate/merchant guild`, `a desperate individual`, `a completely random nobody`, `an ancient/forgotten entity`, `a chaotic force of nature`.
    - Where (10): `in a neighboring city/sector`, `across the nearest border`, `deep underground/in the lower levels`, `in a remote outpost/village`, `in the capital/central hub`, `in a forgotten ruin/abandoned zone`, `along a main trade/travel route`, `in an uncharted area`, `in a highly secure/restricted area`, `in the wilderness/wasteland`.
    - Why (10): `to seize power/control`, `for brutal vengeance`, `to protect a dangerous secret`, `driven by a radical ideology/prophecy`, `for untold wealth/resources`, `due to an escalating misunderstanding`, `out of pure desperation`, `because someone dumb got lucky and found a legendary asset`, `acting on an old grudge`, `to reclaim lost glory/territory`.
    - What (10): `declared open hostilities/war`, `formed an unexpected alliance`, `destroyed an important landmark/facility`, `discovered a game-changing asset/relic`, `assassinated/eliminated a key figure`, `triggered a massive disaster`, `monopolized a critical resource`, `initiated a complete blockade/lockdown`, `caused a mass exodus/evacuation`, `staged a violent coup/takeover`.
- State Representation in `state.json`:
  `state.tension = { surpriseDC: 95, encounterDC: 198, worldEventDC: 498 }` (defaults applied when missing).

### 2. Wire Safety & Payload Capping (REC-9)
- Enforce `capToolOutput(payload, maxBytes = 16384)` in `plugins/dsh-dd35-preset/memory.js` and `plugins/dsh-dd35-preset/context-index.js`.
- Truncates safely at UTF-8 / JSON string boundaries and appends notice: `\n[truncated: output exceeded 16KB wire safety limit]`.
- Mitigates 409 `MERIDIAN_PENDING_REPLAYABLE` transport timeouts caused by unconstrained tool responses.

### 3. NPC Signature Kits & Drift Detection (REC-2)
- Limit NPC inventory/spells to <= 4 items in prompt serializations.
- Gate 1 admission diagnostic rules in `doctor.js` flagging hallucinated entity gear drift.

### 4. Witness Boundaries & Scene Hysteresis (REC-3)
- Turn graph indexing separates `witnesses` (present on-stage) from `mentioned_actors`.
- Divergence register partitions facts by `knownBy: [player, npc:<id>, faction:<id>]`.
- Scene detection hysteresis (`_SCENE_INCUMBENT_BONUS = 2`, `_SCENE_SWITCH_MARGIN = 3`) prevents room bouncing on passing keywords.

### 5. DM Behavioral Directives (REC-4)
- Pure table prose (no markdown headings `###` or bullet lists in narrative output).
- Transition bangs (end scenes with a concrete prompt or sudden event).
- Absolute PC sovereignty (never narrate player actions, emotions, or thoughts).
- Natural 20 rewards inspiration/momentum.

### 6. Arc Tracking & Table Dials (REC-5, REC-6)
- 6-beat dynamic arc tracking with pre-emption landing paths (`cost_path`, `secondary_consequence`, `deferred`).
- Table dials: `difficulty` (casual, standard, gritty), `spotlight` (focused, ensemble), `pacing` (deliberate, brisk).
- `scope` dial (local, regional, national, planar, continental): the campaign's stated dramatic and political scale, set at Session Zero confirmation and read thereafter. Prevents a level-15+ premise from being restated as routine local errands. Context for the DM, not a validator — the Arbiter keeps authority over encounter placement.

### 7. Scene-Boundary Micro-Saves (REC-7)
- Silent continuity serialization at scene boundaries in `context-freeze.js`.

### 8. Companion UI Manifest (REC-8)
- Declarative `plugins/dsh-dd35-preset/ui.json` for DSH Web GUI sidebar.

### 9. Memory Isolation & Fork Protection (`scratch_state.md`)
- Step 1: Per-session episodic namespace + recall reading it (+ `global` core) with tests.
- Step 2: `inheritedEventCount` guard in `agent/turn-stopping` to prevent duplicate turn capture on forked sessions.
- Step 3: Inheritance-at-fork on `agent/created` with idempotence test.
- Step 4: Explicit `forget-session` and `re-ingest` actions (routes + Memory tab UI) with tests.

## 3-Phase Roadmap Execution Plan

### Phase 1: Mechanical Stability & Tension [ACTIVE]
1. [x] Analyze reference repositories (`open-tabletop-gm`, `NarrativeEngine-P`, `claude-dnd-skill`).
2. [x] Populate `ambient_surprise`, `tactical_encounter`, and `world_event` tables in `plugins/dsh-dd35-preset/tables.json` (10 rows each, 4 content columns).
3. [x] Implement `evaluateTensionTick(state, seed)` in `plugins/dsh-dd35-preset/oracle-core.js`, plus `plugins/dsh-dd35-preset/tension.js` (turn-stopping roll → one-turn frozen context).
4. [ ] Implement `capToolOutput(payload, 16384)` in `plugins/dsh-dd35-preset/memory.js` and `plugins/dsh-dd35-preset/context-index.js`. **This is the next item.**
5. [x] Add unit tests for `evaluateTensionTick` (oracles.test.mjs, 7 cases) and its persistence/delivery (tension.test.mjs, 14 cases). 256 preset tests pass.
6. [ ] Add `capToolOutput` cases once the helper exists.

### Phase 2: DM Quality & Canon Validation [IN PROGRESS]
0. [x] **REC-12**: preset-owned session-start routing contract, recorded in [preset-evolution-report.md §REC-12](docs/dd35/preset-evolution-report.md).
   - `state.js`: `setup` phase on `route_turn` (`!state.last_turn` — absent or null, because `loadState` does no defaulting — and scene status not `active`); `set_mode` returns a mode-skill hint; every `route_turn` hint now leads with the action and names its skill last.
   - `cordis.patch.yml`: Turn Routing block, Naming Discipline, Diegetic Information Boundaries. +1,370 bytes, prefix 6,294 → 7,664 (~1,916 tokens, under the ~2,300 ceiling).
   - Tests: `create_campaign` now asserts `setup`; four cases added (unplayed campaign, explicit `last_turn: null`, active scene keeps normal phases, `set_mode` hint). 235 preset tests pass.
   - [ ] Remaining: drop the phase and mode tables from `.agents/AGENTS.md` in the D&D35 campaign workspace — that file is outside this repo and needs elevated permissions.
1. [ ] Implement REC-2: NPC Signature Kit bounds (max 4) and Gate 1 diagnostic rules in `doctor.js`.
2. [ ] Implement REC-4: Inject condensed DM behavioral directives into `prompt.js`.

### Phase 3: Narrative Pacing, Scoping & Companion UI [UPCOMING]
1. [ ] Implement REC-3: Witness & observer boundary tracking (`witnesses` vs `mentioned_actors`) in `context-index.js`.
2. [ ] Implement REC-5 & REC-6: Pre-emption landing paths and table dials in `state.js` and `prompt.js`, including the `scope` dial (see §6).
3. [ ] Implement REC-7: Scene-boundary micro-save serialization in `context-freeze.js`.
4. [ ] Implement REC-8: Declarative `ui.json` manifest for DSH Web GUI sidebar.

### Memory Architecture & Isolation Follow-ups
1. [ ] Implement per-session episodic namespace in `memory.js`.
2. [ ] Add `inheritedEventCount` guard in `agent/turn-stopping`.
3. [ ] Implement inheritance-at-fork in `agent/created`.
4. [ ] Add `forget-session` and `re-ingest` administrative actions.

## Session Notes (context checkpoint, 2026-10-24)

### Decisions and history
- User rule: do NOT edit anything in `plugins/dsh-dd35-preset/` without explicit approval. No plugin file has been changed so far.
- Docs written: `docs/dd35/preset-evolution-report.md` (requested report with 12-row Before/After matrix) and `docs/dd35/reference-repos-comparison-and-roadmap.md` (unrequested duplicate). Asked the user which one to keep; delete the other once told.
- User approved the suggestions (REC list) but wants to first step back to the fundamental DM design. User supplied Wikipedia DM definitions; I agreed and mapped 7 DM responsibilities onto the roadmap.

### Seven DM responsibilities (yardstick for roadmap items)
1. Create details/challenges, keep continuity. 2. Control everything except PC actions. 3. Describe what PCs perceive and effects of actions. 4. Prepare each session. 5. Know, teach and enforce rules. 6. Own narrative flow, pacing, dynamic feedback. 7. Arbiter: may bend/invent rules, improvise, roll when unsure, separate creativity from exploits.

### Findings from the mapping
- Tension engine tags (P1) must be DM-adaptable prompts, not mandatory (conflicts with #7). Six-beat arc and dials must stay optional.
- P2-4 (trim rules summary): keep or expand adjudication principles (when to roll, set DC, improvise, spot exploits); only move BAB/save tables to lookup tools.
- Current prompt says use `roll_check` "rather than DM fiat"; stricter than #7. Rewrite.
- Not covered yet: session preparation (#4), teaching rules to the player (#5).
- Peripheral to the seven duties: micro-saves, `ui.json`.

### Open threads
- Ask user: reorder roadmap around the 7 responsibilities, adding items for session prep and adjudication principles, before implementing anything?
- Which duplicate doc to delete.
- Phase order: Phase 1 vs M-2 fork guard first; tension in combat or not; trim vs keep rules summary.
- Note: `cordis.patch.yml` changes need a harness restart.

### Checkpoint Update (5 Core DM Roles Defined)
- **Agreed 5 DM Roles**:
  1. **World Builder**: Setting, factions, NPCs, locations, adventure scaffolding, prep & continuity unified. Builds with mechanics in mind (CR, settlement economy, classes/levels) for verisimilitude.
  2. **Simulation Engine**: Advances world state (NPC goals, faction moves, clocks, resources, tension). Resolves actions via rules (DCs, rolls). Mechanics act as world physics.
  3. **Storyteller**: Sensory descriptions, narrative pacing, dynamic feedback, sensory economy (2-3 details), pure table prose, transition bangs. Strict PC sovereignty (never narrates PC speech/thoughts/actions).
  4. **Arbiter**: Rulings when rules don't fit, improvised rulings, rolls when uncertain, distinguishes creative play from exploits. Outranks and overrides simulation engine.
  5. **Rules Teacher**: Explains mechanics to player when asked/needed. Mostly reactive and thin.
- **Key Realization**: Game rules and mechanics are interwoven throughout the roles (verisimilitude for World Builder, physics/resolution for Simulation Engine, overrides for Arbiter), not an isolated role or separate silo.
- **Action In-Flight**: Author `docs/dd35/dm-roles-design.md` defining each role, its inputs/outputs, associated tools, and prompt directives.
- **Files Cleaned Up**: Deleted unrequested duplicate `docs/dd35/reference-repos-comparison-and-roadmap.md`, kept `docs/dd35/preset-evolution-report.md`.
- **Constraint**: Strict gate on editing `plugins/dsh-dd35-preset/` with explicit user approval followed.

### Checkpoint Update (Prefix Pruning & Commentary Implementation, 2026-10-27)
- **Approved & Applied**: Replaced static d20 reference tables in `plugins/dsh-dd35-preset/cordis.patch.yml:17-94` with 5 Core DM Roles, compact mechanics formulas, AoO / Tumble DCs, double-damage safety for `roll_attack(apply: true)`, `dm_notes.md` secret isolation, and complete tool indexing.
- **Measurements**: Reduced prefix from 9,559 bytes to 6,295 bytes (saved 3,264 bytes, net ~815 tokens, now ~1,570 tokens resting prefix).
- **Verification**: Executed `node --test plugins/dsh-dd35-preset/tests/*.test.mjs` — all 231 tests passing across 12 suites.
- **Roadmap Updated**: Marked item 202 in `docs/dd35/preset-evolution-report.md` complete.
- **Commentary Cleanup (AGENTS.md Compliance)**:
  - Replaced metaphorical/personifying comments in `cordis.patch.yml` and `scene-state.js` with direct technical descriptions (KV prefix cache attention reuse, volatile snapshot truncation order, deterministic turn-seeded oracle draws, and read-only diagnostics).
  - All 231 tests pass across 12 suites.
- **Pending Roadmap Tasks**:
  1. Phase 1: Tension loop vocabularies in `tables.json`, `evaluateTensionTick` in `oracle-core.js`, `capToolOutput(16384)` in `memory.js` & `context-index.js`.
  2. Phase 2 Remaining: Signature kit bounds (<= 4 items) in `doctor.js`, prompt directives in `prompt.js`.
  3. Note: Changes to `cordis.patch.yml` require harness restart to activate.

### Checkpoint Update (Campaign Storage Redundancy Revision & Commentary Alignment, 2026-10-28)
- **Campaign Storage Redundancies Documented**: Added "Campaign Storage and File Redundancy Revision" under `## Open Architectural Items` in [docs/dd35/handoff.md](docs/dd35/handoff.md).
  - Documented the 4 file storage redundancies:
    1. Entity Presence & Roster: tracked in `state.json` (`scene.entities`), markdown transcript headers (`- Entities:`), `events/memory_index.json`, and co-occurrence graphs (`context-index.js`).
    2. Scene Location: stored in `state.json` (`scene.location`), transcript `- Location:` headers, and `events/memory_index.json`.
    3. Dual Partitioning: identical schemas split between `player/` and `actors/` requiring directory precedence in `state-store.js`, shadowing detection in `doctor.js`, and deduplication in `context-index.js`.
    4. Condition Tracking: split between entity sheet `conditions` array and `state.json` combat round counters (`combat.conditions` / `combat.combatants`), needing orphaned status checks in `doctor.js`.
  - Documented proposed revisions: on-demand ephemeral transcript indexing, unified `entities/` directory with `type: 'pc' | 'npc' | 'companion'`, `state.json` as authoritative scene presence, and distinct condition ownership.
- **Approved Commentary Alignments**: Non-functional comment updates applied across `plugins/dsh-dd35-preset/doctor.js`, `plugins/dsh-dd35-preset/memory.js`, `plugins/dsh-dd35-preset/context-index.js`, and `plugins/dsh-dd35-preset/state-store.js` ensuring literal, technical AGENTS.md phrasing.
- **Test Integrity**: Preserved 231 passing tests across all 12 test suites (`node --test plugins/dsh-dd35-preset/tests/*.test.mjs`).

### Checkpoint Update (Session-Start Routing Contract, Wording Drafted 2026-10-29)
- **Trigger**: a live campaign (Chronicles from the Seventh Moon) opened its first scene at level 15 immediately after the character files were loaded. `route_turn` answered `gameplay` because a campaign was attached and the message was not the session's first. It cannot currently express "campaign built, nothing played".
- **Root Cause**: the phase contract is split. `route_turn` is a preset tool and its hints already name workspace skills ([state.js:166-215](plugins/dsh-dd35-preset/state.js#L166-L215)), but the phase table and the instruction to call `route_turn` at all lived only in the campaign workspace's `.agents/AGENTS.md`. A workspace without that file leaves the routing tool unused.
- **Decision**: move the contract into the preset. Phase meaning in the tool description and hints, the call requirement in `persona.prefix`, and the mode-skill hint in `set_mode`. The workspace file keeps folder- and machine-specific procedure only. Skill names stay as pointers, action-first, because the harness publishes every skill's `whenToUse` in the `<available_skills>` catalog.
- **Wording**: drafted verbatim in [preset-evolution-report.md §REC-12](docs/dd35/preset-evolution-report.md) — a Turn Routing block, a `setup` phase hint, a `set_mode` hint, a naming directive, and a diegetic information boundary directive. Measured cost +708 bytes, prefix 6,294 → ~7,002 bytes (~1,750 tokens).
- **Two directive additions cover live failure modes**:
  1. *Naming*: forbids invented placeholders (`Oakhaven`, `Blackwood`, `Ironforge`) and requires `generate_place_name` / `generate_character_name`. The generators shipped but nothing required their use.
  2. *Diegetic boundaries*: in-character documents and NPC reports carry only what the sender knows or claims. Secrets stay in `dm_notes.md`. `dm_notes.md` isolation already shipped; the failure was a secret narrated into a temple letter, which no storage rule prevents.
- **Not yet applied**: no plugin file has been edited for REC-12. Wording is pending review, then the three-file edit plus test updates follows.
- **Deliberately deferred**: power-tier alignment needs `state.dials.scope` (REC-6, Phase 3); multiclass caster-level auditing needs class progression data — `compendium/classes` in the D&D35 workspace holds only the 11 core classes, so `get_class` cannot answer for Knight of the Raven, Ordained Champion, or Crusader.

### Checkpoint Update (Session-Start Routing Contract Shipped 2026-10-29)
- **Applied**: the approved wording, revised once for a more instructive register before editing. [`state.js`](plugins/dsh-dd35-preset/state.js) gets the `setup` phase, the five-phase description, and the `set_mode` hint; [`cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml) gets `Turn Routing`, `Naming Discipline`, and `Diegetic Information Boundaries`.
- **Gating**: `phase = unplayed && !framed ? 'setup' : (first_message ? 'fresh_session' : 'gameplay')`, where `unplayed = !state?.last_turn` and `framed = state?.scene?.status === 'active'`. The scene guard stops a campaign that agreed its framing from re-opening the interview before its first turn is captured.
- **Measured**: prefix 6,294 → 7,664 bytes (~1,574 → ~1,916 tokens). Turn Routing 654, Naming 341, Boundary 372.
- **Consistency pass**: the three new hints and the two pre-existing `session_zero` / `choose_campaign` hints now lead with the action and name the skill last, so the whole tool surface follows one shape.
- **Tests**: 235 pass. Added four `session-binding` cases; the `create_campaign` case now expects `setup`.
- **Outstanding**: `.agents/AGENTS.md` in the campaign workspace still carries the phase and mode tables; that file needs elevated permissions.
- **Restart required**: no `cordis.patch.yml` change mounts until the harness restarts.

### Checkpoint Update (Tension Engine Shipped 2026-10-29)
- **What**: REC-1. Three decaying-DC tiers rolled at the turn boundary, delivered as a one-turn runtime-context snapshot.
- **Files**: [`tables.json`](plugins/dsh-dd35-preset/tables.json) (+3 vocabularies, 10 rows × 4 content columns each), [`oracle-core.js`](plugins/dsh-dd35-preset/oracle-core.js) (`TENSION_TIERS`, `TENSION_FLOOR`, `TENSION_PRIORITY`, `evaluateTensionTick`), [`tension.js`](plugins/dsh-dd35-preset/tension.js) (new: hook + frozen context), [`cordis.patch.yml`](plugins/dsh-dd35-preset/cordis.patch.yml) (`dd35-tension` row).
- **Rates over 400 seeded turns**: ambient 67 fires / 5.9-turn mean gap, tactical 36 / 11.0, world 20 / 20.0. A firing resets its own tier; the floor keeps the last 5 points of every DC as a real die result.
- **Delivery**: the tick runs at `agent/turn-stopping` (before commit), writes `state.tension = { tiers, pending }`, and `pending.after_turn` pins the event to exactly one turn. The renderer shows it only when `state.last_turn.number === pending.after_turn + 1`.
- **Why not the assembly path**: the DCs decay by turns-since-last-fire, which is history. A pure renderer would have to decay from the turn number alone and would reset the pressure on every restart. The one-turn latency is the cost of durability, and it matches a table DM rolling at the end of a turn.
- **Guards**: no roll for a campaign with no captured turn (a `setup`-phase campaign has nothing to interrupt); every path wrapped so a bad `state.json` logs a warning instead of raising into turn-stopping. The snapshot is frozen per turn like the scene state, for the same mid-turn re-append reason.
- **Tests**: 256 pass (was 235). Seven tick-arithmetic cases in `oracles.test.mjs`, fourteen persistence/delivery/wiring cases in the new `tension.test.mjs`.
- **Next**: `capToolOutput(payload, 16384)`. [`fetch_memories`](plugins/dsh-dd35-preset/memory.js#L359-L398) is the measured unbounded path — full turn text for every id plus both neighbours, no ceiling.
