# dsh-compaction-guard

Two guards against the compaction behaviours that destroyed session
`session-293cca94` on 2026-10-04. **No harness source is modified.** Each guard
subclasses a shipped compaction plugin and delegates to it; only two specific
bad outcomes are refused.

Full analysis, evidence and acceptance criteria:
[`docs/compaction-guard-implementation-plan.md`](../../docs/compaction-guard-implementation-plan.md).

## What it guards

### Case 1 — a degenerate summary must not be committed

The shipped engine checks that a summary is *smaller* than the span it replaces
(`compaction-basic/src/region.ts:418`) and never that it *is* a summary. In the
incident, six summarization attempts failed with `no text summary content` and
the seventh succeeded with:

```
I can't answer in a 1-token limit.
```

31 characters, replacing 1840 events (`seqs 9-1849`). It was well-formed, so no
error handler could see it, and small enough to pass the size check. That
session's model-visible context is now gone.

`engine.js` overrides `BasicCompactionEngine.summarize()` — the hook the shipped
class documents as its sole subclass customization point — and validates the
result before it can become a checkpoint. A rejection throws, which the engine's
existing retry loop routes through the `compaction/summary-error` waterfall,
where this plugin allows a bounded number of retries and then declines, so the
compaction fails **without committing anything**.

### Case 2 — no mid-turn rewrite on a delivered-prefix provider

The shipped engine runs the model-free tool-result pruner before summarising
(`compaction-basic/src/index.ts:296` and `:324`). A prune rewrites surface nodes
with `replace` ops. Meridian's Antigravity backend pins a tool continuation to
the exact history it already delivered (`antigravity.ts:86`) and answers 409 when
that prefix moved, which is what wedged turns 16, 17 and 18.

`pruner.js` overrides `ToolResultPruner.pruneSession()` and defers the pass when
the routed provider enforces a delivery contract **and** the surface is mid-turn.
Mid-turn is decided with the harness's exported pairing cuts — defer unless the
tail is balanced on both sides — so no deprecated event read is involved. An
unreadable pairing state defers, because "cannot tell" is not "safe".

## Trade-offs, stated plainly

- On a contract provider, pruning becomes **turn-boundary-only**, which is
  exactly when context pressure peaks. There is no way to keep mid-turn pruning
  on such a route: the rewrite is what the provider refuses. Summarization still
  reduces context at turn boundaries.
- The substance floor is a heuristic. It is a length floor plus optional
  patterns — not a judgement about summary quality. A long, wrong summary still
  passes. Set `minRatio` above zero only if you accept it rejecting legitimately
  terse summaries.

## Placement: compaction may be preset-scoped

**Read this before trusting the guards.** A compaction service is not
necessarily mounted at the host plane. A preset can own one inside an isolated
group:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config: [ ...its own compaction-basic and tool-result-pruner... ]
```

`isolate` puts that provider in a different realm, so a guard mounted at the
host plane **cannot reach those sessions**. The guard has to be mounted inside
the same group.

In this profile that is the case for the `dd35` preset, which mounts the guarded
files directly, and for the shipped `standard` preset, which this bundle's own
patch now overrides wholesale. The `web-app` bundle separately disables the
host-plane `compaction-basic`, `tool-result-pruner` and `command-compact` rows,
so this bundle's own `disabled` flags are redundant there — they are kept only so
the bundle states its intent if another profile leaves those rows enabled.

Overriding a shipped declaration is the only way in, because a patch replaces a
row's `config` wholesale and a preset's plugin list is not a Loader row that
`disabled` can reach. Two consequences:

- The shipped plugin list is restated verbatim, so an upstream change to
  `presets/standard.patch.yml` does not reach `standard` sessions until that copy
  is refreshed. `tests/preset-override.test.js` pins the copy to the installed
  file and fails on any drift outside the two swapped rows. `ptc` and `cordis`
  are not overridden and stay unguarded.
- The names inside a declaration must be absolute `file:///` URLs. The loader
  anchors a relative plugin name only inside an `insert` list, so `./engine.js`
  there resolves against the root entry list's base, fails to import, and
  activates the preset as broken rather than merely unguarded.

Before installing, establish which realm actually serves the sessions you care
about:

1. `plugin_manager action=list_plugins` — find every `compaction-*` row and
   whether it is enabled.
2. Search the preset bundles for a `cordis:group` whose `isolate` names
   `compaction`. Any such group mounts its own engine.
3. Mount the guard in every realm that provides one, or the sessions you care
   about run unguarded.

## Install

```
plugin_manager action=install_bundle target=<abs path to this directory>
```

Add `@local/dsh-compaction-guard` to the profile's `dsh.profile.bundles` list
after `@deepseek-ai/dsh-base` so its patch layer applies after the base bundle.

For a preset that owns an isolated compaction group, also point that group's
nested rows at this package's files by absolute `file:///` URL, as
`plugins/dsh-dd35-preset/cordis.patch.yml` does.

## Verify the swap actually took effect

Do not assume it. A silently-failed `disabled` would leave two `ctx.compaction`
providers or the shipped pruner still active.

```
plugin_manager action=list_plugins
```

- `compaction-basic` → `enabled: false`
- `tool-result-pruner` → `enabled: false`
- `compaction-guard-engine` and `compaction-guard-pruner` → present, with config

Those three lines settle the host plane and nothing else. **A preset's own rows are
not Loader rows, so `list_plugins` cannot confirm or refute the swap inside one.** In
particular, `preset-standard` reporting `fiberPhase: active` means only that the
declaration row mounted: `agent-preset-registry` catches a child-mount failure into its
own `broken` record and calls `logger.warn`
(`packages/preset/agent-preset-registry/src/index.ts:112-125`), so a preset whose guard
rows failed to import still shows as active. The harness journal is no help either — it
has emitted no lines at all between restarts.

