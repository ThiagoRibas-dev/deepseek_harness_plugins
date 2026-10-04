# dsh-compaction-guard — spec and implementation plan

Two guards against the compaction behaviours that destroyed a real session on 2026-10-04. Both are
implemented as ordinary Harness plugins: **no harness source is modified.**

Status: **plan only, nothing built.** Every API, line number and failure below was read from the
installed harness at `/usr/lib/node_modules/@deepseek-ai/dsh-root` (the code that runs), and the
evidence is from this workspace's session transcript `session-293cca94`.

---

## 1. Purpose and scope

`compaction` is the harness subsystem that keeps a session inside the model's context window. It has two
independent mechanisms:

| Mechanism | Package | What it does |
| --- | --- | --- |
| Summary compaction | `@deepseek-ai/dsh-compaction-basic` | Asks an LLM to summarize a span, then shadows that span with one checkpoint message. |
| Tool-result pruning | `@deepseek-ai/dsh-compaction-tool-result-pruner` | Model-free head/middle/tail truncation of oversized tool results. |

Each can fail destructively:

- **Case 1** — the summary mechanism accepts a worthless summary and commits it, shadowing the whole
  conversation. Silent, total context loss.
- **Case 2** — the pruning mechanism rewrites the surface mid-turn, invalidating a tool continuation that
  a provider has already delivered. Loud, but it wedges the turn.

This plugin adds one guard for each. It does **not** change compaction policy, thresholds, retention, or
pricing; it only refuses to commit the two specific bad outcomes.

---

## 2. Incident record

Session `session-293cca94`, 2253 events. Relevant sequence:

| seq | Event | Detail |
| --- | --- | --- |
| 2029 | `model/selection` | switch to `meridian-antigravity/claude-sonnet-5-5-medium` |
| 2044–2096 | `compaction/prune` ×28 | one-node prune sweep immediately after the switch |
| 2098–2155 | `compaction/start` → `compaction/end` | six failures, each `summarization produced no text summary content` |
| 2104 | `turn/end` turn 16 | `Meridian refused this tool continuation…` |
| 2143 | `compaction/end` | `Meridian Antigravity stream ended before message_stop (Individual quota reached. Resets in 2h43m43s.)` |
| 2150 / 2160 | `turn/end` turns 17, 18 | same continuation refusal |
| **2184** | **`compaction/summary`** | **committed `"I can't answer in a 1-token limit."`, `shadowedRange {start: 9, end: 1849}`** |

The session was oversized because one turn ran 401 tool calls. The summary that was eventually committed
replaced 1840 events — effectively the entire conversation — with one sentence. That session's
model-visible context is now unrecoverable without surgery, and the same one-line artifact became the
compacted checkpoint seen by later turns.

**Answering the obvious question:** this was not caused by switching models. The switch to Meridian on an
oversized session is what *triggered* compaction, but Case 1 is route-independent and would have happened
on any provider.

---

## 3. Case 1 — a degenerate summary is committed

### Symptom

The conversation vanishes from the model's view. The model behaves as though it never saw the session. No
error is surfaced to the user.

### Evidence

`compaction/summary` seq 2184:

```json
{"compactionId":"e0361c5a-…","summary":[{"type":"text","text":"I can't answer in a 1-token limit.\n"}],
 "shadowedRange":{"start":9,"end":1849},"shadowedSeqs":[9,10,11,17,2045,22,…],"llmStreamCall":true}
```

Preceded by six `compaction/end` records carrying `error: "summarization produced no text summary content"`.

### Root cause

`summarizeCompaction` accepts whatever the summarizer returns and commits it
(`compaction-basic/src/region.ts:387`):

```ts
for (;;) {
  try { summaryResult = await dependencies.summarize(prepared.input, agent, signal); break }
  catch (error) {
    if (signal?.aborted === true) throw error
    assertStable(…)                                        // region.ts:404
    if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error  // :405
    prepared = prepareCompaction(…)                        // :406 — retry the loop
  }
}
```

The only quality check in the whole path is a **size** check, at `region.ts:418`:

