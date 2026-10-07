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
unproven there.

### The guard could never run, until 2026-10-07

`BasicCompactionEngine` reaches the pruner through `ctx.get('toolResultPruner')`
(`compaction-basic/src/index.ts:292`) and calls a method on that service. Cordis invokes a
service method with a **shadow** receiver rather than the instance (`createShadowMethod`,
`cordis/lib/index.js:116`), and a `#private` field is not installed on the shadow. So the
original `this.#guard` threw:

```
TypeError: Cannot read private member #guard from an object
           whose class did not declare it
    at Proxy.pruneSession (pruner.js:68)
```

The throw is not caught at the call site, so before the fix an over-budget prune did not
defer — it aborted the compaction pass. `engine.js` had the same defect in `summarize()`
via `#guard`, `#rejected` and `#attempts`.

Both classes now keep that state in public fields, assigned once in the constructor and
never reassigned (a write through the shadow would land on the shadow). This is why the
guard has never been observed doing anything in any realm since it was written.

`tests/pruner-deferral.test.js` reproduces it. It builds a real `Session`, runs the shipped
pruner as a control, then runs the guarded one **through `ctx.get`**, which is the path the
engine takes — the earlier unit tests covered `shouldDeferPrune`, a pure predicate that
nothing in the live path was obliged to call, so a broken override was invisible:

```
✔ the shipped pruner prunes this fixture, so the control is real
✔ the guarded pruner is the service the engine resolves
✔ a surface ending on an unanswered tool result is deferred
✔ the deferral is the guard, not an inert pruner
✔ a route outside contractProviders is pruned as before
✔ the deferral switch turns it off
✔ an unmatched tool result is deferred rather than throwing
✔ guard state survives the service shadow, which is why it is not #private
✔ the engine guard state is reachable through its service too
```

Run it with `./tests/run.sh`, which builds a module-resolution rig; the pure tests also run
standalone with `node --test tests/pending-batch.test.js tests/summary-quality.test.js`.

The engine's *decision* is still only pinned at the property-read level. Driving
`summarize()` through the service would need a full agent and a real summarisation call, so
a regression that made the engine read a shadow-local field would still be caught, but one
that broke the validation logic would not.

### The chronology that looked like a failure

An earlier revision of this file claimed the guard had demonstrably failed to defer on
2026-10-04, citing four `dd35` sessions. That was wrong: it joined prune events to the
sessions' **file** mtimes instead of to the events' own timestamps, which are much earlier.

The events say:

| session | pruned at | conflict at |
| --- | --- | --- |
| `f349a9a1` | 2026-10-04 10:12:48 | 10:12:48 |
| `4678ab35` | 2026-10-04 10:32:50 | 10:32:50 |
| `53bcb5d2` | 2026-10-04 10:34:28 | 10:34:28 |
| `2918da11` | 2026-10-04 11:03:54 | — |

The guarded patch was committed at 10:36:50 and the process that read it started at
11:32:35, so three of those sessions pruned *before the guard existed on disk* and the
fourth before any process had loaded it. **No `dd35` session has pruned under a process that
had the guard loaded**, which is consistent with the deferral working — and equally
consistent with the exception above, which is what was actually happening.

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
tests/run.sh            module-resolution rig; runs every test below
tests/pending-batch.test.js    the mid-turn predicate (pure)
tests/summary-quality.test.js  the substance rules (pure)
tests/preset-override.test.js  the preset declaration copy, against the installed file
tests/pruner-deferral.test.js  a real Session through ctx.get, which is the engine's path
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
