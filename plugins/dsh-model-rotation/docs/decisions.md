# Decision log — Model Rotation

Each entry records a choice that shapes the implementation, the alternatives
that were considered, and the cost of the choice. Decisions marked **user
choice** were selected by the operator before implementation.

---

## D1 — A dedicated, self-contained settings form

**Context.** The "Custom model API" form in Settings → Models already collects
`baseURL`, protocol, API key, and models, and writes them into the `llm-pi-ai`
namespace. Reusing it would avoid a second form.

**Decision.** **User choice:** build a dedicated form in this plugin. Pools and
their members live in this plugin's own settings namespace, `model-rotation`.

**Consequences.**

- Endpoint facts are owned by one namespace and one page. There is no second
  list to keep in sync and no dependency on the `llm-pi-ai` settings shape.
- The plugin must implement its own credential flow: derive a reference, store
  the key through the credentials remote, and show configured state.
- Member routes do not appear as extra provider rows in the Models page.

**Alternatives.**

- *Reuse existing Custom model API rows as members.* Least new UI, but pool
  membership would live in a second place and the user would create provider
  rows that are never selected directly.
- *YAML only.* Fastest, but the operator asked for an in-app form and the
  feature is meant to be edited while the session runs.

---

## D2 — The pool key is the model id

**Context.** A pool needs a name and the model picker needs a model id.

**Decision.** Use one identifier for both. `pools.<key>` is the model id the
composer selects, and `displayName` is only a label.

**Consequences.**

- Adding a pool immediately adds a selectable model.
- Renaming a pool changes the model id, so a session configured with the old id
  must be re-selected.
- The settings page validates the id as a stable key.

**Alternatives.** Separate pool id and model id; one provider route per pool.
Both add a second naming decision for no user-visible benefit.

---

## D3 — Reuse the shipped `PiAiAdapter` over constructed member profiles

**Context.** The connector must speak OpenAI Chat Completions, OpenAI
Responses, and Anthropic Messages: streaming deltas, tool calls, reasoning
blocks and signatures, image projection, replay, and attribution headers.

**Decision.** Build one pi-ai `Provider` per member and pass the resulting
resolved profiles to a private instance of the exported `PiAiAdapter` from
`@deepseek-ai/dsh-llm-pi-ai`. Dispatch with an internal provider key
(`mr.<pool>.<member>`) and the member's model id.

**Consequences.**

- Wire behavior is identical to the Custom model API route, including fixes
  shipped to pi-ai.
- The plugin depends on the resolved-profile shape that adapter reads. That
  shape is an internal detail, not an exported type contract. A change would
  fail startup or the first request; the guard logs it.
- The plugin constructs its own adapter instance. The one serving existing
  routes and its settings are untouched.
- The native packages are declared as `peerDependencies`. A linked profile
  package resolves bare imports through its own manifest's peer declarations and
  the installation's package table; without the declaration, the first install
  failed with `Cannot find package '@earendil-works/pi-ai'`. The declaration
  names the packages, not a version range, because this deployment always uses
  the installation's copies.

**Alternatives.**

- *Implement the protocols in this plugin.* Removes the internal-shape
  dependency, but duplicates several hundred lines of translation (SSE parsing,
  tool-call deltas, reasoning signatures, image handles, replay) and drifts with
  every upstream fix.
- *Mount a second `llm-pi-ai` plugin row with generated profiles.* Uses only
  public APIs, but requires the plugin to write another plugin's settings or
  loader config, and its routes would appear in the Models page.
- *Nested `ctx.llm.stream()` to routes the user created manually.* Public path,
  but forces the user back to the Custom model API form and strips replay state
  at the runtime boundary.

---

## D4 — Failover only before the first output chunk

**Context.** A provider stream cannot be resumed. If a member fails after text
or a tool call has been announced, continuing on another member would duplicate
or reorder the response.

**Decision.** Allow failover only while no output has been yielded. `usage`
never commits, and `block-start` is buffered until its block produces content.
A content delta, `block-end`, or any unknown chunk commits, and so does a
finish. A terminal error finish before content is swallowed, its buffered starts
are discarded, and the next member is tried; after content it is yielded and
ends the request.

**Consequences.**

