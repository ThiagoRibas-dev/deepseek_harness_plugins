# Compaction freshness and checkpoint framing — plugin-only plan

Two defects, both documented with measurements in `docs/lessons-learned.md` §8, and both fixable without
touching the harness:

| Defect | Symptom | Where the fix belongs |
| --- | --- | --- |
| **Staleness** | a checkpoint written hours and several turns ago keeps describing the session as it was then, so the model answers an older state and re-offers a choice already made | a host plugin (approach A) |
| **Framing** | the checkpoint's `## Next Step` is phrased as an instruction ("await user selection") and the preamble tells the model to treat it as established background, so it outlives its trigger | our connector's wire derivation (approach B) |

Status: **both implemented 2026-10-24.**

| Part | Where | Tests |
| --- | --- | --- |
| A | `plugins/dsh-compaction-freshness/` (`index.js`, pure `policy.js`, `cordis.patch.yml`) | `node --test plugins/dsh-compaction-freshness/tests/policy.test.mjs` — 7 checks |
| B | `plugins/dsh-meridian-antigravity/lib/serialize.js` (`reframeCheckpoint`) | `tests/serialize-notices.mjs` — framing replaced, body untouched, prefix unmoved |

Neither is live yet: A needs its `cordis.patch.yml` row mounted in the profile, and both need a restart.

## Approach A — freshness trigger (new plugin)

```
plugins/dsh-compaction-freshness/
  index.js          apply(ctx, config) — agent/status listener
  policy.js         pure: is this checkpoint stale?
  cordis.patch.yml
  tests/policy.test.mjs
```

**Hook.** `agent/status`, only on the transition to `idle`:

```js
ctx.on('agent/status', ({ agent, status }) => {
  if (status !== 'idle') return
  void refresh(ctx, settings, seen, agent).catch(error => {
    ctx.logger?.warn?.(`compaction-freshness: ${String(error)}; leaving the checkpoint alone`)
  })
})
```

**Why not `agent/pre-step`.** `compactNow` runs through `runMaintenance`, whose contract is *"run a
non-turn maintenance operation only while the agent is idle… throws synchronously when the agent is already
active"*. Pre-step is mid-turn, so it would always be `busy`. `agent/status` is the idle boundary, and the
engine withholds waking input (FIFO) until the refresh settles — a message sent during it waits rather than
racing.

**Staleness metric.** Pure, computed from the session surface:

- `since` — `surface.nodes.length` minus the index of the newest `compact-checkpoint` node. Measures
  messages the checkpoint has not seen; cheaper and more honest than wall-clock age.
- `checkpointSeq` — identifies which checkpoint was evaluated, so a new checkpoint re-arms the guard.
- `isMidTurn(session)` must be false — the same test `dsh-tool-result-policy/pass.js` uses. A refresh
  rewrites history, and on a Meridian session that is a prefix change; it must never happen with a tool
  batch open.

**Config.**

```yaml
refreshAfterMessages: 40   # messages appended since the checkpoint
cooldownMs: 300000         # never twice in five minutes
maxRefreshes: 3            # per session
```

**Cost.** One summarisation call per refresh — measured 69,177 input / 5,970 output tokens, ~30 s, on the
manual `/compact` in `session-d772c4cf`. That is why the threshold is conservative and why the refresh runs
only at idle.

**Guards.** `busy` from `compactNow` is a no-op, not an error (the engine's durable lock is shared with
automatic pressure compaction). Attempts are tracked per `(session, checkpointSeq)` so a failed refresh is
not retried on every idle. Maps are capped, keyed by the session object.

## Approach B — checkpoint framing at dispatch (connector change)

The rewind happened because the model obeyed text that was already in the transcript. That text passes
through our derivation on the way to the wire, so it can be rewritten there.

**Where.** `plugins/dsh-meridian-antigravity/lib/serialize.js`, beside `filterNoticeMessages`: when a message
carries `source.kind === 'compact-checkpoint'`, replace its preamble with one that names the winner —
*"later messages supersede this checkpoint; the newest user message defines the task; do not re-offer a
choice the conversation has already settled"* — and leave the summary body untouched.

**Why this is prefix-safe.** The transform is a pure function of the surface message, applied to **every**
request, opener and continuation alike. Same input, same bytes, every dispatch — which is exactly what
Meridian's continuation contract needs. Injecting a *new* notice per step would not be; that is why the
`context-pressure`-style approaches are rejected.

**Caveat.** It lives in the Meridian connector, so it helps Meridian sessions only. A provider-agnostic
version would use `agent/pre-step`'s message replacement (`'agent/pre-step'(payload: { messages }, next)`),
which is safe for providers without prefix matching and a prefix risk for Meridian — so it would need the
same "deterministic everywhere" rule.

## Rejected: patching the summariser from a plugin

`compactNow` calls `this.summarize` through a closure (`compaction-basic/src/index.ts:441`), so a plugin
*could* shadow that method on the live engine instance and supply a better instruction. Rejected:

- it means reimplementing the summarisation call against `ctx.llm.stream` ourselves;
- it depends on an internal method name and shape, which fails silently on upgrade;
- it duplicates machinery the harness already owns, for a fix that approach B delivers at the dispatch
  boundary with none of that risk.

The harness is not patched. The connector rewrites the checkpoint preamble at the dispatch boundary, which is
where the wire is shaped, and that decision is settled in `pending-work.md`.

## Test plan

| Approach | Offline | Live |
| --- | --- | --- |
| A | `policy.js` unit tests: fresh vs stale, cooldown, re-arm on a new checkpoint, refresh cap | leave a session to cross the threshold; expect a `compaction/summary` event at an idle boundary with **no user message in between**, and no refusal around it |
| B | `serialize.js` test: a `compact-checkpoint` message is rewritten identically on an opener and on a continuation; the body after the preamble is byte-identical | after a compaction, the wire body's checkpoint opens with the new preamble (capture or session store) |

## Open questions

1. Does approach B's rewritten preamble actually change the model's choice, or does the body's `## Next
   Step` still dominate? Only a live rewind reproduces that, so the test is opportunistic.
2. Should approach B also strip an `## Next Step` section outright, or only reframe the preamble? Stripping
   loses state; reframing assumes the model reads instructions in order.
3. For approach A, is 40 messages the right threshold? The measured freeze was 6 turns / 22 messages, and a
   refresh costs ~70k input tokens — the two numbers argue for different settings.
