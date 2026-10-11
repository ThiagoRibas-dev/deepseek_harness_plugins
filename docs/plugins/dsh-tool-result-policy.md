# Tool-Result Retention Policy — Specification

**Document:** `docs/plugins/dsh-tool-result-policy.md`
**Date:** October 8, 2026 · **rev 2:** October 9, 2026 · **rev 3:** October 9, 2026
**Status:** `SPECCED`
**Bundle:** `plugins/dsh-tool-result-policy/`
**Scope:** preset-scoped, live-toggleable. All `dd35` sessions behave one way, all `cordis`
sessions another, and the policy is editable without a harness restart.

> **⚠️ rev 3 — two bugs meant the strip never ran; what caused the session's conflict is undetermined.**
> Live session `4ba1929e` ("Resuming Previous Session", `dd35`, 2 turns) exercised the pass. It fired at the
> first completed-turn boundary and rewrote two large results; the next continuation was then refused by
> Meridian and the turn closed with a notice while `turn/end` said `completed`.
>
> The same session showed the strip had never worked: `toolNamesByCallId` read `session.events` and
> `commitPlan` read `session.tokenMeter`, and the real `Session` has neither (`lessons-learned.md` §6.8).
> Both are fixed and pinned; a replay on that session's log classifies 14 results and would free 60,303 chars.
>
> **The conflict's cause is not established.** The prune ran at a turn boundary with no batch pending — outside
> the window the connector documents — and the request immediately after it was accepted, so the prune is a
> weak explanation. The connector's own catalogue splits its 52 conflicts three ways (21 pruned, 16 model
> change, ~12 neither), and the prune/conflict correlation is confounded by session length. Keeping the policy
> off for Meridian-routed presets is precaution, not a demonstrated verdict; `lessons-learned.md` §3.2 records
> what is actually known and how to identify a cause with `captureRequestBodies`.

> **⚠️ rev 2 — the strip is a Host-plane pass, not a `ToolResultPruner` service.**
> §2.1's original composition change mounted the service inside the `dd35` preset's
> isolated group, which governs **one** preset: the shipped `web-app` bundle disables the
> host-plane pruner and gives `standard`, `ptc` and `cordis` their own copy inside their
> own `isolate: { toolResultPruner: true }` realms. So the settings page listed every
> preset while only `dd35`'s toggle did anything.
>
> Covering them by service would mean overriding each shipped preset declaration, which
> replaces its complete `config.plugins` — ~450 lines of harness configuration copied into
> this bundle and silently shadowing upstream changes. Instead the strip now runs as a
> `agent/pre-step` listener in `plugin.js`, which Host-plane plugins see for every session
> (`dsh-context-pressure` is the proof). `pass.js` owns it; `index.js` is deleted; `dd35`
> mounts the guard's pruner again for truncation. §2.1, §2.7 and §3 are updated below.

---

## 1. The measurement that motivates this

From 88 real `dd35` sessions:

| | |
| :--- | ---: |
| `tool/result` events retained in history | **4,479** |
| Their payload | **10.6 MB ≈ 3.03 M tokens** |
| Assistant + user message text | 4.1 MB ≈ 1.18 M tokens |
| **Tool output as a share of provider-bound bytes** | **72%** |

Top contributors:

| Tool | Calls | Retained | Avg |
| :--- | ---: | ---: | ---: |
| `read` | 1,134 | ~1,775 k tok | 5,478 B |
| `bash` | 319 | ~232 k tok | 2,540 B |
| `grep` | 134 | ~188 k tok | 4,922 B |
| `fetch_memories` | 167 | ~163 k tok | 3,418 B |
| `skill` | 135 | ~131 k tok | 3,399 B |
| `list_memories` | 254 | ~125 k tok | 1,720 B |
| `get_state` | 290 | ~103 k tok | 1,244 B |
| `update_scene` | 310 | ~60 k tok | 675 B |

`get_state` and `update_scene` alone retain ~163 k tokens of state that is **fully re-readable
from `state.json` at any moment.** Every past copy is re-sent on every subsequent request.

### 1.1 Why retention is wrong, per tool class

**Transient reads.** A tool result is a *rendering* of data that lives in files. `get_state`
renders `state.json` + the entity sheets; `update_scene` echoes back what it just wrote;
`read`/`grep`/`glob`/`bash` produce output whose durable artifacts (if any) are on disk. Once
the turn that consumed the result is narrated, the result is a **duplicate of durable state**
and has no further use.