```ts
if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
  throw new Error(`summary is not smaller than the shadowed content …`)
}
```

That guard asks "is it smaller?", never "is it a summary?". A 31-character non-answer is trivially
smaller, so it passed, and 1840 events were shadowed.

### Why the existing recovery path does not cover it

`compaction/summary-error` (`compaction/src/index.ts:106`) is a **waterfall that only runs on failure**:

```ts
'compaction/summary-error'(payload: {session, sourceEventSeqs, error, signal}, next: () => boolean): boolean
```

The six failures reached it. The seventh attempt **succeeded** — it returned well-formed text — so no
waterfall ran and nothing could intervene. A handler on that waterfall alone cannot fix this case; the
guard must sit on the **success** path.

### Solution

Subclass `BasicCompactionEngine` and override the documented hook
(`compaction-basic/src/index.ts:247`, *"Override this sole hook for a template or remote summarizer"*):

```ts
protected async summarize(input, agent, signal?): Promise<SummaryResult>
```

Our override calls `super.summarize(...)`, validates the returned `SummaryResult.summary` blocks, and
**throws `DegenerateSummaryError` when they are not a usable summary**. The throw lands in the
`catch` at `region.ts:402`, so the engine consults `compaction/summary-error`.

We therefore also register a `compaction/summary-error` handler that returns `true` (retry) for our own
error, up to a bounded number of attempts, and `false` for everything else — preserving the behaviour of
the shipped `compaction-image-offload` handler. The net effect:

- a degenerate summary is **never committed**;
- summarization is retried a bounded number of times;
- if every attempt is degenerate, compaction fails loudly and the session is left intact.

### Validation rules

`lib/summary-quality.js`, pure and unit-testable:

1. **Substance floor.** Concatenate `text` blocks, trim, and require a minimum length
   (`minSummaryChars`, default 400). This alone rejects the observed 31-character summary.
2. **Not a verbatim repeat** of the summary most recently rejected in this session, so a retry loop
   cannot converge on the same garbage.
3. **Optional pattern rejection** (`rejectPatterns`, default a short refusal-shaped list), off by
   default. Configurable because pattern lists age badly.
4. **Optional relative floor** (`minRatio`, default `0` = disabled): `summaryChars >= inputChars ×
   minRatio`. Deliberately off by default — a good summary of a huge conversation is legitimately far
   smaller than its input, and this check can reject valid output. Documented so nobody enables it
   casually.

Rule 1 is the load-bearing one. Rules 2–4 are defence in depth and are recorded as heuristics, not as
correctness guarantees.

### Acceptance criteria

- A summary of `"I can't answer in a 1-token limit."` for a large range is rejected and never appears as
  a `compaction/summary` event.
- With a stub summarizer that always returns degenerate output, compaction ends in an error and the
  session surface is unchanged (no new `compaction/summary`, no new checkpoint node).
- With a stub summarizer that returns a substantial summary, compaction commits exactly as before.
- Retry count is bounded by `maxDegenerateRetries` (default 2); no unbounded loop.

---

## 4. Case 2 — pruning rewrites history under a delivered-prefix contract

### Symptom

```
Meridian refused this tool continuation because it no longer matches the turn it already delivered:
the delivered history, tool batch, model or execution controls changed between the tool call and its
result. … (Meridian Antigravity: Pending Antigravity tool continuation changed its delivered history or
tool batch)
```

The turn cannot be repaired by retrying; the user must abandon it.

### Evidence

Failed turns 16, 17 and 18 at seq 2104, 2150 and 2160, all on provider `meridian-antigravity`, all
following the 28-node prune sweep at seq 2044–2096 that ran immediately after the session switched to
that route.

### Root cause

`BasicCompactionEngine.compactIfNeeded` runs the pruner before summarising
(`compaction-basic/src/index.ts`):

```ts
if (trigger === 'context-overflow') {
  if (prune !== undefined) { prune.pruneSession(agent.session); … }   // :296
  …
}
…
if (prune !== undefined) { prune.pruneSession(agent.session); … }      // :324
```

