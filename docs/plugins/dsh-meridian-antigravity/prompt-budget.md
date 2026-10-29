# Prompt budget

The provider keeps the head of a prompt and drops the tail, so an oversized request loses the newest
messages — the ones the user just sent. This connector refuses such a request before dispatch instead, with
the error code the harness compacts in response to.

## Why a local check is required here

`agy` keeps about 192,000 bytes of one input step and drops the rest, and a started or replayed conversation
sends its whole history in one step with the history last. Meridian 1.83.0 and later shorten the prompt to fit
(`MERIDIAN_AGY_MAX_PROMPT_BYTES`, default 190,000) and can pass the overflow to the client, but the installed
release (1.81.0) has neither: it sends the prompt and lets the CLI truncate. The connector therefore cannot
delegate this decision; it is the only component that knows the body it is about to send.

## How it works

```
serialize → enforceRequestBudget (maxRequestBytes) → measurePrompt → over budget?
                                                     ├─ no  → dispatch
                                                     └─ yes → throw CONTEXT_WINDOW_EXCEEDED
                                                              → compaction-basic compacts and retries once
```

`compaction-basic` reacts to that exact code (`CONTEXT_WINDOW_EXCEEDED`) by compacting and retrying, so the
refusal is a repair rather than a dead end. The check runs before the ledger entry and before any capture, so
a refused dispatch leaves no trace on the wire.

## Units and conversion are configuration

`lib/budget.js` holds three numbers and one comparison. All of them come from the row's `promptBudget` object,
which is editable from the settings UI; nothing is hard-coded in the dispatch path.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` restores the previous behaviour: no local check |
| `unit` | `bytes` | `bytes`, `chars` or `tokens` — applies to `limit` and to the measurement |
| `measure` | `estimate` | `estimate` converts the body with `ratio`; `body` compares the body directly |
| `limit` | `190000` | Budget in `unit` |
| `ratio` | `0.647` | Body bytes to prompt bytes; empirical, re-measure when the provider changes |
| `charsPerToken` | `4` | Used only when `unit` is `tokens` |
| `margin` | `0.05` | Fraction held back below `limit`; the effective limit is `limit × (1 − margin)` |

The measurement is `value = bodyBytes × ratio`, divided by `charsPerToken` when the unit is `tokens`. `chars`
and `bytes` deliberately share a number: the difference is not measurable for this prompt, and pretending
otherwise would imply precision the estimate does not have.

Switching to tokens, for example, needs no code change:

```yaml
promptBudget:
  unit: tokens
  limit: 40000
  charsPerToken: 4
```

## Where 0.647 comes from

Measured 2026-10-29 by pairing a capture with the prompt the CLI recorded for the same request:

| Quantity | Value |
|---|---|
| Body, as dispatched | 270,285 bytes |
| Prompt the CLI stored | 174,944 characters |
| Ratio | **0.647** |
| Implied body size at a 191,999-byte prompt | ≈ 297,000 bytes |

That prompt was *under* the keep limit, so nothing was truncated and the ratio reflects what Meridian builds.
Bodies at 261–270 KB are just under the cap in body terms; the 420,887-byte dispatch in the capture ring is
well over it and was truncated.

Re-measuring: `antigravity.sqlite` gives the join. `exchanges.json.timestamp` aligns with a capture's `time`
within 0.2 s, and `exchanges.json.conversationId` is the brain directory name, so
`brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` holds that conversation's prompt.
`transcript_full.jsonl` keeps only the newest prompt per conversation, so pair a capture with the prompt
written *after* it. `transcript.jsonl` is a condensed copy and its marker counts are misleading.

## Tests

`tests/spent-batch.mjs` covers the measurement in each unit, the margin, `measure: body`, `enabled: false`,
and one integration case: an over-budget turn throws `CONTEXT_WINDOW_EXCEEDED` and nothing reaches the
provider.

## Open

- The ratio is one measurement from one conversation. A second and third pair would say whether 0.647 is
  stable or whether it drifts with the tool-result mix.
- The threshold has never fired on a live turn; the integration test covers the refusal path offline.
