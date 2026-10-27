# Design — Model Rotation

This document describes how the connector is put together and why. The
decision log in [decisions.md](decisions.md) records the alternatives that were
rejected. User-facing settings and the store layout are in the
[README](../README.md).

Status: Host row, request path, rotation engine, log, replay handling, HTTP
surface, client surfaces, and the offline suite are written. The bundle is
installed in this profile; the running Harness predates it and needs a restart
to load the current module generation. Live verification follows that restart.

---

## 1. Goals and non-goals

**Goals**

1. One selectable model can be served by many endpoints, so calls spread across
   keys and hosts instead of concentrating on one.
2. A broken or rate-limited endpoint is skipped rather than failing the turn,
   as long as the request had not started producing output.
3. The user can see, per session, which endpoint answered which request, from
   which model, and what failed.
4. Configuration is self-contained: pools, endpoint fields, keys, and rules are
   edited in one settings page, not by asking the user to create native
   provider routes first.
5. The Harness and its native plugins stay untouched.

**Non-goals**

- Resuming a stream on another endpoint after output has begun.
- Sharing one conversation's context or cache across endpoints. Each request is
  independent; prefix caching is whatever the target endpoint supports.
- Reimplementing provider wire protocols. The shipped pi-ai adapter does that.
- Aggregating quota or usage across accounts.
- A general-purpose LLM router with per-token cost optimization.

---

## 2. Component map

```
Harness `llm` registry
  └── route "model-rotation" ── ModelRotationAdapter (lib/adapter.js)
        ├── config snapshot ── lib/config.js  resolvePools()
        ├── selection ──────── lib/rotation.js createRotationEngine()
        ├── per-member wire ── lib/profiles.js buildMemberProfiles()
        │                       └── PiAiAdapter (shipped, own instance)
        ├── history rewrite ── lib/replay.js prepareMessagesForMember()
        ├── commit rule ────── lib/stream.js relayMemberStream()
        └── request log ────── lib/log.js createLogStore()
                                └── lib/route.js createRouteHandler()

Host apply (plugin.js → lib/host.js)
  ├── registers the route
  ├── tracks turn/step per session from `agent/pre-step`
  ├── mounts `/api/model-rotation`
  └── injects identity into the page

Client (client.js)
  ├── settings.section "model-rotation"
  │     └── createRotationSettingsStore (created once in apply)
  └── sidebar.right.pane.tab "Rotation"
```

The adapter is the only object registered with the shared `llm` service. The
pi-ai adapter is a private instance created by this plugin; it is not registered
as a provider and has no routes of its own.

---

## 3. Configuration model

`Config` is a schemastery schema. Only `pools` is volatile, which is what makes
the settings remote able to edit it and what makes the adapter see a change on
the next request.

```yaml
provider: model-rotation        # fixed route name
displayName: Model Rotation     # picker label
apiToken: ''                    # empty = generate one per start
pools:
  fast:
    displayName: Fast pool
    members:
      - name: gateway-a
        baseURL: https://a.example/v1
        api: openai-completions
        model: gemini-3.8-flash-high
        apiKeyEnv: MODEL_ROTATION_FAST_GATEWAY_A_API_KEY
      - name: gateway-b
        baseURL: https://b.example/v1
        api: openai-completions
        model: claude-sonnet-5-5-high
    strategy: round-robin
    cadence: request
    failover: true
    maxAttempts: 2
    cooldownMs: 60000
    replay: auto
```

`resolvePools` never throws for a stored document. It drops unusable members
with a diagnostic, excludes a pool left with no member, and keeps the
diagnostic keyed by pool. A request for an excluded pool fails with
`INVALID_CONFIG` naming the diagnostic; the settings page can show the same
text. This matters because a settings document can be edited by hand and a
single typo must not take the whole connector down.

The pool key is the model id. It is used in three places that must agree:

1. the composer's model picker,
2. `GenerateOptions.model` on every request,
3. the `pools` dict key in settings.

The key reference for a member is derived from pool key + member name:
`MODEL_ROTATION_<POOL>_<MEMBER>_API_KEY`. It is stored on the member as
`apiKeyEnv` so the host can resolve a key without guessing. A rename changes the
reference; old history is unaffected, but the key must be re-entered.

