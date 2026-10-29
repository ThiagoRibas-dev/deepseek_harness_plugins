# Lessons learned

**Read this before writing new plugin code, and before debugging a plugin that will not start.**

Every entry here cost real time, and most of them cost it because the failure was **opaque** — the harness
reported `failed` and nothing else, so we guessed. Guessing produced three confident, wrong diagnoses in one
session. Each entry therefore has the same shape:

> **Symptom** → what you see · **Cause** → the mechanism · **Rule** → what to do next time

---

## 0. The meta-lessons

These are the ones that caused the most damage, and none of them are about code.

1. **A `fiberPhase: failed` with no stack is not a debuggable failure.** Before investigating any plugin that
   will not start, get the log. Do not form a theory from the symptom first.
2. **Do not trust the first plausible string in a large dump.** A prompt was once quoted back from *inside a
   tool result*. Check whose words they are.
3. **Correlation is not causation, and a coincidence of timing is seductive.** A fork and a model switch
   happened six seconds apart; the fork was blamed for three rounds. Both were innocent.
4. **Measure the cheap thing before theorising about the expensive one.** A tool was suspected of taking 16 s;
   timing it took two minutes and showed 0.14 s.
5. **Optional chaining does not make an undeclared service safe** (§1.1). It is the single most common way our
   code has failed to start.
6. **Write failures to a file we own.** See §5 — the harness gives you one word, `failed`.

---

## 1. Cordis / harness API errors

### 1.1 Reading an undeclared service throws

**Symptom**

```
tool-result-policy-route (@local/dsh-tool-result-policy/plugin):
  Error: cannot get property "timer" without inject
```

The row shows `fiberPhase: failed` in the Plugin Manager, with no further detail.

**Cause**

Cordis permits a plugin to touch only the services it declares. The check is on **property access**, so
`ctx.timer?.interval?.(…)` does **not** help: the `?.` guards the *call*, not the *get*. `ctx.timer` itself
throws before any optional chaining applies.

**Rule**

```js
// WRONG — looks defensive, throws anyway
ctx.timer?.interval?.(refresh, 60_000)

// RIGHT — declare it
export const inject = ['timer']
// …or better, do not depend on it at all
```

Before touching `ctx.<anything>`, ask whether it is in `inject` — **or** whether you need it. In the case that
caused this, the timer was refreshing a list for a settings page; resolving lazily on the request that needs it
removed the dependency entirely. **Prefer removing a dependency over declaring one.**

**`ctx.get(name)` is the lookup that does not throw.** It returns `undefined` for an absent service and needs
no `inject`, so it is the right call for a capability you can do without — `knownPresets` uses
`ctx.get('agentPresets')` and degrades to an empty list. Property access (`ctx.agentPresets`) is the form that
throws. Use `inject` + property access only for a service the plugin cannot work without.

---

### 1.2 `webServer` is not available when a plugin applies

**Symptom**

A plugin that mounts an HTTP route fails to start, or mounts nothing.

**Cause**

`webServer` may not exist yet at apply time. A **hard** `inject: ['webServer']` turns a timing problem into a
fatal one.

**Rule**

Use the scoped deferred form, which waits for the service (this is what the shipped `dsh-tts` bundle does):

```js
export function apply(ctx, config) {
  // do NOT put 'webServer' in inject
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') return
    webCtx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler }))
  })
}
```

**A profile with no browser surface then loses only the settings page, not the plugin row.**

---

### 1.3 Host export forms, and one Service per realm

**Symptom**

```
Error: service "toolResultPruner" has been registered at <GuardedToolResultPruner>
```

**Cause**

Two separate rules, both easy to trip:

- A host plugin is **either** the `apply(ctx, config)` form **or** a service class as the default export —
  not both in one file.
- Cordis provides a Service **once per realm**. A preset that isolates its own service instance collides with
  a bundle row that claims the same service at the Host plane.

**Rule**

Keep the two concerns in **two files**: `index.js` default-exports the service class (for the preset to mount),
`plugin.js` exports `apply` (for the bundle row). And never disable a shipped host-plane row to "swap" it —
`disabled` reaches the Host plane only, so every *other* preset silently loses the service.

**Corollary, learned the hard way: a Service is the wrong shape for a capability that must cover every preset.**

Isolation is per realm, and the shipped presets each isolate their own `toolResultPruner`. So a Service mounted
in `dd35` governs `dd35` alone, and a Service mounted at the Host plane is either invisible to the presets or
collides with them. `dsh-tool-result-policy` needed a working toggle for every preset and could not get one from
a Service at all; it now registers a Host-plane `agent/pre-step` listener instead, which sees every session's
steps (`dsh-context-pressure` is an existing example of that hook working from the Host plane).

Reaching for a Service also invites the expensive workaround: overriding a shipped preset declaration replaces
its **complete** `config.plugins`, so covering `standard`, `ptc` and `cordis` would have copied ~450 lines of
harness configuration into the bundle and silently shadowed every upstream change. Before mounting a Service,
ask which realms must see it. If the answer is "all of them", it is not a Service.