- Most real failures (auth, 429, 5xx before headers, connection refusal) are
  recoverable. A probe against an unresolvable host showed that the shipped
  adapter's zero `usage` chunk would otherwise have made every failure terminal.
- A mid-stream drop is terminal. The log records that output had been committed
  so the case is visible rather than guessed at.
- Only `block-start` is buffered, not content, so time-to-first-token is
  unchanged.

**Alternatives.** Buffer the whole response before yielding (delays streaming);
resume after a drop (not supported by any of the three protocols); fail over
regardless (produces duplicated output).

---

## D5 — Two cadences: per request and per turn

**Context.** The operator asked for rules such as "rotate each turn" and "rotate
when error". Spreading load usually means per request; keeping a turn on one
endpoint helps prefix caching and raw conversations.

**Decision.** Support `cadence: request | turn`. `request` advances a
round-robin cursor once per model call. `turn` pins the chosen member per
session and turn, advancing once at a turn boundary. Turn and step come from the
Host `agent/pre-step` event.

**Consequences.**

- A tool loop with `cadence: request` can use several members within one turn.
  That is intentional load spreading.
- `cadence: turn` keeps all steps of a turn on one member until it fails or
  cools down.
- Without a turn number (standalone or maintenance calls), `turn` behaves as
  sticky-until-error.

**Alternatives.** Only per request (simpler, but cannot preserve a turn on one
endpoint); only "on error" (does not spread load); a per-member request quota
(more knobs than the first version needs).

---

## D6 — Session log as JSONL files, not session events

**Context.** The operator wants, per session, which model answered which
request and what failed. The Harness has a durable session event log with
projections and new event types.

**Decision.** Write one append-only JSONL file per session under
`$DSH_HOME/model-rotation/logs/`, read through a small HTTP route.

**Consequences.**

- The log survives restarts and can be read with `tail`, `jq`, or curl.
- It does not appear in the session store, event replay, or export. A session
  copied to another host does not carry its rotation log.
- A downstream Harness build never has to understand an out-of-repo event type,
  and this plugin does not extend `SessionEventMap` or `KNOWN_SESSION_EVENT_TYPES`.
- Bounds and redaction are entirely this plugin's responsibility.

**Alternatives.**

- *Custom session event + projection.* Better integration (survives with the
  session, appears in the store, can be rendered by a Chat node), but requires
  an ignorable external event type, an out-of-repo vocabulary, and coupling to
  the projection API. Rejected for the first version.
- *In-memory only.* Lost on restart and unavailable to a second browser tab.
- *A local tool the agent can call.* Answers a different question: the operator
  wants to see the log, not ask the model about it.

---

## D7 — Read-only HTTP route with a per-start token

**Context.** The browser cannot read the Host filesystem. The tab needs the
session's log and member health.

**Decision.** Mount `/api/model-rotation` through the deferred `webServer`
injection. Require a bearer token: `apiToken` from config, or a `randomUUID()`
generated at startup and injected into the page as
`window.__DSH_MODEL_ROTATION__`.

**Consequences.**

- The route is read-only and denies anonymous requests, matching the TTS and
  memory routes' posture.
- A restart invalidates the token; the page must be refreshed.
- No new Remote namespace is introduced and no business Service is added.

**Alternatives.** A Typert Remote namespace (typed, but heavier and not needed
for two GETs); serve the log through the settings remote (mixes concerns and
exposes filesystem paths); no auth (unacceptable on a network-bound server).

---

## D8 — Additive Loader row; no Harness or native-plugin changes

**Context.** This deployment keeps hand-written plugins in a separate repository
and avoids editing the Harness checkout. Earlier campaign work established that
`disabled` reaches the Host plane only and that overriding a shipped row
replaces its whole config.

**Decision.** The bundle patch contains exactly one `insert` row,
`id: model-rotation`. The plugin imports native packages read-only and keeps
all writes within its own namespace, credentials, log directory, and HTTP
prefix.

**Consequences.**

- Updating the Harness cannot silently drop this feature, and removing the
  bundle cannot change native behavior.
- The plugin depends on native exports rather than replacing them; a breaking
  native change is observed as a startup failure in
  `$DSH_HOME/plugin-errors/dsh-model-rotation.log`.