---

## 4. Request flow

For one model call (`stream(options)`):

1. **Resolve the pool.** `options.model` is looked up in the current resolved
   pools. Missing or invalid pool → `LlmError` (`UNKNOWN_MODEL` or
   `INVALID_CONFIG`).
2. **Identify the session and position.** `options.sessionId` is the session
   key. The Host's `agent/pre-step` tracker supplies the current `turn` and
   `step` for that session. A caller without a session id uses `no-session`;
   the log still records the request.
3. **Plan the member order.** The rotation engine returns healthy members in
   strategy order, followed by cooling members by soonest expiry. `cadence:
   turn` pins the first member for the session and turn; `cadence: request`
   advances the round-robin cursor once per request.
4. **Start the log group.** A `start` row names the request number, pool, model,
   turn/step, cadence, strategy, and primary member.
5. **Attempt each member in order**, up to `maxAttempts`:
   1. `engine.begin()` records the member as used.
   2. `prepareMessagesForMember()` rewrites this connector's assistant history
      for the member (see §6).
   3. The shared `PiAiAdapter` streams the request with
      `provider = member.key`, `model = member.model`.
   4. Chunks are yielded to the caller unchanged.
   5. On failure, `engine.recordFailure()` updates health, a `failover` row is
      written if another member will be tried, and the next member starts.
6. **The member provider fills member options.** `lib/profiles.js` wraps pi-ai's
   request options: a member `temperature` is a default when the caller set
   none, and an `onPayload` hook applies the member's raw body overrides after
   the protocol built the body. With capture on, the same hook writes the final
   body to the request's log group through an async-local context.
7. **Finish the log group.** `end` records success, error, or abort, the final
   member/model, total duration, and the last failure's code/status/message.

The outer `LlmRuntime` still owns adapter selection, call-config freezing, and
failure normalization. The adapter participates in the normal `prepareCall` →
`stream` path; it does not bypass the runtime or the `llm/stream` waterfall.

---

## 5. Selection and health

`lib/rotation.js` is pure apart from an injectable clock and random source.

State per pool:

- `cursor` — round-robin position,
- per-member `{ lastUsed, lastSuccess, failures, cooldownUntil, lastCode, lastMessage }`,
- per-session `{ turn, memberKey, lastUsedAt }`, capped at 512 pins per pool.

Ordering:

| Strategy | Healthy order |
| :--- | :--- |
| `round-robin` | Healthy members rotated by `cursor` |
| `least-recently-used` | Ascending `lastUsed` (never used first) |
| `fill-first` | Declared order |
| `random` | Fisher–Yates with the injected random source |

Cooling members are appended after every healthy member, ordered by the
soonest cooldown expiry. A pool whose members are all cooling therefore still
attempts one request instead of refusing locally; the `start` row is marked
`allCooling` so the tab can show it.

Cadence:

- `request`: the cursor advances once per request. A tool loop's steps each
  count as separate requests and can land on different members.
- `turn`: the first request of a turn advances the cursor and pins the chosen
  member for the session. Later steps of the same turn reuse the pin. A pin
  whose member has cooled down is ignored and a new primary is chosen for that
  turn. Without a turn number (standalone calls, maintenance paths), the
  session's existing pin is reused, so the cadence degenerates to
  sticky-until-error.

Failure classification lives in the adapter (`errorWorthFailover`) and the
engine (`errorCools`):

- Failover happens for every failure except an abort.
- Cooldown is applied to `AUTH`, `MISSING_CREDENTIAL`, `RATE_LIMIT`,
  `QUOTA_EXCEEDED`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `NETWORK`,
  `EMPTY_RESPONSE`, `PI_AI_ERROR`, `UNKNOWN`, and to HTTP 408/429/5xx.
- Deterministic request-shape failures (`INVALID_REQUEST`, unsupported
  content/option/effort, context overflow) still fail over but do not mark the
  endpoint unhealthy: the same payload may be unacceptable while the endpoint
  is fine.

---

## 6. Replay rewrite