**Where the per-preset services actually live** (checked, so nobody re-derives it):

| Fact | Location |
| :--- | :--- |
| Host-plane `tool-result-pruner` row is declared | `packages/bundle/base/cordis.patch.yml:417` |
| …and **disabled** for the Web profile | `packages/bundle/web-app/cordis.patch.yml:494` |
| Each preset mounts its own inside `isolate: { toolResultPruner: true }` | `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml` |
| `minimal` has no compaction group at all | `packages/bundle/web-app/presets/minimal.patch.yml` |
| `agent/pre-step` reaches a Host-plane listener for every session | `plugins/dsh-context-pressure/index.js:70` |

**A Host-plane event hook fires far more often than a Service call did.** `agent/pre-step` runs on
**every step**, so a pass that walks the session surface pays O(history) each time. Measured for
`planPrune`: 245 ms on a first pass over 4,479 results, then **13.4 ms per walk** once they were all
elided — wasted on every unchanged step. Keep a per-session high-water mark (the surface tail
sequence) and skip the walk when nothing moved. That is `pass.js` in `dsh-tool-result-policy`.

---

### 1.4 Loader dialect: relative names only work inside `insert`

**Symptom**

A row in a preset declaration will not resolve, or resolves to the wrong module.

**Cause**

Relative plugin names are anchored only inside an `insert` list. A row inside a **preset declaration** must use
an absolute `file:///` URL.

**Rule**

`file:///absolute/path/to/plugin.js` in presets; bare relative names only in `insert`. See
`plugins/dsh-dd35-preset/cordis.patch.yml` for working examples of both.

---

### 1.5 A Service method is invoked with a shadow receiver

**Symptom**

A method works when called directly but sees `undefined` for a field when the harness calls it.

**Cause**

Cordis invokes service methods with a **shadow receiver**, so `#private` fields are not visible across the
boundary.

**Rule**

Use **public fields** for anything read from outside the constructor.

---

### 1.6 Client-plugins: no JSX, no CSS modules, no shell imports

**Symptom**

The client half renders nothing, or the page 404s / blank-slots.

**Cause**

The client bundle runs in the shell, not through a bundler that understands our source.

**Rule**

- Plain JS via `window.__ModuleLoader__.load({ id, factory })`; `id` **must** equal the package name.
- **No JSX/TSX, no CSS modules.** Use `React.createElement` and inline styles.
- React comes from the shell module table.
- Theme tokens `--dsw-alias-*` only.
- No Harness Client package imports.
- `dsh.client` must declare `{ platform, inject, external }`.

**And do not conclude the client half is broken from a 404 on a URL you invented.** Find how a *working*
bundle (e.g. `dsh-tts`) is actually fetched before believing a probe.

### 1.7 A bundle's web half is discovered from the Loader row's *name*

**Symptom**

The host half works — the route answers 200 — but the settings page never appears, and the target slot
shows only the shipped occupants. Nothing is logged. `plugin_manager` reports the row `active`.

**Cause**

There is no explicit "this package has a web half" registration. `ClientModuleRegistry`
(`packages/client/modules/src/index.ts`) walks every **root** Loader row, resolves the row's module to its
owning `package.json`, and only then reads `dsh.client`. Two gates sit on that path:

1. `resolveMeta` calls `exactPackageSpecifier(row.name)` and returns early when it is `undefined`. For a
   scoped specifier that helper accepts **exactly two segments**, so `@scope/name` resolves but
   `@scope/name/plugin` does **not** — the row is silently dropped before `dsh.client` is read.
2. The loaded bundle must call `window.__ModuleLoader__.load({ id })` with `id` equal to the package name,
   or the module system throws `loaded without registering "<id>"`.

A row named with a **file URL** is fine: `nearestPackage` walks up from the file to its `package.json`.
That is why `dsh-tts` (a `file:///…/plugin.js` row) works while a scoped-subpath row does not.

**Rule**

- Name a bundle row with the **bare package name** (`@local/dsh-myplugin`) or a `file:///` URL to a module
  inside the package. Never a scoped subpath (`@local/dsh-myplugin/plugin`).
- Point `exports["."]` at the entry the row should load. When the Host-plane row must be the *apply* form
  but the package's main export is a Service class, split them: `"."` → the apply entry, a named subpath
  (e.g. `./pruner`) → the Service class. Direct `file:///` imports bypass `exports`, so a preset can still
  mount the Service by path.
- A scoped subpath fails **silently**, so pin the row name in a test. See
  `plugins/dsh-tool-result-policy/tests/bundle-discovery.test.mjs`.
- **One root Loader row per package.** `reconcilePackage` collects every row that resolves to a package and
  throws `client-modules: package <name> resolves from multiple active Loader sources: …; remove one entry`
  when there are two. A bundle that needs both a Host hook and an HTTP route must mount both from **one**
  module, which is why `dsh-tool-result-policy` registers its pass and its route in the single `plugin.js`.

**Verification without a browser:** `cordis_inspect_query` → client `Slots.listSubTree` with the slot key
shows every occupant. If yours is absent, the bundle did not load. A backend route answering 200 says
**nothing** about the web half — the two halves fail independently.

