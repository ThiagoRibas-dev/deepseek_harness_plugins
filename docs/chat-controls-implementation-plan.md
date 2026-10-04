# Chat controls plugin — implementation plan

A DSH plugin adding chat-frontend controls: edit past turns, reroll replies, continue without a user
message, impersonate, and related transcript operations.

Status: **plan only, nothing built.** Everything below was verified against the installed harness at
`/usr/lib/node_modules/@deepseek-ai/dsh-root` (the code that actually runs), not just the checkout.

## 1. Verified primitives

Each row is the mechanism a feature depends on. All confirmed present in the installed harness.

| Primitive | Where | Note |
| --- | --- | --- |
| Positional surface replacement | `core/session/src/types.ts:464` | `{ op: 'replace', startSeq, endSeq }`; `startSeq === endSeq` replaces one node. |
| `Session.append(type, data, opts)` | `core/session/src/index.ts:720` | `opts` is `SurfaceIntent` carrying `surfaceOp` and `sourceEventSeqs`, and exists only for surface event types. |
| Shadow-coverage rule | `core/session/src/surface.ts:369` | `sourceEventSeqs` must list **every** shadowed surface node, or the append throws. |
| Replacement-specific rules | `core/session/src/surface.ts:543-545` | `assertSourceEventReferences`, `assertToolResultRewrite`, `assertSystemHeadRewrite` run per replacement. |
| `Agent.followup / steer / inject / send / whenIdle` | `core/agent-loop/src/agent.ts:153-236` | Runtime face for driving a turn from outside the loop. |
| `Agent.runMaintenance(job)` | `core/agent-loop/src/agent.ts:182` | How to mutate history outside a turn. Compaction uses it. |
| `AssistantStreamAccumulator` / `assembleAssistantStream` / `AssistantStreamRecord` | `llm/llm/src/assistant-stream.ts:100,425,20` | Build a legitimate assistant event the way the loop does. |
| `session.fork(source, boundary?, childSessionId?)` | `core/session/src/index.ts:1237` | Branching already shipped. |
| `conversation.chat.turnTail` (list, session) | `client/ui-chat/src/client/contract/slots.ts:265` | Turn-level controls. |
| `conversation.chat.assistant-actions` (list, session) | `client/ui-chat/src/client/contract/slots.ts:271` | Per-finalized-assistant-message actions. |
| `conversation.chat.node` (keyed) / `conversation.chat.commandview` (keyed) | same file, `:240` / `:259` | Custom transcript rows; command rows. |
| `conversation.input.overlay`, `conversation.composer.dock` | installed client | Dialogs and composer-area controls. |
| `ctx.commands.register(definition)` | `interaction/commands/src/index.ts:285` | Host command registry. |
| `CommandInvocation.agent` | `interaction/commands/src/index.ts:41-61` | **A command handler receives the Agent directly.** This is how the host half reaches the loop. |
| `commands.execute(agent, line, attachments, signal)` | `interaction/commands/src/index.ts:361` | `@Remote`, so it is reachable from the browser. |
| Browser call: `ctx.remote.commands.execute(sessionId, line, attachments)` | `client/ui-commands/src/client/service.ts:406`, `client/ui-plan/src/client/index.ts:122` | The client-side form. `ui-plan` calls it programmatically from UI, which is exactly our pattern. |
| Plain-JS client half can inject `remote.*` | `plugins/dsh-meridian-antigravity/client.js:335` | In-repo precedent: `inject: ['slots', 'configForms', 'remote.credentials', 'remote.llm']`. |

### What this means

The client→host channel needs **no build pipeline and no new Remote service**. A plain-JS client half
injects `slots` and `remote.commands`, renders buttons into `conversation.chat.turnTail`, and calls
`ctx.remote.commands.execute(sessionId, '/reroll', [])`. The host half registers `/reroll` and gets
`invocation.agent` in its handler, which is the handle needed for `runMaintenance`, `followup` and
`session.append`.

## 2. Architecture

```
plugins/dsh-chat-controls/
  package.json          dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml      mounts the host half; declares the client half
  index.js              host: commands + history surgery      (imports @deepseek-ai/* host packages)
  lib/turns.js          pure helpers: locate turn boundaries, plan a replace range
  lib/generate.js       llm.stream + accumulator -> assistant event
  client.js             browser: turnTail buttons, dialogs    (plain JS, module-loader format, no imports)
  tests/                offline tests for the pure helpers
```