The harness stores an assistant message's provider as the route the user
selected, `model-rotation`, and its model as the pool key. The pi-ai adapter
that answers is registered under an internal key, `mr.<pool>.<member>`.

`PiAiAdapter` reconstructs native history only when the stored replay
envelope's `response.provider` and `response.model` equal the assistant
message's `source.provider` and `source.model`. Both are internal details of
that adapter (`replay.ts`, `replayedAssistant()`).

So for each dispatch, `prepareMessagesForMember` maps every assistant message
this connector wrote (`source.provider === route`) back to the member that
produced it:

- read `source.replayState.response`; require `kind: 'pi-ai'`, version 2,
  non-empty `api`/`provider`/`model`;
- if `provider` does not start with `mr.`, leave the message alone (it belongs
  to another provider and pi-ai will degrade it);
- with mode `neutral`, or with mode `auto` and the envelope's `api` different
  from the target member's, drop replay state so pi-ai degrades the message to
  provider-neutral content;
- otherwise copy the message with `source.provider/model` set to the producer's
  envelope identity and keep the replay state.

Mode meanings:

| Mode | Behavior |
| :--- | :--- |
| `auto` | Preserve when producer and target speak the same protocol; drop otherwise |
| `preserve` | Always preserve (use when every member is the same provider/account) |
| `neutral` | Always drop (safest for mixed accounts or protocols) |

This is the only place the connector reads adapter-private metadata. It is
deliberate: without it, every pooled request would send provider-neutral history
and reasoning signatures would be lost, including for a pool whose members are
the same provider. The rewrite is a pure function of the stored message and the
target member, so repeated requests are stable.

---

## 7. Failover commit rule

A stream is not resumable. The adapter allows failover only while **no output
has reached the consumer**.

- `usage` is metadata and never commits. The shipped pi-ai adapter emits a zero
  usage chunk on some failures before the terminal error, so treating usage as
  output would disable failover for every such failure (observed while probing).
- `block-start` is held by `lib/stream.js` until its block produces something.
  A provider that announces a block and then fails would otherwise leave an
  empty block in the assembled message after the retry.
- A content delta, a `block-end`, or an unknown chunk commits.
- A terminal `finish` with `reason.kind === 'error'` received before any content
  is swallowed (and its buffered starts discarded) and treated as an attempt
  failure, so failover is possible.
- The same finish received after a chunk is yielded unchanged and is terminal.
  The log records that output had been committed and that no failover was
  attempted.
- An inner iterator that throws before any chunk → failover.
- An inner iterator that throws after a chunk → terminal error; the attempt row
  records the failure.
- An abort (`options.signal.aborted` or `reason.kind === 'aborted'`) is never
  failed over.

When attempts are exhausted, the thrown `LlmError` uses the last failure's code
(so the agent retry policy classifies it normally) and carries a message that
lists every attempt: member name, code, status, and provider text. The log has
the same facts in structured form.

The inner iterator is always closed with `iterator.return()` when the attempt
ends early, including when the **consumer** returns or throws at a yield. This
runs in a `finally` around the inner loop; a leaked inner stream would otherwise
keep an HTTP connection and an idle watchdog alive.

---

## 8. Member profiles and the pi-ai adapter

`buildMemberProfiles` produces one `ResolvedPiAiProviderProfile` per member:

- `provider`: internal member key `mr.<pool>.<member>`
- `displayName`: `<pool display name> (<member name>)`
- `apiKeyEnv`: the member's credential reference
- `piProvider`: a pi-ai `Provider` over the protocol's lazy stream
  implementation (`openai-completions`, `openai-responses`,
  `anthropic-messages`), with an api-key auth method that accepts the harness's
  per-request `apiKey` override
- the service defaults the adapter reads: stream idle timeout (300 s), image
  request bounds, retry policy from `resolveRetryPolicy(undefined)`, empty
  `modelErrors`/`configuredMaxTokens`
- member `headers`, when configured

The model descriptor is deliberately simple: declared capacities, pool
modalities, `reasoning: false`, zero cost (the harness token meter prices from
its own tables), and no `compat` block, so pi-ai's own base-URL detection
applies.

`PiAiAdapter` receives:

- `profiles`: the memoized map above,
- `resolveApiKey`: `ctx.credentials.resolve(ref)`, failing loud with
  `MISSING_CREDENTIAL` when a named reference is not stored; `assertUsableApiKey`
  rejects whitespace-only values,
- `auth`: an inert credential store (api-key auth never writes) and an
  `AuthContext` backed by `process.env`,
- `resolveAttachments` / `resolveImageAccess`: the same attachment and
  filesystem joins the shipped plugin uses,
- `onReplayDegrade`: logged as a warning, not a request failure.

The key is resolved per attempt, through the harness credentials service. It is
never copied into the settings document or the log.

---

## 9. Request log

Storage: `$DSH_HOME/model-rotation/logs/<sanitized-session>.jsonl`, one file per
session, append-only. `lib/log.js` owns writes and reads; the adapter only calls
`nextRequest`, `begin`, `failover`, and `finish`.

Rows (`v: 1`):

```jsonc
{"v":1,"k":"start","id":"…","t":0,"sessionId":"…","request":7,"pool":"fast","model":"fast",
 "turn":12,"step":1,"purpose":"…","member":"gateway-a","memberModel":"gemini-…",
 "cadence":"request","strategy":"round-robin","allCooling":false,"coolingCount":0}
{"v":1,"k":"failover","id":"…","t":0,"member":"gateway-a","memberModel":"gemini-…",
 "next":"gateway-b","nextModel":"claude-…","code":"RATE_LIMIT","status":429,
 "message":"…","ms":812}
{"v":1,"k":"end","id":"…","t":0,"ok":true,"committed":true,"member":"gateway-b",
 "memberModel":"claude-…","ms":4210}
```

`groupRows` folds them into one request group. A group with only `start` is
`pending` (in flight or cut short by a process exit). Error and abort groups keep
the terminal attempt in `attempts` as well as in the top-level fields.
`allCooling` says every member was cooling when the request was planned;
`committed` says the consumer had received output before a failure, which is
the case where failover is impossible.

Bounds and safety:

- messages are capped at 2,000 characters before they reach disk;
- `redactSecrets` replaces any supplied secret of 4+ characters with
  `[redacted]` (the adapter does not supply keys; the mechanism is there for
  callers that do);
- file names are sanitized so a session id cannot escape the directory;
- writes are best-effort and never throw into a request;
- reads load at most the last 2 MB, skip torn or partial lines, and return at
  most 500 groups;
- a file over 4 MB is rewritten to its last 1.5 MB, aligned to a line boundary.

The per-session request counter is in memory. After a restart it starts at 1
again; rows remain in order because the file is append-only, and the tab shows
time as well as number.

---

## 10. Compatibility, body overrides, and capture

Provider quirks that are not expressible as a pool/member field have three
levels, in increasing order of power:

1. **Typed compatibility.** A member `compat` object is copied onto the pi-ai
   model. pi-ai's `getCompat(model)` merges it over its own base-URL detection,
   so a member can set `maxTokensField`, `supportsStore`,
   `supportsUsageInStreaming`, and `supportsStrictMode` without a code change.
   A member `temperature` becomes the request default when the caller set none.
2. **Raw body overrides.** A member `body: { set, unset }` is applied in
   pi-ai's `onPayload` hook, after the protocol has built the body and before
   it is sent. The transform adds/replaces keys and deletes keys; a rename is a
   set plus an unset. Headers, auth, URL, and the streaming choice stay with
   pi-ai.
3. **Body capture.** A pool's `captureRequestBodies` records the final body in
   the session JSONL (a `body` row, capped at 32 KB) and the Rotation tab shows
   it in the expanded request. Capture is off by default because the body
   contains the whole conversation and tool schemas.

The capture path uses `AsyncLocalStorage` (`lib/capture-context.js`). The member
provider is shared across sessions, and `onPayload` sees only the payload and
the model. The adapter wraps each inner `iterator.next()` in a context carrying
the log-group id and a body writer, so concurrent sessions cannot cross their
captured bodies.

The body transform is pure (`lib/body.js`) and unit-tested; the async-local
wiring is exercised by the live probe against a local capture server.

### Gemini thought signatures