---

### 1.8 The runtime-context channel is append-only and re-rendered every step

**What it is.** `systemPrompt.context({ name, order, text })` registers dynamic context. On **every step**
the harness renders every registered context, and when the joined text differs from the last one it
**appends a new user message** (`RuntimeContextProjection.project`,
`packages/core/agent-loop/src/runtime-context.ts`). The previous message is never replaced — it stays on
the surface, and `scene-state.js`'s own header records the consequence: *"every superseded snapshot is
retained in session history"*.

**Why that matters twice.**

- **History growth.** A volatile contribution is re-sent for the life of the session. Measured in session
  `4ba1929e`: 3 snapshots, **28 KB**, in a **2-turn** session. The only replacements in that whole session
  were our two prunes, so all three snapshots were live.
- **Provider contracts.** The append lands wherever the step happens to be, including **between a tool call
  and its result** — the window Meridian's continuation contract watches.

**Rule**

- Feed `context()` only facts that are **stable for a whole turn**. Freeze anything derived from a file a
  tool can rewrite mid-turn. `dsh-dd35-preset/context-freeze.js` does this by keying on
  `state.last_turn.number`, which only the turn-capture path writes, so the key changes exactly at the turn
  boundary. Checked against the live session: the two mid-turn snapshots both said `State as of turn 143`,
  so the key is stable where the content was not.
- **Do not "inject always".** The harness already suppresses unchanged text; emitting unconditionally would
  append the block on every step.
- `PromptContext` has no timing option (`name`, `order`, `text` only) and `suppressRuntimeContext()` is
  all-or-nothing, so the freeze belongs in the contributor, not the registration.
- Moving a volatile block from `context()` to `section()` does not help: on a series restart the
  system-prompt projection **replaces** the node in place, which is a rewrite of delivered history.

### 1.9 Session state cannot live in a workspace file

**What happened.** The `dd35` preset resolved its campaign from one global
`campaign/campaign_registry.md`, read against the session's `cwd`. Every session in the folder therefore
played the same campaign, and a brand-new chat was already inside the old one before the player typed.

**Why a plugin cannot attach metadata to a session.** `SessionHeader` is `readonly` and documented as
"detached, deep-frozen creation metadata", with no update API. The only writable identity is the header
itself, which a plugin may **read**. So session-scoped state goes in a workspace file keyed by
`session.header.id` — here `campaign/session_campaigns.json`.

**Do not detect a "new" session by walking events.** `Session.snapshotEvents()` and `ownEvents()` are both
marked deprecated and *"new calls are prohibited"* (`packages/core/session/src/index.ts:647`, agent note
`2026-09-09-deprecate-synchronous-session-event-reads`). `session.surface.nodes` is the live accessor. The
binding module avoids the question entirely by keying on identity and `header.createdAt`.

**Two rules for the resolver**

- **Never throw.** It runs during prompt assembly, where a throw kills the session before its first token.
  A corrupt binding file, a deleted campaign directory and a malformed `state.json` all resolve to "no
  campaign".
- **An identity-less caller keeps the old behaviour.** A session stub with no `header.id` — standalone
  use, and the fixtures that drive these modules directly — cannot be bound, so it resolves through the
  registry. Without that rule the 179 existing preset tests would have had to be rewritten to assert
  nothing.

**Migrating live state is a measurement, not a guess.** The first cut of the migration cutoff was
"midnight today". Scanning the session store found **10 of 107 `dd35` sessions created after it**,
including the live campaign — every one would have detached. Set the cutoff to the deploy instant *and*
seed the binding file for every session that already exists. Measure which sessions the rule would move
before shipping it.

### 1.10 A notice that replaces a provider error must carry the provider's words

**What happened.** A `dd35` turn was refused by Meridian mid-play. The connector committed a notice in
place of the missing reply, and the notice opened by blaming the tool-result pruner. A full session-store
survey later showed the pruner count does not predict these conflicts at all — one session pruned 15
results and was fine, another pruned none and failed — while every conflict sat in a session where the
runtime-context snapshot had been rebuilt. The notice's opening guess was the wrong subsystem.

**The rule.** When a connector swallows an error to keep the conversation alive, whatever it commits
becomes the *only* record. Carry these three, or the incident is unrecoverable:

- **the provider's message verbatim** — not a paraphrase of it;
- **the request id and status**, so the provider can be asked again;
- **the machine code**, so occurrences can be counted.

Here `LlmError.failure` is a frozen `{ code, message, status, requestId }` and the raw provider text
survives only *inside* `message`, wrapped in the connector's own explanation. So the raw response body is
now kept beside the classified error and quoted into the notice.

**A canned cause list reads as a finding.** Listing plausible causes "without choosing one" is not
neutral: readers take the first item as the likely one. `tests/failure.test.js` asserted the old wording
"names every cause and chooses none" — the test passed while the notice misled.

