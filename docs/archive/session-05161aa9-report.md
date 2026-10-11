# Session report — `session-05161aa9-b64e-4568-82ea-eb6ae7e82768`

**"D&D AI Dungeon Master Tools (5)"** · the chat that built the `dd35` preset and the Kokoro TTS plugin.

*Written because the session log is no longer loadable (an unknown `tts/preference` event the harness
refuses to interpret), and the chat is being archived rather than repaired. This is its record.*

---

## How this report was reconstructed

The session log itself (`session.v4.jsonl.zstd`) is the only place the verbatim transcript exists, and the
harness refuses to read it. Everything below comes from sources that survived:

| Source | What it gave |
|---|---|
| `/root/.dsh/storages/session_projcache/sessions/session-05161aa9-….json` | the session's projection cache — title, first prompt, model, permission preset, session statistics, and a **turn outline** carrying the prompt and the opening of the response for all 64 turns |
| The workspace (`D&D35/`) | every artifact the session produced: the preset bundle, the plugin, the docs |
| `/root/.dsh/profiles/web/package.json` | where each bundle is mounted from |

**The outline truncates.** Each response is stored cut at roughly 90–110 characters (the cache's own
ellipsis, not mine), so this is a faithful *map* of the session, not its prose. The full text is
recoverable only by decoding the log — which is why the tool that does exactly that, and nothing else, was
worth writing even though the chat is being dropped.

---

## The session at a glance

| | |
|---|---|
| Title | D&D AI Dungeon Master Tools (5) |
| Preset | **`cordis`** — not `dd35`; this was a development chat that *built* the D&D preset |
| Working directory | `/export/DownloadsSSD/Projects/Writing/TTRPG/D&D35` |
| Model | `deepseek-official` / `deepseek-flash`, reasoning effort **high** |
| Permissions | `danger-full-access`, approval **never** |
| Started | ~2026-10-01 (`createdAt` 1790900146058) |
| Last prompt | 2026-10-02 (`lastPromptAt` 1790970753594) |
| Seeded | yes — inherited **2,619 events** from a parent chat, i.e. this is itself a resume |
| Turns | **64** (≈1–23 inherited, 24–64 authored here) |
| Steps | **1,025** |
| Model time | 8,557,854 ms (≈2 h 23 m) |
| Tool time | **34,650,568 ms (≈9 h 38 m)** — 4× the model time; the real cost of this session was execution, not generation |
| Decode | 1,044,489 tokens over 4,438,506 ms |
| Subagents | 1 — child `782dcf09…`, labelled *"Investigate DSH global plugin infra"* |
| TTS preference at death | `auto: true` — set from the chat toggle, which is what killed the log |

The title's `(5)` and the seeded prefix say something worth stating plainly: **the `dd35` project's origin
is upstream of this log.** This chat inherited a conversation already in progress, and the work below is the
continuation that happened here.

---

## The 64 turns

### Phase 0 — inherited (turns 1–23, events 0–2,618)

Where the project's foundations were laid, and where the MCP server was replaced by a native plugin.

| # | Prompt | Response begins |
|---|---|---|
| 1 | *"So, this repository is an attempt at creating workflows and tools to play D&D with an AI Dungeon Master. As you can see, we have a @src folder, containing an MCP server… read that and tell me what the tools in question are"* | "Based on the contents of the `@src` directory, specifically inside `src/mcp-server/server.py`, the MCP server provides…" |
| 2 | *"If we are focusing on running D&D 3.5e, how many…"* | "If your focus is strictly on **D&D 3.5e**, a system known for its crunch…" |
| 3 | *"Alright. Let's implement the tools from categorie…"* | "I'd love to set this up for you! However, I just hit a minor technical snag…" |
| 4 | `/skill cordis-composition-reference` | — |
| 5 | `/skill editing-cordis-compositions` | — |
| 6 | *"Also. We already have a plugin and a profile. Che…"* | "Done. Here's the complete picture and everything I changed… Bundle `@local/dsh-dd35-p…" |
| 7 | *"Great! Does this profile have access to the tools…"* | "Yes — **now it does.** I added the file tools to the `dd35` mode…" |
| 8 | *"Minor quirk I noticed (not from my change): each…"* | "Yes — you've read it right, and \"idle\" was too kind. It's **cumulative, and it's a genuine harness-side bug**…" |
| 9 | *"Hmm. Instead, we could drop the MCP server and cr…"* | "Done. The MCP server is dropped and replaced with a native harness plugin…" |
| 10 | *">rules/dm_aids/tables/monster_reactions.cs The so…"* | "Done — the reaction table is rebuilt and `get_monster_ai(phase=\"reaction\")` now resolves every roll 1–100…" |
| 11 | *"Awesome. Read the stuff inside the @.agents/ fold…"* | "Yes — DSH auto-loads it. Here's the precise mechanism…" |
| 12 | *"Alright. In that case, >trim+dedup and keep auto-…"* | "Phase 1 is built, tested, and live in the preset… `state-store.js`…" |
| 13 | *"Status?"* | "**The `dd35` mode is functional and live**…" |
| 14 | *"Yes please. Keep going with the implementation."* | "Mechanics work. The condition-timer test didn't actually reach the expiry round…" |
| 15 | *"Keep going please"* | — |
| 16 | *"What's happening?"* | "No" |
| 17 | *"No? No what?"* | — |
| 18 | *"Keep going please."* | — |
| 19 | *"Status please"* | "**Phases 1–3 are complete, tested, and live.** Phase 4–5 and the legacy-campaign migration remain…" |
| 20 | *"Go ahead."* | "**Phases 4 and 5 are done — and I found a bug that would have sunk the whole thing.**…" |
| 21 | *"Is the migration going to be done programmaticall…"* | "Yes — and the simplest path is a single tool… `update_entity` \| The workhor…" |
| 22 | *"We have a D folder (`Projects\Writing\TTRPG\D`) t…"* | "Yes — it's a genuine artifact of an unescaped `&`, and it's safe to delete…" |
| 23 | *"Sick. Alright. Can you do a summary report on the…"* | "Report written to `docs/dd35-preset-architecture.md`…" |

