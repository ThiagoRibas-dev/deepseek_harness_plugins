# Meridian spent-batch durability — findings and plan

*Started from a live failure on 2026-10-05. **Everything in this document is now
implemented and tested** — the first three fixes (§4) and the two follow-up bugs
found afterwards in Meridian's own ledger (§6), plus the dropped-agent code. §7 is
kept as the record of how each was built. Read §6 first if you only read one
section.*

*Status: connector suites green — spent-batch **20/0**, client **10/0**,
conformance **55/0**, `node --test` **55 pass**; dd35 **46 pass**. Every new behaviour was checked by
mutating it back out; each mutation fails the intended check (§7).*

---

## 1. The incident

`session-4a0221dd-88cd-49ed-8e0e-dea35056f540` (the original "Let's continue our
campaign where" session), turns 6–8:

1. Turn 6 step 1: model calls `update_scene`; Meridian delivers the tool_use and the
   harness returns the result.
2. Turn 6 step 2: the continuation carries the result. **Meridian consumes the batch**
   (`accept()`), then Antigravity's output filter blocks the reply:
   `stream ended before message_stop (Your previous response was blocked by content
   safety filters … Prohibited Use policy)`, code `TRANSPORT`.
3. `lib/errors.js` `streamInterrupted()` mapped everything non-quota to `TRANSPORT`,
   whose in-code rationale was *"safe because no tool block is ever delivered before
   `message_stop`"* — true about tool blocks, and silent about the fact that the
   **request side already consumed the batch**.
4. The harness retried (`TRANSPORT` is retryable) → Meridian 409s:
   `Antigravity tool result was already consumed; append the subsequent assistant
   response before continuing` → `MERIDIAN_CONTINUATION_CONFLICT`, permanent.
5. The transcript tail stays a tool result with no assistant message, so every later
   turn is refused identically. **Dead session.**

**Correction worth keeping:** the retry did *not* create the deadlock. Without it,
turn 7 would still 409. Retry only arrives sooner with a worse message. **Repair is
the fix; classification and retry are hygiene.**

The user then forked repeatedly; fork (2) got through only because its model
happened to answer with text instead of calling a tool — luck, not a fix.

---

## 2. Meridian's state store (the discovery)

Meridian is **not** containerised. It is a plain Node process on **this** host
(hostname `openmediavault`; `http://openmediavault:3457` is localhost):

```
node /root/.local/share/pnpm/global/v11/<hash>/node_modules/@rynfar/meridian/dist/cli.js
```

Its state, all readable:

```
/root/.local/state/meridian/
├── antigravity.sqlite                       ← ag_state, 1332 rows
├── antigravity.sqlite-wal                   ← 4.1 MB, actively written
└── antigravity-workspaces-158191e5aaca/
    └── conversation-SGBl0S/                 ← per-conversation agy workspace
        ├── policy.cjs        (3180 B)       ← likely where the content filter is configured
        ├── policy-audit.jsonl
        ├── .agents/{hooks.json,mcp_config.json}
        └── attachment-paths.json
```

**Schema:** `ag_state(kind, id, scope, json, bytes, expires)`, PK `(kind,id)`, index on
`expires`. Kinds: `exchanges` (1242, keys are `msg_agy_*`), `native` (88),
`completed-answers` (1 — the saved answer used by `x-meridian-replay-only`),
`native-sessions` (1).

**An `exchanges` row is a per-request ledger entry — metadata, not content:**

```json
{ "conversationId": "6c1145da-…", "continuation": "tool-result",
  "requestId": "msg_agy_128a5a4b…", "timestamp": 1791221253164,
  "durationMs": 30502, "model": "gemini-3.1-pro-high", "status": 502,
  "error": "Your previous response was blocked by content safety filters: …",
  "inputTokens": …, "outputTokens": …, "cacheReadTokens": … }
```

**It records the shape and outcome of every request, never the message bytes.** So it
answers *whether* history moved, not *what* moved.

### Querying it

```bash
DB=/root/.local/state/meridian/antigravity.sqlite
sqlite3 -readonly "$DB" "select kind, count(*), sum(bytes) from ag_state group by kind;"
```

Per-request view (columns live inside the `json` text column):

```sql
select datetime(json_extract(json,'$.timestamp')/1000,'unixepoch') as t,
       json_extract(json,'$.conversationId')  as conv,
       json_extract(json,'$.continuation')    as continuation,
       json_extract(json,'$.status')          as status,
       json_extract(json,'$.durationMs')      as ms,
       json_extract(json,'$.inputTokens')     as input,
       json_extract(json,'$.cacheReadTokens') as cacheRead,
       json_extract(json,'$.outputTokens')    as output
from ag_state where kind='exchanges'
order by json_extract(json,'$.timestamp') desc limit 30;
```

---

## 3. What the ledger showed

```
continuation × status                    statuses        errors
  tool-result  200  x929                  200 x1197       [502] x22  agent connection interrupted
  new          200  x201                  502 x24         [499] x15  Request cancelled
  restored     200  x56                   499 x15         [429] x4   quota reached
  live         200  x10                   429 x4          [504] x2   turn timed out
  new          502  x22                   504 x2          [502] x2   CONTENT SAFETY FILTER
  new          499  x10
  tool-result  499  x5
  new          429  x4
  tool-result  502  x2   ← the incidents
  tool-result  504  x2
  client-context-replay 200 x1           ← the harness's replay-only recovery, worked
```

Meridian classifies every request as `new` / `restored` / `live` / `tool-result` /
`client-context-replay`. The two content-filter blocks are **`tool-result`
continuations with status 502**.

### Corroboration from the harness side

In the recap session (`session-e6c33b55`, the `(1)` fork) the DM answered a
"climbing on the bed" prompt with a **bathtub** scene, and invented an oracle result it
never rolled (turn 6 made zero tool calls). The harness log showed
**`cacheReadTokens: 0` on every turn from turn 3 onward** — the backend rebuilt the
conversation every request — and the prompt swung **93,013 → 43,094 → 65,528** tokens
across turns 4→6 with no new tool calls and no compaction. Pruning can account for at
most ~14K of that; the rest is unexplained. The ledger can now be used to check the
same numbers from Meridian's side.

---

## 4. Shipped in the first pass — verified

Implemented in `plugins/dsh-meridian-antigravity/`, all with tests. **§6 extends all
of this**; the line counts below are the first pass only.

| | Change |
|---|---|
| `lib/failure.js` (new, pure) | `isContentFiltered`, `isSpentBatch`, `spentBatchNotice`, `NOTICE_PREFIX` |
| `lib/errors.js` | `CONTENT_FILTERED` branch in `streamInterrupted` (before the `TRANSPORT` fallback); `batchSpent()` builds `MERIDIAN_BATCH_SPENT` |
| `lib/config.js` | `repairSpentBatch` (boolean, default `true`) |
| `lib/transport.js` | tracks `accepted` (a 2xx); repairs the spent tail by yielding a notice instead of throwing; `spentIfContinuation()` upgrades a cut stream on an accepted continuation |
| tests | `tests/failure.test.js` (6, plain `node --test`), `tests/spent-batch.mjs` (7, wired into `tests/run.sh`) |

Proven load-bearing: disabling the three new behaviours fails 3 of the 7 spent-batch
checks. **The user restarted after these — they are live.** Current totals are in §7.

---

## 5. Related work shipped in the same session

- **`dsh-context-pressure`** — the notice now declares `kind: 'context-pressure'`
  instead of `kind: 'user'`, which had made it indistinguishable from a player prompt
  (it was being recorded in `campaign_log.md` as the player's own words).
- **`dsh-dd35-preset`** — `isPlayerMessage` now requires a client-minted `rpcId`;
  **`isConnectorNotice`** skips capture when the DM output is only a connector notice
  (otherwise the spent-batch repair notice would enter the campaign record as
  narration); `dm_notes.md` guidance now forbids anything that changes turn to turn.

**⚠ Written after the user's restart, so NOT live yet:** the dd35 notice guard, the
`NOTICE_PREFIX` refactor, the `dm_notes` guidance. Needs one more restart.

---

## 6. Follow-up bugs found in the ledger — all fixed

### Bug 1 — the content filter is only handled on one transport path — **FIXED**

`streamInterrupted` covered the in-stream error. The ledger shows Meridian records
the block as **HTTP 502**, and `meridianError()` has:

```js
if (status === 504) return new LlmError(message, 'TIMEOUT', facts)
if (status >= 500) return new LlmError(message, 'SERVER', facts)   // ← retryable
```

`SERVER` is retryable, so a 502 carrying the policy text was retried and reached
the spent-batch refusal — the same deadlock, on the other path.

**Shipped:** the body is read before the status. `meridianError` now tests
`isContentFiltered(detail)` ahead of the `504`/`5xx` branches and returns
`CONTENT_FILTERED`. The message is built once, by a new `contentFiltered(detail,
facts)` helper that `streamInterrupted` also calls, so the two paths cannot drift.
The regex's third alternation was tightened from `could not be generated` to
`model output could not be generated`, because the HTTP path now feeds whole
gateway bodies through it.

### Bug 2 — the spent-batch guard is narrower than it should be — **FIXED**

`spentIfContinuation()` only fired when `accepted` was true, and `accepted` was set
**only after `dispatch` returned a 2xx**. A non-2xx threw before that line, so:

> **a 502 on a `tool-result` continuation was classified `SERVER`, retried, and
> could spend the batch — the same trap, reached through the HTTP path instead of
> the streaming one.**

The 22 × 502 "connection to the agent was interrupted" all landed on `new`, so
retrying was harmless — **by luck, not by design**. One landing on a `tool-result`
kills a session.

**Shipped:** the flag was renamed and its meaning changed to *"Meridian answered
this request at all"*. `dispatch` was split: `sendMessages()` returns the response
whatever its status and is the **only** place a connection failure becomes an
error, while the caller classifies a non-2xx. `spentIfContinuation` now upgrades
any recoverable failure on a continuation once `reachedMeridian` is true, and the
idle-stall path (which previously threw before the guard) is routed through it
too. A stall that fires while connecting, and a connect failure, both keep their
retryable code — nothing can have been consumed, and that distinction is the whole
reason the flag exists.

### Bug 3 — aborted continuations lean on the repair — **FIXED (tested, no code change)**

499 × 15, **five on `tool-result`**. A cancelled continuation may also have spent
its batch. The connector throws `ABORTED` without repairing, so that class depends
entirely on `repairSpentBatch` healing it on the *next* turn.

**Shipped:** deliberately still no repair on abort — a cancelled turn is the
operator's decision, and committing a notice on it would rewrite history nobody
asked to change. The dependency is now **tested**: an aborted continuation is
followed by a request that meets the spent-batch 409, and the repair answers it.
Disabling `repairSpentBatch` fails that check.

### Signal (not a bug) — 22 dropped agent connections — **FIXED**

`[502] x22 "the connection to the agent was interrupted before the response
finished"` was the most frequent failure and was lumped into `SERVER`, invisible.

**Shipped:** `isAgentInterrupted` in `lib/failure.js` and a
`MERIDIAN_AGENT_INTERRUPTED` branch in `meridianError`, placed with the other
body-driven 502. It is **retryable exactly as `SERVER` was** — the code is signal,
not policy — and a check asserts that, so a later edit cannot quietly make the
connector's most common failure permanent. `isRecoverable` learned it too, or the
same-identity replay recovery would have stopped being attempted.

### Bug 4 — the repair became unreachable in the case it was written for — **FIXED**

*Found live on 2026-10-05 at 20:03, in `session-45365d66` ("Review Active Campaign
Log Events"), after Bugs 1–3 were written but before a restart loaded them. The
in-stream first pass — `CONTENT_FILTERED` and `repairSpentBatch` — was live.*

The user asked the agent to fix the campaign log's frozen metadata blocks. The
generation was blocked, and the turn ended `CONTENT_FILTERED`. The transcript was
left ending on a tool result, and it stayed that way.

What made this different from §1: **the block arrived late.** The request ran
62,002 ms, the model streamed 55 text chunks totalling 1,250 characters — a
complete refusal plus a three-step manual remediation plan — and the filter then
failed the turn at the `finish`. `ag_state` records it as `tool-result × 502`,
`outputTokens: 3130`. The turn 1 answer had meanwhile *quoted* the log's explicit
text verbatim and passed the filter, so the block is post-hoc and inconsistent: it
killed a refusal.

The harness committed no `assistant/message`, so the delivered text survived only
in the `assistant/attempt` diagnostic record and was never sent to the model again.
And the repair could not fire, for a reason that is entirely of our own making:

> The repair keys on Meridian's `"already consumed"` 409. That 409 is produced by
> **refusing a spent continuation**. Making the content filter non-retryable
> (Bug 1's fix, shipped in the same release) removed the retry that used to deliver
> it. So on a blocked continuation the 409 never arrives, `isSpentBatch` never
> matches, and the repair is unreachable — in exactly the case it exists for.

Confirmed by the ledger: one row for that request, no follow-up, and no 409
anywhere in `ag_state`. (The refusal is real — a 409 `invalid_request_error` in the
09-27/28 ancestor history and again in `session-4a0221dd` — but Meridian refuses
*before* writing the `exchanges` row, so the repair's trigger can never be audited
from the ledger.)

**Shipped:** the repair now also fires on a `CONTENT_FILTERED` failure that has a
continuation. Because a blocked turn can arrive after the model has already
answered, the delivered text is **kept**: `MeridianTranslator.closeWith(text)` closes
the open text block with what was streamed and appends the notice as a second block,
so a reply cut mid-word cannot read as prose running into the notice, and no usage is
reported because a cut stream never reaches the terminal totals. A new
`blockedReplyNotice` says the text above may be incomplete. A block on an *ordinary*
turn is still reported rather than repaired — nothing is stranded there. This also
retired the hand-built `spentBatchChunks`, which `closeWith` subsumes.

`dsh-dd35-preset`'s `isConnectorNotice` was widened with it: the marker is now
matched at the start of **any** line rather than only the first, because a salvaged
turn carries the model's text and the notice in separate blocks. Matching it
anywhere would be wrong — prose that merely mentions the connector is narration, and
a test says so.

Two live sessions hit this class (`session-45365d66` and `session-89b7c212`, both
`inheritedEventCount: 0`), and **both dead-ended and were never resumed**.

---

## 7. As implemented

All in `plugins/dsh-meridian-antigravity/`, in the bundle's style (2-space, single
quotes, no semicolons, JSDoc explaining *why*).

### `lib/failure.js`

- `isContentFiltered` kept and reused on the HTTP path. Its third alternation was
  tightened to `model output could not be generated` — the HTTP path feeds whole
  gateway bodies through it, and `could not be generated` alone also appears in
  ordinary gateway prose.
- `isAgentInterrupted` added, with the verbatim ledger detail as its fixture.

### `lib/errors.js`

- `contentFiltered(detail, facts)` extracted as the one builder of the
  `CONTENT_FILTERED` message; `streamInterrupted` now calls it instead of inlining
  the text.
- `meridianError` reads the body **before** the status: `isContentFiltered(detail)`
  and `isAgentInterrupted(detail)` are tested ahead of the `504`/`5xx` branches.
- `meridianErrorFromText` reads the same two conditions out of a **non-JSON** body.
  Without that, a gateway passing Meridian's wording through verbatim bypassed
  `detail` entirely and the 502 fell back to retryable `SERVER` — the hole the JSON
  fix had just closed. Only those two are read from a raw body: a 409 with no
  envelope still stays the conservative `MERIDIAN_UNCERTAIN_OUTCOME`, which is what
  *a 409 with no readable provider message* guards.

### `lib/transport.js`

- `dispatch` split into `sendMessages` (returns the response at any status; the only
  place a connect failure becomes an error) plus caller-side classification of a
  non-2xx.
- `accepted` → `reachedMeridian`, set the moment a response arrives, whatever its
  status.
- The idle-expiry throw now goes through `spentIfContinuation`, so a stream that
  stalls after Meridian has the request is not retried as a plain `TIMEOUT`.
- `isRecoverable` gained `MERIDIAN_AGENT_INTERRUPTED`.

### `lib/config.js`

- `MERIDIAN_AGENT_INTERRUPTED` added to `DEFAULT_RETRY_POLICY.retryableCodes`, with
  the reason it is not a policy change.

### `lib/stream.js` and `lib/transport.js` (Bug 4)

- `MeridianTranslator.closeWith(text)` closes the open text block with what was
  streamed, appends the notice as a fresh block, drops any withheld tool block, and
  finishes `stop`. Replaces the hand-built `spentBatchChunks`.
- The repair condition takes `spent || blocked`, where `blocked` is
  `CONTENT_FILTERED` **and** a continuation.
- `blockedReplyNotice(results)` added beside `spentBatchNotice`; the transport picks
  between them on whether the translator streamed any text.

### `dsh-dd35-preset/memory.js`

- `isConnectorNotice` matches the marker at the start of any line, so a salvaged
  reply-plus-notice turn stays out of the campaign record.

### Verification — every new behaviour is load-bearing

Reverting each change in a throwaway copy of the plugin fails exactly the intended
checks:

| Mutation | Checks that fail |
|---|---|
| delete the HTTP-path content-filter branch | *a blocked generation is CONTENT_FILTERED* (stream), *a 502 carrying the policy text is CONTENT_FILTERED* |
| `spentIfContinuation(…, false)` (2xx-only guard) | *a cut stream on an answered continuation…*, *a 502 on a continuation…* |
| delete the `MERIDIAN_AGENT_INTERRUPTED` branch | *a dropped agent connection gets its own retryable code* |
| `repairSpentBatch: false` | *the connector stands in for a reply…*, *an aborted continuation is healed…* |
| loosen the regex back to `could not be generated` | *a generic "could not be generated" is not claimed as a content filter* |
| idle path thrown without the guard | *an idle stream stall on a continuation is MERIDIAN_BATCH_SPENT* |
| `reachedMeridian` set unconditionally | *a cut stream that never reached Meridian…*, *a stall before Meridian answers…* |
| disable the non-JSON body read in `meridianErrorFromText` | *a non-JSON 502 body carrying the policy text…* |
| classify the capped `detail` instead of the whole body | *the policy text is found past the message-length cap* |
| require `spent` only (drop the blocked-continuation arm) | *a blocked continuation is repaired…*, *a reply the filter cut late is kept…* |
| make `closeWith` discard the open block | *a reply the filter cut late is kept…* |
| narrow dd35's `isConnectorNotice` back to `startsWith` | *the notice prefix is recognised…* (dd35), *a salvaged reply carrying an appended notice…* (dd35) |

**Fixtures are verbatim.** The content-filter text and the agent-interruption text
both come straight out of the ledger:

```bash
DB=/root/.local/state/meridian/antigravity.sqlite
sqlite3 -readonly "$DB" "select json from ag_state where kind='exchanges' and json_extract(json,'\$.status')=502;"
```

### Suites

```console
$ cd plugins/dsh-meridian-antigravity
$ DSH_INSTALL_ROOT=/export/DownloadsSSD/AI/TEXT/deepseek-harness ./tests/run.sh
  10 passed, 0 failed        # client
  serialize-compaction: ok
  serialize-notices: ok
  20 passed, 0 failed        # spent-batch  (was 7)
  55 passed, 0 failed        # conformance
$ node --test tests/*.test.js
  55 pass                    # was 50; failure.test.js 6 → 11
```

---

## 8. Open threads

- **Resolution of the former top item.** This section used to lead with "does the
  next request really get the 409?", and the answer stopped mattering: the live
  20:03 incident showed the retry that produced that 409 is gone, so the repair now
  fires directly on a blocked continuation (§6, Bug 4). The derived question — does
  a stale spent batch also block the following user turn — is still unanswered, and
  no longer load-bearing, because the block is now repaired on the turn it happens.
- **`MERIDIAN_AGENT_INTERRUPTED` retryability is asserted at the policy list, not
  observed end-to-end.** The check reads `connection.retryPolicy.retryableCodes`, which
  proves the connector declares it; it does not drive the harness retry loop. Same
  limitation for every other code — worth knowing before reading a green suite as proof
  the harness retries.
- **A repaired turn reports no usage.** A salvaged blocked turn delivered real model
  output, but a cut stream never reaches the terminal usage totals, so the connector
  sends none. Cost accounting for those turns is Meridian's ledger, not the harness.
- **`MERIDIAN_BATCH_SPENT` still errors rather than repairing.** A cut stream on a
  continuation that recovery cannot complete also leaves the transcript on a tool
  result, so by the same argument it could commit the notice too. Left alone
  deliberately: it is a separate decision with its own test, and changing two things
  at once would make the next live result ambiguous.
- **Request bodies are no longer nowhere.** `exchanges` is metadata only; Meridian's activity API
  (`/providers/status`) is counts only; `agy` is not on this host (the D&D35 workspace
  has a Windows launcher, `run-antigravity.bat`). The config-flagged dump in the connector now exists:
  `captureRequestBodies` + `captureDir` + `captureMaxFiles`, off by default, one file per dispatch,
  bounded, pruned, and never fatal. See §9.3. **`policy.cjs` is now read and is *not* the content
  filter** — it is a tool allow-list hook (`allow`/`deny` per `toolCall`, writing
  `policy-audit.jsonl`), and its baked-in allow-list matches the current dd35 tool names
  (`roll_check`, `roll_monster_behavior`). It neither configures nor can lift the safety filter. The
  `policy-audit.jsonl` in that workspace is 0 bytes, so nothing has been denied yet.
- **Prompt swing unexplained.** 93K → 43K → 65K tokens with no compaction and no new
  tool calls. Pruning accounts for ≤14K. Use the ledger query in §2 to check it from
  Meridian's side before writing any code.
- **`dm_notes.md` staleness** — guidance fixed, but the campaign's existing file still
  opens with a `## Current State` block from three sessions ago, and everything in that
  file is re-injected as authoritative on every request.
- **A branch is not a fresh session** — `fork` truncates history with no in-session
  marker. Recorded in `docs/chat-controls-implementation-plan.md` Phase 7.
- **The restart was done on 2026-10-07 13:55.** It loaded the §5 dd35 notice guard and `dm_notes`
  guidance, the compaction-guard `preset-standard` override, and the refused-continuation repair.
  §9 is what is still owed after it, and what it already settled.

## 9. Live verification — the restart checklist

The web service restarted on 2026-10-07 13:55, which loaded everything in §6/§7 plus the
compaction-guard `preset-standard` override and the refused-continuation repair. One item below is
already settled; the rest are still owed, and the harness has emitted no journal lines since the
restart, so all of it has to be read from session JSONL rather than from logs.

**Settled 2026-10-07: the two absolute `file:///` URLs import under the loader.** `preset-dd35`
declares the identical strings, and 77 of 84 `dd35` sessions ran dd35-scoped tools (`get_state`,
`list_memories`, `roll_*`), most recently at 03:18 that day. A preset tree with one unresolvable row
refuses to mount as a whole, so those rows import. The `standard` override names the same two files
with the same strings.

### 9.1 The guard reaches a `standard` session

1. `plugin_manager action=list_plugins`. This settles the host plane only: expect the host-plane
   `compaction-basic` and `tool-result-pruner` rows `enabled: false`, and `compaction-guard-engine` /
   `compaction-guard-pruner` present with their config. **It says nothing about a preset.**
   `preset-standard` reports `fiberPhase: active` whether or not its children imported, because
   `agent-preset-registry` catches a child-mount failure into its own `broken` record and only calls
   `logger.warn` (`packages/preset/agent-preset-registry/src/index.ts:112-125`). The harness journal has
   emitted no lines at all between restarts, so that warning is not observable either.
2. Start a **new** session on the `standard` preset. That it composes at all is the first real check: a
   preset tree with one unresolvable row refuses to mount. Existing sessions keep the plugin revision
   they started with, so an old session proves nothing.
3. In it, run a turn with enough tool calls to raise context pressure, then read the session JSONL for
   `compaction/prune`. Two things are worth knowing about this check, both learned the hard way:
   - a `compaction/prune` between an `assistant/message` carrying a tool call and its `tool/result` is
     the failure signal;
   - **the absence of one is weak evidence.** No `dd35` session has pruned since 2026-10-04 14:38, so a
     guarded realm that never prunes looks identical to one whose pruner is broken. What would settle it
     is a prune landing at a *turn boundary*, which the guard permits by design.
   - **and the deferral is already disproven once.** Four `dd35` sessions pruned on 2026-10-04 13:12–14:38
     after the guarded patch was declared *and* after the restart that read it, each with the surface
     ending on an unanswered tool result. Full evidence and the decisive experiment are in
     `plugins/dsh-compaction-guard/README.md`. Do not treat a `standard` session that never prunes as
     confirmation of anything.

### 9.2 The repair makes the next request ordinary again

`session-0bc7fee5` ("Passive RAG for D&D Recap") is the ready-made case: its prefix was already
rewritten when turns 4-7 were refused, and its transcript still ends on an unanswered batch — the last
assistant message is seq 217 and the tool results at seq 219 and 222 have nothing after them.

1. Send any message. Expect the turn to end `completed` with a `[Meridian Antigravity]` notice instead
   of `turn/end` carrying `MERIDIAN_CONTINUATION_CONFLICT`.
2. Send a **second** message. This is the decisive observation.
   - It reaches the model: the repair restores continuability, and nothing further is needed.
   - It ends in `MERIDIAN_CONTINUATION_CONFLICT` again: the repair is cosmetic for a rewritten prefix,
     because the notice the connector commits was never delivered to Meridian and the divergence is
     permanent. The notice then has to say so and name the remedy — fork from before the affected turn
     — and the case for talking to `agy` directly gets stronger.

   A single success is not proof of the first outcome: turn 8 of that session was accepted on a prefix
   identical to the one turns 5-7 were refused on, seven seconds after turn 7, with no prune in
   between. Whatever cleared there is not understood. What matters for the notice is only the binary
   above, not which mechanism produced it.

### 9.3 If it fails, capture the evidence

Set `captureRequestBodies: true` and `captureDir: <a directory outside the repositories>` on the
`llm-meridian-antigravity` row and repeat. Two consecutive captures differ in exactly the messages that
moved; the files are complete transcripts and are pruned to the newest 50. This is the material that
decides whether the connector keeps translating for Meridian or talks to `agy` itself.