**Log the thing that turns a symptom into an answer.** "The prefix moved" cost an afternoon of
archaeology; "message 61 (user) changed, 7786 -> 9114 chars" would have ended it in one line. The
connector already kept request capture — the exact body of each dispatch, off by default, on in this
deployment since 2026-10-11 (§3.2) — so the diff
was a small module (`lib/diagnostics.js`) over data already being produced. Check what evidence the
system already keeps before adding instrumentation.

---

## 2. Diagnostics: where to actually look

### 2.1 Get the stack before forming a theory

| Source | What it gives |
| :--- | :--- |
| **The launcher's console / journal** | **The stack trace.** Best source. `journalctl` or the terminal that ran `run-dev-lan.sh`. |
| `$DSH_HOME/plugin-errors/*.log` | Our own plugins, once §5 is applied. |
| Plugin Manager → Built-in plugins | `fiberPhase` only — `failed`/`active`, never a reason. |
| `plugin_manager list_plugins` | Same, plus `fiberPhase` per row. |

### 2.2 The DSH session store is the record of what a model actually saw

`~/.dsh/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`

Useful event types: `turn/start`, `step/start`, `assistant/message` (with `source.model` and block kinds),
`tool/call`, `tool/result`, `turn/end` (with `reason.kind` and `reason.error.code`), `compaction/*`.

Pairing is by `callId`. A `step/start` with no matching `assistant/message` means a step produced an attempt
and no reply — **that is what a failed generation looks like.**

The session store records what the *harness* dispatched, not what the provider received. When the question is
"what did the model actually see", the request captures are the record: `captureRequestBodies` in the Meridian
connector writes one file per dispatch to `/root/.dsh/meridian-capture`. `tmp/meridian/wire-report.mjs
<session-id-suffix>` summarises one session from them — conversation key, notice exposure, continuation, and
whether a body is the recovery retry — and it is the fastest way to tell a connector fault from a context one
(§8).

### 2.3 The provider's own state is richer than ours

For Meridian/Antigravity: `/root/.gemini/antigravity-cli/`. Services, directories, environment and the
prompt byte limits for this deployment are catalogued in
`docs/plugins/dsh-meridian-antigravity/environment.md` — Meridian runs as a **user** unit
(`journalctl --user -u meridian-agy`), which is why a system-scope `systemctl list-units` shows nothing.

- `brain/<uuid>/.system_generated/logs/transcript.jsonl` — what was sent
- `brain/<uuid>/.system_generated/steps/N/output.txt` — **the step's error, verbatim**
- `annotations/<uuid>.pbtxt` — conversation titles
- `log/*.log` — ~50 k files, **startup noise only**; they do **not** log model calls or bridge timing

The `steps/N/output.txt` files are where a provider-side failure is actually written down. Check them before
theorising.

### 2.4 A plain `node` import of a bundle module is not a diagnostic

Running this from the profile directory:

```bash
node --input-type=module -e "await import('@local/dsh-myplugin')"
```

fails with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-…'`. **That is expected.** The harness
resolves its own `@deepseek-ai/*` packages through a Loader hook a standalone Node process does not have, so
every profile bundle that imports one behaves this way — `dsh-context-pressure`, `dsh-meridian-antigravity`
and `dsh-tts` all import harness packages.

Use standalone Node for modules that import **only** relative paths and Node builtins; that is what makes
`pass.js`, `policy.js` and `prune-core.js` unit-testable with no rig. Do not read a harness-package resolution
failure as a defect in the module — check the runtime instead (`$DSH_HOME/plugin-errors/`, the slot probe, or
the session log).

---

## 3. Provider-protocol errors (Meridian Antigravity)

These are four *different* failures that all look like "the DM stopped replying".

| Provider message | Connector code | Retryable | Meaning |
| :--- | :--- | :--- | :--- |
| `completed history can be replayed` | `MERIDIAN_PENDING_REPLAYABLE` | **yes** | Idle process reclaimed, or **tool deadline expired**. Replay-safe: a retry runs no tool twice. |
| `without a saved response` / reused id | `MERIDIAN_UNCERTAIN_OUTCOME` | no | Genuinely unknown outcome. |
| anything else | `MERIDIAN_CONTINUATION_CONFLICT` | no | Deterministic transcript mismatch. |
| — | `MERIDIAN_BATCH_SPENT` | no | Tool results were consumed, generation died before any reply. |

### 3.1 `MERIDIAN_BATCH_SPENT` — the 503 shape

**Symptom** The turn errors with `MERIDIAN_BATCH_SPENT`; no reply is written.

**Cause** The backend accepted the tool results, then the generation died (observed cause:
`UNAVAILABLE (code 503): No capacity available`, and more often `Antigravity turn timed out` after a long
tool loop). The batch is spent; re-sending the same continuation would be refused.

**Rule** With `repairSpentBatch` on (the default) the connector retries the turn **once as an ordinary
call** — appending a placeholder assistant turn and a user instruction to continue from the tool results
above, which leaves the request ending on a user message — and if that also fails it commits a notice so
the conversation can continue. The retry is what makes the failure recoverable; the notice alone only keeps
the transcript valid. **Before 2026-10-20 there was no retry on this path**, because the code that
classifies a cut stream as spent runs after the repair block and threw directly, so a live turn failed with
no reply and no repair (`session-dc7217e4`, turn 2). Do not fork. If a retried turn still ends on a notice,
the instruction must be re-issued as a new message.

