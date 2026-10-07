# @local/dsh-meridian-antigravity

A DeepSeek Harness model API connector for a local [Meridian](https://github.com/rynfar/meridian)
bridge running the Antigravity backend over a signed-in `agy` CLI.

It registers **one provider route** — `meridian-antigravity` by default — on the harness `llm`
service and speaks Anthropic Messages to Meridian's `/v1/messages`. It exists because Meridian's
Antigravity backend is not a stateless chat-completion service: it is a bridge over one live, signed
in CLI process, and it has a contract a harness has to keep. The generic OpenAI-compatible route
this profile used before (`@deepseek-ai/dsh-llm-pi-ai` pointed at `/v1`) can carry text and tools,
but it cannot hold tool blocks, carry a retry identity, or gate on the CLI pin.

Verified against Meridian **1.76.1** with official `agy` **1.2.7**, client tool bridge enabled,
`nativeReasoning: false`, `thinkingBudgets: false`.

## What it does about each part of the contract

| Contract requirement | How this connector keeps it |
| --- | --- |
| Refuse a wrong backend or CLI pin | `GET /health` before every turn (cached, refreshed after a probe failure). A wrong `backend`, `support.cliVersion` or `support.verifiedCliVersion` fails with `MERIDIAN_UNSUPPORTED_SERVICE`, which is **not** retryable, because an unsupported `agy` is a host operator error. |
| The catalogue is the account's, and a missing slug is a hard error | `GET /v1/models` is read live, cached, and merged with any static entries. An unadvertised slug fails with `UNKNOWN_MODEL`; nothing is substituted. |
| `temperature`, `top_p`, `top_k` are rejected before generation | Never serialized. A caller that sets `temperature` gets a warning, not a failed turn. |
| Effort is a slug, not a sampling parameter | Effort is inferred from the slug suffix. A client `reasoningEffort` that contradicts the slug fails with `UNSUPPORTED_REASONING_EFFORT`; a matching one is sent only if `sendEffortOverride: true`. |
| No reasoning channel exists | `thinking`/`signature` events are ignored and no `reasoning` block or delta is ever emitted. |
| Structured output controls are rejected | `output_config.format` and `output_format` are never sent. |
| `max_tokens` is advisory | Sent as the prompt instruction Meridian expects, never enforced as a local cap; tool calls and schema results are never truncated locally. |
| Continuation is an exact-match contract | The whole transcript is re-serialized on every request and the complete tool-result batch is returned in one turn. Meridian compares the prefix **it already delivered**, so the transcript must not be rewritten while a tool batch is pending: a compaction that prunes or summarises an earlier message between a `tool_use` and its result is refused with `MERIDIAN_CONTINUATION_CONFLICT`. See *Known limitations*. |
| Hold every `tool_use` until `message_stop` | Tool blocks, and any text after the first one, are buffered inside the translator and emitted only at `message_stop`. A stream that never completes therefore emits no tool block, so nothing can run. |
| One identity per logical turn | A session-scoped, content-addressed `idempotency-key`: a hash of the logical body with `stream` excluded, scoped by the harness session id and sent as Meridian's `meridian_session_key`. Identical bytes in the same session that have not yet succeeded reuse their id; a completed turn mints a new one; identical bytes in two different sessions never share one identity, so one session's saved answer or live conversation cannot be replayed into another. |
| Do not mint a new id to escape the guard | A failed turn keeps its identity, so the harness retry presents the identity Meridian already recorded. |
| Recover by replay, not by regenerating | A stream cut before `message_stop` triggers exactly one `x-meridian-replay-only: true` re-ask under the same identity, which never starts a model. Only the missing text suffix and the withheld tools are emitted, and a saved answer that does not extend what was already shown is refused. |
| A replayed answer is not new usage | `x-meridian-response-replayed: true` suppresses the usage chunk, so a replay is never counted twice. |
| Do not retry generation blindly | The provider retry policy retries only `TRANSPORT`, `TIMEOUT`, `SERVER`, `MERIDIAN_AGENT_INTERRUPTED`, `RATE_LIMIT`, `EMPTY_RESPONSE` and `MERIDIAN_PENDING_REPLAYABLE`, at most twice. `INVALID_REQUEST`, `AUTH`, `QUOTA`, `MERIDIAN_CONTINUATION_CONFLICT`, `MERIDIAN_UNCERTAIN_OUTCOME`, `MERIDIAN_NO_SNAPSHOT`, `MERIDIAN_UNSUPPORTED_SERVICE`, `UNKNOWN_MODEL`, `CONTENT_FILTERED` and `MERIDIAN_BATCH_SPENT` are permanent. |
| A retry must not re-present a spent batch | `TRANSPORT` is retryable because no tool block is delivered before `message_stop` — but Meridian consumes an accepted tool result on the **request** side, so a retry can re-present a batch it has already released and be refused permanently. Any recoverable failure on a continuation **Meridian answered** — a cut stream, a stream stall, or a non-2xx — is therefore reclassified `MERIDIAN_BATCH_SPENT`; one that never reached the service keeps its retryable code, because nothing can have been consumed. A blocked generation is `CONTENT_FILTERED` on both the streaming and the HTTP path. Neither is retried. |
| A refused continuation is repaired, not repeated | Meridian pins a continuation to the history it already delivered, so a request it no longer matches is refused deterministically, and every later turn re-presents the same history and is refused again. A `MERIDIAN_CONTINUATION_CONFLICT` on a continuation therefore takes the repair path: the connector commits a notice that closes the turn so the conversation can continue. Observed live: a `standard` session lost four consecutive turns to an unguarded prune before this, and all 45 conflicts in the session store arrived on a continuation. The notice names Meridian's possible causes without choosing one, because the connector cannot see which moved. A conflict on a turn with no continuation is still reported as an error. |
| A stranded batch is repaired, not only reported | When a reply never arrives, the transcript is left ending on a tool result, and every later request presents a batch Meridian has already consumed, so it is refused again. Two failures cause this and both are answered by **committing the assistant turn**: Meridian's `"already consumed"` 409, and a `CONTENT_FILTERED` failure on a continuation. The second is needed because a blocked generation is not retryable, so nothing re-sends the request and the 409 never appears. If the model had already streamed part of an answer, that text is kept and the notice is added as a second block saying the text above may be incomplete. A block on a turn with no continuation is left as an error, because no tool result is left unanswered and the request can simply be sent again. |
| One condition, one legible code | Meridian's text, not its status, names two different 502s. `connection to the agent was interrupted` is `MERIDIAN_AGENT_INTERRUPTED` — the connector's most frequent live failure, split out of `SERVER` so it can be counted — and the content-filter policy text is `CONTENT_FILTERED`. Both are read from the body by `lib/failure.js` before the status is considered, whether it arrives in Meridian's JSON envelope or passed through verbatim by a gateway. |
| Four live processes, no queue, 429 when full | A local FIFO gate (`maxConcurrentTurns`, default 3) leaves headroom for Meridian's own probes and turns pool exhaustion into a bounded wait instead of a lost warm process. |
| 8 MiB request cap | Measured before the bytes leave the harness. An image-bound overflow throws `IMAGE_OFFLOAD_REQUIRED` with the number of oldest occurrences to drop, which `dsh-compaction-image-offload` knows how to repair; a request with no image fails as `INVALID_REQUEST`. |
| Images are inlined, `image/jpg` is never produced | Every image is read through `ctx.attachments.readImage` and sent as canonical base64 with a media type from the harness union (`png`/`jpeg`/`webp`/`gif`). |
| Files, audio and video are host-side adapters | Out of scope by design: the harness projects durable files to handle text before any adapter sees them, and this connector does not assume the Meridian host has Poppler, ffmpeg or a whisper model. |

## Statuses

Meridian returns 409 for several unrelated conditions, so the provider message decides the harness code.

| Meridian | Harness code | Retried |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | no |
| 401 / 403 | `AUTH` | no |
| 404 | `MERIDIAN_NO_SNAPSHOT` | no |
| 409 — `"completed history can be replayed"` (idle process reclaimed, tool deadline expired) | `MERIDIAN_PENDING_REPLAYABLE` | **yes** — Meridian already released the waiting process, so the retry replays the saved history and runs no tool twice |
| 409 — interrupted by a service restart, or a reused id with different bytes | `MERIDIAN_UNCERTAIN_OUTCOME` | no |
| 409 — anything else (changed delivered history, tool batch, model or execution controls) | `MERIDIAN_CONTINUATION_CONFLICT` | no — a deterministic transcript conflict; re-sending cannot repair it |
| 422 | `MERIDIAN_STOP_IN_STRUCTURED_OUTPUT` | no |
| 429 | `RATE_LIMIT`, or `QUOTA` when the body names quota | `RATE_LIMIT` only, honoring `Retry-After` |
| 502 / 503 | `SERVER` | yes, honoring `Retry-After` |
| 502 — body says `"the connection to the agent was interrupted…"` | `MERIDIAN_AGENT_INTERRUPTED` | yes — the same retryable condition as `SERVER`, named separately so it can be counted |
| 502 — body carries the content-filter policy text | `CONTENT_FILTERED` | no — the identical request is blocked identically; on a continuation the connector commits the assistant turn instead, keeping any reply the filter cut short |
| 504 | `TIMEOUT` | yes; on a continuation it becomes `MERIDIAN_BATCH_SPENT` |

## Configuration

The bundle patch mounts the route. Every field is optional and live-updatable.

```yaml
- insert:
    - id: llm-meridian-antigravity
      name: '@local/dsh-meridian-antigravity'
      config:
        baseURL: http://openmediavault:3457   # $MERIDIAN_BASE_URL, then http://127.0.0.1:3457
        apiKeyEnv: ANTIGRAVITY_API_KEY        # local Meridian shared secret, not a Google key
        displayName: Meridian Antigravity
        requireHealthGate: true
        expectedBackend: antigravity
        expectedCliVersion: 1.2.7
```

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | `meridian-antigravity` | Route name selected by `GenerateOptions.provider` |
| `baseURL` | `http://127.0.0.1:3457` | Meridian origin; a pasted `/v1` suffix is stripped, credentials/query/fragment are refused |
| `apiKeyEnv` | `MERIDIAN_API_KEY` | Credential reference resolved per request, then the launching environment |
| `requireHealthGate` | `true` | Fail closed on the backend and CLI pin |
| `expectedBackend` / `expectedCliVersion` | `antigravity` / `1.2.7` | The pinned service this connector was written against |
| `staticModels` | `[]` | Pins capacities/modalities for slugs, overriding what discovery infers |
| `allowUnknownModels` | `false` | When true, an unadvertised slug is served with default capacities |
| `healthTtlMs` / `catalogueTtlMs` | 60s / 300s | Cache lifetimes; `0` re-probes every request |
| `defaultContextWindow` / `defaultMaxTokens` | 200000 / 32768 | Harness-side budgets, because `/v1/models` advertises no window |
| `maxRequestBytes` | 8388608 | Meridian's own body cap |
| `maxImagesPerRequest` | 64 | Count bound; overflow asks for image offload |
| `maxConcurrentTurns` | 3 | Local admission gate |
| `streamIdleTimeoutMs` | 300000 | Must not exceed Meridian's own turn deadline |
| `sendEffortOverride` | `false` | Send `output_config.effort` for a slug whose suffix matches |
| `stripToolsForSessionTitle` | `true` | Helper title turns advertise no tools |
| `ignoredNoticeKinds` | `['model-selection', 'user-approval']` | Injected user-role notice kinds the provider never sees; `[]` disables the filter |
| `keepLatestRuntimeContext` | `true` | Send only the newest `runtime-context` snapshot instead of every superseded one |
| `repairSpentBatch` | `true` | Stand in for a reply the backend blocked after Meridian consumed the tool batch; without it the conversation ends on a tool result nothing can answer |
| `captureRequestBodies` | `false` | Write the exact body of each dispatch to `captureDir`. Off by default: a capture is a complete transcript and nothing in it is redacted |
| `captureDir` | — | Required when capture is on; turning capture on without it is refused at resolve time |
| `captureMaxFiles` | 50 | Captures kept before the oldest is deleted. Only files this connector wrote are eligible |
| `retryPolicy` | normal, 2 retries | Provider-owned policy, executed by `dsh-llm-retry` |

### Injected notices

DSH records harness state changes as user-role messages and appends them after the player's own
message. Meridian renders the conversation as one prompt and asks the process to answer the latest
user message, so a trailing notice is what gets answered.

The connector drops the notices that carry no instruction for the process:

| Kind | Why it is dropped |
| --- | --- |
| `model-selection` | Says which model produced earlier turns. Informational only. |
| `user-approval` | Says the approval policy changed. The newest `runtime-context` snapshot already reports the current policy, and approvals are enforced by the harness. |
| `runtime-context` (all but the newest) | Each snapshot states that it replaces the earlier ones, so older copies describe policies that no longer apply. |

Every other kind survives, because each carries something the model may act on: `tool-jobs` (a
background job finished; read its output), `subagent-settled`, `plan-mode`, `skill-catalog`,
`agent-instructions`, `goal`, `compact-checkpoint`, `agent-message` and `tool-goal`.

A notice is kept when dropping it would leave the request ending on an assistant turn, because
Meridian requires the final message to be a user turn and a turn can be driven by a notice alone —
changing the approval policy or the model starts one. Set `ignoredNoticeKinds: []` together with
`keepLatestRuntimeContext: false` to send everything, as earlier versions did.

### Diagnosing a refused continuation

Meridian answers 409 when a request no longer matches the turn it already delivered. The connector
can only see what it is sending now, never the history Meridian kept, so on its own it cannot say
which message moved. Setting `captureRequestBodies: true` and `captureDir` writes the exact body of
each dispatch, before it is sent, one file per request and named by dispatch time. Diffing two
consecutive files names the message that changed.

The files are complete transcripts with tool results and nothing redacted, so this is off by default
and the directory is session data. The directory is bounded by `captureMaxFiles`, and only files this
connector wrote are ever deleted. A capture that cannot be written warns and the turn continues.

Capture is a diagnostic, not a repair trigger: the repair path stays keyed on Meridian's own 409,
because that verdict is the only authoritative statement that the prefix moved.

### Modalities

`/v1/models` advertises no per-slug vision flag, and the contract warns that the Claude and GPT
slugs do not see an image equally well, so only the Gemini family is advertised as image-capable.
The harness then projects images to deterministic placeholder text for any text-only route before
the adapter is reached.

### The Web Models page

The shipped Models page renders a dedicated editor only for the namespaces `llm-deepseek` and
`llm-pi-ai`; every other namespace gets a read-only hint and a disabled Apply button. This bundle
therefore ships a client half (`client.js`) that registers into the keyed slot
`settings.models.provider-card` under `settingsNs = llm-meridian-antigravity`, which is the seat the
section dispatches for every card of a family.

The card shows the route's live state (registered / inactive, key stored / missing, route id) and
edits `baseURL`, `apiKeyEnv`, `displayName`, the expected backend and CLI pin, the concurrency limit,
the context and `max_tokens` budgets, the request byte cap, both cache lifetimes, and the three
booleans. It also stores or clears the shared secret through the credentials remote, and fetches the
account's live model list through `llm.discoverModels`. Fields that a user layer overrides are marked
with a trailing `•`. Everything it writes lands in the same `cordis.patch.yml` layer you would edit
by hand.

The client half is plain JavaScript in the module-loader format, uses only `--dsw-alias-*` theme
tokens, and imports no Harness Client package. It needs one page refresh after installation, because
the browser boots from the module graph embedded in the served HTML.

### Compaction calls

Summarization is a replay, not a new question: the harness re-sends part of the conversation with an
instruction appended. That replay carries the tool ids Meridian handed out when it delivered those
calls, and Meridian looks a request's tool results up by id and treats a hit as that run's tool
continuation, which it then requires to match the delivered batch and history exactly. A replay never
can, so compaction was refused with `Pending Antigravity tool continuation changed its delivered
history or tool batch` every time.

This connector therefore re-derives the tool ids on calls the harness marks `purpose: 'compaction'`,
and drops the advertised tools, since a summarization has nothing to call. Conversation traffic is
untouched. The replacement ids are a hash of the originals rather than fresh values, because the
`idempotency-key` header is a hash of the request bytes and Meridian refuses an id that arrives with
different bytes; a stable derivation keeps one logical compaction call byte-identical across retries.

The diagnostic line `compaction call re-derived N tool id(s)` is logged for each such call, so a
remaining failure can be told apart from a rewrite that never reached the wire.

### A continuation issued by another provider

Meridian can only continue a tool batch it delivered: it looks the request's trailing tool results up
by id and accepts only ids it issued. When the model is changed while a tool batch is open, the batch
was issued by the previous provider and the harness routes its continuation to the newly selected one,
so the request cannot succeed. Meridian answers with the same 409 it uses for a genuinely rewritten
transcript, which points the reader at the wrong cause.

The connector cannot prevent this, because the routing decision is made before the request reaches it.
It can explain it: `lib/continuation.js` records, at serialization, any trailing tool result whose id
is not one of Meridian's (`toolu_agy_` prefixed) together with the provider that issued it, read from
the assistant message that made the call. When that request then fails as a transcript conflict, the
error carries the explanation, naming the issuing provider and the offending ids.

The remedy is to let the batch finish on the provider that issued it, or to switch models when no tool
call is awaiting a result.

### Quota and activity

Meridian publishes per-provider quota windows through `GET /providers/status`, a documented stable
interface, and reports an exhausted quota as either a 429 or an error event inside a stream. A quota
failure now classifies as `QUOTA` on **both** paths — the in-stream case used to arrive as `TRANSPORT`
and was retried twice against a condition that cannot clear until a window resets — and the reset
window stated in the message (`Resets in 2h43m43s`) becomes `providerRetryAfterMs`.

`lib/quota-source.js` reads that endpoint once a minute at most, driven by two triggers pooled behind
one floor: every assistant response, and a 15-second timer that the floor turns into a read about once
a minute. A minute is Meridian's own cadence rather than a rate above it — it refreshes a quota reading
every 60 seconds on success and 10 after a failure, and starts at most one background status refresh
per 10 seconds — so most reads return its cache.

`lib/quota-route.js` serves the cached snapshot to the browser half over a prefix route, and
`index.js` injects the route token into the document as `window.__DSH_MERIDIAN__`. A route registered
by a plugin inherits none of the harness's own authentication, so the token is what keeps the account's
usage off the LAN; it is per process, so a rotated token needs a page refresh.

The browser half renders it in `conversation.composer.dock`, an ambient strip below the composer. It
shows utilisation and a reset countdown per window, plus the request and token counts from Meridian's
activity block. When Meridian cannot read the quota — which is the current state for this account, its
schema rejecting the `agy` usage report over a missing `reset_time` — the strip says so and shows
Meridian's own error, because an indicator that silently shows nothing is worse than none.

A plugin **cannot** stop a send. `conversation.composer.bar` declares `blocked` and `disabled`, but they
are owner props, `ui-conversation` never sets them, and no service exposes an equivalent, so a registrant
cannot reach them. The strip is a report, not a gate.

## Tests

`./tests/run.sh` runs five suites through a module-resolution rig — no live service and no subscription
quota:

- `tests/conformance.mjs` — 55 checks against a scriptable fake Meridian over loopback (health gate,
  catalogue, request shape, tool holding, recovery, identity, error policy, injected-notice filtering,
  base-URL handling, and the in-stream quota classification).
- `tests/spent-batch.mjs` — 22 checks that a blocked generation or a spent tool batch cannot kill a
  conversation: `CONTENT_FILTERED` instead of a retryable fault on both the streaming and the HTTP 502
  path, in a JSON envelope and in a bare body; `MERIDIAN_BATCH_SPENT` for any recoverable failure on a
  continuation Meridian answered (a cut stream, an idle stream stall, a non-2xx) and `TRANSPORT`/`TIMEOUT`
  kept for one that never reached the service; the repair on Meridian's spent-batch 409, on the
  abort-then-repair path, on a blocked continuation, and on a refused continuation; that a reply the filter
  cut late survives with the notice in a second block; that a conflict with no continuation is still
  reported; and that the opt-in capture writes the dispatched body and nothing when it is off.
- `tests/client.mjs` — the module-loader contract, both slot registrations, and the card's first render
  under a minimal React shim (every field, the inactive and keyless states, the overridden marker, and
  the unwritable namespace).
- `tests/serialize-compaction.mjs` — that a compaction call reaches the wire with re-derived, paired
  ids and no tools, that a conversation call is byte-identical to before, and that serialization is
  stable across attempts.
- `tests/serialize-notices.mjs` — that the injected-notice filter keeps the turn's last user message and
  drops only the configured kinds, in order.

The remaining suites import nothing but Node built-ins, so they run standalone with `node --test` and no
rig:

- `tests/quota.test.js` (10) — quota detection, reset-window parsing, status normalization.
- `tests/quota-source.test.js` (9) — the pooled reader: coalescing, the refresh floor, failure states.
- `tests/quota-route.test.js` (6) — route auth, method handling, and the not-settled answer.
- `tests/compaction-ids.test.js` (10) — tool-id rewriting for compaction calls.
- `tests/continuation.test.js` (12) — the continuation diagnosis, and the shapes the repair gate reaches.
- `tests/capture.test.js` (5) — capture naming, the bounded directory, the never-throw rule, and that a
  capture that is off writes nothing.
- `tests/failure.test.js` (13) — the failure-text classifiers and all three notice texts, against verbatim provider strings and
  verbatim `ag_state` rows from Meridian's own ledger.

The runner builds a throwaway module-resolution rig, because a profile-installed plugin resolves
`@deepseek-ai/*` through the harness loader, which plain Node does not provide.

```console
$ ./tests/run.sh
...
10 passed, 0 failed

serialize-compaction: ok

serialize-notices: ok

20 passed, 0 failed

55 passed, 0 failed
```

## Deliberate non-goals

- **No reasoning or thinking transcript.** This backend returns none, and no effort slug adds one.
- **No numeric thinking budget, sampling control or structured-output control.**
- **No automatic retry of a failed generation.** Failures are classified; the harness decides.
- **No `agy` update, ever.** An unpinned CLI is refused, not fixed.
- **No native browser or native subagent grants**, which would also disable the identified-retry path.
- **No `replayState` written into the transcript.** The message id lives in the adapter's bounded
  ledger rather than in provider metadata, so switching routes never leaves an unreadable envelope.
- **No session store in telemetry.** `/telemetry` is an operator side channel and is never polled on
  the generation path.

## Known limitations

- **A compaction that rewrites the transcript while a tool batch is pending is refused.** Meridian requires a
  tool-result continuation to carry the exact prefix it already delivered, so a harness that prunes or
  summarises an earlier message between a `tool_use` and its result gets `MERIDIAN_CONTINUATION_CONFLICT`
  before any generation. That is a deterministic transcript conflict, not an uncertain tool outcome, and
  re-sending cannot repair it: the model must answer again from the changed history. This connector cannot
  prevent it, because the rewrite happens inside the harness loop. A deployment that hits it can disable the
  tool-result pruner (`@deepseek-ai/dsh-compaction-tool-result-pruner`) in its composition so the delivered
  prefix stays stable; context pressure is then handled by summary compaction, which rewrites a whole region
  at once and is subject to the same rule.
- **A generation blocked after its tool results were accepted left the batch stranded, and the connector
  now repairs it.** Antigravity's content filter can refuse the *output* of a turn whose tool results
  Meridian has already consumed, because consumption happens on the request side. The transcript is then left
  ending on a tool result, and every later turn presents a batch Meridian already has, so it is refused the
  same way. This was observed live twice; the second occurrence produced the current design. Four changes
  apply. The block is classified **`CONTENT_FILTERED`** instead of the retryable `TRANSPORT`, so the harness
  reports the content filter rather than a transcript conflict, and the same text arriving as Meridian's
  **HTTP 502** is classified the same way, because the ledger showed the block arrives on that path too. A
  recoverable failure on a continuation Meridian answered — a cut stream, a stream stall, or any non-2xx — is
  classified **`MERIDIAN_BATCH_SPENT`**, because re-sending would present a batch it has already released;
  only a failure that never reached Meridian keeps a retryable code. With `repairSpentBatch` on (the
  default), the connector commits the assistant turn, which is what lets the next request proceed. With the
  option off, the session stays stuck at that turn until it is forked from before it.
  The repair no longer depends on Meridian's 409. Making the block non-retryable removed the retry that used
  to produce `"Antigravity tool result was already consumed"`, which was the repair's only trigger, so a
  repair keyed on that message alone stopped running in the case it was written for. It now also fires on a
  `CONTENT_FILTERED` failure that has a continuation. Committing the turn is what Meridian's own error
  message asks for.
  A blocked turn can arrive late. The live case ran for 62 s, streamed a complete 1,250-character reply, and
  then failed at the finish. That text is kept: it is closed as its own block and the notice follows in a
  second block, so a reply cut mid-word does not run into the notice. No usage is reported, because the only
  figure such a stream carried is the partial one from `message_start`. A block on a turn with no
  continuation is still reported rather than repaired, because no tool result is left unanswered.
  The notice arrives as an ordinary assistant message and its turn completes, so a turn recorder has to
  distinguish it from narration: `dsh-dd35-preset` treats a turn carrying a notice as non-canon. It matches
  [`NOTICE_PREFIX`](lib/failure.js) at the start of any line, because a salvaged turn carries the model's
  text and the notice in separate blocks. Changing that string means changing its
  `CONNECTOR_NOTICE_PREFIXES` list as well.
- **The repair's trigger cannot be audited from Meridian's ledger.** `"already consumed"` is a real
  Meridian 409 (`invalid_request_error`), but it appears in `ag_state` **never** — Meridian refuses a spent
  continuation before it writes the `exchanges` row, so that table only ever holds 200/499/502/429/504. A
  repair that silently stopped firing would therefore leave no trace on Meridian's side either; the harness
  transcript is the only place to look.
- **Attachments (PDF, audio, video) need an upstream seam change, not an adapter change.** The
  contract describes `document`, `audio` and `video` blocks, but `@deepseek-ai/dsh-llm` projects every
  durable file to handle text *before* any adapter runs, unconditionally:
  `index.ts:1049` — "Files are never dispatched natively: every route receives handle text." The
  image path is conditional on `LlmModelInfo.inputModalities` (line 1054); the file path at line
  1051 has no such gate, and `ModelModality` is only `'text' | 'image'`. So this adapter cannot
  receive file bytes however it is configured. Supporting them means adding a `file` modality to the
  seam and gating the file projection the way images are gated, after which the adapter can read
  bytes with `ctx.attachments.readFileStream(ref)` and translate them. Two further facts matter for
  that work: Meridian caps the whole request at 8 MiB while a DSH file attachment is unbounded, so a
  request-size guard is required; and PDF rendering, audio transcription and video frame extraction
  happen on the *Meridian host*, so a deployment cannot assume Poppler, ffmpeg or a whisper model is
  present.
- Retry identity is bounded like Meridian's own snapshot: 128 entries, 30 minutes. A retry that
  arrives after that window is a new logical turn, so a non-idempotent shell command must still be
  made safe in the tool itself. This matches the contract's own "side effects are not exactly-once".
- `max_tokens` cannot cap output, because the CLI has no hard cap. Enforce tool rounds, wall clock,
  repeated calls and output bytes harness-side instead.
- A cache read is not free subscription usage; a full replay after an edit, fork or compaction costs
  more than the previous turn's usage suggested.
- The client card's appearance is not verified in a browser from this environment. Its module
  contract and first render are covered by `tests/client.mjs` under a React shim, which is not a
  substitute for seeing it beside a host card in light and dark themes.