Two halves, one concern. The host half owns every durable change; the client half owns only
presentation and intent.

**Host half** — registers one command per feature. Each handler:

1. resolves the target turn from `invocation.agent.session`,
2. refuses when the session is busy or a tool batch is pending (see §4),
3. enters `agent.runMaintenance(async signal => { ... })`,
4. appends the replacement event(s) with the correct `surfaceOp` + complete `sourceEventSeqs`,
5. when the feature should generate, calls `agent.followup(...)` or generates in place.

**Client half** — one module-loader bundle that:

1. injects `['slots', 'remote.commands', 'remote.sessions']`,
2. registers a list into `conversation.chat.turnTail` for turn-level controls,
3. registers a keyed `conversation.chat.node` kind for its own marker rows,
4. opens dialogs through `conversation.input.overlay`,
5. calls features by invoking commands with the session id.

Commands carry the argument in `rawInput`, so one command per feature plus a small parse step is
enough. Command lifecycle (`command/run` / `command/done`) is logged outside model history by design,
so invoking a command does not itself perturb the transcript.

## 3. Durability rules (non-negotiable)

1. **Only existing event vocabulary.** A plugin may not invent durable event types; a reader meeting an
   unknown required type refuses to reopen the session (`core/session/src/known-event-types.ts`).
   Everything below uses `user/message`, `assistant/message`, `system/message` and `replace` ops —
   the same vocabulary compaction uses.
2. **Never fabricate a `source.kind` without checking.** Session-format migrations validate source
   kinds against a fixed set (`session-format-v2-to-v3/src/payload.ts`, `session-format-v3-to-v4/src/sources.ts`).
   Pre-flight check P2 below decides this before Phase 1.
3. **Complete shadow coverage.** `sourceEventSeqs` lists every shadowed node, and both range endpoints
   must currently be surface nodes, or `append` throws.
4. **Plugin-owned metadata lives outside the log** — a storage domain or a session projection, never a
   new event field.
5. **The transcript is not the model surface.** `ui-chat` renders append-origin events only; a
   replacement renders nothing. A plugin that rewrites history must present that rewrite itself, via
   its own `conversation.chat.node` kind.

## 4. The cross-cutting guard (do this before any rewrite feature)

The dangerous state is a **pending tool continuation**: an assistant message requested tools and their
results have not been delivered yet.

On the `meridian-antigravity` route this is a hard failure, not a soft one. Meridian requires a
tool-result continuation to carry the exact prefix it already delivered, so any history rewrite while a
batch is pending returns `MERIDIAN_CONTINUATION_CONFLICT`. This is the same mechanism as the
tool-result pruner bug fixed earlier in this repo. A chat-controls plugin is a *second* producer of
exactly that failure mode.

Rule: **every rewriting feature refuses unless the session is idle and no tool batch is unresolved.**
Implementation: `await agent.whenIdle()` first, then a check that the current surface's last node is not
a `tool/result`, then `runMaintenance`. Returning a `CommandResult` error (not throwing) keeps the
refusal visible and non-fatal.

This is also the right behaviour on every other route: editing history under a live continuation is
confusing regardless of provider.

## 5. Pre-flight checks

Do these before writing feature code; each answers a question the design depends on.

- **P1 — round-trip a replacement.** In a scratch session, `runMaintenance` + append a `user/message`
  replacing a one-node range. Confirm the model sees the new text, the transcript still shows the
  original, and the session reopens after a restart.
- **P2 — source-kind tolerance.** Append a `user/message` with a novel `source.kind` (e.g.
  `chat-controls`), restart, and reopen. If it refuses, all inserted messages use `source: { kind: 'user' }`
  with self-describing text, and the plugin's own rendering distinguishes them.
- **P3 — tool-bearing turn coverage.** Reroll the assistant message of a turn that called tools. Confirm
  the exact set of nodes that must be shadowed (assistant + every `tool/result`), and confirm the
  failure message when coverage is incomplete.

## 6. Feature roadmap, in order

