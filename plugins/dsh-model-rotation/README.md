# Model Rotation

A model-API connector for this Harness profile. It registers one provider route,
`model-rotation`, whose models are **pools**. A pool is a set of endpoints that
all serve the same logical model; rotation decides which endpoint answers each
request.

The purpose is load spreading and resilience: no single API key, host, or free
tier receives every call, and an endpoint that starts failing is skipped for a
cool-down period instead of failing the turn.

This bundle adds a connector. It does not modify the Harness, its installed
packages, or any other profile plugin. See [Boundaries](#boundaries).

Status: **installed and active.** The Host row, rotation engine, log, replay
handling, HTTP surface, settings page, and right-pane tab are implemented, and
the offline suite passes (77 tests). The client bundle is served from a
snapshot taken at its Loader source's registration, so a client-side edit needs
a disable/enable cycle of the `model-rotation` row, then a page refresh. A Host
code edit needs a full Harness restart; a disable/enable cycle re-applies the
row but Node's ESM cache keeps the old `lib/*.js` modules. Details and alternatives are in [docs/design.md](docs/design.md) and
[docs/decisions.md](docs/decisions.md).

---

## Features

- **Pools as models.** Every pool key is a model id in the composer's model
  picker. Adding a pool makes it selectable without a second naming decision.
- **Any number of endpoints per pool.** Each member carries its own hostname,
  protocol, API key, model id, and optional context/output capacities.
- **Four rotation strategies:** `round-robin`, `least-recently-used`,
  `fill-first`, `random`.
- **Two rotation cadences:** a new member per request (`request`) or one member
  pinned for a whole user turn, including every tool step (`turn`).
- **Failover before output.** If a member fails before any content reaches the
  conversation, the next member in the planned order answers. A zero `usage`
  chunk does not count as output, and an announced block is held until it
  produces something. After content has started, the failure is terminal: a
  stream is not resumable, and retrying elsewhere would duplicate or reorder
  text.
- **Cooldown.** Rate limits, quota exhaustion, auth failures, timeouts, and
  transport/5xx errors mark the member unhealthy for `cooldownMs`. A cooling
  member is tried only after every healthy member.
- **Per-session request log.** One JSONL file per session, plus a right-pane
  **Rotation** tab showing time, turn/step, pool, chosen member and model,
  duration, outcome, and each failure's code and message.
- **Self-contained settings page.** Pools and members are edited in
  Settings → Model Rotation. Keys are stored through the credentials service,
  never in the settings document.
- **Read-only HTTP surface.** The tab reads the log and member health from
  `/api/model-rotation/*` behind a per-start token.
- **Same wire behavior as Custom model API.** The request is handed to the
  shipped pi-ai adapter, so streaming, tool calls, reasoning blocks, images,
  replay state, and attribution headers follow the existing implementation.
- **Provider compatibility switches.** Per member: output-token field
  (`max_tokens` vs `max_completion_tokens`), send `store`, streaming usage,
  strict tool schemas, and temperature. A **compatibility preset select**
  offers `Defaults` and `Gemini (OpenAI-compatible)`, and its list is easy to
  extend with further providers.
- **Body overrides.** Per member, set/replace JSON fields and remove fields
  just before send (`onPayload`), for provider quirks no typed field models. A
  rename is a set plus a removal.
- **Opt-in request-body capture.** Per pool, the exact body sent can be
  recorded in the session log and shown in the Rotation tab. Bodies are
  sensitive, capped at 32 KB, and off by default.
- **Gemini thought-signature replay.** For a Gemini OpenAI-compatible
  baseURL, the member provider tees the SSE response, records
  `extra_content.google.thought_signature` by tool-call id, and puts it back on
  the assistant tool call in the next request. Missing signatures use Google's
  documented `skip_thought_signature_validator` placeholder. This is what lets
  a fresh Gemini session continue a tool loop and lets history from another
  model or another key pass validation.

---

## How it is used

1. Enable the bundle (it is profile state; see [Install](#install)).
2. Open **Settings → Model Rotation**.
3. Create a pool. The pool id is the model id; give it a display name.
4. Add one or more members: hostname, protocol, model id, API key.
5. Choose rotation rules for the pool.
6. In the composer, select provider **Model Rotation** and the pool's model.
7. Open the right pane's `+` menu and choose **Rotation** to watch requests for
   the current session.

### Pool settings

| Field | Values | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `displayName` | string | pool key | Label in the picker and the log |
| `members` | array | `[]` | Endpoints serving this model |
| `strategy` | `round-robin` \| `least-recently-used` \| `fill-first` \| `random` | `round-robin` | Order among healthy members |
| `cadence` | `request` \| `turn` | `request` | When the primary member changes |
| `failover` | boolean | `true` | Try another member before output |
| `maxAttempts` | 1–16 | `min(3, members)` | Members one request may try |
| `cooldownMs` | integer ≥ 0 | `60000` | How long a failed member is skipped |
| `replay` | `auto` \| `preserve` \| `neutral` | `auto` | How stored native replay metadata crosses a member switch |
| `contextWindow` | integer | min over members | Advertised context capacity |
| `maxTokens` | integer | min over members | Advertised output capability |
| `input` | `text`, `image` | `[text]` | Modalities the pool advertises |
| `captureRequestBodies` | boolean | `false` | Record the exact sent body in the session log (sensitive) |

### Member settings

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `name` | yes | Stable id used in logs, replay identity, and the derived key reference |
| `baseURL` | yes | `http(s)://…` endpoint, normally ending in `/v1` |
| `api` | no | `openai-completions` (default), `openai-responses`, `anthropic-messages` |
| `model` | yes | Model id the endpoint accepts |
| `apiKeyEnv` | no | Credential reference; derived from pool/member names when absent |
| `contextWindow` | no | Member capacity; default 262144 |
| `maxTokens` | no | Member output capability; default 32768 |
| `headers` | no | Extra HTTP headers (never body fields) |
| `temperature` | no | Optional request temperature (0–2) |
| `compat` | no | Provider switches: `maxTokensField`, `supportsStore`, `supportsUsageInStreaming`, `supportsStrictMode` |
| `body` | no | Raw overrides: `{ set: {...}, unset: [...] }` applied after the protocol builds the body |

The key reference is derived as
`MODEL_ROTATION_<POOL>_<MEMBER>_API_KEY`. Renaming a pool or member changes the
reference, so a stored key must be entered again after a rename.

---

## Store layout

| Fact | Location |
| :--- | :--- |
| Pool settings | `settings` namespace `model-rotation`, field `pools` |
| API keys | credentials service, refs `MODEL_ROTATION_*` |
| Request logs | `$DSH_HOME/model-rotation/logs/<session-id>.jsonl` |
| Failure logs | `$DSH_HOME/plugin-errors/dsh-model-rotation.log` |
| Provider route | `llm` registry route `model-rotation` |
| HTTP prefix | `/api/model-rotation` |

Log rows are append-only and grouped by request id at read time. Each request
writes a `start` row, one `failover` row per failed attempt, and an `end` row.
Files are capped: a 2,000-character message limit per row, a 2 MB read tail, and
a 4 MB file that is trimmed to its last 1.5 MB. Provider messages are stored
only after they are capped; the adapter never writes an API key to the log.

The HTTP surface requires a token. `apiToken` may be set in the row config;
when it is empty, the plugin generates a fresh token at startup and injects it
into the page as `window.__DSH_MODEL_ROTATION__` for the tab to use. The route
never serves anonymous requests. `GET /log` accepts `format=text` for reading
from a terminal:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3080/api/model-rotation/log?sessionId=session-…&format=text"
```

---

## Boundaries

This is an additive bundle. The policy is: **no Harness source changes, no
changes to installed native plugins, no overrides of shipped rows.**

- **Harness checkout:** unmodified. Verified with
  `git -C /export/DownloadsSSD/AI/TEXT/deepseek-harness status --porcelain`
  (empty while this bundle was written).
- **Loader composition:** the bundle patch contains one `insert` row,
  `id: model-rotation`. It does not set `disabled`, replace a shipped entry, or
  restate a preset.
- **Native imports are read-only.** The plugin imports
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`, and
  `@earendil-works/pi-ai` as libraries. It constructs its own `PiAiAdapter`
  instance over its own member profiles. It does not modify, replace, or
  re-register the adapter that serves the existing `llm-pi-ai` routes, and it
  does not read or write the `llm-pi-ai` settings namespace. Those packages are
  declared as `peerDependencies` so the profile resolver supplies the
  installation's copies to a linked profile package; without that declaration a
  bare `@earendil-works/pi-ai` import is not routable from the plugin directory.
- **Own state only.** Settings writes target `model-rotation`; credentials are
  stored under `MODEL_ROTATION_*`; logs live under `$DSH_HOME/model-rotation`;
  the HTTP prefix is `/api/model-rotation`. The provider route name is new; a
  collision is refused by the registry and logged, never silently overridden.
- **Installation touches the profile, not the Harness.**
  `plugin_manager` with `install_bundle` adds the package to
  `/root/.dsh/profiles/web/package.json` and links it into that profile's
  `node_modules`.

Known dependency, stated so it is not mistaken for a modification: the adapter
reuses the exported `PiAiAdapter` and the resolved-profile shape it reads. That
shape is an internal detail of this Harness build. If it changes, `apply`
rejects and the reason is written to
`$DSH_HOME/plugin-errors/dsh-model-rotation.log`; the native pi-ai plugin is
unaffected. The entry file loads the implementation dynamically for exactly
this reason: a failed native `import()` is otherwise reported as the single
string "failed to import", with no stack.
[docs/decisions.md](docs/decisions.md) records the alternatives.

---

## Limitations

- **No mid-stream failover.** A failure after the first content chunk is
  terminal by design. Most provider failures arrive before content, so this is a
  narrow case; the log marks whether output had been committed.
- **Replay portability is a heuristic.** With `replay: auto`, stored native
  metadata is preserved only when the producing member's protocol matches the
  target member's. Cross-endpoint signatures are not assumed portable; when
  they are dropped, history degrades to provider-neutral content.
- **Health is in memory.** Cooldowns and failover counts reset when the process
  restarts. The request log is on disk.
- **No reasoning-effort control.** Pool models are advertised as non-reasoning,
  so the composer offers no effort selector and no effort parameter is sent;
  the endpoint's own default applies. Selecting a pool model clears any effort
  carried from a previously selected model. Put the effort in the member's
  model id when the gateway encodes it there.
- **Capacity is the minimum.** A pool advertises the smallest context window
  and output capability among its members unless the pool overrides them.
- **Body overrides are per member and raw.** They are applied to the JSON
  body after the protocol builds it. A wrong override can break a request; the
  captured last body and the provider error are the way to diagnose it.
- **Gemini signatures are process-local.** The connector captures them from the
  SSE response and replays them by tool-call id, but the map is not persisted.
  A session whose tool call was created before the feature loaded, or a process
  restart between tool steps, has no real signature; the next request uses the
  documented dummy and passes, with lower reasoning quality. Parallel calls
  carry a signature only on the first call, which is what Gemini validates.
  An invalid real signature is not retried with the dummy.
- **Real signatures are member-scoped.** A signature is recorded per member
  (which carries its key reference and endpoint) and replayed only to that
  member. Gemini treats signatures as credential/account-scoped, so a real
  signature from one project's key is not sent to another.
- **Missing signatures use the documented dummy.** When the target member has no
  recorded signature, the request carries `skip_thought_signature_validator`,
  which Gemini documents as a way to skip validation for function calls that
  were not generated by the API (history from another model, a different key,
  or a mid-turn failover). Google describes this as a last resort that can
  reduce model performance. A real same-member signature always takes
  precedence. With `cadence: turn`, a whole tool loop normally uses real
  signatures from one key; cross-key rotation and failover still pass, with the
  dummy on the steps that cross keys.
- **No endpoint model discovery.** The member carries a model id; a "fetch
  available models" control is not implemented.
- **The log is not a session event.** It survives restarts because it is a
  file, but it does not appear in the session store or its event replay.
- **Client and Host code reload differently.** The client-modules registry
  serves the bytes it read when the plugin's Loader source was registered, so a
  client edit needs a disable/enable cycle and then a page refresh. A Host edit
  needs a **full Harness restart**: disable/enable re-applies the row but Node's
  ESM cache keeps the already-imported `lib/*.js` modules. Check the mount time
  in `$DSH_HOME/plugin-errors/dsh-model-rotation.log` before trusting a test.
  This is a deployment property, not a form bug.

---

## Files

| Path | Role |
| :--- | :--- |
| `plugin.js` | Loader entry: exports `Config`, logs a native-import failure, loads the Host |
| `lib/host.js` | Host `apply`: registration, turn tracking, HTTP mount, guard |
| `client.js` | Settings page and right-pane tab |
| `lib/config.js` | Config schema (schemastery) |
| `lib/pools.js` | Pure pool/member resolution and key-reference derivation |
| `lib/profiles.js` | Per-member pi-ai provider and resolved-profile construction |
| `lib/adapter.js` | The `LlmAdapter` that plans, delegates, fails over, and logs |
| `lib/stream.js` | Commit rule, block-start buffering, iterator cleanup |
| `lib/rotation.js` | Selection order, per-turn pin, cooldown bookkeeping |
| `lib/replay.js` | Assistant-source rewrite for the selected member |
| `lib/body.js` | Pure raw-body override transform |
| `lib/capture-context.js` | Async-local request context for `onPayload` capture |
| `lib/gemini-signatures.js` | SSE signature capture and assistant tool-call replay |
| `lib/log.js` | Per-session JSONL store, grouping, caps, redaction |
| `lib/route.js` | Read-only HTTP dispatcher and Node handler |
| `lib/plugin-log.js` | House failure-logging and guard helpers |
| `cordis.patch.yml` | Additive Loader row |
| `docs/design.md` | Request flow, components, and failure semantics |
| `docs/decisions.md` | Decision log with alternatives |

---

## Install

Use the `plugin_manager` tool with:

```text
action: install_bundle
target: /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation
```

This profile already has the bundle selected. **Restart the Harness after
changing the package files** (or before a first activation): the running
process keeps its module generation and its failed first import. After the
restart, reload the page so the new settings page and the Rotation tab receive
the injected token. The client bundle does not need a separate install step.

Installation writes the profile manifest and its `node_modules` link only; it
does not touch the Harness checkout.

---

## Verification

Offline (pure modules, no Harness imports):

```sh
cd /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation
npm test
```

77 tests cover pool resolution, the rotation engine, replay rewriting, the
stream commit rule, the log store, the HTTP dispatcher, the client bundle
contract, and the settings store's draft persistence.

Live Host probe (uses the running installation's module resolution, applies the
plugin to a fake context, and dispatches one credential-less stream; no network
request and no server started):

```sh
cd /export/DownloadsSSD/AI/TEXT/deepseek-harness
node --import tsx/esm \
  /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation/tests/live-probe.mjs
```

After the restart, verify in this order:

1. `plugin_manager list_plugins` shows `model-rotation` `active`.
2. Settings → **Model Rotation** opens and can save a pool.
3. The composer's model picker shows provider **Model Rotation** and the pool's
   model.
4. The right pane's `+` menu → **Rotation** shows the session's requests.
5. `GET /api/model-rotation/` answers `401` without the injected token.
