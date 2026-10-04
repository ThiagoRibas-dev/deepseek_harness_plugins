# Meridian Antigravity connector — remediation plan

Status: **Phases 1, 2 and the documentation corrections are implemented. Phase 3 is withdrawn.**

Scope: the DSH ↔ Meridian Antigravity connector in `plugins/dsh-meridian-antigravity/`.
The harness checkout is never modified from this workspace, so the Phase 3 compaction guard is out of scope.

## Decisions

- **Phase 3 and 3b are withdrawn.** The owner's rule is that the harness code is never touched from this
  workspace, and the guard can only live in `compaction-basic` / the tool-result pruner. The residual risk is
  accepted and documented instead: `MERIDIAN_CONTINUATION_CONFLICT` now names the cause precisely, and the
  connector README records the composition-level workaround (disable the tool-result pruner so the delivered
  prefix stays stable).
- Phases 1 and 2 were implemented in the workspace plugin, with conformance coverage added.
- Phase 4's documentation corrections were implemented; the upstream Meridian telemetry gap remains a
  report-only item for the Meridian repository.


## Findings this plan addresses

| ID | Finding | Severity |
| --- | --- | --- |
| A | The reported 409 `"Pending Antigravity tool continuation changed its delivered history or tool batch"` is caused by DSH tool-result pruning rewriting the delivered prefix between a `tool_use` turn and its continuation. Meridian requires that prefix to be canonically identical. | Blocking |
| B | The `idempotency-key` is a pure content hash with no session scope, so byte-identical requests from *different* chats share an identity and Meridian's `[scope, request-id]` answer store can replay one chat's answer into another. | High |
| C | `GenerateOptions.sessionId` is never mapped to Meridian's `meridian_session_key`, so Meridian cannot separate sessions in `contractKey`, and live-process reuse is matched on contract + history prefix alone. | High |
| D | Every 409 is flattened into `MERIDIAN_UNCERTAIN_OUTCOME` (non-retryable, "do not retry") even though several 409s are deterministic or explicitly replayable. | Medium |
| E | 409s raised from `selectRun` are never recorded in Meridian's `/telemetry/requests`. | Low (upstream) |

Evidence for A: session `session-5b35daf2-170d-4f9e-b631-1b14005851bc`, turn 12 — record 424
is `compaction/prune` (shadowing seq 62, a 2799-token `tool/result`), immediately before the
continuation at step 2 that 409s. Meridian's check is
`src/proxy/backends/antigravity.ts:85-87` (`historyKey(run.history) !== historyKey(prefix)`).
DSH's prune runs from `compaction-basic` on every `agent/pre-step`, including continuation steps.

---

## Phase 1 — Connector: session-scoped identity and session key (fixes B, C)

Independent of Phase 2. No harness core change.

