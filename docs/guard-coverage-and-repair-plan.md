# Guard coverage and connector repair — implementation plan

Status: approved 2026-10-07. Fixes land as separate commits, in the order below.

## Goal

Make both fixes actually work, close the two gaps found in review, and make the ones that cannot be tested offline verifiable in the live environment.

**Success criteria:** `standard`-preset sessions run the guarded pruner; a refused continuation is repaired, which the live evidence shows means every conflict shape observed so far (Fix 2's amendment); the notice never asserts a cause it cannot know; and each of these is either covered by a test or has a named, reproducible live check.

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

The evidence agrees. Every `MERIDIAN_CONTINUATION_CONFLICT` in the session store — 45 of them, across 30 sessions — arrived on a request with trailing tool results, so the existing gate `continuation !== undefined` reached all of them. That includes the four consecutive refusals in `session-0bc7fee5`: turns 4 and 5 carried a batch directly, and turns 6 and 7 carried the same still-unanswered batch plus the user's next message, which does not clear it.

What the plan described as the gap — "later turns over a broken prefix still error" — does not follow, because a later turn only stops looking like a continuation once something has answered the batch, and the repair is that something.

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

**Prerequisite:** the restart. Fixes 1–3 are inert until then.

## Fix 5 — read before building the capture

`lib/serialize.js:141-149` mentions hashing a continuation's prefix to the message list Meridian delivered. A prefix-signature mechanism was designed without reading it.

**Step 5.1** — read `lib/serialize.js` lines ~120–200 and `lib/contract.js` for existing prefix or request-body machinery.

**Step 5.2** — then implement `captureRequestBodies` (boolean, default `false`) plus a directory config: write the serialized body per request to a bounded, opt-in location, one file per request id. Off by default; no redaction inside the file, and the path must be documented as containing full transcripts.

**Step 5.3** — only if the capture shows a rewrite worth diagnosing locally, add the prefix signature as a *diagnostic* (codes in the error text), never as a repair trigger. Meridian's 409 stays the repair trigger, because it is the confirmation.

## Sequencing and risks

Order: 1 → 2 → 3 → restart → 4 → 5. Fixes 1–3 are independent and can land together.

- **Restart required** for 1; the connector's 2 and 3 load the same way.
- **Assumption:** the repair restores continuability — that is what Fix 4 tests.
- **Residual, accepted:** `ptc` and `cordis` stay unguarded; the override pins the shipped plugin list; a Web-editor edit of `standard` discards the swap (Fix 1.3's test detects the shape change, not the Web-editor path).
- **Not in scope:** the direct-`agy` bridge.