`ToolResultPruner.pruneSession` rewrites each oversized tool result with a `replace` surface op
(`compaction-tool-result-pruner/src/index.ts:165-171`).

Meridian's Antigravity backend pins a continuation to the exact history it delivered
(`antigravity.ts:86`):

```ts
if (results.length !== run.delivered.length
    || results.some(r => !run.delivered.some(call => call.id === r.tool_use_id))
    || owners.some(owner => owner !== run)
    || historyKey(run.history) !== historyKey(body.messages.slice(0, suffixStart)))
  throw new AntigravityError("Pending Antigravity tool continuation changed its delivered history or tool batch", 409)
```

Between the delivery of an assistant tool call and the delivery of its results, the prefix is frozen. Any
prune in that window changes `historyKey` and the continuation is refused.

This is inherent to a delivered-prefix provider, not a bug in either side: mid-turn pruning and an
exact-prefix continuation contract are mutually exclusive.

### Solution

Subclass `ToolResultPruner` and override `pruneSession` to **defer** when pruning would be unsafe:

```js
pruneSession(session) {
  if (this.#shouldDefer(session)) return { pruned: [], charsRemoved: 0 }
  return super.pruneSession(session)
}
```

`#shouldDefer(session)` is true when **both**:

1. the routed provider for the latest request is one that enforces a delivered-prefix contract, and
2. the surface is mid-turn.

**Route lookup.** `session.requestHeader()?.config.provider`. This is public session API and is exactly
how the engine's own private `routedTarget` resolves it (`compaction-basic/src/index.ts:52`), so we
reproduce it rather than importing the private helper. The provider list is configuration
(`contractProviders`, default `['meridian-antigravity']`), not hardcoded.

**Mid-turn predicate.** Defer when the last surface node is:

- a `tool/result` — a continuation is about to be sent; or
- an `assistant/message` carrying tool calls with no matching results yet — a batch is in flight.

Otherwise the session is at a turn boundary, the next request is a fresh user turn, the provider starts a
new run, and pruning is safe.

### Trade-off, stated plainly

On a contract-enforcing route this makes pruning **turn-boundary-only**, which is precisely when context
pressure is highest. There is no way to keep mid-turn pruning on such a route — the rewrite is what the
provider refuses. The alternative (disable pruning globally) was rejected because it also degrades the
DeepSeek routes, where mid-turn pruning is sound. Route-aware deferral keeps existing behaviour
everywhere it is safe.

### Acceptance criteria

- On a `meridian-antigravity` session mid-tool-batch, `pruneSession` returns `{ pruned: [], charsRemoved: 0 }`
  and appends nothing.
- On the same session at a turn boundary, pruning behaves exactly as today.
- On any other provider, behaviour is byte-identical to today at every point in the turn.
- The 28-prune sweep pattern from the incident no longer occurs inside an open tool batch.

---

## 5. Case 3 — retry of an already-consumed continuation (documented, **out of scope**)

Recorded here because it is the third distinct failure in the same incident and must not be confused with
Case 2, and because it is **not** fixed by this plugin.

### Evidence

`turn/end` turn 3 at seq 320:

```
409: {"type":"invalid_request_error","message":"Antigravity tool result was already consumed;
append the subsequent assistant response before continuing"}
```

Provider `antigravity` — the shipped `@deepseek-ai/dsh-llm-pi-ai` OpenAI-completions route, **not** our
connector. Immediately preceded by `llm/retry` at seq 316 for the same turn and step.

### Root cause

Meridian consumes a tool result exactly once (`antigravity.ts:78`):

```ts
if (continuationResults.some(r => runtime.recoveringTools.has(r.tool_use_id))
    || (continuationResults.some(r => runtime.hasConsumedTool(r.tool_use_id))
        && !runtime.canRetryContinuation(body)))
  throw new AntigravityError("Antigravity tool result was already consumed; append the subsequent
    assistant response before continuing", 409)
```

