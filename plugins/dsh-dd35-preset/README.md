# dsh-dd35-preset

An agent preset for a solo **D&D 3.5e Dungeon Master**: 43 native tools, automatic turn memory, and
two optional per-campaign prompt files. The bundle inserts one `@deepseek-ai/dsh-agent-preset` row
(`id: dd35`) whose `plugins` list is the composition below.

Nothing here talks to an MCP server or a child process; every tool is a plain `defineTool`
registration on the harness tool registry.

## Composition

| Row | Module | What it contributes |
| --- | --- | --- |
| `persona` | `@deepseek-ai/dsh-persona` | The DM identity: the d20 primer, the solo-oracle discipline, and the tool table, as the `deployment:persona-prefix` section. |
| `agent-instructions`, `skill-filesystem`, `tool-skill` | shipped | Workspace `AGENTS.md`, and the campaign's skills from disk. |
| `dd35-tools` | [`tools.js`](tools.js) | 10 oracle / generation / dice tools over [`tables.json`](tables.json). |
| `dd35-state` | [`state.js`](state.js) | 10 campaign- and session-lifecycle tools. |
| `dd35-memory` | [`memory.js`](memory.js) | 3 recall tools **and the preset's only event hooks**. |
| `dd35-mechanics` | [`mechanics.js`](mechanics.js) | 14 check / combat / initiative tools. |
| `dd35-reference` | [`reference.js`](reference.js) | 6 indexed lookups into `rules/` and `compendium/`. |
| `dd35-prompt` | [`prompt.js`](prompt.js) | The two optional campaign prompt files. |
| `tool-fs`, `tool-fs-search`, `tool-ask-user` | shipped | `read`/`write`/`edit`/`glob`/`grep`, and asking the player. |
| `compaction` group | [`dsh-compaction-guard`](../dsh-compaction-guard/) | Guarded `/compact` and tool-result pruner, isolated into the preset's realm. |

[`dice.js`](dice.js) is the single dice engine behind every roll and [`state-store.js`](state-store.js)
/ [`memory-store.js`](memory-store.js) are the shared filesystem helpers. None of the three is a
plugin row.

## One dice engine, three roll tools

Every roll in the preset goes through [`dice.js`](dice.js). Three tools expose it:

| Tool | Use |
| --- | --- |
| `roll_dice` | The generic roll: an XdY pool with keep/drop, plus `modifier` and an optional `dc`. |
| `roll_check` | Every saving throw, skill check, ability check, and opposed contest (`opponent` selects the opposed form; a tie re-rolls once). |
| `roll_attack` | Every attack: crit-threat confirmation, damage dice, and with `apply: true` it writes HP and 3.5e status to the target's sheet. |

`roll_d20`, `roll_save`, `roll_skill` and `roll_opposed` were retired into these; `get_monster_ai` is
now `roll_monster_behavior`. The persona's tool table names all three, because `roll_attack` is the
only roll that persists its result.

## Campaign prompt files

Both are optional, live in the **active campaign** directory, and are re-read on **every request**, so
editing one takes effect on the next turn and `set_active_campaign` switches them:

| File | Channel | Purpose |
| --- | --- | --- |
| `campaign/<id>/dm_persona.md` | system prompt, section `dd35:dm-persona` at order 100 | The campaign's own persona, directly after the preset's DM persona. Voice and presentation. |
| `campaign/<id>/dm_notes.md` | runtime-context snapshot, `dd35:dm-notes` at order 200 | The DM's durable scratchpad: house rules, prior rulings, active quests, plot-arc intent, anything it would need reminding of. |

The split is deliberate. Persona text is stable and worth paying for once as a cached prompt prefix;
notes are mutable and are delivered as a superseding snapshot instead, so writing them never
invalidates that prefix. Both bodies are registered with `interpolate: false` — campaign prose is
arbitrary text and must never be scanned for `{{variable}}` groups, since an unknown reference throws
during render.

`dm_notes.md` is the home for campaign-specific truth. It must not live in `AGENTS.md` or another
workspace-global file, because those are shared by every campaign in the folder.

## Turn memory

Capture runs in code on the turn boundary, with no tool call and no model cooperation:

1. `agent/turn-stopping` takes a snapshot of the closing exchange.
2. `session/event` with `turn/end` **and `reason.kind === 'completed'`** commits it. An aborted,
   errored, blocked or truncated turn is not canon.

A commit writes **one** file: `events/transcripts/NNNN_turn.md`. It carries the exchange *and* the scene
state as it stood when the turn closed — location, entities, micro-state, pending action — read out of
`state.json` at write time. `state.json` holds only the current values, so the transcript is the sole place
that history survives. It also folds a row into `events/memory_index.json` and stamps `state.last_turn`.
Subagent sessions never write, and a turn carrying no fresh player input is skipped.

There is no second turn file. A hand-maintained `campaign_log.md` used to duplicate the same conversation
with the state snapshot appended. That meant two writers and two files to repair by hand, and nothing
detected when they diverged: the log held 29 machine entries against 34 transcripts, and the index
advertised turn ranges the corpus could not answer. The state the log uniquely held is now in the transcript
header, and the exchanges it duplicated were already in the corpus.

### Recall

Three tools read the transcripts, and they share one id contract — `NNNN:player` / `NNNN:dm`, defined once
in `messagesOf` ([`memory-store.js`](memory-store.js)) so a listing and a search can never offer different ids:

