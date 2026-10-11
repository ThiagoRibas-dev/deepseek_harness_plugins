# Meridian compaction fix — plan

Compaction against the Meridian Antigravity route always fails. The summarisation call the harness
makes is a replay of part of the conversation, and Meridian classifies that replay as a tool
continuation of a run it already delivered, then refuses it because the request is not that
continuation. The fix is for the connector to change the tool ids on compaction calls, so Meridian
has nothing it recognises.

This document records what is established, what the confirmation step failed to establish, and the
plan that follows from both.

Status: **plan only.** No code written.

## The failure

Two sessions, two symptoms, one cause.

`session-f0641a1f` ("seventh_moon campaign turn maintenance (1)") ran `/compact` manually, twice, on a
turn that had already completed:

```
333 turn/end        turn 8 completed
336 command/run     name: compact
337 compaction/start
338 compaction/end   Meridian refused this tool continuation because it no longer matches the turn it
                     already delivered ... (Pending Antigravity tool continuation changed its
                     delivered history or tool batch)
339 command/done     Compaction could not produce a useful summary.
```

`session-293cca94` failed differently, with `summarization produced no text summary content`, six
times in a row. That symptom is consistent with the same misclassification being *accepted* rather
than refused: Meridian hands the replayed conversation to the live Antigravity session, the model
answers the conversation instead of writing a summary, and the harness finds no summary text. The
two symptoms are two branches of one decision.

## What is established

**The compaction request was classified as a tool continuation.** The error text occurs exactly once
in the whole backend, at `antigravity.ts:87`, inside the branch that runs only when the tool results
trailing the request's last assistant message map to a run Meridian still tracks. Reaching that line
requires `owners.length > 0`. This is certain from the message alone, and it is the fact the fix
depends on.

**The bookkeeping is keyed by tool id, not by session.** `toolOwners` is a single flat map on the
runtime, `readonly toolOwners = new Map<string, AntigravityRun>()` at `antigravityRuntime.ts:391`, and
the lookup is `runtime.toolOwners.get(result.tool_use_id)`. Session identity is not part of the key
and not part of the lookup. Sending compaction calls under a different `meridian_session_key` would
therefore change nothing, which is worth stating because it is the first idea most people have.

**Ownership leaves the map on exactly two paths.** `accept()` deletes each id as it consumes the
result (`antigravityRuntime.ts:315`), and `abort()` deletes every outstanding id
(`antigravityRuntime.ts:331`). There is no other removal.

**Normal turns are unaffected.** They echo back the batch Meridian delivered moments earlier, with
every result for that batch, and with nothing before the last assistant message changed. Meridian
checks three things at `antigravity.ts:86` — the number of results, the set of ids, and the hash of
the prefix — and all three hold. The request genuinely is that continuation, so it is accepted and
the ids are deleted.

A compaction request is the opposite. It is a replay of old messages, so the ids it carries belong to
deliveries that are long finished, and it is not the continuation of any of them. The same three
checks run and cannot pass, because a region selected by token budget carries a subset of a batch
rather than all of it, and because the summariser appends an instruction that was never delivered.

## What the confirmation step did not establish

I had a specific hypothesis for why those ids were still in the map, and the confirmation step
falsified it rather than confirming it.

The hypothesis was that an earlier continuation took the recovery path. `recoverResults` in
`antigravity.ts` marks the tools consumed but does **not** delete them from `toolOwners`, so a
recovery would leave ids registered that later look like a live pending batch. I expected to find a
recovery, a retry, or an interrupted continuation behind the failing compaction.

`session-f0641a1f` contains none of that:

| Checked | Result |
| --- | --- |
| `request/header` events | one, at seq 12, reason `initial` — no `change`, `resume` or `series` |
| `llm/retry` / `llm/retry-started` | none |
| tool calls vs results | 51 calls, 51 results, every call paired |
| turns | all eight completed; the only errors are the two compaction attempts |

So this session shows no interruption, no retry, no contract change, and no abandoned batch. If every
batch was accepted and `accept` deletes what it consumes, the map should have been empty by the time
`/compact` ran, and the request should have taken the `owners.length === 0` path and started a fresh
run. It did not.

**Why the ids were still registered is therefore not explained.** The established facts are that the
request *was* treated as a continuation and that the lookup is id-based; the account of how the ids
survived is incomplete. That matters for the plan, and it is why the plan opens with a diagnostic
rather than with the change.

## The fix

### Step 0 — Diagnostic first

