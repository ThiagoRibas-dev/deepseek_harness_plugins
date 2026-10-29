# Pending work — ordered

Consolidates what is still outstanding across the connector, the freshness plugin and the deployment.
Each item states its acceptance check, because several earlier theories died for want of one.

Status: **1.86.0 update not started**, connector fix committed at `3590146`, freshness plugin mounted but
unverified.

## 1. Meridian 1.86.0 update (blocking most of the rest)

| | |
|---|---|
| Why | 1.83.0 #1382 keeps Antigravity prompts within `agy`'s input step instead of *losing the newest turn* — the mechanism behind ignored messages. 1.86.0 #1437 additionally compacts older assistant text inside tool loops, which is the tool-call looping measured in `Review Unstaged Git Files (9)` (287 and 333 steps per turn, 34–37 verbatim repeated calls) |
| Do | `pnpm add -g @rynfar/meridian@1.86.0`; `systemctl --user daemon-reload && systemctl --user restart meridian-agy` |
| Accept | `/health` reports `1.86.0`, `build.source: npm`, `cliVersion 1.3.4`; `mode: passthrough` unchanged |
| Rollback | `pnpm add -g @rynfar/meridian@1.81.0` + restart |

Prerequisites: restart once with `MERIDIAN_DEBUG=1` (already in the unit) and record a baseline session, so
"after" has something to compare against.

## 2. Measure the body-to-prompt ratio (blocks item 3)

Our captures record body bytes; `transcript_full.jsonl` records the prompt Meridian built. Take one dispatch,
pair the two, and record the ratio. Every byte threshold in item 3 depends on it, and there is currently no
number — only the assumption that they are close.

Accept: a table of three dispatches with body bytes, prompt chars, and the ratio.

## 3. Connector: byte-aware prompt budget

New `lib/budget.js`, called before dispatch:

```
serialize → estimate prompt bytes (body × ratio) → over cap?
         → throw CONTEXT_WINDOW_EXCEEDED  → compaction-basic compacts, retries once
         → still over → surface a real failure (no loop)
```

- Cap from config defaulting to the release's `MERIDIAN_AGY_MAX_PROMPT_BYTES` (190,000). Never hard-code it:
  it did not exist in 1.81.0 and arrived in 1.83.0.
- Depends on 1.83.1 #1388, which preserves context-overflow signals for client compaction.
- No trimming in the connector: that recreates the silent loss being removed.
- Tests: over-cap → `CONTEXT_WINDOW_EXCEEDED`; under-cap → wire byte-identical to today; second consecutive
  failure surfaces; threshold threaded through config.

## 4. Loop report tool

Promote the ad-hoc measurement into `tmp/meridian/loop-report.mjs <session-suffix>`: per turn steps, calls,
wall time, verbatim repeated calls, top repeated signatures. It is the regression test for items 1 and 3, and
needs no restart.

Accept: reproduces the numbers already quoted for `Review Unstaged Git Files (9)`.

## 5. Idle deadline: 300,000 → ~120,000

The connector's `streamIdleTimeoutMs` default is 300 s while Meridian abandons an upstream turn after 90 s
(`MERIDIAN_UPSTREAM_IDLE_MS`), and stops retrying after three consecutive stalls. Ours should be a backstop,
not a second policy.

Accept: a stalled stream is abandoned by the connector in ~2 minutes, and the recovery retry is not spent on
a stream Meridian was still willing to continue.

## 6. Lease failures must not reach the repair path

`MERIDIAN_SESSION_TURN_MAX_HOLD_MS` (600,000) means a stalled holder answers **503 `overloaded_error`** with a
distinct reason. Assert in `errors.js` that a lease failure never classifies as a transcript conflict, or the
connector sends a repair pair for a queueing problem and spends the retry.

Accept: a test feeding the lease 503 body returns a capacity error, not a conflict.

## 7. Verify the freshness plugin

Mounted through its bundle patch; `apply` was never observed running. The mount log line now makes it
observable.

Accept: `compaction-freshness: mounted (…)` in the launcher console, then one refresh after 40 messages past
a checkpoint at an idle boundary.

## 8. Verify the sticky rotation, live

`streamIdleTimeoutMs: 6000`, one message, two tools in sequence. Expect the retry on `#r1` and **every** later
dispatch of that turn on `#r1`, not just the retry.

## 9. Decisions taken — do not reopen

**`per-request` mode: removed.** It sent a fresh conversation key on every dispatch, so every request became a
replay. Reusing one live CLI conversation is the point of the connector, and a replay is the path that loses
history on this provider: `agy` keeps about 192,000 bytes of an input step and drops the rest, and the history
sits last. The schema entry, the branch in `conversationKey`, the README section and the test are all gone.

**Harness patch: removed.** `patches/compaction-checkpoint-framing.patch` and every reference to it are
deleted. The connector rewrites the checkpoint preamble in its own derivation, which is where the wire is
shaped; the harness never needed editing for it.

## 10. Deployment hardening

- `MERIDIAN_API_KEY` is plaintext in a world-readable unit file: move to `EnvironmentFile=` with `0600`.
- `MERIDIAN_DEBUG=1` is now permanent; add journald rotation or a `LogRateLimit` check so it cannot fill the
  disk.

## Deferred, with triggers

| Item | Trigger |
|---|---|
| `agy` 1.4.8 | only after item 1 is green; one variable per restart; re-verify the `brain/` layout, marker format and tool bridge |