### 3.2 `MERIDIAN_CONTINUATION_CONFLICT` — the transcript-moved shape

**Symptom** The turn "completes" but the assistant message is a refusal notice. Looks healthy; is not. The raw
shape, when the connector does not intercept it, is `turn/end reason.kind = "error"` with
`code: MERIDIAN_CONTINUATION_CONFLICT`, `status: 409`.

**Cause** Meridian requires a continuation to carry **the exact prefix it already delivered**. Anything that
moves it — a prune, a compaction between a `tool_use` and its result, a model change while a batch is open, or
a fork that rebuilds history — makes the continuation unrecognisable. It does not open a new conversation
instead: the connector pins one identity to the harness session (`meridian_session_key`), so a continuation
under that identity with a changed prefix is a protocol violation, not a fresh start.

**It does not have one cause, and the connector says so.** `plugins/dsh-meridian-antigravity/docs/README.md:35`
catalogues all 52 conflicts in the store: **21** from sessions that had pruned a delivered tool result, **16**
correlating with a model change inside the same turn, and **~12** with neither (mostly `dd35`). The connector
deliberately does not choose between them, because it cannot see which of Meridian's three named causes moved.

**A correlation exists for pruning, but it is confounded.** Over the sessions in `~/.dsh/sessions/`:

| Group | Sessions | Conflicted |
| :--- | ---: | ---: |
| Meridian, ≥1 `compaction/prune` | 12 | 10 |
| Meridian, no prune | 63 | 22 |
| non-Meridian, ≥1 prune | 11 | 0 |

Do not read that as proof. The pruner only runs **under context pressure**, so "pruned" selects for long
sessions with many steps and many mid-turn state mutations — which independently raise the conflict rate. In
`4ba1929e` the conflict came at the first continuation after a prune, but the prune ran at a **turn boundary**
with no batch pending, and the very next request (a new user turn) was accepted. That is outside the window the
connector documents, so the prune is a poor explanation for that particular failure. Candidates I could not
separate in that session: the prune; and the `dd35` runtime-context block, which is re-appended whenever
`state.json` changes, so `update_scene` at step 1 produced a **different** runtime-context user message at
step 2 inside the batch window (the two blocks differ exactly in the `Micro-state`/`Pending action` lines).

**Rule** Keeping the strip off on a Meridian-routed preset is the safe default, and it is what the connector's
own *Known limitations* recommends. It is precaution, not a demonstrated single cause: the connector's notice
is generic, and the session log cannot show a retried turn at all (see below). Do not write a lesson that
asserts a cause; that is how this section was wrong the first time. Where a conflict *has* been attributed
from captures, the cause was ours, not the pruner's: §3.3 records a notice filter that ran on the turn opener
and not on its continuation, which is a prefix change by construction.

**Capture is on in this deployment, and has been since 2026-10-11.** `captureRequestBodies: true` with
`captureDir: /root/.dsh/meridian-capture` sits in **both** `plugins/dsh-meridian-antigravity/cordis.patch.yml:42`
and `/root/.dsh/profiles/web/cordis.patch.yml:134`. It has to be repeated there: the profile's
`llm-meridian-antigravity` row **replaces** the bundle's config rather than merging into it, so a flag left only
in the bundle patch does not take effect in that profile. The schema default is still `false`
(`plugins/dsh-meridian-antigravity/lib/config.js:193`); the bundle is what turns it on. Captures are complete
unredacted transcripts, pruned to the newest **50**, written `0644` into a `0755` directory — treat that
directory as session data.

**To identify a cause:** diff the capture of the refused dispatch against the previous one for the same
session. `plugins/dsh-meridian-antigravity/lib/diagnostics.js` does that and reports
`message N (role) changed, A -> B`. The 50-file cap bounds how far back this works: `session-dc7217e4`'s first
turn — 44 steps plus the compaction call — had already rotated out by the time it was worth reading.

**Measured once, 2026-10-20** (`session-dc7217e4`): the message that moved was the **last user turn**. A
`MERIDIAN_BATCH_SPENT` left an unconsumed `tool_result` at the tail of the surface; `serialize.js` merges
consecutive user-role turns and hoists tool results, so the next user message was merged into that same wire
turn — message 58 grew **4,263 -> 31,946 bytes** — and the continuation re-delivered a tool result Meridian had
already consumed. That is one cause, not the cause.

**A retried turn is invisible in the session store.** On a refused continuation the connector appends
`assistant: "Recovering from transcript conflict."` and a user instruction, then resends as an ordinary call
(`plugins/dsh-meridian-antigravity/lib/transport.js`). Both messages exist in the capture and in **no**
`session.v4.jsonl.zstd` event: searching the store for those strings finds them only inside `tool/result`
payloads, because the model later read the source that contains them. For a retried turn the store does not
record what the model saw.

