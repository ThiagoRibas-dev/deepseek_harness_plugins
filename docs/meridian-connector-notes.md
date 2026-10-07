# Meridian connector — working notes

Written on request of the context-pressure nudge at 76%, so the hard-won detail below survives a
compaction. Not committed; delete when it stops being useful.

## What is committed (branch `main`, unpushed)

| Commit | What |
| --- | --- |
| `d9b8339` | Notice filter no longer rewrites the prefix of a tool continuation |
| `cdbbdf4` | Quota classification, `/providers/status` read, composer strip |
| `7416e78`, `f245f0c` | The quota plan, and its settled decisions |
| `99c8e81` | `remote` inject, which fixed both Models-page buttons |
| `c5b41ef` | Continuation diagnosis (foreign tool ids explained on the error) |
| `1fff2e7` | Compaction tool-id rewriting, which made `/compact` work |
| `d5fc467` | The compaction plan |
| `63af18d` | Context-pressure nudge |
| `8a0ab42`, `e99e4ef` | Compaction guard, and its plan |
| `4d7062c` | Chat-controls plan (nothing built) |

## Meridian's continuation contract, as established

`antigravity.ts:86` refuses a tool continuation whose prefix does not hash to what it delivered, whose
batch differs, or whose execution contract (model, session, `max_tokens`, `thinking`, `output_config`,
grammars) changed. `sameAgExecutionContract` tolerates only `system` and `tools`.

Tool ownership is a **flat map keyed by tool id alone** (`antigravityRuntime.ts:391`), so a different
session key does not evade it. Ids are Meridian's only for calls Meridian issued (`toolu_agy_` prefix); a
continuation answering another provider's call cannot succeed.

Three distinct guards, three different fixes:
1. `changed its delivered history or tool batch` — the pruner, then our own notice filter. Both fixed.
2. `already consumed` — line 78. Retry aftermath; still reachable when a model change lands mid-batch.
3. `changed its model, session or execution controls` — a contract change between call and result.

**Anything injected mid-turn breaks the prefix** unless it is only appended after the tool results. That
is why history-rewriting filters must apply only to the request that starts a turn.

## Quota

`GET /providers/status` (documented stable interface) and `/v1/usage/quota/all` carry
`{type, utilization, resetsAt}` windows from `agy -p /usage`. **This account's returns `unavailable`
because Meridian's schema rejects the report over a missing `reset_time`** — so the strip shows an
explanation, not a percentage. A quota failure is `QUOTA` on both paths (it already was for a 429; the
in-stream case was `TRANSPORT` and got retried twice). Meridian caches a quota read 60s, 10s after a
failure, and starts at most one status refresh per 10s, so a one-minute poll is its own cadence.

A plugin **cannot** block a send: `conversation.composer.bar` declares `blocked`/`disabled` but they are
owner props that `ui-conversation` never sets.

## Open items

- The continuation fix is unverified end to end: the next long tool loop on Meridian is the test.
- The quota strip needs a **restart**, because `dsh.client.inject` changed in `package.json`.
- The context-pressure nudge has never been observed firing before now; its interaction with Meridian's
  contract is the reason the notice-filter fix matters.
- `/root/.dsh/profiles/web/cordis.patch.yml` is the one live config not in git. Three plugins are
  mounted there.
