# D&D 3.5e DM preset — architecture

*What runs as code, what runs as prompt, and where the boundary sits. Moved here from the game
workspace (`Projects/Writing/TTRPG/D&D35/docs/`), where it described a bundle that had already left
that repository — which is why the two drifted apart.*

> **Contract and usage live in [`plugins/dsh-dd35-preset/README.md`](../plugins/dsh-dd35-preset/README.md).**
> This document is the *design rationale* and the *corpus measurements*: the parts with no other home.
> It deliberately does not restate the tool inventory, the file layout, or the capture rules, because
> duplicating a reference is how this file went stale the first time.

---

## TL;DR

| Layer | Content |
|---|---|
| **Preset plugins** | 14 entries — the composition table lives in the [README](../plugins/dsh-dd35-preset/README.md) |
| **Tools** | **43** across 5 plugins, plus automatic turn capture, over 3 shared modules |
| **Skills** | **6** (`dd35-*`), discovered live from `<projectRoot>/.agents/skills/` |
| **Instructions** | `<projectRoot>/.agents/AGENTS.md` — ⚠️ **present but not loaded**; see [§4](#4-the-instruction-file-is-in-the-wrong-place) |
| **Design rule** | **The model makes decisions; the code does arithmetic and bookkeeping.** |
| **Corpus health** | Rules ✅ 91% substantive · Spells ✅ 88% · **Monsters ❌ 0% — stub index only** |

Measured against the live `seventh_moon` workspace on 2026-10-05.

---

## 1. Layers

```
┌─ PROMPT ─────────────────────────────────────────────────────┐
│  AGENTS.md      who the DM is, tone, axioms, response format │  ← not loading, §4
│  6 skills       how to run a turn / a mode / a session       │
│  persona        the d20 primer + oracle discipline table     │
│  dm_persona.md  the campaign's own voice (per campaign)      │
└──────────────────────────────────────────────────────────────┘
┌─ TOOLS ──────────────────────────────────────────────────────┐
│  43 deterministic functions the model calls                  │
└──────────────────────────────────────────────────────────────┘
┌─ STATE ──────────────────────────────────────────────────────┐
│  campaign/<id>/{state.json, player/, actors/, events/}       │
└──────────────────────────────────────────────────────────────┘
```

The prompt layer decides *what should happen*. The tool layer decides *what the numbers are* and
*what gets written where*. Everything below is about keeping that split honest.

> **Load-bearing detail:** presets do **not** inherit host plugins. `agent-instructions`,
> `skill-filesystem` and `tool-skill` must each be declared explicitly — and this is exactly the
> seam where §4 went wrong.

---

## 2. The prompt / programmatic boundary

This is the core design question. The split is deliberate and consistent.

### 2a. Fully programmatic — the code decides

The model never invents these; it only supplies inputs.

| Behaviour | Where |
|---|---|
| **Every die roll** (`Math.random`, d4–d100, `2d6+3`) | [`dice.js`](../plugins/dsh-dd35-preset/dice.js) — the single engine |
| **Temp HP absorption order** — temp pool drains before real HP | `apply_damage`, `roll_attack` |
| **Death thresholds** — 0 = disabled, −1…−9 = dying/unconscious, −10 = dead | `hpStatus` |
| **Critical confirmation** — threat range, confirm roll, dice×mult with the flat bonus applied once | `roll_attack` |
| **Natural 20 / natural 1** — always hits / always misses | `roll_attack` |
| **Initiative** — rolling, descending sort, tie-break by bonus then name | `init_combat`, `sortOrder` |
| **Condition expiry** — `expires_round <= current round` | `expireConditions` |
| **Transcript numbering** and header format | `writeTranscript`, `parseTranscript` |
| **Corpus indexing and fuzzy matching** (normalise, slug, substring) | `reference.js` |
| **Oracle table selection** | `tools.js` |

### 2b. Fully prompt — the model decides

No tool can or should compute these.

- Narrative prose, voice, and pacing (zoom in vs. summarise)
- NPC goals, dialogue, and **tactical intent**
- **DC selection** — the model picks the number; the tool only rolls against it
- **Damage expressions** — the model supplies `"1d8+5"`, not the tool
- Which rule is relevant to a situation
- What the player perceives vs. what stays hidden
- Houserule adjudication when RAW is silent
- Interpreting a free-form character sheet into fields
- Entity boundaries (is this companion a separate sheet? is that summon persistent?)

### 2c. Split — model supplies, code executes

The handoff that makes the whole design work.

| Tool | Model provides | Code enforces |
|---|---|---|
| `roll_check` | modifier, DC, label — or an opponent | the roll, total, success, margin, tie re-roll |
| `roll_attack` | attacker, target, damage expr, crit range | hit/miss, confirmation, damage, HP subtraction |
| `roll_dice` | pool size, keep/drop, modifier, DC | the dice, the kept set, the total |
| `apply_damage` | target, amount, type | temp HP, HP arithmetic, status conditions |
| `apply_condition` | name, effect text, duration | round arithmetic, expiry |
| `init_combat` | the combatant list | rolls, sort, round 1, scene insertion |
| `update_entity` | any JSON patch | persistence, create-on-first-use |
| *auto-capture* | nothing — it observes the turn | numbering, formatting, both files, the index |
| `lookup_rule` | topic, optional category | index lookup, extraction |

**What this buys:** the arithmetic that is tedious in prose — and that a language model does
unreliably across a 20-round combat — happens once, deterministically, and is persisted. What stays
with the model is judgment, which is what it is actually good at.

---

## 3. Prompt layer detail

Four layers now, and the split is deliberate: **the preset owns what is true of the harness-level
tools; the workspace owns what is true of this campaign.**

### The `persona` prefix — the preset's own prompt

The only *static* prompt text that travels with the preset rather than being read from the workspace.
Registered by `@deepseek-ai/dsh-persona` as `deployment:persona-prefix`, and therefore:

- **preset-scoped** — a session that does not select `dd35` never sees it, and editing the workspace
  cannot change it;
- **able to name the preset's own tools** — it is the only layer that can, because the tools are
  mounted by the same patch file;
- **static**, so it sits in the cached prefix and is paid for once.

It carries the DM's role line, the d20 primer, and the **oracle discipline**: an instruction to roll
uncertain world facts rather than decide them, plus a tool × when-to-use table. That table is the
canonical answer to "which oracle, and when" — `AGENTS.md` and the skills deliberately do not restate
it, and a tool list in a repository file would be wrong anyway, since a repository cannot know which
plugins a preset mounts.

### `dm_persona.md` and `dm_notes.md` — the campaign's own layers

Read from the active campaign directory on every request (see the [README](../plugins/dsh-dd35-preset/README.md)).
The persona half is a *dynamic system-prompt section* placed directly after the static prefix; the
notes half is a *runtime-context snapshot*, so writing notes never invalidates the cached prefix. Both
are per-campaign, so `set_active_campaign` switches them.

The distinction these two layers create is the one the static prefix cannot make: **identity is
preset-wide, but voice and campaign truth are per-campaign.**

### Six skills

| Skill | Owns |
|---|---|
| `dd35-gameplay-loop` | The per-turn spine: resync → route → look up → resolve → narrate, then recall when needed |
| `dd35-encounter-mode` | Rounds, initiative, action economy, AoOs, mid-combat changes |
| `dd35-exploration-mode` | 10-minute blocks, marching order, light, checks |
| `dd35-downtime-mode` | Rest, crafting, research, income, living expenses |
| `dd35-fresh-session` | Resuming a campaign from turn memory |
| `dd35-session-zero` | Onboarding, character build, campaign initialisation |

Each names the concrete tool for each step rather than describing the work in prose. The catalog is
injected; bodies load on invocation.

---

## 4. The instruction file is in the wrong place

**`<projectRoot>/.agents/AGENTS.md` exists and is not loaded into any session.** Verified against two
live `dd35` sessions on 2026-10-05: neither contains the file's text, and no message carries the
`agent-instructions` source kind at all.

The mechanism is a discovery mismatch, not a plugin failure:

| Layer | Root it scans | Result |
|---|---|---|
| `skill-filesystem` | `<projectRoot>/.agents/skills/` — an explicit `.agents` root | ✅ finds all six skills |
| `agent-instructions` | `AGENTS.md` / `CLAUDE.md` **in each directory** from the project root down to cwd (`files.ts`: `join(dir, candidate)`) | ❌ no `AGENTS.md` at the project root |

The project root is the directory containing `.git`, and the only `AGENTS.md` in the tree sits one
level down inside `.agents/`. A previous session presumably placed it beside the skills expecting the
same convention to apply to both — it applies only to skills.

**Two fixes, either sufficient:**

1. **Config** — set `instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md']` on the
   preset's `agent-instructions` row. Candidates are joined to each directory, so this resolves at the
   project root and costs nothing elsewhere. Keeps the accepted-layout convention.
2. **Move the file** to `<projectRoot>/AGENTS.md`. The plugin's documented layout, at the cost of
   splitting instructions from skills.

This matters more than a missing file usually would. `AGENTS.md` carries the Core Axioms — *rules
first, preserve agency, multi-campaign context* — and the DM has been running without them. It is also
the file that declares `dm_persona.md` an absolute priority, so the campaign persona layer was only
working because the plugin reads that file directly, not because the instruction ever arrived.

---

## 5. Corpus quality

Measured across the live workspace on 2026-10-05.

| Corpus | Files | Substantive | Verdict |
|---|---|---|---|
| `rules/` | 187 | 170 have `## Mechanics`/`## Summary` (**91%**) | ✅ Usable |
| `compendium/spells/` | 4,617 | carry `Level:`, `School:`, `Components:` fields (**88%**) | ✅ Usable |
| `compendium/classes/` | 11 | full write-ups (7–21 KB each) | ✅ Usable |
| `compendium/monsters/` | 975 | **0 have a stat block** | ❌ **Stub index only** |

### The monster problem

Every one of the 975 monster files is ≤25 lines and follows this shape:

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

**No ability scores, no AC, no hit points, no attacks, no special abilities.** `get_monster`
correctly finds the file and returns its contents — the contents just contain nothing playable.

**Impact:** the DM cannot stat an encounter from the corpus. It must either supply monster numbers
from its own knowledge (unverified, and unreliable for exact 3.5e values) or have the user provide
them. This remains the single largest functional gap in the setup.

**Note:** this is an *ingestion* problem, not a tool problem — the extraction step recorded the header
and source but not the stat block. Re-extracting from the original sourcebooks fixes it without
touching code. Tracked as FI-3.

---

## 6. Known gaps

Beyond the monster corpus. Each of these is a backlog item in
[`dd35-future-improvements.md`](dd35-future-improvements.md), which owns the detail and the priority:

| Gap | Item |
|---|---|
| No derived-stat computation — `attack_bonus` and skill modifiers are *stored*, never computed from BAB + ability + feats + equipment | FI-2 |
| No grid, distance, or line-of-sight tracking — `position` is free text | FI-4 |
| No spell-slot or resource automation — `resources` is a free-form object the model manages by hand | FI-5 |
| No XP, level-up, or encumbrance automation | FI-6 |
| `search_reference` matches filenames, not contents | FI-7 |
| Free-form sheet fields (`stats`, `feats`, `equipment`) persist verbatim and are read by nothing | — |
| `create_campaign`'s `party` entries keep only `id`, `name`, `hp`, `max_hp`, `ac`, `initiative_bonus`; a full sheet needs a follow-up `update_entity` | — |

---

## 7. Verification status

| Check | Result |
|---|---|
| Three offline suites: `dsh-dd35-preset`, `dsh-context-pressure`, `dsh-compaction-guard` | ✅ 74 tests |
| Tool modules invoked through a module-resolution rig (not just `node --check`) | ✅ `roll.test.mjs` |
| Turn capture driven through the real `agent/turn-stopping` / `turn/end` hooks | ✅ `memory.test.mjs` |
| Campaign prompt providers against a temporary campaign tree | ✅ `prompt.test.mjs` |

**Still not verified:** the 43 tools and 6 skills have never been exercised end-to-end from inside a
live `dd35` session. Everything above is offline module testing plus host-scope inspection, and it is
structurally blind to the failure class that has actually bitten this preset — a *session-level*
problem such as a branch that truncated history, or an instruction file that never loaded. A live
session is the remaining acceptance test.