The normal retry policy retried a request whose final message was a `tool_result`. The first attempt was
consumed; the retry is therefore guaranteed to fail. Retrying cannot work — the message says so itself.

### Fix direction (separate task)

Constrain the retryable set so a **continuation** request (last message is a tool result) is not retried
on a route that consumes results once, or supply an identity that makes the retry a replay rather than a
second consumption. Our own connector already does the latter via a content-addressed `idempotency-key`
(`lib/idempotency.js`); the `llm-pi-ai` route does not.

**Open question:** whether `llm-pi-ai` exposes its retry policy through row config. Not yet verified.
This plugin deliberately does not touch retry policy.

---

## 6. Why none of this needs a harness edit

Both mechanisms are **separate plugin packages mounted by id** in the base bundle
(`packages/bundle/base/cordis.patch.yml`):

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

The profile's own patch layer (`/root/.dsh/profiles/web/cordis.patch.yml`, already overriding eight ids)
is applied after every bundle layer. The loader dialect supports `disabled: true` and `insert` lists, and
both classes we need are exported with documented override seams:

- `BasicCompactionEngine` — `export class` at `compaction-basic/src/index.ts:113`, default export at `:452`;
  `summarize()` documented as the sole subclass hook; `compactIfNeeded` documented as dynamically
  dispatched "so subclass overrides are honored at event time".
- `ToolResultPruner` — `export class` and default export at `compaction-tool-result-pruner/src/index.ts:44,185`.

**One dialect constraint matters:** *"A truthy `name` asserts the existing plugin name rather than
renaming it."* We therefore cannot retarget an existing id at our package. The mount strategy is
**disable + insert**, and service identity (`ctx.compaction`, `ctx.toolResultPruner`) is what makes the
swap work.

---

## 7. Architecture

One package, two plugin entry points, one shared library.

```
plugins/dsh-compaction-guard/
  package.json          dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml      disables the two shipped rows; inserts our two
  engine.js             GuardedCompactionEngine : BasicCompactionEngine
  pruner.js             GuardedToolResultPruner : ToolResultPruner
  lib/summary-quality.js  validateSummary() — pure
  lib/pending-batch.js    isMidTurn() + routedProvider() — pure
  tests/                node --test, offline
  README.md             what it guards, why, and how to remove it
```

Two entry points rather than one because the two services have different injections
(`['llm','tokenMeter','sessions']` vs `['tokenMeter']`) and different config schemas. Splitting them keeps
each row's `config` valid against its own schema.

---

## 8. Implementation guide

### 8.1 package.json

Mirror `plugins/dsh-meridian-antigravity/package.json`, minus the client block:

```json
{
  "name": "@local/dsh-compaction-guard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Compaction guards: reject degenerate summaries, defer tool-result pruning under a delivered-prefix contract.",
  "meta": { "title": "Compaction Guard", "description": "Guards against destructive compaction outcomes." },
  "exports": {
    ".": "./engine.js",
    "./pruner": "./pruner.js",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 8.2 `lib/summary-quality.js`

Pure, no harness imports. Export `summaryText(blocks)` and `validateSummary(blocks, context, config)`,
where `context` carries the rejected-summary memo and the input size. `validateSummary` returns
`{ ok: true }` or `{ ok: false, reason }`. Keep every threshold in `config` so the plugin's behaviour is
readable from the row.

### 8.3 `lib/pending-batch.js`

Pure. Export:

- `routedProvider(session)` → `session.requestHeader()?.config?.provider`
- `isMidTurn(session)` → walks the surface tail using `session.surface.nodes` and `session.eventAt(seq)`,
  exactly as the shipped pruner does, and applies the two-part predicate from §4.

### 8.4 `engine.js`

```js
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { validateSummary, summaryText } from './lib/summary-quality.js'

export const name = 'compaction-guard-engine'
export const inject = ['llm', 'tokenMeter', 'sessions']

export class DegenerateSummaryError extends Error {
  constructor(reason, text) {
    super(`compaction-guard: refusing degenerate summary (${reason}): ${JSON.stringify(text.slice(0, 120))}`)
    this.name = 'DegenerateSummaryError'
  }
}