Each phase ends in something demonstrable. Effort assumes familiarity with this codebase.

### Phase 0 — Skeleton and the channel (proves the architecture)

**Deliverable:** a button in the transcript that round-trips to a host command and shows a result.

- `plugins/dsh-chat-controls/package.json` + `cordis.patch.yml`, mirroring `dsh-meridian-antigravity`.
- Host: register one command, `chatctl`, that returns the session id, turn count and surface length.
- Client: register into `conversation.chat.turnTail`; one button invoking
  `ctx.remote.commands.execute(sessionId, '/chatctl', [])`; render the result in a dialog.
- Prove: it appears only on completed turns, and the command is logged without touching model history.

*Effort: hours. No history mutation, no guards needed.*

### Phase 1 — Continue (append-only, safest real feature)

**Deliverable:** a "Continue" button that makes the model keep going without the user typing.

- **V1 (do this first):** `agent.followup(createUserMessage({ content: [{ type: 'text', text: '…' }], source: { kind: 'user' } }))`.
  A visible user bubble containing a short instruction such as `(continue)`. No rewrite, no guard beyond
  idleness, no new vocabulary.
- **V2 (the real one):** generate a continuation and *replace* the tail assistant node so no user bubble
  appears.
  1. Read the last assistant message from the surface.
  2. Build a request that ends with a continuation instruction, stream it via `ctx.llm.stream`, fold it
     with `AssistantStreamAccumulator`, settle with `assembleAssistantStream`.
  3. In `runMaintenance`, append `assistant/message` with
     `surfaceOp: { op: 'replace', startSeq: lastAssistantSeq, endSeq: lastAssistantSeq }` and
     `sourceEventSeqs: [lastAssistantSeq]`, carrying the concatenated text.
  4. Present the new text as the active variant in your own node kind (Phase 6 generalises this).
- Guard: V2 requires idleness and a completed assistant turn with no pending tools.

*Effort: V1 trivial, V2 medium (the generation path is the work).*

### Phase 2 — Edit a past user message

**Deliverable:** edit the last turn's user text; optionally regenerate the reply.

- Client: dialog from the turnTail slot (via `conversation.input.overlay`), submitting the new text as
  command `rawInput`.
- Host `edit-turn <text>`:
  1. `await agent.whenIdle()`; assert no pending tool batch (§4).
  2. Locate the turn's user-message seq, and the last surface seq belonging to that turn.
  3. `runMaintenance`: append `user/message` with the edited text and
     `surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: turnTailSeq }`,
     `sourceEventSeqs: [every seq in that range]`.
  4. If the user asked for regeneration, `agent.followup(...)`; otherwise return and let the transcript
     show the edit as your own marker row.
- Failure modes: range endpoints no longer on the surface (turn already edited/compacted) → return an
  error naming the reason; incomplete coverage → the append throws (P3 tells you the exact shape).
- Tests: pure range-planning helper against recorded surface shapes; a live check that the model sees
  the edited text and the original is still in the log.

*Effort: medium. This is the template every later rewrite copies.*

### Phase 3 — Reroll the last reply

**Deliverable:** regenerate the final assistant message.

- **V1:** replace the assistant range, then let the loop regenerate (followup / steer).
- **V2:** generate yourself with `ctx.llm.stream` + accumulator and append the settled
  `assistant/message`, so you control model, sampling and whether tools run.
- **Tool-bearing turns:** if the assistant message requested tools, its `tool/result` nodes must be
  shadowed in the same replacement, and the design must state explicitly whether the tools re-run.
  Silently re-running side-effecting tools is the one outcome that must never happen by accident;
  default to *not* re-running and surface the choice.
- Guard: idleness + no pending batch. Refuse on turns whose tool results cannot be safely replayed.

*Effort: medium, higher if tool-bearing turns are in scope for v1 (recommend excluding them initially).*

### Phase 4 — Delete turn / delete range

**Deliverable:** remove a turn from the model's view while keeping it in the log.