**And the instruction it appends decides which request gets answered.** The repair was originally a fixed
sentence, "continue your work using the tool results above", which is only correct when the tool results
belong to the request being answered. When a **new player turn** arrived while a spent batch was still at the
tail, the serializer merged that turn into the tool result, so the fixed sentence pointed at the previous
request: turns 3 and 5 of `session-dc7217e4` both retried under it and both re-emitted the answer to turn 1.
The connector now re-issues the player's own message when one sits **after** the last tool result, and keeps
the fixed sentence otherwise. Two conditions make that predicate non-obvious: `role: 'user'` does not identify
the player (runtime context, workspace instructions, the skill catalog and a compaction checkpoint are all
user-role), and the player's turn is not necessarily last, because notices are appended after it. Position
relative to the last tool result is the only reliable signal.

### 3.3 A notice filtered on one path is a prefix change on the other

**Symptom** Every tool step of a turn is refused as a continuation conflict, each one repaired with an extra
dispatch, and the answer comes back about the *previous* subject. Measured on `session-857354e7`
(`Review Unstaged Git Files`), turns 8 and 9: five consecutive refusals, each followed by the recovery retry,
and both turns re-emitted an earlier audit instead of doing the documentation work that was asked for twice.

**Cause** `lib/serialize.js` runs `filterNoticeMessages` **only when `continuation === undefined`**:

```js
const { messages: history, dropped } = continuation === undefined
  ? filterNoticeMessages(options.messages, { ignoredKinds: connection.ignoredNoticeKinds, … })
  : { messages: options.messages, dropped: [] }
```

`model-selection` and `user-approval` are in `ignoredNoticeKinds` by default, so those notices are dropped
from turn openers and from the recovery retry — both non-continuations — and **sent** on every continuation,
which is forwarded verbatim. Meridian therefore accepts a history without the notice and is then asked to
continue a history that contains it.

The evidence is a single block. Message 8 of the refused body and of the accepted body it replaced differ in
exactly one text block:

```
accepted (73 msgs): [tool_result][tool_result][tool_result] "Keep going please."
refused  (75 msgs): [tool_result][tool_result][tool_result] "Keep going please."
                    + "[model changed: … the session continues with gemini-3.8-flash-high]"
```

Presence is not the problem: an earlier run in the same session carried the notice on every continuation with
no retry, so a prefix that contains it from the start is stable. **The alternation is the bug.** Once the
retry body (which drops the notice) is the last thing Meridian accepted, every following continuation re-adds
it and is refused, so the cycle repeats for the rest of the turn.

**Rule** A history-rewriting filter must apply **identically to every request**. "Apply it only where the turn
starts" sounds like it protects the pinned prefix, and it does the opposite: it makes the opener and its
continuation disagree, which is the one thing the contract will not tolerate. Decide drop-or-keep from the
content, never from the request's position.

**Why it cost three answers** Each refusal spends a dispatch and replaces the operative instruction with the
recovery line ("continue your work using the tool results above"). By the time the model answers, the user's
request is several messages back and the checkpoint at message 0 — an answer-shaped summary — is what "your
work" means. That is how two explicit doc instructions turned into the same audit twice.

### 3.4 The silent-failure trap

**A refused turn is recorded as `reason.kind = "completed"`** with a notice as the assistant message. So the
session looks fine, the turn advances, and the user just sees no response — which is why prompts get re-sent
several times and look like duplicates in the log. When a user reports "it stopped replying", **check the
assistant text for the `[Meridian Antigravity]` marker** before anything else.

---

## 4. Result-shape errors that degrade a session

### 4.1 An uncapped tool result breaks sessions

**Symptom** Huge payloads in the transcript; `[truncated N bytes]` markers; missed tool deadlines.

**Cause** One memory tool returned whole messages **verbatim with no ceiling** while its siblings were capped.
Seven calls in one turn produced a **188 KB** block.

**Rule** **Every tool that can return unbounded text needs an explicit ceiling.** Check every new tool against
this. Fixing a *parser* can enlarge results dramatically — a bug fix that restored full narration text made the
same call ~30× bigger, because the previous under-parse had been capping it by accident.

### 4.2 A marker can be bigger than what it replaces

**Symptom** Pruning makes history *longer*.

**Cause** A ~90-character elision marker replacing a 5-character result grows it.

**Rule** Only rewrite when the replacement is actually smaller — compare measured sizes, do not assume.

### 4.3 Range columns in tables may not cover their dice

**Symptom** A `roll_*` returns `null` on most rolls.

**Cause** Range columns had gaps and overlaps (`monster_reactions` covered 21/100). The fix was uniform row
selection generally, ranges only where complete.

**Rule** Validate table coverage whenever you add table data. `dd35_doctor` does not check this yet.

---

## 5. The house pattern: log before you throw

**Every plugin we own must write a failure to the filesystem before rethrowing it.** `fiberPhase: failed` is
not enough to debug with, and the launcher console is not always reachable.

```js
export function logDir() {
  const configured = process.env.DSH_PLUGIN_LOG_DIR
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'plugin-errors')
}

/** Append one failure, best-effort. Never throws: logging must not add a failure. */
export function logPluginError(plugin, stage, error) {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} [${plugin}] ${stage}: ${error?.stack ?? error}\n`
    appendFileSync(join(dir, `${plugin}.log`), line)
  } catch {
    // A read-only home is not worth turning into a second error.
  }
}