**Entropy.** `roll_dice`, `roll_solo_oracle`, `ask_oracle`, `consult_oracle` produce outcomes
not persisted anywhere. They are **per-turn entropy**: the result's only job is to steer the
turn being narrated. Once narrated, the direction has been chosen and the number is spent.
Keeping it buys nothing; the model does not need to know what it rolled last turn.

**Mutations.** `apply_damage`, `roll_attack(apply: true)`, `heal`, `next_turn` change entity
sheets. Their *effect* is persisted to the sheet, so the result is again a duplicate of durable
state. This is why mutation tools need no special exemption.

**So the rule is uniform: no tool result needs to outlive the turn that produced it.** The one
class that would have needed an exemption — dice/oracle outcomes, which are not persisted —
is exempted by design intent rather than by preservation: they are entropy, and spent entropy
is not a record.

### 1.2 What the current machinery does, and why it is insufficient

`plugins/dsh-compaction-guard/pruner.js` already overrides `ToolResultPruner.pruneSession()`:

```yaml
thresholdChars: 8192     # only results larger than this
headChars: 4096
tailChars: 1024
deferWhenBatchPending: true
```

Two limitations:

1. **It truncates, never deletes.** A 5,478-byte `read` is under the 8 KB threshold and is
   retained in full, forever. That is ~2,500 of the 4,479 results, including the largest
   aggregate contributor.
2. **It runs only as part of compaction** (`compaction-basic` calls it before summarising), so
   pruning is triggered by context pressure rather than by the turn boundary. Retention
   accumulates until compaction is already necessary.

---

## 2. Design

### 2.1 New bundle: `@local/dsh-tool-result-policy`

Rather than extend `dsh-compaction-guard`, this is a **sibling bundle** that provides its own
`ToolResultPruner`. Reasons:

* **The capability is general.** It applies to any preset and any deployment; the compaction
  guard's concern (deferring mid-turn rewrites on a delivered-prefix provider) is orthogonal.
* **Both behaviours live in one place.** Truncation-over-threshold and stripping-by-class are
  two policies over one pass, not two services racing to rewrite the same nodes.
* **No service race.** Implementing `ToolResultPruner` ourselves means the guard's pruner is
  simply not mounted for the preset that uses this one.

Composition change — **rev 2, the shipped form**. No preset is restated. The bundle patch
inserts one Host-plane row that mounts both the strip pass and the settings route:

```yaml
- insert:
    - id: tool-result-policy
      # The bare package name. A scoped subpath is dropped by the client-module
      # scan before it reads `dsh.client`, which is why the settings page did not
      # appear. See lessons-learned §1.7.
      name: '@local/dsh-tool-result-policy'
      config:
        policyPath: '!!js dshHomePath("tool-result-policy.json")'
        stripTransientResults: false
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
```

`plugin.js` registers `ctx.on('agent/pre-step', …)`, so **one mount applies the per-preset
policy to every preset**. The `dd35` compaction group keeps
`dsh-compaction-guard/pruner.js` for truncation-at-compaction, exactly as before this work;
`plugins/dsh-tool-result-policy/index.js` no longer exists.

The two service-mounting designs were rejected, and the reasons are the part worth keeping:

1. **A service in one preset governs one preset.** Isolation is per realm, so `dd35`'s
   pruner is invisible to `standard`. Confirmed live: `settings.plugins.tab` listed every
   preset, and only `dd35` had a pruner that read the file.
2. **A service at the Host plane cannot be added.** The shipped `web-app` bundle disables
   the host-plane pruner row outright (`packages/bundle/web-app/cordis.patch.yml:494`) and
   gives each preset its own; re-enabling it collides with those realms
   (`service "toolResultPruner" has been registered at <GuardedToolResultPruner>`).

**The turn boundary is the correctness rule, not an optimisation.** A tool result is
load-bearing until the turn that produced it is narrated. `isMidTurn` — the guard's own
pairing test — is the gate, and it applies to **every** provider, not only
`contractProviders`: eliding a live turn's inputs is wrong regardless of who is serving it.
That is stricter than the service form, which deferred only on Meridian.

**Cost, measured:** a full walk of a 4,479-result history is 245 ms when the toggle is first
switched on, and ~13 ms while nothing changes. `agent/pre-step` fires every step, so a
per-session high-water mark in `pass.js` skips the walk entirely when the surface tail has
not moved.

