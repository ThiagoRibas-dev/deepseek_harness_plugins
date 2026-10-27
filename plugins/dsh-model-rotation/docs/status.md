# Model Rotation — status and handoff

Last updated: 2026-10-27 (Gemini tool loop verified after a full Host restart).

This file is the working memory for the bundle. Read it before resuming.

## Shipped state

- Bundle installed in `/root/.dsh/profiles/web/package.json` (dependencies and
  `dsh.profile.bundles`), row id `model-rotation`, module
  `@local/dsh-model-rotation`, `fiberPhase: active`.
- Entry: `plugin.js` (exports `Config`; dynamically loads `lib/host.js` inside
  `async apply` so a native-import failure is written to
  `$DSH_HOME/plugin-errors/dsh-model-rotation.log`).
- Client: `client.js` — settings section `settings.section` id
  `model-rotation`, right-pane tab `@local/dsh-model-rotation` kind
  `model-rotation`.
- Offline suite: `npm test` → 77 tests, all pass.
- Live Host probe: `tests/live-probe.mjs` passes (applies the plugin to a fake
  ctx, two-member failover, aggregate `MISSING_CREDENTIAL`, start/failover/end
  log rows).
- No Harness source changes (`git -C /export/DownloadsSSD/AI/TEXT/deepseek-harness
  status --porcelain` empty).
- **Verified working:** the Gemini pool completes a tool loop. The first
  response's signature is captured from the SSE stream and replayed on the next
  request; a missing signature (old history, another key, or a restart) uses
  the documented `skip_thought_signature_validator` placeholder.
- The plugin is a self-contained directory in this repository.

## Current deployment configuration (in profile `cordis.patch.yml`)

```yaml
- id: model-rotation
  config:
    pools:
      Gemini:
        members:            # 10 identical members
          - name: primary
            baseURL: https://generativelanguage.googleapis.com/v1beta/openai/
            api: openai-completions
            model: gemini-3.6-flash
            contextWindow: 1000000
            maxTokens: 64000
            compat:
              maxTokensField: max_tokens
              supportsStore: false
              supportsStrictMode: false
          - name: member-2 … member-10   # same URL/model and compat
        displayName: Gemini-pool
        strategy: round-robin
        cadence: turn
        failover: true
        replay: auto
        input: [text, image]
```

Credential refs present in `/root/.dsh/.credentials.yaml`:
`MODEL_ROTATION_GEMINI_PRIMARY_API_KEY` and `…_MEMBER_2_` through `…_MEMBER_10_`.
All ten refs exist. Values were not read. If they are all the same Google key,
rotation does not spread quota.

## Captured request before the compat preset (historical)

The capture used the exact member profile shape and a local HTTP server, before
the saved `compat` switches took effect. The current member sends `max_tokens`
and omits `store`; the post-compat probe appears below.

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
Authorization: Bearer <key>
user-agent: deepseek-harness/0.1.7-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)
content-type: application/json