/** Log, then rethrow. Swallowing would leave a half-registered row. */
function guard(ctx, stage, body) {
  try {
    return body()
  } catch (error) {
    logPluginError(name, stage, error)
    ctx.logger?.error?.(`${name}: ${stage} failed — ${error?.message ?? error}`)
    throw error
  }
}
```

**Two rules that matter:** the logger must **never throw** (a read-only home must not become a second error),
and the guard must **rethrow** (a half-registered row is worse than one that refuses to start).

**Status:** implemented in `dsh-tool-result-policy/plugin.js`. **Owed in** `dsh-dd35-preset`,
`dsh-meridian-antigravity`, `dsh-compaction-guard`, `dsh-context-pressure`. A shared helper is better than five
copies — do that refactor before the next debugging session.

---

## 6. Testing traps

1. **A module-level workspace access during assembly fails silently.** A state loader called without a root
   threw, was caught, and returned `''` — the block simply never appeared. Pass the root explicitly.
2. **An options object merged wrongly leaves budgets `undefined`, and `slice(0, NaN)` throws** — which, if
   swallowed, deletes the block. Merge defaults internally and test it.
3. **A `cap()` that returns empty for a budget ≤ the notice length silently deletes content.** Return the
   notice instead.
4. **Importing a tool module into prompt assembly drags harness dependencies into tests.** Split pure logic
   (`oracle-core.js`) from the tool layer (`oracles.js`). Pure modules are unit-testable offline.
5. **A test that depends on `/proc` being read-only can hang.** Use a file-as-directory to create a
   deterministic write failure instead.
6. **When a test file hangs, probe the module in isolation first.** A route test hung; importing and calling
   the route directly worked, which localised the problem to the test harness, not the code.
7. **A host event hook is not a service call.** `agent/pre-step` fires once per **step**, so a pass over the
   session surface needs a per-session high-water mark or it walks all of history every step. Measured:
   245 ms for the first pass, 13.4 ms for each repeat on a 4,479-result session. Pin the skip in a test.
8. **A hand-written double that invents an API hides production bugs that no test can then catch.** The
   `dsh-tool-result-policy` doubles offered `session.events` and `session.tokenMeter`; the real `Session`
   (`packages/core/session/src/index.ts`) has **neither**. So `toolNamesByCallId` classified nothing (the
   strip never fired once) and `commitPlan` priced every prune at zero — through 240 green tests, a live
   session, and three doc revisions. Build the double from the real class's declaration (`Session` exposes
   `surface`, `eventAt`, `append`, `ownEvents()`, `snapshotEvents()`), and when a bug is found this way,
   **delete the invented property from the double** so a regression fails the suite. The two deprecated
   whole-log readers are `snapshotEvents()`/`ownEvents()`; prefer `surface.nodes` + `eventAt(seq)`, which is
   what the shipped pruner does.

---

## 7. Debugging checklist

Before writing a theory, in order:

1. **Is there a stack trace?** Launcher console / journal, then `$DSH_HOME/plugin-errors/`.
2. **Is the failure ours, the harness's, or the provider's?** Check the session log for `reason.error.code`
   to see which layer reported it.
3. **Measure the suspect directly.** Import it, time it, call it. Two minutes beats an hour of inference.
4. **Check the provider's own artifacts.** `brain/<uuid>/.system_generated/steps/N/output.txt`.
5. **For a UI plugin, probe the live slot tree** (`cordis_inspect_query` → client `Slots.listSubTree`).
   A healthy backend route proves only that the host half loaded.
6. **Before asserting a cause, state what would falsify it** — then test that. Three theories died in one
   session to a single falsifying check each.
7. **Model answers an older question, or re-offers a choice you already made?** Check the newest
   `compaction/summary` time against the session's last turns before reading the model's behaviour at all:
   a stale checkpoint is §8, and `/compact` then resend is the remedy. Forking does **not** help — it copies
   the checkpoint.
8. **Model "ignoring" an instruction that it can otherwise follow?** Check the checkpoint first (§8). Only if
   it is current, read the workspace's `AGENTS.md` for a plan/approval gate — §9.
9. **When the harness surprises you, write it here before moving on.** A fact re-derived costs the same hour
   twice; the sections above exist so it costs it once.

---

## 8. A stale compaction checkpoint freezes the session

**Symptom** The model answers a question you did not ask: it restates an earlier answer and re-offers a
choice you have already made. In `session-d772c4cf` (*Review Unstaged Git Files (1)*) three successive
versions of one request were met with re-audits, "what were we doing?" was answered with the state as of 19
hours earlier, and "did you receive my message?" produced a 7,008-character audit instead of a yes.

**The model received everything.** Measured on the dispatch for that last question (15:35:18, 93 messages):
the checkpoint at `[0]`, the same request **three times**, both intervening questions, and the new question
last. Nothing was lost, merged away or reordered. "It ignored my message" is the wrong diagnosis; it had the
message and answered a different state.

**Cause — the checkpoint is the operative state, and it goes stale.**

- It lands as a **user-role** message at position 0, and its preamble tells the model to *"treat the captured
  context as established background and build on it without restating it."*
- `compaction-basic` rewrites it **only when compaction runs**, which is triggered by context pressure, not by
  age. The last summary before this incident was written at **20:12:03**, and it was still the checkpoint
  **19 hours and 6 turns later**, while the session grew from 73 to 95 messages with only prunes.
- That stale summary carried `## Current Work: audit complete… awaiting user instruction on which track to
  execute` and `## Next Step: Await user selection of priority track: P1, P2, P3`. A gate written as an
  instruction, in a user-role message, outlives the moment that motivated it: every later "let's start with
  Roadmap Hygiene" is a request the state does not acknowledge, so the model re-offers the choice.