- Installation writes only the profile manifest and `node_modules` link.

**Alternatives.** A Service mounted by a preset (wrong plane: the route must be
registered once for every preset); disabling a native row (forbidden by the
policy and unsafe).

---

## D9 — Keys in the credentials service, references derived from names

**Context.** The form must collect an API key per member. The settings document
is the wrong place for a secret, and the existing UI stores keys through the
credentials remote.

**Decision.** Derive `MODEL_ROTATION_<POOL>_<MEMBER>_API_KEY`, store the value
through `credentials.set`, and keep only the reference in settings as
`apiKeyEnv`. Resolve it per attempt through `ctx.credentials`; a named reference
that is missing fails loud with `MISSING_CREDENTIAL` instead of falling back to
an ambient environment variable.

**Consequences.**

- Settings can be exported, reviewed, or committed without leaking keys.
- Renaming a pool or member orphans the old key under its old reference. The
  form shows the reference so the effect is visible.
- A missing key is a per-member failure: it is logged, cooled down, and another
  member can answer.

**Alternatives.** Store keys inline in settings (leaks into the profile patch);
one shared key per pool (cannot express different accounts); rely on ambient
environment variables only (poor fit for many endpoints).

---

## D10 — Replay modes `auto`, `preserve`, `neutral`

**Context.** Stored pi-ai replay metadata includes provider-native signatures
that are validated against the producing provider/model. Sending them to a
different endpoint is not always meaningful.

**Decision.** Rewrite history to the producing member before dispatch, and
choose portability per pool: preserve when the protocols match (`auto`), always
preserve, or always drop.

**Consequences.**

- Same-protocol pools keep reasoning signatures and native tool-call ids.
- Mixed-protocol pools degrade those messages to provider-neutral content,
  which is the same fallback the shipped adapter uses for foreign history.
- The rewrite reads adapter-private metadata. This is the one deliberate
  exception to "treat replay state as opaque", and it is documented in
  `docs/design.md` §6.

**Alternatives.** Always drop (loses signatures even for same-provider pools);
always preserve (can send a signature a different provider did not issue);
replay-free history only (would make pooled reasoning models behave differently
from the Custom model API route).

---

## D11 — One provider route, one model per pool

**Context.** The pool could surface as one provider per pool, or rotation could
happen invisibly over existing routes.

**Decision.** **User choice:** one provider route named `model-rotation`; each
pool is one of its models.

**Consequences.**

- The picker shows one provider entry and a flat list of pool models.
- The session records `provider: model-rotation` and `model: <pool>`, so the
  selected logical model is stable while the serving endpoint varies.
- A single registration point and a single `llm/adapters-updated` on changes.

**Alternatives.** One route per pool (more picker clutter, more registrations);
transparent rotation over existing routes (selected endpoint and served endpoint
disagree, and attribution becomes misleading).

---

## D12 — Health state in memory only

**Context.** Cooldowns and failure counts could be persisted next to the logs.

**Decision.** Keep them in the process. Persist only the request log.

**Consequences.**

- A restart begins with every member healthy; a still-broken endpoint is
  discovered again by the first request and cooled down again.
- No stale cooldown survives a configuration fix (a corrected key is retried
  immediately).
- One less file to migrate or corrupt.

**Alternatives.** Persist health (helps across restarts, but risks carrying a
stale failure into a fixed endpoint); store health per session (does not reflect
endpoint-wide outages).

---

## D13 — Advertised capacity is the minimum across members

**Context.** Members may declare different context windows or output
capabilities.

**Decision.** Unless the pool overrides `contextWindow`/`maxTokens`, advertise
the smallest value among its members. Modalities come from the pool's `input`
list.

**Consequences.**

- A request that fits the advertised window fits every member, so rotation
  cannot fail just because the next member is smaller.
- A deployment whose members differ can override the pool explicitly and accept
  that a smaller member may reject the request.

**Alternatives.** Use the maximum (would over-advertise for smaller members);
require equal capacities (needlessly strict); track per-member capacity in the
request path (cannot help once the request is assembled).

---

## D14 — Settings draft in a store, with an inner render boundary