### Phase 1 — the backlog and the plan (turns 24–46)

The stretch where the project's *thinking* was written down: two living specification documents, and the
decisions that later caused the outage.

| # | Prompt | Response begins |
|---|---|---|
| 24 | *">No derived-stat computation  While that's not rea…"* | "Good question, and your framing is exactly right — the stacking rules are the whole game here…" |
| 25 | *"Hmm. Let's save a DSH Profile future improvements…"* | "Saved to `dd35-future-improvements.md`…" |
| 26 | *"Put it inside docs/dsh. Also, let's make these de…"* | "Moved to `docs/dsh/dd35-future-improvements.md`…" |
| 27 | *"Can't we change log_turn from a tool to a plugin…"* | "Yes — and there's a purpose-built hook for exactly this. I checked the live event and service contracts rather than gue…" |
| 28 | *">log_turn should probably be removed, Yes. >Abort…"* | "Recorded. All three decisions are in the spec…" |
| 29 | *"And how would you build this structure ``` ## Tur…"* | "Confirmed the exact API — and the key detail is that `text` accepts a **function**, evaluated per assembly…" |
| 30 | *"Actually. Forget the index. While it would be a c…"* | "Spec updated… **Dropped:** the `systemPrompt.context` injection entirely…" |
| 31 | *"Reading the document, get_state is called automat…"* | "Close, but one correction and one caveat. **Correction:** `get_state` isn't called *automatically*…" |
| 32 | *"Agreed. Is there a way to gave get_state called e…"* | "Yes — `agent/pre-step` is exactly the hook…" |
| 33 | *"Great. Then we don't need to have the memory stuf…"* | "Agreed and recorded. That's a genuine simplification — `get_state` now needs **no change at all**…" |
| 34 | *"Great. Let's implement FI-1 then mark it as compl…"* | "No on both counts — and that's the uncomfortable part… It was **not a commit**. It was a plai…" |
| 35 | *"Yeah. Given this mishap, it's probably a good ide…"* | "Done — `main` and `origin/main` are both at `99e771c`…" |
| 36 | *"Does the D&D GM Profile instruct the agent to mak…"* | "**No — and that's a real gap, not a nuance.** The oracle suite appears in the prompt layer only four times…" |
| 37 | *"Let's add a small table of tools x when to use to…"* | "Done — committed as `7ae64e7`, one ahead of `origin/main`…" |
| 38 | *"Let's also consider adding to our features docume…"* | "Committed as `ba4eb1a`. I had to research first — Jev and Laya were unfamiliar to me…" |
| 39 | *">Node ships ~1.7 GB fp32 Can't programmatically d…"* | "You were right, and my framing was sloppy. Committed as three focused commits…" |
| 40 | *"Another thing I'd like to add since we are dealin…"* | "Committed as `bbfb509`. The research changed the design in one important way… it doesn't belong in the dd35 b…" |
| 41 | *"For these features that depend on downloading loc…"* | "Committed as `a4ba03e`. That pointer was the most valuable thing in this whole thread…" |
| 42 | *"Let's also add a setting where the harness can ex…"* | "Committed as `0e8ef14`. I made it **GP-2** rather than a paragraph in GP-1…" |
| 43 | *">Which hook supplies the reply text? We could hav…"* | "Committed as `9b25f83`. It makes sense, with **one correction**…" |
| 44 | *"The toggle and settings should not be client-side…"* | — |
| 45 | *"What were we doing?"* | "Restored and verified. First, the damage report… **A derailed turn overwrote two files — fixed**…" |
| 46 | *">the projection route is the more DSH-native one.…"* | "Committed as `7745cd2`. GP-1 now has no open questions…" |