**Shape is neither sufficient nor necessary.** One session, two checkpoints, measured:

| Checkpoint | Template | Age | Result |
| --- | --- | --- | --- |
| 20:12:03, 7,067 chars | **8/8** sections | 19 h | froze — three request versions absorbed, all re-audited |
| 16:05:54, 7,625 chars (after `/compact`) | **0/8** sections | seconds | recovered — 68 tool calls and **7 edits** to `docs/MILESTONES.md` |

The conforming one failed and the non-conforming one worked, so "the summary follows the template" is not
evidence that the checkpoint is safe. Fix the shape anyway — 5 of that session's 8 summaries missed the
template — but do not expect it to fix a stale session.

**Rule**

- **A checkpoint must describe, never instruct.** `## Next Step: await user selection` is an instruction that
  outlives its trigger. Write state as *"as of turn N, X was pending"*, and say that later messages supersede
  it and that a choice already made must not be re-offered.
- **Refresh on staleness, not only on pressure.** A host plugin can compare the checkpoint against the
  session and re-summarise past a threshold. It must hook `agent/status` on `idle`, not `agent/pre-step`:
  `compactNow` runs through `runMaintenance`, which throws when the agent is active. Design, costs and
  guards: `docs/plugins/compaction-freshness.md`.
- **Framing can be fixed without the harness.** The checkpoint's preamble is ordinary text in our wire
  derivation, so the connector can replace it deterministically on every request — prefix-safe because the
  transform is a pure function of the surface message. Same document.

**Remedy available today:** `/compact` (`@deepseek-ai/dsh-command-compact`, mounted in the `standard`, `ptc`
and `cordis` presets). Run it in the session and resend the message. It worked first try here. **Do not fork**:
a fork copies the stale checkpoint, which is why this looked unfixable twice.

The recovery was not just research: the same turn removed the Windows `file:///d:` prefixes, normalised
`###` headings to `##`, and dropped `(Currently Active)` / `(Active)` suffixes — the roadmap hygiene that had
been requested three times, executed without any approval message in between.

**Confound, stated rather than hidden:** that compaction also shadowed 109 events / 61,038 tokens, most of
them the model's own repeated audits. A shorter context with less of that tail may account for part of the
recovery; one event cannot separate freshness from length.

---

## 9. A workspace rule can outrank a conversational instruction

**Symptom** The model will not execute a task it clearly understands, and keeps producing a plan or an audit
instead.

**The workspace's own `AGENTS.md` can require a gate.** In
`/export/DownloadsSSD/Projects/Game Dev/rogue-like/AGENTS.md`:

| Line | Rule |
| --- | --- |
| 5 | *"**Wait for authorization.** Never move on to executing a plan or writing code before the User gives explicit approval."* |
| 7 | *"**NEVER assume. ASK.**"* |
| 83 | research step: *"**STOP HERE** and present the research document… Do not proceed to Step 4 until the User explicitly confirms…"* |
| 87 | *"**STOP HERE and wait for the User's explicit approval of the Implementation Plan before writing or modifying any actual codebase files.**"* |

Those rules explain the **shape** of the replies in this session — a `research_notes.md` artifact (turn 8),
"once you choose, we will produce a detailed plan with exact diffs before writing any code" — instead of edits.

**They do not explain the loop, and this entry was wrong about that for one round.** The behaviour carried on
across three identical requests and cleared the moment the checkpoint was refreshed (§8) — with **no approval
message in between**. The turn after `/compact` made seven edits to `docs/MILESTONES.md`. So the gate was not
what blocked execution; a stale "await user selection" was.

**Rule** Check §8 first: a stale checkpoint is the cheaper explanation and the cheaper fix. Only if the
checkpoint is current and the model still will not act should the workspace instructions be read as the cause —
and then the remedy is to phrase approval in the terms the rules accept (*"plan approved — update
`docs/MILESTONES.md` now; skip the plan artifact"*) or to add a doc-only exemption to that `AGENTS.md`. A
doc-only change has no reason to sit behind a code-approval gate.

**Evidence that the model was never broadly stuck** (worth keeping, because it rules out the model and the
transport): it wrote `research_notes.md` when asked to work (turn 8), answered `test` when told "reply with
test please" (turn 11), and gave a correct recap when asked what it had been doing (turn 12).