Gemini 3 requires the opaque signature of the first function call in each step
to be returned on that same assistant tool call. pi-ai 0.85.1's
OpenAI-completions parser drops `extra_content`, so the second tool request of
a loop fails. The connector works around it at the HTTP layer:

- the member provider tees a successful Gemini SSE body and passes the original
  branch to the SDK;
- `lib/gemini-signatures.js` parses the copy and records
  `choices[].delta.tool_calls[].extra_content.google.thought_signature` by tool
  call id;
- the member `onPayload` calls `replayGeminiSignatures` on the outgoing body,
  adding `extra_content: { google: { thought_signature } }` to assistant tool
  calls whose id has a recorded signature.

The map is in memory and bounded (2,000 entries). Real signatures are keyed by
member, because Google treats them as credential/account-scoped. When the target
member has no recorded signature, `replayGeminiSignatures` writes the documented
`skip_thought_signature_validator` placeholder instead. Google documents this
as a last resort for function calls not generated by the API (history from
another model, a different key, or a mid-turn failover); it skips validation and
can reduce model performance. A real same-member signature always wins.

A restart between steps loses the map. A missing signature after the restart
receives the dummy, so the request still passes, with the performance caveat.
Parallel calls carry the signature only on the first call, which is the part
Gemini checks.

## 11. Client state and render faults

The settings form is a slot entry under `settings.section`. The shell renders
list entries through a per-entry error boundary and **abdicates a crashed entry**
(`host.reportEntryError(..., { abdicate: true })`); a remount or an abdication
therefore discards component-local state. Observed live: the form reset while
fields were being filled.

Two measures address it:

1. **The draft lives in a store created once in `apply`**, not in component
   state. The component reads it through `useSyncExternalStore`. Reopening the
   section, or the shell remounting the entry, reads the same draft. Every host
   call is captured in the store's bound operations, so no effect depends on a
   function created during render.
2. **An inner `SettingsErrorBoundary` catches a render fault.** The shell's
   boundary never sees it, so the entry is not abdicated for the rest of the
   page's life; the section shows the error with a retry instead of disappearing.

`load()` runs once when the section first mounts (`status: 'idle'`). A remount
sees `status: 'ready'` and does not re-read the host, so a draft is never
replaced by a background read. Explicit save/remove/conflict paths call
`load()` themselves.

The client-modules registry snapshots a bundle at plugin activation and only
replaces it through its HMR rebuild hook. Editing `client.js` therefore needs a
Harness restart on this deployment, not a page refresh.

---

## 12. HTTP surface

`lib/route.js` separates a pure dispatcher from the Node adapter, so the route
can be tested without a server. `createRouteHandler` is what the Host mounts.

Authentication:

- `apiToken` from the row config, or a `randomUUID()` generated at startup;
- `Authorization: Bearer <token>`, `x-dsh-token`, or `?token=`;
- constant-time comparison; empty configured token refuses everything with 503.

Endpoints:

| Method | Path | Answer |
| :--- | :--- | :--- |
| `GET` | `/` | Service name and endpoint list |
| `GET` | `/log?sessionId=…&limit=…&format=json\|text` | Grouped requests for one session, file path, byte size, truncation flag |
| `GET` | `/health` | Member cooldowns, failure counts, last code, last use, per configured pool |
| `GET` | `/sessions` | Log files on disk, newest first |

Responses are JSON with `cache-control: no-store`; `format=text` yields one line
per request for terminal use. The route is read-only: it cannot change pools,
keys, or health.

The tab gets its token from `window.__DSH_MODEL_ROTATION__`, injected into the
index HTML by the Host through `webServer.tapIndex`. A page refresh is required
after a restart because the token is per process.

---

## 13. Turn tracking

The Host listens to `agent/pre-step`, which fires for every session and carries
`{ agent, turn, step }`. It records `session.header.id → { turn, step }` in a
bounded map. The adapter reads the entry for `options.sessionId` at dispatch.

Why this event:

- `GenerateOptions` carries a session id but no turn/step, and a new request
  object is built per step;
- `agent/pre-step` is the boundary immediately before the model call, so the
  position is current;