**Context.** The settings form initially kept its draft in `useState`. On the
live deployment the form reset while fields were being filled: the settings
shell renders a section as a slot entry with a per-entry error boundary, and a
crash abdicates that entry; a remount or abdication discards component state.

**Decision.** Create the settings store once in the client plugin's `apply`, read
it through `useSyncExternalStore`, and wrap the section in its own error
boundary. The store loads from the host once, then only on explicit refresh;
remounting it does not re-read.

**Consequences.**

- A draft survives a section remount or a panel close/reopen.
- A render fault shows the error and a retry instead of vanishing; the slot
  entry is not abdicated.
- Host operations are bound once, so no effect depends on a per-render function
  identity.
- The store holds credentials' configured state, not the keys themselves.

**Alternatives.**

- *Keep `useState` and hope the shell does not remount.* The live failure shows
  it does.
- *Persist drafts to `localStorage`.* Survives a page reload but adds stale-state
  and secret-handling problems for no benefit here.
- *Let the shell boundary catch the crash.* It abdicates the whole section until
  a page reload, which is the disappearing form.

---

## D15 — Three levels for provider quirks

**Context.** Gemini's OpenAI-compatible endpoint exposes request-shape
differences (`max_tokens` vs `max_completion_tokens`, an unexpected `store`
field) and other gateways will expose their own. A single raw JSON editor would
work but makes every small quirk a hand-written payload.

**Decision.** Offer typed compatibility switches first (output-token field,
send `store`, streaming usage, strict tools, temperature), a raw `body`
set/unset escape hatch applied in pi-ai's `onPayload`, and opt-in capture of the
final body for diagnosis.

**Consequences.**

- The common Gemini fix is three selects plus a preset, with no JSON editing.
- Anything not modelled can still be changed; a wrong override is visible in
  the captured body and the tab.
- `onPayload` is supported by all three protocols, so the escape hatch is not
  limited to OpenAI-compatible members.
- Capture is sensitive (full conversation), so it is off by default and capped.
- The provider is shared, so capture uses `AsyncLocalStorage` rather than a
  module global.

**Alternatives.**

- *Only raw body editing.* Maximum power, but every user must know the OpenAI
  body shape and can break tool calls without a guardrail.
- *Only typed fields.* Keeps the UI safe but blocks the next provider quirk
  until a plugin release.
- *Rewrite the body in a fetch proxy.* More general, but duplicates pi-ai's
  request construction and can break streaming/auth.


---

## D16 — Capture Gemini thought signatures at the HTTP boundary

**Context.** Gemini 3 requires the opaque signature of the first function call
in each step to be returned on that same assistant tool call. pi-ai 0.85.1's
OpenAI-completions parser drops `extra_content.google.thought_signature`, so a
fresh Gemini session's second tool request fails with
`Function call is missing a thought_signature`. Real signatures are scoped to
the credential/account/backend that produced them, so replaying one across API
keys or projects is not valid.

**Decision.** The member provider tees a successful Gemini SSE response, records
the signature by `memberKey + tool-call id`, and puts it back on the assistant
tool call in `onPayload` (the hook that already carries body overrides and
capture). When the target member has no recorded signature, the request uses
Google's documented `skip_thought_signature_validator` placeholder instead of
failing. Real same-member signatures always take precedence. The map is in
memory and bounded.

**Consequences.**

- Fresh Gemini tool loops work without a pi-ai change.
- Cross-key rotation and mid-turn failover still pass, but the crossing step
  uses the dummy and loses reasoning continuity; `cadence: turn` keeps the
  common path on real signatures.
- Old sessions and a restart between steps degrade to the dummy rather than a
  400.
- The signature map is process-local; a durable sidecar would need the
  session/tool-call scope and a migration policy.
- An invalid real signature is not retried with the dummy.

**Alternatives.**

- *Wait for pi-ai to preserve `extra_content`.* Correct long-term, but the
  connector is installed against 0.85.1 and cannot change the Harness.
- *Use OpenRouter or a native Gemini provider.* Works for tool loops, but adds
  a gateway or a third protocol; kept as an option, not a requirement.
- *Send the dummy for every call.* Simplest, but discards real signatures on
  the common path and loses reasoning quality.
- *Persist signatures only.* Does not help history created before capture or
  signatures from another credential.