- **`grep_memories`** — ranked snippets with ids, bounded by `from_turn` / `to_turn` and by `role`.
- **`fetch_memories`** — the full text of the ids you picked, plus `context` neighbouring turns.
- **`list_memories`** — the scene index (turn count, in-game date span, which ranges belong to which scene);
  with `from_turn` / `to_turn` it lists turn headers **and the ids to feed `fetch_memories`**, which is how
  a fresh session reads a specific stretch without synthesising ids by hand.

Each returned message carries the scene snapshot for its turn, so recall reports the state at that point in
the campaign rather than only the current state.

### What counts as the player

`isPlayerMessage` requires `role === 'user'` **and** `source.kind === 'user'` **and** a non-empty
`source.rpcId`. The rpcId is load-bearing: `SessionCommandController.prompt()` mints one for every
prompt the Web client sends, while a producer that injects model-facing content as a user-role
message has none. The kind check alone was not enough — `dsh-context-pressure` used `kind: 'user'`
for its pre-compaction notice, and the notice landed between the player's message and the reply, so
capture walked back and recorded it as the player's words.

Known exception: **ACP delivers real prompts as `{ kind: 'user' }` with no rpcId**
(`acp/session.ts`), so a session driven that way records no turns. ACP is not mounted in this
profile; admitting that shape is a deliberate change, not a widening of the kind test.

### What counts as narration

A completed turn is still not canon if the DM wrote no fiction. A connector that has to stand in
for a reply which will never exist — `dsh-meridian-antigravity` does this when the backend blocked a
generation after Meridian had already consumed the tool batch — delivers that notice as an ordinary
assistant message, so the turn completes and nothing distinguishes it structurally. Capture therefore
rejects a reply that opens with a known connector notice prefix, the same way it already rejects an
aborted or errored turn. Without that guard a system disclaimer would be written into the transcript and
the scene index, and would later be quoted back by `grep_memories` and `fetch_memories` as something the DM
said. The prefixes live in `CONNECTOR_NOTICE_PREFIXES` in
[`memory.js`](memory.js) and mirror the connectors' own markers
(`[Meridian Antigravity]` is `NOTICE_PREFIX` in `dsh-meridian-antigravity/lib/failure.js`).

### Which message is the reply

Capture takes the turn's last assistant message that contains text, because a model narrates after its tool
calls. One case overrides that: a **work-requesting notice** injected after the model has already answered.
`dsh-context-pressure` steers such a notice at the pre-step boundary asking for a resumption note; the model
then keeps working, and its closing message describes that work instead of answering the player. Capture stops
its search at the first such notice, so the text before it is the reply. Observed live in `seventh_moon`
turn 137, which recorded an OOC status report about `compaction_save.md` and discarded the answer.

The guard is that earlier text has to exist. A notice steered during tool work, before the model has said
anything, is part of the working phase, and its next message is still the reply — both orderings occur in the
corpus. `WORK_REQUESTING_NOTICE_KINDS` in [`memory.js`](memory.js) lists the kinds that bound the reply.
Reporting kinds (`runtime-context`, `skill-catalog`, `tool-jobs`, `subagent-settled`) deliberately do not,
because the model carries on normally after them.

## State on disk

Under the **session workspace** (`session.header.cwd`), never under this bundle:

```
campaign/campaign_registry.md            active-campaign registry (markdown)
campaign/<id>/state.json                 session facts: mode, clock, initiative, scene
campaign/<id>/events/transcripts/NNNN_turn.md   the turn record: exchange + scene snapshot
campaign/<id>/events/memory_index.json   scene index (derived; rebuildable)
campaign/<id>/player/<entity>.json       PC sheets
campaign/<id>/actors/<entity>.json       NPC sheets
rules/                                   rule markdown for lookup_rule
compendium/{monsters,spells,classes}/    corpus for the reference tools
```

**Division of truth:** `state.json` holds session facts, each entity sheet holds per-entity facts.
No field lives in both. An explicit `workspace` config on any of the four tool plugins pins a fixed
root instead of following the session.

## Tests

```
node --test        # from this folder; offline
```

Four suites, no harness required. [`roll.test.mjs`](tests/roll.test.mjs) and
[`memory.test.mjs`](tests/memory.test.mjs) build a throwaway copy of the modules beside a one-export
stub of `@deepseek-ai/dsh-tools` so the tools can actually be invoked; `Math.random` is pinned so the
roll assertions are exact. [`prompt.test.mjs`](tests/prompt.test.mjs) drives the prompt providers
against a temporary campaign tree, and [`workspace.test.mjs`](tests/workspace.test.mjs) covers path
resolution.

## Gotchas

- **Plugin code is imported once per harness process.** Editing any module here needs a DSH restart;
  the HMR root in the profile does not cover this bundle.
- **A seeded session is not a fresh one.** Branching a session forks it at an event prefix, so the
  child's history ends where the branch point was, with no in-session marker saying so. A DM resumed
  into a truncated history has no way to know turns are missing — and if the head of that history is
  an instruction like *"rewrite the last two turns"*, it may simply re-run it.
- **`dm_notes.md` goes stale silently.** It is injected as authoritative "current state" on every
  request. Nothing marks it with an "as of" turn, so a note that stops being updated keeps being
  presented as the present.
- **`AGENTS.md` is loaded from the project root, not from `.agents/`.** This preset mounts
  `agent-instructions`, but it looks for `AGENTS.md`/`CLAUDE.md` *in each directory* from the project
  root to cwd, while `skill-filesystem` scans the explicit `.agents/skills/` root. A file written to
  `.agents/AGENTS.md` therefore sits next to the skills and never loads. Measured on 2026-10-05: the
  live campaign's instructions were absent from every session. See
  [`docs/dd35-preset-architecture.md` §4](../../docs/dd35-preset-architecture.md) for the mechanism and
  the two fixes.
