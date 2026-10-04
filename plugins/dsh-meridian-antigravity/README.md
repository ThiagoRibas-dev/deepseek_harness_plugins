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
| Do not retry generation blindly | The provider retry policy retries only `TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`, `EMPTY_RESPONSE` and `MERIDIAN_PENDING_REPLAYABLE`, at most twice. `INVALID_REQUEST`, `AUTH`, `QUOTA`, `MERIDIAN_CONTINUATION_CONFLICT`, `MERIDIAN_UNCERTAIN_OUTCOME`, `MERIDIAN_NO_SNAPSHOT`, `MERIDIAN_UNSUPPORTED_SERVICE` and `UNKNOWN_MODEL` are permanent. |
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
| 504 | `TIMEOUT` | yes |

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

## Tests

`./tests/run.sh` runs four offline suites — no live service and no subscription quota:

- `tests/conformance.mjs` — 53 checks against a scriptable fake Meridian over loopback (health gate,
  catalogue, request shape, tool holding, recovery, identity, error policy, injected-notice filtering,
  base-URL handling).
- `tests/client.mjs` — 9 checks on the client half: the module-loader contract, the slot key and
  registration options, and the card's first render under a minimal React shim (every field, the
  inactive and keyless states, the overridden marker, and the unwritable namespace).
- `tests/serialize-compaction.mjs` — that a compaction call reaches the wire with re-derived, paired
  ids and no tools, that a conversation call is byte-identical to before, and that serialization is
  stable across attempts.
- `tests/compaction-ids.test.js` — 10 checks on the rewriting itself, runnable standalone with
  `node --test tests/compaction-ids.test.js` since the module imports only `node:crypto`.

The runner builds a throwaway module-resolution rig, because a profile-installed plugin resolves
`@deepseek-ai/*` through the harness loader, which plain Node does not provide.

```console
$ ./tests/run.sh
...
9 passed, 0 failed

53 passed, 0 failed
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