### 2.2 The policy table

A single JSON file, **not** in any session's workspace, because this is a deployment preference
rather than session-derived state (see `practices.md`: session-derived state belongs in a
projection; plugin-owned data belongs in a storage service). The file is human-readable and
hand-editable, which is the escape hatch if the UI is unavailable.

```jsonc
{
  "version": 1,
  "presets": {
    "dd35":   { "stripTransientResults": true },
    "cordis": { "stripTransientResults": false }
  },
  "defaults": { "stripTransientResults": false }
}
```

**Resolution order** for a session: `presets[agentPreset]` → `defaults` → the bundle's own
`config.defaults`. A preset absent from the table falls through to `defaults`, so a new preset
is opt-in rather than silently affected.

**Cached with mtime invalidation**, keyed by file path + mtime + size — the same idiom
`scene-state.js` uses for campaign files. A hand-edit or a UI write is observed on the next
`pruneSession` call without a restart.

### 2.3 Strip policy: which results are stripped

Stripping is **by tool classification**, declared in one table so the rule is auditable:

| Class | Tools | Action |
| :--- | :--- | :--- |
| **transient read** | `read`, `glob`, `grep`, `bash`, `get_state`, `update_scene`, `list_memories`, `list_campaigns`, `get_entity`, `dd35_doctor`, `dd35_context_index`, `skill`, `list_agents`, `job_output`, `job_list`, `tts_status`, `cordis_inspect_*` | **strip** |
| **entropy** | `roll_dice`, `roll_solo_oracle`, `ask_oracle`, `consult_oracle`, `roll_check`, `roll_save`, `roll_attack`, `init_combat`, `next_turn`, `next_round`, `draw_*`, `generate_*`, `explore_*`, `roll_monster_behavior` | **strip** |
| **mutation** | `apply_damage`, `heal`, `apply_condition`, `remove_condition`, `tick_conditions`, `create_entity`, `update_entity`, `create_campaign`, `set_active_campaign`, `set_mode`, `route_turn`, `adjust_initiative`, `add_combatant`, `remove_combatant`, `end_combat`, `write`, `edit` | **strip** |
| **unclassified** | anything else | **keep** (with truncation still applied) |

The default for unknown tools is **keep**, so a future plugin's results are not silently
destroyed by a policy written before it existed. That asymmetry is deliberate.

### 2.4 What a stripped result becomes

One line, on the session log, so the exchange stays readable and reconstructable:

```
[tool result elided: read — 5,478 B, 41 lines. Re-run the tool if the content is needed again.]
```

Requirements:

* **The tool-call message is untouched.** Only the result node is rewritten, so the
  call/result pairing the provider relies on stays intact.
* **Never mid-turn.** The existing `deferWhenBatchPending` logic is preserved verbatim: a
  rewrite while a tool batch is pending on a delivered-prefix provider causes
  `MERIDIAN_CONTINUATION_CONFLICT`, of which the live session store already holds ~12
  unexplained `dd35` cases. Stripping happens at a turn boundary only.
* **Idempotent.** An already-elided marker is not re-elided, so repeated passes are free.

Observed on `tools/result` per `practices.md` (`Observe final tool outcomes on tools/result`),
the classification is recorded at execution time; the prune pass only needs to know which
nodes are eligible.

### 2.5 Live toggle — the settings page

Registered at `settings.plugins.tab` — *"One page inside the Plugins settings section"* — which
is the correct seat for a plugin's own configuration and does not shadow shipped UI.

The page renders the preset-versus-boolean table described in the requirement:

```
Tool-result retention

  Preset              Strip transient results
  ─────────────────   ────────────────────────
  dd35                [ on  ]
  cordis              [ off ]
  (default)           [ off ]

  Keeps 72% of provider-bound bytes out of history …measured on 88 sessions.
  Changes apply to the next model request; no restart.
```

Behavioural requirements, from `practices.md`:

* **React component in a slot**, not an iframe — an iframe loses theme tokens and locale.
* **Theme tokens only** (`--dsw-alias-*`), no literal colours.
* **No Harness Client package imports** — controls are written locally, marked up like the
  host's own, with `role="switch"` + `aria-checked` on the toggle.
* **Visible text through the Client locale service.**
* Registrations via `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`, disposed with
  the owning declaration.

Write path: the Client calls a `@Remote` method on the host policy service, which writes the
file and invalidates its cache. The next `pruneSession` observes the new value — live, no
restart.