export class GuardedCompactionEngine extends BasicCompactionEngine {
  // Redeclare the parent's schema fields plus the guard's, because the row's
  // config is validated against the declared Config.
  static Config = /* thresholdRatio … auto (parent's) + guard fields */

  #rejected = new WeakMap()   // Session -> { text, count }

  async summarize(input, agent, signal) {
    const result = await super.summarize(input, agent, signal)
    const verdict = validateSummary(result.summary, {
      session: agent.session,
      rejected: this.#rejected.get(agent.session),
      inputChars: measureInput(input),
    }, this.config)
    if (!verdict.ok) {
      this.#rejected.set(agent.session, { text: summaryText(result.summary), count: … })
      throw new DegenerateSummaryError(verdict.reason, summaryText(result.summary))
    }
    this.#rejected.delete(agent.session)
    return result
  }
}

export function apply(ctx, config) {
  new GuardedCompactionEngine(ctx, config)

  // Bound the retry: answer our own error with `true`, everything else with
  // `false` so shipped handlers (compaction-image-offload) keep their meaning.
  ctx.on('compaction/summary-error', (payload, next) => {
    if (!(payload.error instanceof DegenerateSummaryError)) return next()
    const tries = attemptsFor(payload.session)
    if (tries >= config.maxDegenerateRetries) return false   // fail loudly, commit nothing
    attemptsBump(payload.session)
    return true                                              // retry summarization
  })
}

export default GuardedCompactionEngine
```

Notes that matter:

- `BasicCompactionEngine`'s constructor calls `resolveConfig(config)` and registers automatic compaction
  when `auto` is set — call `super(ctx, config)` and keep the parent's config fields in the row.
- The waterfall handler must consult `next()` for foreign errors, or it silently disables
  `compaction-image-offload`'s recovery.
- The attempt counter must be per session and must be cleared once a summary is accepted, so an
  unrelated later compaction starts fresh.

### 8.5 `pruner.js`

```js
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { isMidTurn, routedProvider } from './lib/pending-batch.js'

export const name = 'compaction-guard-pruner'

export class GuardedToolResultPruner extends ToolResultPruner {
  static Config = /* parent's three fields + contractProviders + deferWhenBatchPending */

  pruneSession(session) {
    if (this.#shouldDefer(session)) {
      this.ctx.logger.debug('compaction-guard: deferring tool-result prune mid-turn on a contract provider')
      return { pruned: [], charsRemoved: 0 }
    }
    return super.pruneSession(session)
  }

  #shouldDefer(session) {
    if (!this.config.deferWhenBatchPending) return false
    const provider = routedProvider(session)
    if (provider === undefined || !this.config.contractProviders.includes(provider)) return false
    return isMidTurn(session)
  }
}

export default GuardedToolResultPruner
```

### 8.6 `cordis.patch.yml`

```yaml
# Disable the shipped compaction pair and mount the guarded replacements.
# `name` on an existing id asserts the current name rather than renaming it, so
# the swap is disable + insert; service identity is what takes effect.
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true

- insert:
    - id: compaction-guard-engine
      name: '@local/dsh-compaction-guard'
      config:
        # parent fields, restated because `config` is replaced wholesale
        auto: true
        compactionRetries: 2
        # guard fields
        minSummaryChars: 400
        minRatio: 0
        rejectPatterns: []
        maxDegenerateRetries: 2
    - id: compaction-guard-pruner
      name: '@local/dsh-compaction-guard/pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
        deferWhenBatchPending: true
        contractProviders:
          - meridian-antigravity