- the listener only records two integers and never vetoes or rewrites the step.

`session/disposed` removes the entry and the engine's session pin. The map is
also capped so a long-lived process cannot grow without bound.

---

## 14. Startup, failure, and diagnostics

The Host half follows the house pattern from
`docs/lessons-learned.md` §5. `plugin.js` is a thin entry: it exports the
`Config` schema, then dynamically loads `lib/host.js` inside `apply`. A failed
native import is caught there, written to disk, and rethrown, because the
Loader otherwise reports only "failed to import". The schema itself is the one
static dependency, and the loader needs it before the row can activate.

- `logPluginError` appends `stage: stack` to
  `$DSH_HOME/plugin-errors/dsh-model-rotation.log` and never throws;
- `guard` logs, logs through `ctx.logger`, and rethrows, because a
  half-registered row is worse than one that refuses to start;
- `logPluginEvent` records non-fatal diagnostics (for example a member whose key
  is missing at the first request, or a pi-ai replay degrade).

The plugin declares `inject = ['llm']` because it cannot work without the
adapter registry. `webServer` is not injected outright; it is mounted through
`ctx.inject(['webServer'], …)` so a headless profile loses only the tab's data
source, not the connector. `settings` is used through a scoped `ctx.inject` for
`configure({ auto: false })`, matching the shipped pi-ai plugin's posture for a
plugin with a hand-written settings page.

Registration is wrapped in `ctx.effect` so unloading the bundle releases the
route. A volatile settings change re-advertises the route (`replace([route])`)
so the model picker sees new pools without a restart.

---

## 15. Compatibility risk

The two couplings outside the plugin's own code are:

1. **`PiAiAdapter` is exported and used as a class**, with the constructor
   options type exported. This is intended public surface.
2. **The resolved profile shape is not a public contract.** It is the value
   `llm-pi-ai`'s own resolver returns. This plugin constructs the fields that
   adapter reads today. A field rename or a new required field would break the
   plugin at startup or at the first request.

Mitigations:

- The startup guard writes the full stack to `plugin-errors`.
- `buildMemberProfiles` fails loud if a member key or protocol does not match
  the adapter's expectations.
- The offline suite pins the fields this plugin supplies against a fixture, so
  a change is visible in review even before a live failure.
- The dependency is documented in the README and decision log rather than
  hidden.

The alternative that removes coupling #2 is to implement the OpenAI-compatible
wire path in this plugin (and Anthropic separately). That is a much larger
surface and still drifts from the shipped implementation. See
[decisions.md](decisions.md) D3.

---

## 16. Testing plan

Offline (pure modules, `node --test`, no Harness imports):

- `config`: member validation, key-reference derivation, capacity minima,
  diagnostics for empty/invalid pools;
- `rotation`: round-robin order, per-turn pin and new-turn advance, LRU order,
  cooldown skip and all-cooling fallback, failure/success bookkeeping;
- `replay`: producer identity rewrite, `auto` drop on protocol change,
  `neutral` drop, foreign state left untouched, frozen input not mutated;
- `log`: grouping start/failover/end, pending groups, cap and truncation,
  redaction, torn lines, file trim, session-id sanitizing;
- `route`: missing/incorrect token, log grouping, `format=text`, health shape,
  unknown path, method rejection.

Live verification after the restart:

- plugin row `active` in `plugin_manager`;
- provider route and model list through the Harness model selection surface;
- `/api/model-rotation/` answers 401 without the token and 200 with the token;
- `Slots.listSubTree` shows both client occupants
  (`settings.section` and `sidebar.right.pane.tab`);
- one real request through a pool with a deliberately bad member first, then a
  working member, and the resulting log group.

Development probes used before the restart (not part of the shipped bundle):
`node --import tsx/esm` with the profile's runtime resolution installed, then
importing `plugin.js`, calling `apply` with a fake context, and dispatching a
stream whose endpoint cannot resolve. That reproduced the commit-rule bug and
then confirmed two-member failover, the `TRANSPORT` aggregate, and the
start/failover/end log rows.

Browser rendering is verified through the page; where no browser control is
available, that limitation is stated explicitly rather than inferred from slot
registration.
