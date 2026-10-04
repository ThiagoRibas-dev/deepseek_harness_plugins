# dsh-context-pressure

Steers one notice into a running turn when the context window crosses a
configured fraction, so the model can persist what it would need to resume
**before** compaction replaces earlier history.

## Why the band is 75%

Compaction's own pressure trigger is a window fraction that defaults to **0.8**
(`compaction-basic/types.ts:11`). A nudge at 0.75 therefore lands in the window
before compaction fires, not after. That gap is small on purpose — roughly one
tool call and one write — so the nudge is a prompt to act now, not a warning to
plan around.

Once compaction has run, the model's view of earlier history is whatever the
summary says. If the model has already written its own notes, that summary is no
longer the only surviving record.

## What it does and does not do

- **Does** give the model a chance to write durable notes before compaction.
- **Does not** compact anything, and does not prevent compaction. It is warn-only
  by design: proactive compaction at 75% would be a mid-turn surface rewrite,
  which is exactly the failure this repository's compaction guard exists to
  prevent on delivered-prefix providers.
- **Does not** protect against a useless summary. That is
  `plugins/dsh-compaction-guard`'s job. The two are complementary: the nudge
  means real notes exist, and the guard means a worthless summary cannot be the
  thing that survives.

## Mechanism

- Hook: `agent/pre-step`, the same seam `compaction-basic` uses for automatic
  pressure compaction.
- Measurement: `ctx.tokenMeter.measure(session).totalTokens` against
  `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`, minus
  reserved output tokens — the same arithmetic compaction uses, so the two agree
  about how full the window is.
- Delivery: `agent.steer(createUserMessage(...))`. `steer` targets `next-step`
  and wakes the driver (`agent-loop/src/agent.ts:166`), so the notice is part of
  the next request in the same turn.
- Hysteresis: one nudge per pressure episode. The flag re-arms only when the
  window drops back below `rearmRatio`, which in practice means a compaction
  landed. Without it the nudge would repeat on every step.

## Mounting

One **host-plane** row. Session events bubble to ancestor contexts, so a host
listener sees every agent, including preset-scoped ones. This plugin provides no
service, so unlike the compaction guard it does not need to be mounted inside a
preset's isolated group.

**Do not also mount it inside a preset group.** That registers a second listener
for the same sessions and steers the nudge twice.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `warnRatio` | `0.75` | Window fraction that triggers the nudge. |
| `rearmRatio` | `0.6` | Drop below this to re-arm. Clamped strictly below `warnRatio`. |
| `message` | generic | Template. Placeholders: `{percent}`, `{used}`, `{window}`. |

The default message is deliberately generic, because a plugin cannot know what a
given session calls its scratchpad. A preset that owns a notes or memory tool
should override `message` to name it — see the commented example in
`cordis.patch.yml`.

## Known risk: the nudge is a mid-continuation request change

On a provider that pins a tool continuation to the history it already delivered
— `meridian-antigravity` in this profile — **any** change to the model-visible
request during a pending tool batch can be refused. Injecting a message is such a
change, and it is the same class as the pruning rewrite that caused the failures
this repository has been chasing.

There is a specific reason to expect it is safe: Meridian's own source anticipates
it (`antigravity.ts:69` — *"Clients may append steering as text in the result
message or as another user message"*), and steering lands **after** the tool
results, so the delivered prefix — everything up to the last assistant message,
which is what the `historyKey` guard compares — is unchanged.

This has **not been verified on a live Meridian tool batch.** Verify it before
trusting the nudge on that route: run a long tool loop on `meridian-antigravity`
past 75% and confirm the turn completes and no
`Pending Antigravity tool continuation changed...` appears. If it does, the nudge
must be deferred to a balanced surface cut, which would cost most of its value on
that route.

## Rollback

Disable or remove the `context-pressure` row. The plugin writes nothing durable
of its own; the only trace is the steered message in the affected sessions.

## Layout

```
index.js              pre-step hook, measurement, steer
lib/pressure.js       band policy and message rendering (pure, offline-tested)
tests/                node --test tests/*.test.js
cordis.patch.yml      the host-plane row
```