1. **`lib/idempotency.js` — scope the hash.**
   - Change `logicalRequestHash(body)` to `logicalRequestHash(body, scope = '')`.
   - Digest becomes `sha256(scope + "\0" + JSON.stringify(logicalWithoutStream))`.
   - Keep the default `''` so existing callers/tests that pass only a body keep working.
   - `mintId` is unchanged (id stays `dsh-<32 hex>` = 36 chars, inside Meridian's 1–128 alphabet).

2. **`lib/serialize.js` — send the session key.**
   - `serializeRequest({ options, connection, images, imageAccess, warn, sessionKey })`.
   - When `sessionKey` is a non-empty string, add `meridian_session_key: sessionKey` to `body`
     (Meridian's schema declares it: `z.string().max(512).optional()`; it is part of `contractKey`).
   - This alone disambiguates Meridian's live-run reuse and its answer store; the scoped hash in
     step 1 is defence in depth for the case where no session id exists.

3. **`lib/transport.js` — wire it through.**
   - Derive `const scope = typeof options.sessionId === 'string' ? options.sessionId : ''`.
   - Pass `sessionKey: scope` into `serializeRequest`.
   - Compute `const hash = logicalRequestHash(body, scope)`.
   - `enforceRequestBudget` already measures the same `body`, so the added bytes are accounted for.

4. **Tests (`tests/conformance.mjs`).**
   - Same body + different `sessionId` ⇒ different `idempotency-key`.
   - Same body + same `sessionId`: reuses the id after a failure, mints a new generation after success.
   - A request built with a `sessionId` carries `meridian_session_key`; without one it does not.

## Phase 2 — Connector: classify 409s by provider message (fixes D)

Independent of Phase 1 and 2b. Connector only.

5. **`lib/errors.js` — split the 409 branch (currently lines 88-97).**
   - `MERIDIAN_PENDING_REPLAYABLE` — retryable. Matches the messages Meridian itself says can be
     replayed: `"Idle tool process reclaimed; completed history can be replayed"`,
     `"Client tool result deadline expired; completed history can be replayed"`.
     Message explains that a retry replays completed history and does not re-execute tools.
   - `MERIDIAN_UNCERTAIN_OUTCOME` — unchanged, and now only for genuine identity/restart
     uncertainty: `"interrupted by a service restart without a saved response"`,
     `"Request ID was reused with a different request"`.
   - `MERIDIAN_CONTINUATION_CONFLICT` — **new, non-retryable**. Everything else in the 409 family
     (`changed its delivered history or tool batch`, `changed its model, session or execution
     controls`, `unknown live tool`, `already has an active response`, `already consumed`,
     `must match the entire delivered batch`, `was not requested by this turn`).
     Message names the real cause (the delivered prefix or tool batch changed mid-continuation —
     typically compaction) and must **not** carry the "uncertain outcome / do not retry under a new
     identity" wording.
   - Unknown 409 fallback stays `MERIDIAN_UNCERTAIN_OUTCOME` (conservative).

6. **`lib/config.js` — `DEFAULT_RETRY_POLICY.retryableCodes` (line 68).**
   - Add `'MERIDIAN_PENDING_REPLAYABLE'`. Bounded by the existing `maxRetries: 2`.
   - `MERIDIAN_CONTINUATION_CONFLICT` stays out, like the other transcript codes.

7. **Tests (`tests/conformance.mjs`, status table at lines 548-573).**
   - 409 + uncertain-outcome body ⇒ `MERIDIAN_UNCERTAIN_OUTCOME`.
   - 409 + `"...changed its delivered history or tool batch"` ⇒ `MERIDIAN_CONTINUATION_CONFLICT`,
     and the message does **not** contain "uncertain outcome".
   - 409 + `"Idle tool process reclaimed; completed history can be replayed"` ⇒
     `MERIDIAN_PENDING_REPLAYABLE`, and it **is** in `retryableCodes`.

## Phase 3 — WITHDRAWN (harness rule)

Not implemented. The owner's rule is that harness code is never modified from this workspace, and this guard
can only live in `compaction-basic` or the tool-result pruner. The options below are retained for reference in
case that rule ever changes; the accepted mitigation is connector-side reporting plus the README's
composition-level workaround.

This was the actual prevention of finding A. It touches shared core, so it was the phase needing a decision.

**Decision 3a — placement (recommended: 3a-i).**

- **3a-i (recommended).** Predicate exported from the pruner package and used in two places:
  - `packages/compaction/compaction-tool-result-pruner/src/index.ts`
    - Add exported `isPendingToolContinuation(session)`: derive the model-visible surface
      (`session.deriveMessages()`) and report true when the last message is a tool result.
    - `pruneSession` returns `{ pruned: [], charsRemoved: 0 }` when true.
  - `packages/compaction/compaction-basic/src/index.ts` (handler at lines 158-176)
    - Skip the `'pressure'` `compactIfNeeded` call when `isPendingToolContinuation(agent.session)`.
    - Non-continuation steps prune exactly as today, so pruning is deferred by one step, not lost.
- **3a-ii (alternative, smaller blast radius).** Guard only inside `pruneSession`; leave
  `compaction-basic` untouched. Fixes the observed trigger; summary compaction on a pressured
  continuation step remains a 409 risk.

**Decision 3b — the context-overflow path (lines 294-298).** If a continuation is rejected for
context length and recovery prunes the history to retry, Meridian can still 409 because the pending
run is live. Options: leave as-is (connector now reports it accurately), or apply the same guard
(then overflow recovery cannot shrink and the turn fails hard instead). Recommend leaving as-is and
documenting it; say the word if you want it guarded too.

8. **Tests (DSH).**
   - `packages/compaction/compaction-tool-result-pruner/tests/tool-result-pruner.spec.ts`:
     surface ending in a tool result ⇒ no prune; ending in an assistant/user message ⇒ prune happens.
   - `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts`:
     pressure compaction skipped on a continuation step, still applied on a normal step.

## Phase 4 — Documentation (connector `README.md`) — DONE

Implemented: the exact-match continuation row, the identity row, the retry row, the statuses table (409
split into three outcomes) and a new first bullet under *Known limitations* recording the compaction
conflict and the composition-level workaround.

10. Out of scope here (upstream): Meridian `antigravity.ts:140` skips `runtime.record` for
    `selectRun` failures. Worth reporting to the Meridian repo; not fixable from this workspace.

## Implementation log

| File | Change |
| --- | --- |
| `plugins/dsh-meridian-antigravity/lib/idempotency.js` | `logicalRequestHash(body, scope)`; session id participates in the digest; module doc updated. |
| `plugins/dsh-meridian-antigravity/lib/serialize.js` | `serializeRequest` accepts `sessionKey` and emits `meridian_session_key`. |
| `plugins/dsh-meridian-antigravity/lib/transport.js` | Derives the session scope from `options.sessionId`, passes it to the serializer, hashes with it. |
| `plugins/dsh-meridian-antigravity/lib/errors.js` | 409 split into `MERIDIAN_PENDING_REPLAYABLE`, `MERIDIAN_UNCERTAIN_OUTCOME` and `MERIDIAN_CONTINUATION_CONFLICT`. |
| `plugins/dsh-meridian-antigravity/lib/config.js` | `MERIDIAN_PENDING_REPLAYABLE` added to the default retryable codes. |
| `plugins/dsh-meridian-antigravity/tests/conformance.mjs` | Four new identity/session tests, three new 409 tests, updated status table and retry-policy assertions. |
| `plugins/dsh-meridian-antigravity/README.md` | Corrected contract claims, statuses table and limitations. |

Result: `tests/run.sh` → 9 passed / 0 failed (client) and 45 passed / 0 failed (conformance).

## Verification

| Step | Command |
| --- | --- |
| Connector conformance (offline, no quota) | `plugins/dsh-meridian-antigravity/tests/run.sh` |
| Harness typecheck + suites | `npm test` (and `npm run typecheck`) in the relevant packages |
| Web artifacts unaffected | no `apps/web` or client-half change in this plan |
| Optional live smoke (consumes quota) | fresh `dd35` chat → tool call → confirm no 409 |

## Risks

- **Phase 3 is shared-core.** The predicate only changes continuation steps; other providers
  currently prune there and would now defer by one step. 3a-ii avoids even that.
- **Phase 3 defers pruning** during long tool loops, so peak tokens can rise slightly within a turn.
  This is forced by Meridian's contract.
- **Phase 1 changes request bytes** (new field) and therefore identity. The ledger is in-memory, so
  there is no migration; a restart simply starts a new ledger.
- **Phase 2 retries a 409** that was previously terminal. Bounded to the configured 2 retries, and
  only for the two messages Meridian documents as replayable.

## Suggested order

Phase 1 → Phase 2 → Phase 4 (connector is self-contained and unblocks the reported symptom class),
then Phase 3 for the actual prevention. Phases 1 and 2 are independent and can land together.
