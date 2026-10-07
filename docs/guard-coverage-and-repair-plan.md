# Guard coverage and connector repair — implementation plan

Status: approved 2026-10-07, implemented in the commits that follow. Two of the five items changed shape against the evidence and are recorded as amendments: Fix 2 was withdrawn, and Fix 4's post-restart result corrected a claim in the plan.

## Goal

Make both fixes actually work, close the two gaps found in review, and make the ones that cannot be tested offline verifiable in the live environment.

**Success criteria:** `standard`-preset sessions run the guarded pruner; a refused continuation is repaired on every conflict shape the corpus contains (Fix 2's amendment); the notice never asserts a cause it cannot know; and each of these is either covered by a test or has a named, reproducible live check.

## Fix 1 — resolve the guard plugin names (D1, highest priority)

The override's `name: './engine.js'` / `'./pruner.js'` do not resolve. The plan was to settle this by inspection; the inspection is done and the answer is negative.

`@deepseek-ai/dsh-app-boot` anchors relative plugin paths in exactly one place, `anchorInsertedPluginNames` (`packages/boot/app-boot/src/index.ts:344`), and it visits only `patch.insert` rows and the nested groups inside them. A non-insert patch's `config` is never visited: the function's own docstring says it keeps assertion names literal. `@deepseek-ai/dsh-agent-preset` types `name` as `z.string()` and does nothing with it (`packages/preset/agent-preset/src/index.ts:18`). `mountPreset` resolves the declared list against `ctx.baseUrl` of the declaring row (`packages/preset/agent-preset-registry/src/mount.ts:263`, `index.ts:114`), which is the root entry list's base, not this patch file's directory. So `./engine.js` would resolve to a path that does not exist, the import would throw, and `standard` would register as **broken** rather than merely unguarded — worse than not overriding it at all. `preset-dd35` avoids this by naming its own children with absolute `file:///` URLs.

**Step 1.1 — done.** The rule is settled: only inserted rows are anchored; declaration children need an absolute `file:///` URL or a resolvable package specifier.

**Step 1.2 — apply the absolute `file:///` form** to the two swapped rows in the `preset-standard` override, matching the URLs `preset-dd35` already uses live for the same two files. Nothing else in the declaration changes.

**Step 1.3 — structural regression test** (new: `plugins/dsh-compaction-guard/tests/preset-override.test.js`, `node --test`). Parses the installed `@deepseek-ai/dsh-web-app` `presets/standard.patch.yml` and this bundle's override, then asserts: same `id`, `order` and plugin-id sequence; **exactly one** differing row, `compaction`; and every name in the declaration is a package specifier or an absolute `file:///` URL, never a bare relative path.

**Acceptance:** the test passes; after restart, `plugin_manager list_plugins` shows `preset-standard` active rather than carrying an activation diagnostic.

**Rollback:** revert the one file; the guard bundle is a link into this workspace.

## Fix 2 — the repair gate is already as wide as it can usefully be (G1 withdrawn)

**Amended 2026-10-07, before any code change.** The planned predicate turned out to be redundant, so it was not added.

`analyzeContinuation` scans the messages after the last assistant message and returns `undefined` when none of them is a tool result. That is the same condition as "the last tool result comes after the last assistant message", which is the predicate the plan proposed adding as `hasUnresolvedBatch`. The two are equal for every message list, so widening the gate to it changes nothing.

The evidence agrees. Every `MERIDIAN_CONTINUATION_CONFLICT` in the session store — 52 of them, across 35 sessions — arrived on a request with trailing tool results, so the existing gate `continuation !== undefined` reached all of them. That includes the four consecutive refusals in `session-0bc7fee5`: turns 4 and 5 carried a batch directly, and turns 6 and 7 carried the same still-unanswered batch plus the user's next message, which does not clear it.

A prune cannot remove a trailing tool result, only change its content, which is why the shape survives one: the shipped pruner appends a *replacement* `tool/result` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` (`compaction-tool-result-pruner/src/index.ts:165`) and throws if the replacement is not smaller. A rewritten prefix is a changed hash, not a shorter transcript.

What the plan described as the gap — "later turns over a broken prefix still error" — does not follow, because a later turn only stops looking like a continuation once something has answered the batch, and the repair is that something.

### Which conflicts the guard actually addresses

Counted from the session store by the preset each session used — its `agent-preset/selected` event, or the session header when it has none:

| preset used | sessions with a conflict | conflicts | sessions that pruned | prunes |
| --- | --- | --- | --- | --- |
| `dd35` | 24 | 30 | 3 | 36 |
| `standard` | 7 | 11 | 7 | 28 |
| `cordis` | 4 | 11 | 4 (three with 28 each) | 315 |

Two consequences, and the second is the one that matters:

- `standard` and `cordis` are the prune population. Every `standard` conflict session logged `compaction/prune` events, and three of the four `cordis` ones logged 28 each. This is the population the guard is for.
- `dd35` is not. **27 of its 30 conflicts come from sessions with no `compaction/prune` event at all**, and `dd35` has mounted the guard since 2026-10-04, so those conflicts continued after the guard was in place. A `model/selection` event inside the same turn window accounts for 16 of the 52 conflicts overall, mostly a slug change inside `meridian-antigravity` (`gemini-3.6-flash-medium` → `-high`), which is Meridian's "model or execution controls changed" case. About a dozen `dd35` conflicts have neither a prune nor a model change and are unexplained.

So the guard closes a demonstrated hole in `standard` and would close the same one in `cordis`; the repair is what covers the largest population, `dd35`. Neither is sufficient alone, and before this correction the documents implied the guard was the main fix.


**Residual, deliberately not repaired.** After a repair commits the notice, the transcript ends with an assistant message, so the next request is no longer a continuation. If Meridian refused *that* request, the conflict would be reported rather than repaired. That is the right behaviour: nothing is stranded, and committing a second notice would fabricate an assistant turn for a request that produced no output. Whether Meridian refuses it is the live question Fix 4 answers.

**Step 2.1 — withdrawn.** No predicate added.
**Step 2.2 — no change** to `lib/transport.js`.
**Step 2.3 — tests added** in `tests/continuation.test.js`: the gate and the unresolved-batch predicate agree across six shapes; the five distinct live conflict shapes are all reached; and a repaired transcript is not a continuation.

One observation from the same evidence belongs to Fix 4: the refusal is not always permanent. `session-0bc7fee5` turn 8 succeeded on a prefix identical to the one turns 5–7 were refused on, seven seconds after turn 7's refusal, with no prune in between. The mechanism is unknown, so no retry policy was changed for it.

## Fix 3 — stop the notice asserting one cause (G3)

`MERIDIAN_CONTINUATION_CONFLICT` covers a rewritten message *and* "changed its model, session or execution controls" — a model switch mid-batch lands here. The notice claims the first; the README row repeats it.

**Step 3.1 — rewrite `rewrittenContinuationNotice`** in `lib/failure.js` to state what is known and name the candidates without choosing.

**Step 3.2 — correct the README row** in `plugins/dsh-meridian-antigravity/README.md` to the same neutral framing.

**Step 3.3 — test** in `tests/failure.test.js`: the notice names both candidates and no longer contains the single-cause assertion.

## Fix 4 — verify live, then adjust the promise (G2)

Nothing offline proves that committing the notice makes Meridian accept the next request.

**Step 4.1 — use the broken session as the harness.** `session-0bc7fee5` already has a rewritten prefix and unresolved batches, so a message there should reproduce the conflict. Observe: the notice is committed; the turn reports `completed`; the *following* turn reaches the model without a conflict.

**Step 4.2 — check the guard at the same time.** In a new `standard`-preset session, read the session log for `compaction/prune`. With the guard active, a prune that would land while a batch is pending must not appear.

**Step 4.3 — branch on the result.** If the next request succeeds, leave the notice as written. If it does not, the repair is cosmetic for the rewrite case: say so in the notice, name the remedy (fork from before the affected turn), and record that the rewrite conflict is not repairable from the connector — which strengthens the case for Fix 5.

**Acceptance:** written down in `docs/meridian-spent-batch-plan.md` either way, including a negative result.

**Status after the 2026-10-07 restart.** One of the three unknowns is settled and one instruction of mine was wrong.

- **Settled: the two absolute `file:///` URLs import under the loader.** `preset-dd35` declares the identical strings, and 77 of 84 `dd35` sessions ran dd35-scoped tools (`get_state`, `list_memories`, `roll_*`) as recently as 2026-10-07 03:18. A preset tree with one unresolvable row fails to mount as a whole, so those rows import. The `standard` override names the same files with the same strings.
- **Wrong: `list_plugins` cannot confirm a preset's children.** `plugin_manager` reports `preset-standard` as `fiberPhase: active`, and that proves nothing: `agent-preset-registry` catches a child-mount failure into its own `broken` record and only calls `logger.warn` (`packages/preset/agent-preset-registry/src/index.ts:112-125`), so the Loader row stays active with the preset unusable. The journal also shows no lines at all since the restart, so a warning is not a usable signal either. The README instruction that said otherwise has been corrected; the only real check is a session on `standard` composing.
- **Still open: whether the repair leaves the next request an ordinary call, and whether the deferral fires.** The only session to run since the override loaded is on `cordis`, which the override does not cover. Worse, the deferral is now *disproven* for `dd35`: four sessions pruned after the guarded patch was declared and after the restart that read it, each with the surface ending on an unanswered tool result, and three of them took the conflict immediately afterwards. The full evidence and the two candidate mechanisms are in `plugins/dsh-compaction-guard/README.md`; the decisive experiment is a test that drives `pruneSession` rather than the pure helpers.

## Fix 5 — read before building the capture

**Read first.** `lib/serialize.js:139-154` already documents the prefix rule: a continuation sends the message history verbatim, because filtering a superseded `runtime-context` snapshot out of the prefix is itself what makes Meridian answer 409, and the newest snapshot is appended after the tool results where Meridian accepts it. There is no existing prefix hash and no existing request-body machinery, so the capture was written from scratch.

**Implemented.** `lib/capture.js` writes one file per dispatch, named by dispatch time and request identity, containing the identity, the logical request hash, the session key, the model, the purpose, the continuation diagnosis, the enforced byte size, and the exact body that went on the wire. Config: `captureRequestBodies` (default `false`), `captureDir`, `captureMaxFiles` (default 50). Turning capture on without a directory throws at resolve time rather than silently doing nothing. The directory is pruned to the newest `captureMaxFiles`, and only names this module produces are eligible for deletion. A write failure warns and the turn continues.

**Tests.** `tests/capture.test.js` covers naming, the bounded directory, the foreign-file guard, the off case, and the never-throw rule. `tests/spent-batch.mjs` covers the wiring: capture off by default, the missing-directory refusal, and a refused dispatch leaving exactly one file whose body is what was sent.

**Still open, deliberately.** Step 5.3 — a per-message prefix signature in the error text — stays unbuilt until a capture shows it would help. The capture is a diagnostic; Meridian's own 409 remains the only repair trigger. The answer to "should the connector talk to `agy` directly instead" needs captures from a session that fails after the repair is live, so it is part of Fix 4.

## Sequencing and risks

Order: 1 → 2 → 3 → restart → 4 → 5. Fixes 1–3 are independent and can land together.

- **Restart required** for 1; the connector's 2 and 3 load the same way.
- **Assumption:** the repair restores continuability — that is what Fix 4 tests.
- **Residual, accepted:** `ptc` and `cordis` stay unguarded; the override pins the shipped plugin list; a Web-editor edit of `standard` discards the swap (Fix 1.3's test detects the shape change, not the Web-editor path).
- **Not in scope:** the direct-`agy` bridge.