The change below rests on an incomplete account of the bookkeeping, so before or alongside it the
connector should record what a failing compaction call actually carried. The narrow version is to log,
when a 409 with this provider message is classified, the call's purpose and the number of tool results
trailing the last assistant message, along with their ids. That distinguishes the two cases that
matter: a request whose trailing ids are a subset of a delivered batch, and a request whose trailing
ids should not be known to Meridian at all.

The diagnostic is small, it is off the critical path, and it converts the next failure into evidence
rather than another hypothesis.

### Step 1 — Rewrite the ids on compaction calls

For a call whose purpose is compaction, walk the messages the harness supplied. For every tool call
block, mint a new id and record the mapping from the old id. Then rewrite every tool result that
refers to an old id so that it refers to the new one. Pairing is preserved, the shape and content of
the conversation are untouched, and the only thing that changes is the identifier.

Conversation calls are not touched at all. The harness already marks these calls, setting
`purpose: 'compaction'` on the options it passes to the adapter, so the distinction is available
without inference.

### Step 2 — Make the new ids deterministic

The new ids must be derived from the old ones, not generated fresh. Our own idempotency ledger keys
the `idempotency-key` header on a hash of the request bytes, and Meridian refuses a request id that
arrives with different bytes. A randomly rewritten request would therefore present the same
idempotency key with different content on any retry, and be refused as a reused request id. Deriving
each new id from the old one with a hash keeps one logical compaction call byte-stable across
retries while still being unrecognisable to the owner map.

This constraint is easy to miss and would only show up under a transport retry, which is exactly when
it is hardest to diagnose.

### Step 3 — Drop the tools from compaction calls

Compaction calls currently advertise the conversation's full tool schemas, because the summariser
reuses the conversation prefix to keep the provider's cache warm. That means the summarising model can
decide to call a tool while it is supposed to be writing a summary. A summarisation has nothing to
call, so the tools should not be advertised at all.

This is a change to the same request, so it belongs in the same commit and the same tests. It is also
likely to reduce the token cost of every compaction.

### Step 4 — Placement

The transformation belongs in request serialisation, which already receives the call options alongside
the connection. One function that either returns the messages unchanged or returns them rewritten
keeps it testable on its own and keeps the transport code unaware of it.

### Step 5 — Tests

Offline first, over the pure transformation:

- a message list containing tool calls and their results comes back with new ids and intact pairing;
- running it twice over the same input produces identical output, which is the determinism
  requirement from step 2;
- a message list with no tool results comes back unchanged;
- a call whose purpose is not compaction comes back unchanged, byte for byte.

Then the live check, which is the only real proof: run `/compact` on a session using Meridian and
confirm a summary is produced. The sessions that are currently failing are the natural test.

### Step 6 — Live verification

Run `/compact` on an existing D&D session, confirm the command reports success rather than
"Compaction could not produce a useful summary", and confirm the resulting `compaction/summary` event
contains text that actually summarises the region. Then check the surrounding turns still complete,
so the change has not disturbed ordinary conversation traffic.

## Risks

The ids are not purely internal. They appear in the conversation the model sees, and a model could in
principle refer to one in text, which would then match nothing downstream. Nothing is executed from a
compaction call, so this seems acceptable, but it is the thing to watch in the live test rather than
assume away.

The second risk is that this treats a symptom. If the diagnostic in step 0 shows the trailing ids
should not have been known to Meridian at all, then the real defect is in the bookkeeping rather than
in the compaction request, and the id rewrite would be masking it. That is the outcome the diagnostic
is there to catch.

## Alternatives

**Route summarisation to a different provider.** The compaction config already has
`summarizationProvider` and `summarizationModel`, and setting them to DeepSeek avoids Meridian
entirely. It is two lines, needs no code, and works today. It is also the right thing to do while
this plan is being implemented. The cost is that summaries then consume DeepSeek tokens and are
written by a different model than the one holding the conversation.

**Fix it upstream.** The summariser replaying delivered tool results verbatim under the same session
identity is the underlying design question, and any backend that tracks what it has delivered will
run into it. Replacing tool results with placeholders in the summarisation replay, or declining to
compact a range whose tail belongs to a live or recent delivery, would fix it for every backend at
once. Neither is possible without editing harness source.

## Open questions

1. Why were the ids still registered at compaction time? The diagnostic in step 0 should answer this
   on the next failure.
2. Should compaction calls keep the conversation's `max_tokens`, or use their own? This is separate
   from the id problem but also part of the contract Meridian compares.
3. Does dropping tools (step 3) measurably change summary quality? It should not, but summaries are
   the one place where a model might legitimately want to ask for something.