### 2.6 Falsification

The design is wrong if, after a full session with stripping on:

* the model re-runs tools to recover content it should not have needed (rising `read`/`grep`
  counts per turn), or
* narration drifts from `state.json` more often (mutation and entropy results were load-bearing
  after all).

Both are measurable with `tmp/dd35-usage2.mjs`, which already reports per-tool counts and
`read` targets. **The rollback is one toggle.**

---

## 2.7 What actually shipped, and the two things that changed on contact

**Built (rev 2):** `plugins/dsh-tool-result-policy/` — `policy.js` (the table and the strip
classification), `prune-core.js` (plan/commit, free of harness imports), `pass.js` (the
Host-plane turn-boundary pass, pure and unit-tested), `route.js` (the read/write surface),
`plugin.js` (bundle entry mounting the pass and the route), `client.js` (the settings page).
**75 tests.** The `dd35` compaction group mounts `dsh-compaction-guard/pruner.js` for
truncation, unchanged from before this work; `index.js` is deleted.

**Three corrections the build forced:**

1. **The bundle must not claim `toolResultPruner` at the Host plane.** It failed to activate
   with `service "toolResultPruner" has been registered at <GuardedToolResultPruner>`: the
   service is provided once per realm, and `dd35` mounts the class inside its own isolated
   compaction group.
2. **The shipped host-plane pruner must be left enabled.** Disabling it reads like the tidy
   swap, but its `disabled` flag reaches the Host plane only, so every *other* preset —
   `standard`, `ptc`, `cordis` — would silently lose pruning. Those presets keep what they
   mount today.
3. **(rev 2) A per-preset service mount cannot deliver the per-preset toggle the page
   promises.** See §2.1. The pass replaces it.

**The client half was invisible for its whole life, and the reason is not obvious.** The row
was named `@local/dsh-tool-result-policy/plugin`. `ClientModuleRegistry` discovers a web half
by resolving each Loader row to its owning `package.json`, and it gates on
`exactPackageSpecifier(row.name)` — which for a **scoped** name accepts exactly two segments.
The subpath returned `undefined`, the row was dropped before `dsh.client` was ever read, and
nothing was logged. The row is now the bare package name. Pinned by
`tests/bundle-discovery.test.mjs` and recorded in `lessons-learned.md` §1.7.

Both are recorded in the bundle's `cordis.patch.yml`, which is where the next person will
look.

**Deliberate deviation from the plan:** persistence is a **plain JSON file** watched by mtime,
not `ctx.storageDomain`. The domain is real and `defineDomain` would be the harness-native
home, but `open()` is async, needs a spec and a lifecycle the pass does not want on a hot
path, and a file is directly editable when the UI is unavailable. The tradeoff is recorded
here rather than left implicit.

## 3. Acceptance criteria

- [x] One Host-plane mount applies the policy to **every** preset; no shipped preset
      declaration is restated, and `dd35` keeps the guard's pruner for truncation.
- [x] The policy table resolves per `session.header.agentPreset`, falls through to `defaults`
      then the bundle default, and is re-read when the file's mtime/size changes.
- [x] With `stripTransientResults: false`, behaviour is byte-identical to today, and the pass
      returns before planning (`reason: 'policy-off'`).
- [x] With it true, eligible results are replaced by the one-line marker at a **completed turn
      boundary only**; the tool-call message is untouched; an already-elided result is not
      re-elided; a mid-turn surface is deferred on every provider.
- [x] Unknown tools are kept, never stripped.
- [x] The settings page renders the table, toggles live without a restart, and writes the JSON
      file; the row name passes the client-module scan.
- [x] Tests: policy resolution and fallback; mtime invalidation; classification (strip/keep/
      unknown); marker idempotence; truncation applied to kept results; the turn boundary; the
      per-session high-water mark; the session-shape contract. **79 tests in this bundle.**
- [ ] **Undetermined:** whether a strip on a Meridian session causes
      `MERIDIAN_CONTINUATION_CONFLICT`. Session `4ba1929e` refused its second continuation after the
      pass rewrote two results, and Meridian pruned sessions conflict more often (10/12 vs 22/63),
      but the prune ran outside the documented window and the correlation is confounded by session
      length. The cause is not provable from the log. Settle it with `captureRequestBodies` and a
      dispatched-body diff before enabling the strip on a Meridian-routed preset.