The two checks that do work are behavioural:

- a session on that preset composes at all, which it cannot if a row failed to import;
- a prune lands at a turn boundary. The guard defers only while a batch is pending, so a
  guarded realm that never prunes anywhere is as consistent with a broken guard as with a
  working one. `pruner.js` logs the deferral at `debug`; without that level, absence of
  `compaction/prune` mid-batch is the only signal, and it is a weak one.

As of 2026-10-07 no session has run on `standard` since the override loaded, so the swap is
unproven there. In `dd35` it is worse than unproven: the guard has been declared since
2026-10-04 10:36 and has demonstrably **not** deferred when it should have.

### The guard did not defer on 2026-10-04 (unresolved)

Four `dd35` sessions pruned after the guarded patch was declared *and* after the process
restart that read it (patch commit `8a0ab42` at 10:36, restart at 11:32, sessions at
13:12, 13:32, 13:34 and 14:38). In each one the first prune lands with the surface ending
on a `tool/result` that no assistant message has answered — the state `isMidTurn` exists
to defer — and three of the four took a `MERIDIAN_CONTINUATION_CONFLICT` within six
events of the prune burst:

```
session-4678ab35   prune 359,361,...,369  conflict 375
   355 assistant/message [call:read]  356 tool/call  357 tool/result  358 step/end
session-53bcb5d2   prune 427,429,...,441  conflict 447
session-f349a9a1   prune 90                        conflict 96
session-2918da11   prune 141,143,145               no conflict
```

Every input the guard reads checks out in all four:

- `routedProvider` was `meridian-antigravity` at every `request/header`, and every
  assistant message in those sessions came from it, so `contractProviders` matched;
- `SURFACE_EVENT_TYPES` is `system/developer/user/assistant/tool/result`
  (`core/session/src/surface.ts:50`), so a `step/end` between the result and the prune is
  not on the surface and the tail really was the tool result;
- `toolPairingBalancedBefore` is false for a tool-result tail by construction — the cut
  before it still has the call open — and `isMidTurn` returns true for exactly that case
  in `tests/pending-batch.test.js:45`;
- the guarded rows were in the dd35 patch before the restart, with `deferWhenBatchPending:
  true` and `contractProviders: [meridian-antigravity]`.

So `pruneSession` should have returned `DEFERRED` and written no events. It wrote six.
Two mechanisms remain and nothing offline separates them: the engine resolved a different
`toolResultPruner` than the guarded row (`compaction-basic/src/index.ts:292` reads it from
`ctx.get`), or the predicate saw a surface that differs from the reconstructed one. The
session log records neither, and `pruner.js` logs the deferral at `debug`, which the
harness journal does not carry.

**What would settle it:** a test that drives `GuardedToolResultPruner.pruneSession` — not
`shouldDeferPrune` — against a session whose surface ends on an unanswered tool result, and
asserts the parent never ran. No test does that today; `pending-batch.test.js` covers the
pure helpers only, which is why a broken override would be invisible. If that passes, the
remaining suspect is the service the engine resolves.

Until then, treat the guard as unproven everywhere. No `dd35` session has pruned since
2026-10-04 14:38, which is consistent with the deferral working and with the pruner simply
not running.

If a `disabled` flag did not apply, move those two rows into the profile patch
`$DSH_PROFILE_DIR/cordis.patch.yml`, which is applied after every bundle layer,
and re-check.

## Config

Engine row (`engine.js`):

| Field | Default | Meaning |
| --- | --- | --- |
| `minSummaryChars` | `400` | Substance floor on trimmed summary text. The load-bearing rule. |
| `minRatio` | `0` | Optional floor relative to input size. `0` disables. |
| `rejectPatterns` | `[]` | Substrings that mark a summary as unusable. |
| `maxDegenerateRetries` | `2` | Retries before refusing the compaction outright. |

Pruner row (`pruner.js`): the parent's `thresholdChars` / `headChars` /
`tailChars`, plus:

| Field | Default | Meaning |
| --- | --- | --- |
| `deferWhenBatchPending` | `true` | Master switch for the deferral. |
| `contractProviders` | `[meridian-antigravity]` | Providers that pin the delivered prefix. |

Guard fields are stripped before the parent sees the config, because both parent
classes throw on unknown keys.

## Rollback

Delete the two `disabled: true` rows and the `insert` block from
`cordis.patch.yml`, or disable the two guard rows. Shipped behaviour returns on
the next mount. The `preset-standard` override is independent: delete that block
on its own to hand `standard` back to the shipped declaration. This plugin writes
nothing durable of its own, so rollback cannot corrupt a session.

## Layout

```
engine.js               GuardedCompactionEngine : BasicCompactionEngine
pruner.js               GuardedToolResultPruner : ToolResultPruner
lib/summary-quality.js  substance rules (pure, offline-tested)
lib/pending-batch.js    mid-turn predicate (pure, offline-tested)
tests/                  node --test tests/*.test.js
cordis.patch.yml        disables the shipped pair, inserts the guards
```

The `name`s of the inserted rows at the end of `cordis.patch.yml` are relative
paths, which the loader anchors beside the patch file. Names inside a preset
declaration are not anchored and must be absolute `file:///` URLs, or the package
specifiers `@local/dsh-compaction-guard` and
`@local/dsh-compaction-guard/pruner`.

## Out of scope

A third failure in the same incident — turn 3's `Antigravity tool result was
already consumed` on the shipped `llm-pi-ai` OpenAI-completions route — is a
retry-policy defect: a continuation was retried after the provider had consumed
it. This plugin does not touch retry policy. See §5 of the plan.