> **Turn 46 is the decision that caused the outage.** Choosing the "more DSH-native" session-projection
> route for the per-chat preference is what made the plugin append `tts/preference` to the session log.
> Everything from here on inherited that choice.

### Phase 2 — building GP-1 (turns 47–60)

The TTS plugin itself, largely executed as **autonomous goal rounds** — turns 48–58 and 60 carry no user
prompt at all; the agent ran its own plan, round after round, and reported at the end of each.

| # | Prompt | Response begins |
|---|---|---|
| 47 | *"Let's do GP-1"* | "GP-1 phase 1 is built, working, and committed (`6bc6d7b`) — but it produced a result that changes the plan…" |
| 48 | *(goal round)* | "Round 1 complete. Goal left **active**… **The variant question is closed.**…" |
| 49 | *(goal round)* | "Round 2 complete… **The bundle is installed and l…**" |
| 50 | *(goal round)* | "Round 3 complete… ## Phase 4a done — the per-chat preference. This was the right target: the **ses…**" |
| 51 | *(goal round)* | "Round 4 complete… ## Phase 5a — the instruction compiler…" |
| 52 | *(goal round)* | "Round 5 complete… **I found a bug I had already committed — and it was serious**…" |
| 53 | *(goal round)* | "Round 6 complete — phase 5 is now finished. ## Phase 5b — and a correction I had coming…" |
| 54 | *(goal round)* | "Round 7 complete — and the blocker I'd been carrying for six rounds turned out not to be one…" |
| 55 | *(goal round)* | — |
| 56 | *(goal round)* | "Round 9 complete… ## The HTTP surface — the prerequisite, now built…" |
| 57 | *(goal round)* | "Round 10 complete… ## The browser half — built, without a bundler…" |
| 58 | *(goal round)* | "Round 11 complete… ## The chat toggle's write path. It had no way to persist. The preference is a…" |
| 59 | *"What are we doing right now?"* | "I've been running autonomous goal rounds on **GP-1: a profile-global Kokoro text-to-speech plugin for DSH**…" |
| 60 | *(goal round)* | "## Where this landed **GP-1 is fully implemented.** All six phases are built and committed — 30 commits, still unpushed…" |

> **Turn 58 is where the poison was written** — the round that gave the chat toggle "a write path", which
> was `session.append('tts/preference', …)`.

### Phase 3 — live debugging, and the end (turns 61–64)

| # | Prompt | Response begins |
|---|---|---|
| 61 | *"Restarted and this is what I see. I'm giving you…"* | "Everything checks out. Here's what your screenshot told me and what I did… Those `4…" |
| 62 | *"Okay. Now it looks like this."* | "Good news first: **the route fix worked.** That error message was *mine*…" |
| 63 | *"Hell yeah. We should add a field in the plugin pa…"* | "## Why the button did nothing I found it, and it wasn't the button — **the host works perfectly**…" |
| 64 | *">\"input\" is 4337 characters; the limit is 2000 Ca…"* | *(no response — the turn never completed)* |

**Turn 64 was in flight when the session died.** The cache shows `openTurnStartSeq: 6759`, `openStep: null`,
a live `pendingCalls` entry, and a draft reading *"My shell quoting mangled the URL. Let me redo it cleanly
with a passage the size that failed (~4300 chars):"*.

That is inference from the projection state, but it fits everything: the last thing under discussion was a
4,337-character passage hitting the plugin's 2,000-character API limit, and the harness was restarted
mid-turn to load the newly written plugin code. **That restart is what surfaced the damage** — the event at
seq 6669 had been sitting in the log since turn 58/62, harmless in memory, fatal on a cold read.

---

## What the session actually produced

| Artifact | Path | State |
|---|---|---|
| The `dd35` preset | `dsh-dd35-preset/` — `tools.js`, `mechanics.js`, `reference.js`, `state.js`, `state-store.js`, `tables.json`, `cordis.patch.yml`, `memory-store.js`, `memory.js`, `package.json` | live, mounted as `@local/dsh-dd35-preset` |
| The preset architecture report | `docs/dd35-preset-architecture.md` | written at turn 23 |
| The preset backlog | `docs/dsh/dd35-future-improvements.md` | FI-1 … FI-17, two of them shipped |
| The plugin backlog | `docs/dsh/global-plugins.md` | GP-1, GP-2 |
| The TTS plugin | `/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-tts/` — 24 files incl. `plugin.js`, `kokoro.js`, `phonemizer`-backed pipeline, `delivery.js`, `tone.js`, `segment.js`, `route.js`, `client.js`, `preference.js` | live, mounted as `@local/dsh-tts` |
| Model cache | `$DSH_HOME/tts/models/kokoro/…` (q8 graph, 3 voices), `$DSH_HOME/tts/models/tone/…` | fetched during the goal rounds |
| The D&D campaign | `campaign/seventh_moon/` — 14 play turns, `state.json`, persona, character sheets | **untouched by the failure** (but see the note at the end) |

