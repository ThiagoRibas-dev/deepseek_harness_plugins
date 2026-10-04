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
files directly. The `web-app` bundle separately disables the host-plane
`compaction-basic`, `tool-result-pruner` and `command-compact` rows, so this
bundle's own `disabled` flags are redundant there — they are kept only so the
bundle states its intent if another profile leaves those rows enabled.

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
the next mount. This plugin writes nothing durable of its own, so rollback
cannot corrupt a session.

## Layout

```
engine.js               GuardedCompactionEngine : BasicCompactionEngine
pruner.js               GuardedToolResultPruner : ToolResultPruner
lib/summary-quality.js  substance rules (pure, offline-tested)
lib/pending-batch.js    mid-turn predicate (pure, offline-tested)
tests/                  node --test tests/*.test.js
cordis.patch.yml        disables the shipped pair, inserts the guards
```

Row `name`s are relative paths, which the loader anchors beside the patch file.
If that ever stops resolving, `@local/dsh-compaction-guard` and
`@local/dsh-compaction-guard/pruner` are the equivalent package specifiers.

## Out of scope

A third failure in the same incident — turn 3's `Antigravity tool result was
already consumed` on the shipped `llm-pi-ai` OpenAI-completions route — is a
retry-policy defect: a continuation was retried after the provider had consumed
it. This plugin does not touch retry policy. See §5 of the plan.
