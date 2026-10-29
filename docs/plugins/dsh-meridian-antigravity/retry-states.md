# Retry states 4, 8 and 9 — why a repaired turn used to come apart

Spec-adjacent analysis for `@local/dsh-meridian-antigravity`. Written after the notice-filter fix, the
key rotation, and the live verification in `session-5084d669`.

**Correction to the earlier summary table:** rows 4 and 8 were listed as failing *today*. They failed
before `_resetConversation` shipped; with the rotation in place the mechanism that produced the cascade
no longer holds, and what remains is one untested assumption plus row 9. Evidence and the test that would
settle it are below.

## 1. Notation

| Symbol | Meaning |
| --- | --- |
| `Sₙ` | the **surface** before step *n* — the session store's ordered messages |
| `f(·)` | the connector's **derivation**: drop ignored notices, drop `runtime-context`, merge adjacent user turns, hoist tool results, offload images |
| `Wₙ = f(Sₙ)` | the **wire**, what is dispatched |
| `Rₙ` | the reply Meridian produced |
| `Tₙ` | the tool results the harness then appends |
| `Dₙ = Wₙ + Rₙ` | what Meridian **delivered**, and what it compares the next request against |
| `P` | the synthetic repair pair: `assistant "Recovering from transcript conflict."` + `user <instruction>` |
| `κ` | the conversation key (`meridian_session_key`) |

**The contract.** A continuation is accepted iff `D_{n}` is a prefix of `Wₙ₊₁`, and the trailing tool
results are ids Meridian issued in that conversation.

**The derivation property** that makes normal steps work: `f` is per-message, so
`f(Sₙ + Rₙ + Tₙ) = f(Sₙ) + Rₙ + Tₙ`. Growth on the surface reproduces growth on the wire, and `Dₙ` stays a
prefix. Every failure below is a violation of *that*, not of ordering.

## 2. Baseline — the normal step (row 2), for contrast

```
S₁ = [u₁]                                  W₁ = [u₁]                    D₁ = [u₁][R₁]
S₂ = [u₁][R₁][T₁]                          W₂ = [u₁][R₁][T₁]            D₂ = …[R₂]
        ^^^^^ = D₁ is a prefix of W₂ ✓
```

Accepted on the first dispatch — measured in `session-5084d669`: the continuation was a strict prefix
extension of the opener, same 32 tool schemas, same 7,644-character system prompt.

## 3. Row 4 — a repair, then another tool call

### 3.1 Pre-reset sequence (measured, `session-bf5d76c6` 23:44–23:48)

Same conversation key `κ` throughout, which is what made it a cascade.

| Step | Time | msgs | `cont` | Body | Meridian |
| --- | --- | ---: | --- | --- | --- |
| opener | 21:18:07 | 79 | – | `f(S)` | accepted, `D₀` |
| … | | | | | |
| step *n* | 23:44:52 | 107 | 1 | `f(Sₙ)` | accepted, `Dₙ` |
| step *n*+1 | 23:44:58 | 109 | 1 | `f(Sₙ)+Rₙ+Tₙ` | **REFUSED** (unknown cause, see §6) |
| retry | 23:45:26 | 111 | – | `f(Sₙ)+Rₙ+Tₙ+P` | accepted → `D'` |
| step *n*+2 | 23:47:23 | 111 | 1 | `f(Sₙ)+Rₙ+Tₙ+R+T` | **REFUSED** — growth 0 |
| retry | 23:47:23 | 113 | – | same `+ P` | accepted |
| step *n*+3 | 23:48:12 | 113 | 1 | `…+R+T` | **REFUSED** — growth 0 |
| retry | 23:48:13 | 115 | – | same `+ P` | accepted |

### 3.2 The diagram

```
                      S (surface, no P)                    W (wire)                       D (delivered)
step n        Sₙ ──────────────►  f(Sₙ)  ──────────────►  f(Sₙ)             ⇒  Dₙ = f(Sₙ)·Rₙ
retry         Sₙ (unchanged)  ──►  f(Sₙ)·P  ────────────►  f(Sₙ)·P           ⇒  D' = f(Sₙ)·P·R'
step n+2      Sₙ·Rₙ·Tₙ        ──►  f(Sₙ)·Rₙ·Tₙ  ═══════════════════════════════════════
                                    ▲
                                    └── D' needs f(Sₙ)·P·R' here; P is missing ⇒ 409
```

`P` exists only in `W`. The surface never records it, so *every* later derivation of that turn omits it,
and each omission is a prefix change. That is the whole of row 4: not three bugs, one missing anchor,
repeated per step.

### 3.3 What the rotation changes

`_resetConversation` is set for the retry only *(transport.js, the `RECOVERY_RETRY_CODE` branch)*, so the
retry runs under `κ#r1` while every other request runs under `κ`:

```
                      κ (main conversation)                              κ#r1 (throwaway)
step n        f(Sₙ)                    → 409, nothing delivered
retry                                                                   f(Sₙ)·P  → accepted, D' = f(Sₙ)·P·R'
step n+2      f(Sₙ)·Rₙ·Tₙ                                                  (never used again)
                 ▲
                 └── κ's last delivery is Dₙ₋₁ = f(Sₙ₋₁)·Rₙ₋₁
                     and f(Sₙ) = f(Sₙ₋₁)·Rₙ₋₁·Tₙ₋₁  ⇒ Dₙ₋₁ is a prefix ✓ accepted
```

The pair is delivered into a conversation that is then abandoned. The main conversation's delivered
prefix is still a prefix of the next body, because the surface carries `Rₙ` and `Tₙ` and `f` is
per-message. **Row 4 therefore should not cascade any more** — the failure mode the table described was
an artefact of the same-key retry.

### 3.4 The assumption this rests on, stated plainly

Step *n*+2 succeeds only if Meridian accepts a continuation of `κ` whose new content (`Rₙ`, `Tₙ`, and
everything the retry produced in `κ#r1`) it never delivered under `κ`. That is ordinary growth from its
point of view — `D` is a prefix, the rest is new — but it has never been exercised, because no
post-reset session has had a mid-turn repair (both post-restart sessions show zero retries).

**Cheapest live test:** set `streamIdleTimeoutMs: 6000` for one turn, send a message that makes the model
call **two** tools in sequence. The first continuation should idle out → spend the batch → retry under
`#r1`; the second continuation then exercises step *n*+2. Pass = accepted first try. Use
`tmp/meridian/wire-report.mjs <suffix>` and expect `#r1` on the retry, `pinned` on everything else, and
`recovery retries 1`.

### 3.5 Costs the rotation introduces

| Cost | Detail |
| --- | --- |
| Abandoned conversations | one per repair (`#r1`, `#r2`, …) may hold a live CLI process until reclaimed |
| Lost reply context in `κ` | the retry's reasoning happened in `κ#r1`; `κ` only sees the answer text |
| Replay on return | the next `κ` request may replay history into a fresh process rather than continue a live one |
| Each rotation is a full prefill | the retry re-sends the whole array |

## 4. Row 8 — two repairs in one turn

Same mechanism as §3, one level up. With the rotation it becomes two throwaway conversations:

| Step | Key | Outcome |
| --- | --- | --- |
| *n* | `κ` | refused → retry on `κ#r1`, accepted |
| *n*+1 | `κ` | accepted if §3.4 holds |
| *m* | `κ` | refused again → retry on `κ#r2`, accepted |
| *m*+1 | `κ` | same condition as §3.4 |

So row 8 adds nothing new **with** the rotation. It matters only for the splice design (below), where two
anchors have to coexist:

```
W (spliced space)   f(S)·P₁·R·T·P₂·R·T        ← P₂ recorded at an index in W
S (surface space)   S·R·T·R·T                 ← P₁ never here
```

An index recorded in `W` shifts once `P₁` is spliced; an index recorded in `S` must be applied after
existing splices. That offset arithmetic is why a sticky splice is the fiddly option, and why rows 4 and 8
would both need it if the rotation did not already cover them.

## 5. Row 9 — the surface is rewritten between the accepted retry and the next step

```
step n        Sₙ            → 409
retry         Sₙ + P        → accepted (κ#r1), D' = f(Sₙ)·P·R'
              ┌───────────────────────┐
              │ compaction or prune   │   Sₙ₊₁ = g(Sₙ, …) — a span replaced by a checkpoint node
              └───────────────────────┘
step n+2      f(g(Sₙ))      → the delivered prefix Dₙ₋₁ (and D') no longer appears anywhere
```

Nothing can reproduce it: the delivered bytes are not in the surface, so no derivation of the surface can
contain them. The rotation does not help — `κ`'s own prefix is what moved, and a new key would simply
discard the context instead of repairing it.

What Meridian does here is **unmeasured**. Its capability list says *"edits, expired sessions and
ineligible native contexts **replay history**"*, which would make a wholesale rewrite acceptable because it
is classified as an edit rather than a failed continuation. The counter-evidence is thin: my earlier
capture scan found **0** shrinking dispatches in the current 50-file ring, and the two I saw before
rotation had no detectable retry after them. So:

| Hypothesis | Prediction | How to falsify |
| --- | --- | --- |
| Rewrite is replayed (row 9 harmless) | a mid-turn compaction is accepted first try; `wire-report` shows a smaller `msgs` with no `retry` row | force a mid-turn compaction (`/compact` cannot run mid-turn; use a very low `thresholdRatio`) and watch the next dispatch |
| Rewrite is refused (row 9 real) | the next dispatch is refused *and* the retry under `#r1` also fails, because the pair was anchored to a history that no longer exists | same run; look for two refusals in a row |