{
  "model": "gemini-3.6-flash",
  "messages": [system full Harness prompt, user],
  "stream": true,
  "stream_options": { "include_usage": true },
  "store": false,
  "max_completion_tokens": 64000,
  "tools": [{ "type": "function", "function": { ..., "strict": false } }]
}
```

- Trailing slash in baseURL is handled; URL is correct.
- `max_completion_tokens` comes from the member's `maxTokens` (pi-ai's simple
  stream defaults the request cap from `model.maxTokens`).
- No `temperature` is sent (Harness has no default temperature).
- `store: false` is sent because pi-ai's `detectCompat` does not recognise
  `generativelanguage.googleapis.com` and defaults `supportsStore: true`.
- `max_tokens` field selection: pi-ai's `detectCompat` chooses
  `max_completion_tokens` for an unrecognised baseURL; Google's 3.6 Flash notes
  describe `max_tokens` as the cap.
- `stream_options.include_usage` is supported by Gemini (per Google forum).
- Gemini returns `usage` on every chunk and thought signatures in
  `extra_content.google.thought_signature`; pi-ai 0.85.1's
  `openai-completions` parser does not read `extra_content`/`thought_signature`
  (grep found no handling). Gemini 3 requires thought signatures on replayed
  function calls. Multi-turn tool loops on the direct OpenAI-compat endpoint
  are therefore at risk of 400 “Function call is missing a thought_signature”.
  Our replay rewrite only preserves signatures pi-ai already captured.

Sources:
- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/thought-signatures
- https://discuss.ai.google.dev/t/openai-api-compatibility-broken-due-to-thought-signature-on-gemini-3-pro-preview/109823
- https://discuss.ai.google.dev/t/gemini-3-6-flash-openai-compatible-token-limits-response-fields-and-auth-keys/183372/2
- https://discuss.ai.google.dev/t/gemini-openai-compatibility-does-it-support-the-stream-options-parameter/92785
- https://discuss.ai.google.dev/t/same-gemini-3-flash-via-openrouter-works-direct-gemini-openai-compat-api-gives-unstable-hallucination-like-behavior-on-multi-turn-tools/142695

## Implemented: typed compatibility, body overrides, capture

All three requested features now exist.

### Member UI

- **Provider compatibility**: output-token field (Auto / `max_tokens` /
  `max_completion_tokens`), send `store` (Auto / Never / Always), streaming
  usage (Auto / On / Off), strict tools (Auto / Off / On), temperature.
  A **compatibility preset select** offers `Defaults (all switches Auto)` and
  `Gemini (OpenAI-compatible)`; add rows to `COMPAT_PRESETS` in `client.js` to
  offer more. The four selects stay editable after applying a preset.
- **Primary button contrast**: `ui.primaryButton` used a non-existent
  `--dsw-alias-button-primary-label` token, so the label inherited an unreadable
  color on the light fill. It now uses
  `--dsw-alias-label-primary-foreground` (the token the memory plugin uses for
  the same button).
- **Body overrides**: a JSON object for fields to set/replace and a
  comma/newline list for fields to remove. Rename = set the new key + remove
  the old one. Applied in pi-ai's `onPayload`, after the body is built and
  before it is sent; headers/auth/URL are untouched.
- **Capture request bodies** (pool checkbox, off by default): a `body` row in
  the session log, shown in the Rotation tab's expanded request. Sensitive
  (full conversation/tool schemas), capped at 32 KB.

### Host wiring

- `lib/body.js` — pure `applyBodyOverrides`.
- `lib/capture-context.js` — `AsyncLocalStorage`; the adapter wraps each inner
  `iterator.next()` in `runInCapture`, so the shared provider's `onPayload`
  finds the right log group without a global race.
- `lib/profiles.js` — copies `member.compat` to the pi-ai `Model`, applies
  `member.temperature` when the caller set none, and installs `onPayload` for
  body overrides + capture.
- `lib/stream.js` — `runNext` option wraps inner `next()`.
- `lib/log.js` — `body` row, `groupRows` attaches `requestBody`, 32 KB cap.
- `lib/pools.js` / `lib/config.js` — member `temperature`, `compat`, `body`;
  pool `captureRequestBodies`; validation and defaults.

### Probe result (local capture server, real adapter)

```json
{
  "model": "gemini-3.6-flash",
  "messages": ["system", "user"],
  "stream": true,
  "stream_options": {"include_usage": true},
  "max_tokens": 64000,
  "temperature": 0.4,
  "top_p": 0.9
}
```

Checks: `max_completion_tokens` absent, `store` absent, `strict` absent,
`max_tokens` present, temperature and `top_p` present, `body` row written to the
session log. The compat + body + capture path works.

### Gemini caveats (current)

- Real signatures are captured and scoped by member. A real signature from key
  A is never sent to key B; missing signatures use the documented dummy. The
  dummy skips validation and can reduce model performance, so `cadence: turn`
  with one key per turn gives the best quality.
- The signature map is in memory. A restart between tool steps loses it; the
  next request gets the dummy and still passes.
- A real signature that Google rejects as invalid is not retried with the
  dummy. That would be a separate fallback.
- Parallel function calls must be ordered all calls, then all results; Google
  returns 400 for interleaved results. The harness's message order is
  compatible.
- The typed UI only exposes four compat switches; other pi-ai compat fields
  (`thinkingFormat`, cache switches, …) are not in the form. Raw YAML
  `compat` is restricted to primitives by the schema.

## Earlier findings (retained)

User asked:

1. Can the `Extra headers (JSON)` member field change body parameters?
   **No.** It is `profile.headers` → `options.headers` → HTTP headers only.
   It cannot rename `max_completion_tokens`, remove `store`, or set
   `temperature`.
2. Suggests either:
   - a request-body preview with manual editing (add/rename/remove fields), or
   - typed select fields for common concepts (context size, output length,
     reasoning, temperature, …).

Findings:

- `StreamOptions.samplingParams` in pi-ai is merged **last** into the OpenAI
  body (`Object.assign(params, options.samplingParams)`), so it can override
  named fields. Setting a key to `undefined` makes JSON.stringify omit it.
  It cannot easily rename a field, but `{ max_tokens: 64000,
  max_completion_tokens: undefined }` achieves the Gemini rename. Only
  OpenAI-compatible adapters apply it; Anthropic and Responses may ignore it.
- `ProviderRequestOptions.onPayload?: (payload, model) => unknown | undefined`
  is called by pi-ai's openai-completions **before sending** (`nextParams`),
  so a wrapper can rewrite/delete/rename arbitrary keys and capture the exact
  final body. This is the stronger hook for a raw body editor and a
  “last request body” view. `ProviderRequestOptions` also has `fetch?`,
  `onResponse?`, and `headers?`.
- Our provider object is built in `lib/profiles.js`:
  `stream/streamSimple: (model, context, options) => api.stream/streamSimple(...)`.
  Wrapping those calls lets us inject `onPayload` and/or `samplingParams`
  per member without touching pi-ai or PiAiAdapter.
- `Model.compat` is read by pi-ai (`getCompat(model)` = detect + model.compat);
  a `compat` member/pool field can set `maxTokensField: 'max_tokens'`,
  `supportsStore: false`, `supportsStrictMode: false`,
  `supportsUsageInStreaming`, etc. This is the safer typed path.
- `Model.reasoning` + `thinkingLevelMap` and `options.reasoningEffort` control
  reasoning; currently our models are `reasoning: false`, so no effort is sent.
  Adding reasoning would mean advertising efforts to the composer per pool.

Implemented design (shipped):

1. **Typed compatibility** (first): per member `compat` object with a small form:
   - Output token field: Auto / `max_tokens` / `max_completion_tokens`
   - Send `store`: Auto / Never / Always
   - Streaming usage: Auto / On / Off
   - Strict tool schemas: Auto / On / Off
   - Optional temperature
   - A “Gemini OpenAI-compatible” preset filling
     `{ maxTokensField: 'max_tokens', supportsStore: false,
     supportsStrictMode: false }`.
2. **Advanced body overrides** (escape hatch): per member
   `body: { set..., unset: [...] }` or a JSON object + unset list, applied in
   `onPayload`; cannot change headers/auth. Validate JSON; cap size.
3. **Body visibility**: opt-in capture of the exact final request body per
   request, shown in the Rotation tab (redacted/capped) and/or the log. A
   static preview cannot include the conversation/tools; “last actual request”
   is the useful view. Add a `captureRequestBodies` switch (default off) and a
   ring buffer/session log row; never store Authorization/keys.
4. Keep `Extra headers` for HTTP headers only, and say so in the UI hint.

Deployment note, learned the hard way on 2026-10-27:

- **Client code:** a page refresh alone serves the activation-time snapshot.
  Disabling and re-enabling the row makes the client-modules registry re-read
  `client.js`, so a page refresh then picks it up.
- **Host code:** disable/enable re-applies `apply`, but Node's ESM cache keeps
  the already-imported `lib/*.js` modules. A **full Harness restart** is the
  only way to load changed Host code. Check the mount time in
  `$DSH_HOME/plugin-errors/dsh-model-rotation.log`; a `disabled`/`enabled` cycle
  updates it but does not prove the module bytes changed. The 20:02 UTC Gemini
  failure proved this: the saved `compat` preset was ignored, no HTTP failure
  line was written, and the old `CONTEXT_WINDOW_EXCEEDED` classification ran.

When in doubt, restart before testing a Host change.

## Relevant files

- `plugin.js` — entry, Config, native-import logging.
- `lib/host.js` — apply, provider route, turn tracker, HTTP mount.
- `lib/config.js` / `lib/pools.js` — schema and pure resolution.
- `lib/profiles.js` — per-member pi-ai Provider/profile construction (hook point
  for compat/body overrides).
- `lib/adapter.js` — route dispatch, failover, log.
- `lib/stream.js` — commit rule (usage/block-start do not commit).
- `lib/replay.js` — assistant source rewrite.
- `lib/log.js` — per-session JSONL.
- `lib/route.js` — read-only HTTP.
- `client.js` — settings store + page, Rotation tab, error boundaries.
- `tests/` — 60 offline tests; `live-probe.mjs` needs the Harness checkout.

## Verification commands

```sh
cd /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation && npm test
cd /export/DownloadsSSD/AI/TEXT/deepseek-harness && \
  node --import tsx/esm /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation/tests/live-probe.mjs
```

The live app is at `http://127.0.0.1:3080` behind its usual browser auth;
plain curl gets `401 dsh web authentication required`.


## Gemini 400 identified — 2026-10-27 20:10 UTC

The Host code is now active (full restart). The failed request logs the exact
response:

```json
[{
  "error": {
    "code": 400,
    "message": "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:route_turn` , position 9. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.",
    "status": "INVALID_ARGUMENT"
  }
}]
```

So the empty 400 is **not** the compat preset. It is Gemini rejecting historical
tool calls in the conversation that carry no thought signature. Position 9 is a
`route_turn` function call from an earlier turn. The session is the dd35 TTRPG
session, which had tool history from before the Gemini route.

Implications:

- A fresh session with no historical tool calls can get through the **first**
  request. pi-ai 0.85.1 still drops `extra_content.google.thought_signature`
  from Gemini's responses, so the next Gemini tool step in that session will
  also fail unless signatures are captured and replayed.
- Existing sessions with non-Gemini tool history have no real signature to
  replay. They pass with the documented dummy; reasoning continuity is lower.

Work implemented for Gemini tool loops:

1. **Capture** `extra_content.google.thought_signature` from Gemini SSE deltas
   (choice delta or `tool_calls[]` entry; verify the exact path) keyed by tool
   call id.
2. **Inject** it into the assistant `tool_calls[]` entries of the outgoing body
   (likely `extra_content: { google: { thought_signature } }`) in `onPayload`.
3. **Persistence:** in-memory is enough within a process, but a restart loses
   signatures while the session history remains. Persist the map (session +
   tool-call id) if this is to survive restarts.
4. **Legacy history:** a real signature cannot be reconstructed. The
   documented dummy skips validation, so the request passes; starting a new
   session gives better reasoning continuity.

The fetch wrapper now logs failed requests/responses to
`$DSH_HOME/plugin-errors/dsh-model-rotation.log`; the response is JSON, not
empty. The OpenAI SDK still says "no body" because it expects a JSON object,
not an array.

Deployment lesson: a full Harness restart is required for Host code; the
disable/enable cycle caused a false "compat didn't fix it" test. See the
deployment note above.


## Fresh session confirms: signature capture needed

`New Gemini pool test` made the **first** request successfully and returned a
`route_turn` tool call. The **second** request (the tool result) failed with:

```
Function call is missing a thought_signature in functionCall parts ...
function call `default_api:route_turn`, position 4.
```

The request body shows the assistant message:

```json
{"role":"assistant","content":null,"tool_calls":[{"id":"call_3571579","type":"function","function":{"name":"route_turn","arguments":"{\"first_message\":true}"}}]}
```

No `extra_content` / `thought_signature`. pi-ai parsed the first response but
dropped the signature. This is exactly the gap to close: capture the signature
from the streamed response and add it to the assistant tool call on replay.

### Implemented — signature capture/replay

- `lib/gemini-signatures.js`: parses Gemini's SSE copy for
  `choices[].delta.tool_calls[].extra_content.google.thought_signature`, records
  it by tool-call id, and `replayGeminiSignatures` injects it into the assistant
  `tool_calls[]` of the outgoing body.
- `lib/profiles.js`: tees a successful Gemini response (the SDK sees the
  original branch) and calls `replayGeminiSignatures` in `onPayload`.
- End-to-end probe against a local mock: first response returns a signed
  `route_turn` tool call; second request body carries
  `{"google":{"thought_signature":"sig-1"}}` on the same call id. **PASS**.
- 77 offline tests pass, including SSE split-across-chunks capture, real
  signature preference, member scoping, existing `extra_content` preservation,
  and the documented dummy fallback.

### Verified after a full Host restart

The Host code was reloaded by a **full Harness restart**. The Gemini pool then
completed a tool loop: the first tool call was captured, the next request
replayed its signature, and the session continued. A fresh session is still
preferable for reasoning continuity; unsigned history uses the dummy.

The linked docs confirm the shape:
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai
- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures.md.txt
- https://github.com/linziyanleo/nanobot__ava/blob/main/tests/agent/test_gemini_thought_signature.py


## Cross-key / cross-project signature scope

Question: does capture/replay work when the pool rotates across API keys from
different projects?

Answer: **a real signature is not replayed across keys, but the request can
still pass because Google documents dummy signatures for exactly this case.**
`skip_thought_signature_validator` (and `context_engineering_is_the_way_to_go`)
are documented in the thought-signature FAQ as a way to skip validation for
function calls not generated by the API, including history transferred from a
different model. Google calls this a last resort that can negatively affect
performance.

Real signatures remain credential/account/backend-scoped:

- `google-gemini/gemini-cli` PR #6090 strips thought signatures when switching
  from a GenAI API key to OAuth (Vertex) because the metadata is not portable
  across those backends.
  https://github.com/google-gemini/gemini-cli/pull/6090
- OpenCodex #1926 scopes its signature store by provider destination and
  credential identity specifically so a signature from one account/endpoint is
  never served to another; treating cross-account replay as a bug.
  https://github.com/lidge-jun/opencodex/issues/1926
- LiteLLM's fallback for history without signatures is the dummy
  `skip_thought_signature_validator`, not a signature from another key.
  https://docs.litellm.ai/blog/gemini_3
- Google documents both dummy values in the FAQ:
  https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
  ("you can set the following dummy signatures of either
  `context_engineering_is_the_way_to_go` or `skip_thought_signature_validator`
  ... to skip validation").

Implementation: `lib/gemini-signatures.js` keys a real signature by
`memberKey + tool-call id`, and `replayGeminiSignatures(body, memberKey)` only
injects a member's own real signatures. A signature from `mr.Gemini.primary` is
never sent to `mr.Gemini.member-2`. When the target member has no recorded
signature, it injects the documented `skip_thought_signature_validator` instead.
A real signature always takes precedence.

Consequences for rotation:

- `cadence: turn` — all steps of one turn stay on the pinned member, so real
  same-key signatures are used. Key/project rotation happens at turn
  boundaries, where Gemini validates only the new current turn. Best quality.
- `cadence: request` — steps can rotate across keys; step 2 on key B has no real
  signature from key A and receives the dummy, so the request passes, with a
  reasoning/performance cost. Functional, lower quality.
- Mid-turn failover — the new key receives the dummy for the current-turn call
  and the request passes, with the same caveat. Use `cadence: turn` to get real
  signatures on the common path.
- Old sessions with unsigned tool calls now pass with the dummy. Start a fresh
  session if reasoning continuity matters.
- The dummy does not fix a **malformed** signature; a real signature that Google
  rejects as invalid still fails. A future fallback could retry with the dummy
  on that specific error.

77 offline tests pass. The signature capture, member scoping, and documented
dummy fallback are verified in a live Gemini tool loop after a full Host
restart.