```

Two cautions:

- **Restate every parent config field.** `config` is replaced wholesale, never deep-merged. Copying the
  effective values from the running setup avoids silently resetting thresholds. Capture them first with
  `plugin_manager list_plugins` / the composed config before writing the row.
- **Package specifier vs relative path.** Subpath specifiers depend on the package's `exports` map and on
  the bundle being installed in the profile. If `@local/dsh-compaction-guard/pruner` fails to resolve, use
  the dialect's relative form (`name: './pruner.js'`, anchored beside the patch file) — the same package
  directory holds both files.

### 8.7 Install and verify

1. Write the package into `plugins/dsh-compaction-guard/`.
2. Syntax-check both entry points (`node --check`) and the two pure libraries.
3. Install with `plugin_manager` `action: install_bundle`, target the absolute package directory.
4. Confirm the swap actually took effect — **do not assume the disable landed**:
   `plugin_manager action: list_plugins` and check that `compaction-basic` and `tool-result-pruner` report
   `enabled: false`, and that both guard rows are present with their config.
5. If a disable did not take (an ordering problem between bundle layers), move the two `disabled: true`
   rows into the profile patch `/root/.dsh/profiles/web/cordis.patch.yml`, which is applied last, and
   re-check.
6. Confirm `ctx.compaction` and `ctx.toolResultPruner` resolve to our instances — a stale duplicate
   service or a silently-missing one is the main failure mode of a replace-by-disable swap.

---

## 9. Testing

**Offline (no harness, no quota)** — `node --test`, the bulk of the value:

- `validateSummary`: a 31-character summary is rejected; a substantial summary is accepted; an empty
  block list is rejected; a repeated rejected summary is rejected; configured patterns and floors behave;
  thresholds are inclusive/exclusive exactly as documented.
- `isMidTurn`: table-driven over surface tails — `tool/result` tail → true; assistant tail with unmatched
  tool calls → true; assistant tail with all calls matched → false; assistant tail with no calls → false;
  empty surface → false.
- `routedProvider`: missing header, empty provider, and a normal header.

**Integration (no live model)** — instantiate both subclasses against a stubbed context with a stub
summarizer and a stub session, and assert the acceptance criteria in §3 and §4: nothing is committed on
a degenerate summary, retries are bounded, and the pruner no-ops only in the guarded window.

**Live check (needs quota, do last)** — force a compaction on a `meridian-antigravity` session mid-tool
batch and confirm the turn completes with zero 409s; then confirm a normal compaction still commits on a
DeepSeek route.

---

## 10. Rollout, rollback, risks

**Rollback** is two lines: delete the two `disabled: true` rows and the `insert` block, or disable the
two guard rows. The shipped plugins take over again on the next mount. Nothing durable is rewritten by
this plugin, so rollback cannot corrupt a session.

**Risks:**

| Risk | Mitigation |
| --- | --- |
| Disable does not apply (layer ordering) | Verify with `list_plugins`; fall back to the profile patch. |
| Duplicate `ctx.compaction` if the disable silently fails while our row mounts | Step 4/6 verification is mandatory, not optional. |
| Parent config fields reset by wholesale replacement | Capture the effective values before writing the row. |
| Summary floor rejects a legitimately terse but correct summary | Floor is configurable; log rejections with reason and the rejected text so tuning is evidence-driven. |
| Deferral makes context pressure worse on Meridian sessions | Accepted and documented; it is the price of the provider's contract. The summary guard still reduces context at turn boundaries. |
| Behaviour drifts from upstream if compaction-basic changes | Pin expectations in tests; treat an upstream `summarize`/`pruneSession` signature change as a compatibility break. |

---

## 11. Upstream recommendations

This is a plugin because a plugin is the least invasive fix, not because these are the right long-term
homes. Two changes belong upstream:

1. **`compaction-basic` should reject a summary on substance, not only size.** `region.ts:418` proves the
   intent to validate the artifact; a minimum-substance check belongs beside it so every deployment gets
   it, not only ones that install a guard.
2. **The pruner should be contract-aware.** A pruning pass that rewrites history a provider has already
   been given is invalid on any delivered-prefix backend, and the pruner is model-free and knows nothing
   about routes. Either the engine should not call it mid-turn on such a route, or the pruner should
   receive the routed target.

Case 3 — retrying a consumed continuation — is a retry-policy defect in `llm-pi-ai` and is tracked
separately.
