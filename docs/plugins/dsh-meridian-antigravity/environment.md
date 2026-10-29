# Meridian / agy deployment — where everything lives

Deployment notes, not upstream documentation. They describe **this host** (`openmediavault`) and would be
stale for any other. Kept in the repo because there is nowhere better; treat it as environment archaeology,
not as a spec.

All of it was read from the machine, not inferred.

## Services

Meridian runs as a **user** unit, which is why `systemctl list-units` (system scope) shows nothing:

```
/root/.config/systemd/user/meridian-agy.service
/root/.config/systemd/user/meridian-agy-auth.service     quota auth
/root/.config/systemd/user/meridian-agy-auth.timer
```

```sh
journalctl --user -u meridian-agy -b -f      # follow the service log
systemctl --user status meridian-agy
systemctl --user restart meridian-agy
```

`Restart=on-failure`, `RestartSec=3`. `openmediavault` resolves to `::1`, and the service listens on
`0.0.0.0:3457` — the API is on this host, not a container. (Inside the DSH bash tool the process tree is
hidden by `--unshare-pid`, so `ps` shows nothing; that is the sandbox, not an absent service.)

The DSH web UI listens on `:3080`.

## Environment

From the unit file:

| Variable | Value |
|---|---|
| `MERIDIAN_BACKEND` | `antigravity` |
| `MERIDIAN_HOST` / `MERIDIAN_PORT` | `0.0.0.0` / `3457` |
| `MERIDIAN_AGY_PATH` | `/root/.local/bin/agy` |
| `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE` | `1` |
| `MERIDIAN_AGY_STATE_PATH` | `/root/.local/state/meridian/antigravity.sqlite` |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` |
| `MERIDIAN_API_KEY` | in the unit file, plaintext (**see the TODO below**) |
| `MERIDIAN_AGY_MAX_PROMPT_BYTES` | **unset → default 190,000** |

`MERIDIAN_AGY_MAX_PROMPT_BYTES` being unset is the important one: Meridian's prompt shortening is *active*,
at its default. See "Prompt limits" below.

Documented defaults for the knobs that matter here: turn timeout 300,000 ms, tool-result deadline 60,000 ms,
idle-conversation retention = the tool timeout, max concurrent CLI processes 4, request bodies 8 MiB,
upstream stdout 16 MiB.

## Directories

| Path | What |
|---|---|
| `/root/.local/state/meridian/antigravity.sqlite` | Meridian's state: saved answers, activity buckets, unfinished-request journal. One table `ag_state` (6,450 rows on 2026-10-26), ~3.9 MB plus a ~4.2 MB WAL |
| `/root/.local/state/meridian/antigravity-workspaces-<hash>/` | retained disposable workspace for eligible completed native snapshots (up to 30 min) |
| `/root/.gemini/antigravity-cli/brain/<uuid>/` | the CLI's own conversation state — **the only place the exact prompt is recorded** |
| `/root/.dsh/meridian-capture/` | DSH's request captures, one file per dispatch (ring of 50) |
| `/root/.dsh/.credentials.yaml` | `refs:` holds the provider keys, including `ANTIGRAVITY_API_KEY` |
| `/root/.dsh/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd` | the harness's own session store |

### The CLI's artefacts, per brain

```
brain/<uuid>/.system_generated/logs/transcript_full.jsonl   full step records, incl. the <USER_REQUEST> prompt
brain/<uuid>/.system_generated/logs/transcript.jsonl        condensed
brain/<uuid>/.system_generated/messages/*.json              individual message payloads
brain/<uuid>/.system_generated/steps/N/output.txt           per-step output
```

## Prompt limits — the constraint that actually bites

Documented in `rynfar/meridian` `docs/antigravity.md` and `docs/antigravity-support.md`:

- `agy` keeps only about **192,000 bytes** of one input step and **silently drops the rest**; a started or
  replayed conversation sends its whole history in **one** step, **history last**.
- `MERIDIAN_AGY_MAX_PROMPT_BYTES` (default **190,000**) shortens the oldest large tool results, arguments
  and text first, the newest round last. A single request that cannot fit returns `400 prompt is too long`.
- `/v1/messages/count_tokens` estimates as UTF-8 bytes / 4 — "neither an exact tokenizer nor an upper-bound".
  `max_tokens` is advisory; `tokenCounting` is an estimate.

**Measured on this deployment:** dispatch bodies are 182 KB – 421 KB, median **294 KB**, and **47 of 50**
captures exceed 190,000 bytes. The CLI's transcripts contain the marker **786** times, dominated by
`<truncated 188064 bytes>` (175×), 188063 (103×), 188062 (15×) — a tight cluster just under 192,000. So the
cap is reached routinely; the question of *which* end is dropped (the doc says history is placed last, which
would drop the newest messages) is still open and is the next thing to measure.

Endpoints, for reference: `/health` (public), `/v1/models`, `/providers/status`, `/v1/usage/quota/all`,
`/v1/messages`, `/v1/messages/count_tokens` — all except `/health` need `x-api-key`. There is no
`/openapi.json` (401 without a key, 404 with one).

## Reading the provider's view

`tmp/meridian/wire-report.mjs <session-id-suffix>` summarises what DSH dispatched from the captures:
conversation key, notice exposure, continuation, and whether a body was a recovery retry. The CLI's
transcript is the record of what the *model* received; the capture is the record of what we *sent*. When the
two disagree, the prompt's own size and the position of the `<truncated …>` marker decide it.

## TODO

- `MERIDIAN_API_KEY` sits in plaintext in the unit file, which is world-readable (`-rw-r--r--`). Move it to
  an `EnvironmentFile=` with `0600` and reload the unit.

## Passthrough mode

`/health` reports `mode: "passthrough"`. That names the **adapter**, not a transport: `MERIDIAN_DEFAULT_AGENT`
lists `passthrough` among the adapters for unrecognized clients (`opencode`, `pi`, `droid`,
`claude-code`, `passthrough`, …), and `MERIDIAN_PASSTHROUGH` is documented as *"forward tool calls to client
instead of executing"*. DSH is served by that generic adapter, which is why tool execution stays in DSH.

The unit sets no passthrough overrides, so the stock defaults apply:

| Variable | Default | What it means here |
|---|---|---|
| `MERIDIAN_PASSTHROUGH_MAX_TURNS` | unset → **capped at 1** | one turn per client request; each dispatch carries one tool batch |
| `MERIDIAN_PASSTHROUGH_EARLY_STOP` | `1` | the turn stops once a batch is forwarded to the client |
| `MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY` | unset | only a **confirmed** CLI rejection (`No such tool available`, unparsable input) is recoverable |
| `MERIDIAN_SUPPRESS_SCRATCHPAD` | `1` | prompt-level scratchpad suppression |
| `MERIDIAN_SUPPRESS_IMPLICIT_ATTACHMENTS` | `1` | sets `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` |
| `MERIDIAN_COMPACTION_SURVIVAL` | `0` | a client-supplied summary is replayed into a **fresh** session; equal-length pruning resumes |
| `MERIDIAN_UPSTREAM_IDLE_MS` | `90000` | Meridian's own stall guard, independent of the connector's `streamIdleTimeoutMs` |
| `MERIDIAN_SESSION_TURN_MAX_HOLD_MS` | `600000` | a turn holds its session lease up to 10 minutes |

Nothing in these defaults rewrites client prompt text, which is why our system prompt reaches `agy` verbatim
("Client system instructions:" followed by the DSH prompt in the transcripts).

Installed build: `/root/.local/share/pnpm/global/v11/<hash>/node_modules/@rynfar/meridian/dist`.

## Official documentation

- `docs/antigravity.md` — backend, start-up, limits, timeouts
- `docs/antigravity-support.md` — supported flows, recovery, what cannot be supported (byte cap, advisory
  `max_tokens`, estimated token counting)
- `docs/configuration.md` — every environment variable, including the passthrough table above
- `docs/plugins.md` — prompt-rewriting plugins (`*-scrub`), `plugins.json`
- `docs/development.md` — build and test
- Repository: <https://github.com/rynfar/meridian>

## The service runs a local build, not the registry package

`ExecStart` points at the checkout, because Meridian pins an exact `agy` version in a compatibility gate and
this host runs a different one:

```ini
ExecStart=/usr/bin/node /export/DownloadsSSD/AI/TEXT/meridian/dist/cli.js
```

Backup of the previous line: `meridian-agy.service.bak.pnpm`. Confirm with `/health` — `build.source` must read
`local`; `npm` means the unit is still pointing at the pnpm shim (`/root/.local/share/pnpm/bin/meridian`).

| | |
|---|---|
| Clone | `/export/DownloadsSSD/AI/TEXT/meridian` |
| Branch | `local/agy-1.3.4-compat-v1.87.0` (from tag `meridian-v1.87.0`) |
| Patch | commit `6db7e3a7` — widen the gate to `1.2.7` **and** `1.3.4`, documented in the clone's `LOCAL-PATCHES.md` |
| Upgrade | fetch tags, branch from the new tag, cherry-pick the patch commit, `npm ci` if the lockfile moved, `npm run build`, daemon-reload, restart |

Use **npm**, not pnpm: the repo ships `package-lock.json` and declares `packageManager: bun@1.3.11`, so pnpm
would ignore the lockfile, and pnpm ≥10 skips lifecycle scripts by default. `npm ci` is also faster than
`npm install` because it skips resolution; skip it entirely when the lockfile has not changed.

`tmp/meridian/patch-agy-gate.mjs` is the fallback for a registry build: it rewrites the gate in the installed
dist to the version `agy --version` reports, is idempotent, and supports `--dry-run`. It is no longer part of
the normal upgrade path.

Two operational details: Meridian binds :3457 about eight seconds before it answers, so a `/health` that fails
right after a restart is not a crash; and `systemctl --user` works from the agent shell only with
`XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`.