Until that is run, row 9 should be treated as **unknown**, not as broken.

## 6. The one refusal in the cascade that no state explains

The first refusal in `session-bf5d76c6` (§3.1, 23:44:58) had **no visible cause**: model, `max_tokens`,
`output_config`, `system`, `tools` and `meridian_session_key` were byte-identical to the accepted body
before it, and the message list was a strict prefix extension. Meridian refused it anyway. The only
remaining explanations the connector cannot see are an idle reclaim or a cumulative turn deadline.

That matters for this analysis because it is the *seed* of every cascade: a repair only ever happens after
a first refusal, and some first refusals are invisible. Reducing those is a separate problem from rows
4/8/9 — the rotation turns an invisible refusal into a recoverable one, which is the best that can be done
without provider visibility.

## 7. Decision matrix

| State | Pre-reset | With rotation | With sticky splice |
| --- | --- | --- | --- |
| 3 — repair, then the turn ends | works | works | works |
| 4 — repair, then another tool call | **cascades** | **works, untested** (§3.4) | works, if indices survive |
| 8 — two repairs in one turn | **cascades** | **works, untested** | works, needs offset arithmetic |
| 9 — rewrite between retry and next step | fails | **fails** | fails |
| Invisible first refusal (§6) | unrecoverable | recoverable in `#r1` | unrecoverable unless it seeds a splice |

## 8. What this means

- The rotation, which was shipped as insurance for a wedged process, looks like it also removes the
  cascade — for a reason I did not anticipate when I wrote it: it moves the synthetic turn into a
  conversation that is then thrown away, instead of into a conversation that must be continued.
- The remaining real exposure is row 9, and it is unmeasured in either direction.
- The sticky splice is only worth building if §3.4 fails. If §3.4 holds, it is complexity with no
  beneficiary.
- `per-request` mode was removed from the connector: it made every request a replay, and replay is the path
  that loses history on this provider — `agy` keeps about 192,000 bytes of an input step and drops the rest,
  and the history sits last. Row 9 needs no fix of its own: the provider replays a compaction summary into a
  fresh session rather than refusing it.

---

## 9. Addendum, 2026-10-24 — §3.3 is wrong: the rotation does **not** fix row 4

`session-10c2aff1` (*Reference Projects for D&D Profile (1)*) ran with the rotation in place and produced
**ten repairs in one turn**:

```
14:44:28  15 msgs  cont  key …abb0      refused
14:44:28  17 msgs  retry key …abb0#r3   accepted
14:45:27  17 msgs  cont  key …abb0      refused
14:45:27  19 msgs  retry key …abb0#r4   accepted
…                     (r3 … r12, one repair per step, 14:44 → 15:00)
```

Measured over the capture ring for that session: 10 repairs, 39 plain continuations, 0 rotated
continuations. Every repair was followed by another refusal on the *pinned* key.

**Why §3.3 was wrong.** The retry under `κ#rN` is accepted, the model issues **new tool calls** there, and
the harness then appends their results to the surface. The next request goes out under `κ` — and presents a
`tool_result` for a call id that `κ` never issued. Meridian's ownership map is keyed by tool id
(`lib/continuation.js`), so `κ` cannot recognise it as a continuation. The pair was never the only anchor:
**tool-call ownership is the other one**, and rotating the key moves new calls into a conversation the pin
does not follow.

So the rotation converts the row-4 failure into a different row-4 failure: one repair per step instead of a
permanent 409, at the cost of a full replay per step and one abandoned conversation per repair (`#r3` …
`#r12` in a single turn).

### The fix this implies — implemented 2026-10-24

`lib/transport.js` now keeps a per-session `stickyConversations` entry: a repair records the conversation
it rotated onto, every later continuation of that turn reuses it, and the next turn opener clears it and
returns to the pin. `conversationKey` reads `_isRetry` rather than a separate `_resetConversation` flag.

The rotation must be **sticky for the rest of the turn**: once a repair picks `κ#rN`, every later request of
that turn must go out under `κ#rN`, so the calls issued there are the calls whose results come back. Switch
back to `κ` on the next request that is not a continuation (a turn opener), which is the only place a new
conversation can be seeded safely.

```
step n     κ        → refused
retry      κ#rN     → accepted, issues call C₁
step n+1   κ#rN     → presents result for C₁  ✓  (today: κ  ✗)
turn n+2   κ        → opener, safe to seed fresh
```

That is a connector-side change of about twenty lines: keep a per-session `activeKey`, set it on a repair,
clear it when a non-continuation request arrives. It also makes the sticky-splice idea unnecessary for rows
4 and 8 — there is nothing to reproduce if the same conversation continues.