Commits named in the session's own reports: `6bc6d7b` (phase 1), `99e771c`, `7ae64e7`, `ba4eb1a`,
`bbfb509`, `a4ba03e`, `0e8ef14`, `9b25f83`, `7745cd2` — and turn 60's summary of *30 commits, still
unpushed*.

### Findings that outlived the session

The session was, more than anything, a long series of "measure, don't assume" corrections, and they are the
parts worth keeping:

- **Kokoro is not real-time on this host.** RTF ≈ 2.3–2.7 (fp32 measured *faster* than INT8 here, opposite
  to the published numbers, because the CPU has no AVX2/VNNI). Streaming synthesis cannot keep up; the
  per-message button became the primary interaction instead.
- **Kokoro has no instruction input** — the instructions field and the tone toggle are one feature (a
  compiler from intent to `{voice, speed}`), not two.
- **The tone classifier is affordable** — ~3 ms/token, ~2% of the synthesis it accompanies. A second model
  was assumed ruinous and was not.
- **A client bundle needs no bundler** — React comes from the shell's shared module table, so a plain
  self-registering `.js` is a legitimate client bundle.
- **A `link:`ed bundle does not get its dependencies installed**, and volatile Config fields arrive as
  accessors, not values.
- **And the last one, learned the hard way:** a session projection requires a session event, and a plugin
  cannot legally write one. See `docs/dsh/global-plugins.md` → *The session-projection route poisoned the log*.

### Near-misses recorded in the transcript

- Turn 45: *"A derailed turn overwrote two files — fixed."* A turn clobbered files and the damage was found
  and repaired inside the session.
- Turn 34: the requested work had not actually been committed; the discovery led to a real commit at `99e771c`.
- Turn 52: *"I found a bug I had already committed — and it was serious."*

Three self-inflicted incidents, all caught and fixed while the session was alive. The fourth — seq 6669 —
was not caught, because nothing was looking at the read path.

---

## What was left unfinished

- **Turn 64 never completed** — the 4,000-character-limit investigation was mid-flight.
- **The browser half's last control**: the per-message "speak" button was still being debugged at turn 63.
- **30 commits unpushed** — the profile had no push credentials throughout.
- **The archived session's own preference** (`auto: true`) is gone with it; the fixed plugin would read it
  from `$DSH_HOME/tts/preferences.json`, keyed by session id, which this archive will not have an entry for.

---

## Why it ended, in one paragraph

At turn 58 the plugin was given a per-chat preference and recorded it as a session event named
`tts/preference` — a type the harness does not ship. The persistence **read** path refuses such a row unless
its envelope carries `ignorable: true`, and `Session.append()` has no way to set that marker; the refusal is
correct, and the append-side validator that let the write through is not the seam that decides. The row sat
in the log as a live session for six more turns and killed the conversation the first time a **cold**
process tried to read it. The write path is fixed (the preference is now plugin-owned state), the failure
mode is documented, and two sessions paid for the lesson.

---

## Adjacent finding — the campaign log is not only play

Not about this session, but discovered while writing this report and worth recording next to it.

While grepping for references to a deleted script, the matches turned up inside
`campaign/seventh_moon/events/transcripts/` — turns **0012, 0013 and 0014** of the campaign are *this*
harness-debugging chat, not play:

| Turn | File header | Its "Player" text |
|---|---|---|
| 0012 | *The Wolves of Hurstwood (Thiago Lvl 15)* · 3 Years Ago Dusk · Hurstwood Eastern Postern | *"Wait. Explain to me whats up first"* |
| 0013 | *(same)* | *">So the doc's claim that the marker is available to a plugin is, right now, false…"* |
| 0014 | *(same)* | *"There. You have full access now"* |

The `dd35-memory` recorder fires on every completed main-agent turn in this workspace and stamps each
transcript with whatever `state.json` currently says. This chat never called `update_scene`, so the dev
turns inherited the **last play scene's** title, date and location, and `memory_index.json` folds them into
the existing `8–14 · The Wolves of Hurstwood` segment. `campaign_log.md` carries the same blocks.

The consequence is a recall problem, not a cosmetic one: a future DM searching memory for scene continuity
will be handed harness chatter presented as canon. Two things follow — the already-recorded turns want
removing (they are the newest, so simply deleting them leaves a contiguous 1–11 and the index can be
rebuilt), and the recorder needs a way to tell "playing" from "working on the harness", which it currently
has no concept of.

