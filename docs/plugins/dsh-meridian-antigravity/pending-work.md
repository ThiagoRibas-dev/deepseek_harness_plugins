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

## 3. Connector: prompt budget — **implemented 2026-10-29**

`lib/budget.js` measures the serialized body in a configurable unit and refuses the dispatch with
`CONTEXT_WINDOW_EXCEEDED` when it exceeds the budget, which is the code `compaction-basic` compacts and
retries on. Every number — unit, limit, ratio, `charsPerToken`, margin, and an off switch — comes from the
`promptBudget` row config, so the units can change from the settings UI without a code change. Spec and the
measurement behind the ratio: [`prompt-budget.md`](prompt-budget.md).

Tests: four checks in `tests/spent-batch.mjs` (each unit, the margin, `measure: body`, `enabled: false`, and
an over-budget turn that dispatches nothing). Suite 36 checks, 0 failures.

Still open: the threshold has not fired on a live turn, and the ratio rests on a single pair.

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


### Item 2, first attempt (2026-10-29) — provisional ratio, join key unsolved

`tmp/meridian/prompt-ratio.mjs` pairs a capture with the CLI's own record of the prompt. Three captures
matched, all to the same brain, all showing the same prompt length:

```
body 267,540 bytes → prompt 191,999 chars   ratio 0.718
body 267,134 bytes → prompt 191,999 chars   ratio 0.719
body 265,308 bytes → prompt 191,999 chars   ratio 0.724
```

Two findings:

1. **191,999 is the cap itself.** A prompt of that length is what `agy` keeps of a larger step, so those
   dispatches were truncated.
2. **Provisional: prompt bytes ≈ 0.72 × body bytes.** Inverted, a 190,000-byte prompt corresponds to a body
   of ~264,000 bytes.

Why the pairing is not yet trustworthy: three dispatches resolved to one brain, so the fingerprint matched
common text rather than the turn. Raising the needle to 140 characters and requiring a unique match found
nothing, because the prompt record stores what was **kept**, and a truncated prompt cannot contain a
fingerprint from the part that was dropped. The ratio is therefore indicative, not measured.

**Fingerprint matching is the wrong join.** Use `ag_state`: a capture carries `meridian_session_key`, and
`MERIDIAN_AGY_STATE_PATH` (`/root/.local/state/meridian/antigravity.sqlite`) holds Meridian's conversation
mapping. Reading it while the service runs is fine through the WAL.

### Item 2, resolved join (2026-10-29)

Fingerprints were the wrong tool. `antigravity.sqlite` holds the join:

| Table | Columns | Use |
|---|---|---|
| `exchanges` | `id` (a `msg_agy_…` request id), `json.timestamp`, `json.durationMs`, `json.conversationId`, `json.continuation` | one row per request; `timestamp` aligns with a capture's `time` to within 0.2 s |
| `native-sessions` | `id` (64 hex, *not* `sha256(session_key)`), `json.conversationId`, `json.count` | conversation bookkeeping |
| `native` | `id`, `json.name`, `json.state` | per-tool native outcomes |

`json.conversationId` is the brain directory name, so the join is:

```
capture.time ≈ exchanges.timestamp  →  conversationId  →  brain/<conversationId>/transcript_full.jsonl
```

Six consecutive captures in one conversation (`1b0e098e-…`) aligned at Δ ≤ 0.2 s, all `continuation:
tool-result`, durations 4.6–21.1 s.

**Measured pair:** body 270,285 bytes → stored prompt **174,944 chars**, ratio **0.647**.

`transcript_full.jsonl` keeps only the newest prompt per conversation, so a capture must be paired with the
prompt written *after* it. For this conversation the prompt stayed under the 191,999 keep limit, i.e. it was
**not** truncated — the ratio is what Meridian builds, not what `agy` keeps.

Consequences:

- **Cap in body terms:** 191,999 ÷ 0.647 ≈ **297,000 bytes**. Bodies at 261–270 KB are close; the 420,887-byte
  dispatch in the capture ring is well past it and was certainly truncated.
- `transcript.jsonl` is the condensed copy and inflates the number of markers; read `transcript_full.jsonl`
  for prompt lengths.
- `exchanges.json.durationMs` is a better latency measure than the session store, and `continuation` says
  whether a request reused the live process.