- A replacement needs a replacement event, so "delete" means replacing the range with a minimal
  self-describing node (compaction's pattern), not true truncation.
- Host: `replace` over the turn range with a single short `user/message` (or `system/message`) such as
  `[turn removed by chat controls]`, `sourceEventSeqs` covering the whole range.
- Client: a marker row via your node kind showing what was removed and offering Undo, which is another
  replacement restoring the original text from the log (the original is always enumerable).
- Guard: idleness + no pending batch.

*Effort: medium. Undo is the interesting half.*

### Phase 5 — Impersonate

**Deliverable:** the model writes the user's next message.

- Generate with `ctx.llm.stream` using a user-role prompt, then either append a `user/message`
  (accepted) or prefill the composer for the human to edit first (recommended default).
- No history rewrite, so no guard beyond idleness.

*Effort: easy–medium, mostly prompt design.*

### Phase 6 — Alternates / swipes

**Deliverable:** N candidate replies per turn, with a switcher.

- There is no variant store. Keep candidates in a plugin storage domain keyed by turn/message id; the
  surface holds only the active one, and switching is a replacement.
- Client: swipe bar on `conversation.chat.assistant-actions`, plus a list view in your node kind.
- This is where "the log keeps every original" pays off: earlier candidates remain enumerable.

*Effort: hard. State, lifecycle and rendering all belong to the plugin.*

### Phase 7 — Branch navigation

**Deliverable:** switch between sibling branches.

- Branching already exists (`session.fork`, and `forkAt` is already handed to the turnTail slot owner).
  The gap is only UI: enumerate siblings and switch the selected session.
- No history rewriting, so no pending-turn guard.

*Effort: easy (UI only).*

### Phase 8 — Include / exclude from model context

**Deliverable:** keep a message visible to the human but hide it from the model.

- Replacement that shadows the node for the model; the transcript keeps it. Mark the row in your node
  kind so the state is obvious, and offer the inverse replacement to restore.
- Guard: idleness + no pending batch.

*Effort: medium — mechanically like Phase 4, with a clearer semantic.*

### Phase 9 — Explicitly out of scope

- **Reordering messages.** The log is ordered and append-only; not expressible.
- **True in-place transcript edit/delete.** The transcript is defined as append-origin events.
- **SillyTavern-identical semantics.** DSH's transcript and model surface are deliberately different
  projections; this plugin shows the difference honestly rather than hiding it.

## 7. Slot reference

| Slot | Kind | Use |
| --- | --- | --- |
| `conversation.chat.turnTail` | list, session | Turn-level buttons: continue, edit turn, reroll, delete turn. |
| `conversation.chat.assistant-actions` | list, session | Per-reply buttons: reroll, swipes, delete. |
| `conversation.chat.node` | keyed | Your marker rows: "edited", "removed", "variant 2/3". |
| `conversation.input.overlay` | — | Edit dialogs and confirmations. |
| `conversation.composer.dock` | — | Optional composer-side controls. |
| `conversation.chat.commandview` | keyed | Only if command rows need custom rendering. |

## 8. Testing

- **Pure helpers** (`lib/turns.js`) — locate turn boundaries, plan a replace range, compute
  `sourceEventSeqs` — as offline unit tests with recorded surface snapshots. This is where the real
  bugs live, and it needs no harness rig.
- **Refusals** — busy session, pending tool batch, stale range, incomplete coverage: each returns a
  named error rather than throwing.
- **Durability** — after each rewrite, restart DSH and reopen the session. This is the check that
  catches new-vocabulary mistakes (P2/P3).
- **Live end-to-end** — edit, reroll, continue on a real session; confirm the model sees the change and
  the transcript is intact. Do this on a non-Meridian route first, then on `meridian-antigravity` to
  confirm the pending-turn guard holds.

## 9. Open decisions

1. **Generated vs loop-regenerated reroll.** Generating ourselves is more control and more code;
   delegating to the loop is less code but less control. Recommend: loop first, self-generate from
   Phase 3 V2 onward.
2. **Tool-bearing turns.** Exclude from v1 (recommended) or design the re-run policy now?
3. **Inserted-message visibility.** If P2 fails, inserted messages appear as ordinary user bubbles. Is
   that acceptable, or should every inserted message be excluded from the visible transcript and shown
   only as a plugin marker row?
4. **Continue semantics.** A visible `(continue)` user bubble (V1) is honest and cheap; a silent
   replacement (V2) is what frontend users expect. Confirm which is the default.
