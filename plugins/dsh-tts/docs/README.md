# dsh-tts

Text-to-speech for the DeepSeek Harness. It reads assistant replies aloud — on demand from
a button, or automatically as each reply completes — using models that run locally. No cloud
service, and no network access at speak time.

- **Two engines.** Kokoro (better voice, slower than real time on this CPU) and Piper (VITS,
  around 3× faster than real time with a *medium* voice — see [Speed](#speed)).
- **Weights are pinned by sha256.** Every model file is verified against `assets.json` before
  it is used, and a mismatch fails loudly rather than producing bad audio.
- **Three surfaces.** A button on each reply, an auto-speak toggle per chat, and an HTTP API
  (`/v1/audio/…`) that anything on the machine can call.

## How it fits into the harness

It is a **profile-global plugin**, not a per-campaign one, so it is available in every chat.
It has two halves and they are installed together:

- **`plugin.js`** is the host half. It owns the models, the downloads, the settings and the
  HTTP route, and it registers one agent tool, `tts_status`, so an agent can ask whether
  speech is ready and where its files are.
- **`client.js`** is the browser half. It is a plain classic script (no bundler) that mounts
  five entries through the harness's slot API:

  | Slot | Entry | What it does |
  |---|---|---|
  | `conversation.chat.assistant-actions` | `tts` (order 20) | the speak button on a reply |
  | `conversation.chat.assistant-actions` | `tts-auto` (order 21) | renderless; speaks new replies when armed |
  | `conversation.session.header.actions` | `tts-provider` (order 24) | which engine speaks |
  | `conversation.session.header.actions` | `tts` (order 25) | the per-chat auto-speak toggle |
  | `plugins.bundle.config` | `@local/dsh-tts` | the settings pane |

  The client cannot see a reply as it is written — the slots hand over a message id and
  nothing else — so auto-speak is triggered by the message *completing*, and the host
  resolves the text. That is why there is no client-side segmenter.

## The moving parts

| File | What it is |
|---|---|
| `plugin.js` | host half: service, preparations, provider registry, route wiring, `tts_status` |
| `client.js` | browser half: pane, button, toggle, engine picker, auto-speak watcher |
| `kokoro.js` | the Kokoro graph: tokenizer, phonemizer call, style vectors, WAV encoding |
| `piper.js` | the Piper driver, its voice catalogue, and both label helpers |
| `download.js` | `ensureAsset` — fetch, verify, cache atomically. Every pin goes through it |
| `assets.json` | the pins: hashes, sizes, voices, and the descriptions the pane shows |
| `segment.js` | sentence splitting and coalescing, shared by every engine and trigger |
| `delivery.js` | compiles "slow and ominous" into voice and speed, and reports what it dropped |
| `tone.js` | optional emotion classifier for pace; falls back to a heuristic when absent |
| `speech-text.js` | the text filter: markdown out, then mechanics (tables, dice, stat lines) |
| `settings.js` | the persisted settings file, with per-key validators |
| `preference.js` | per-chat auto-speak state. **Not** a session event — see the note below |
| `route.js` | the HTTP API, independent of `node:http` so it can be tested without a server |
| `config.js` | the config schema, kept separate so it validates offline |
| `verify.mjs` | the gate: `pre` runs the four suites, `live` benchmarks the running host |
| `check.js`, `check-http.mjs`, `check-client.mjs`, `smoke.mjs` | 339 checks between them |
| `fetch-piper.mjs` | maintainer tool: fetch a Piper voice and print the hash to pin |
| `bench-inference.mjs` | the six-graph sweep, both workload shapes |
| `bench-webgpu-deno.js`, `bench-webgpu.html` | the iGPU attempts. Both are dead ends; kept for the setup |

## How a reply becomes audio

1. **Trigger.** The button, the auto-speak watcher, or an HTTP call. All three end at the same
   service method.
2. **Filter** (`speech-text.js`). Markdown is stripped, then mechanics — table rows, dice
   notation, and lines that are only stat fragments. One filter, applied before segmentation,
   so every trigger inherits it. `raw: true` skips it.
3. **Compile delivery** (`delivery.js`). Standing instructions and any tone reading become a
   voice and a speed. Anything the engine cannot express is reported rather than dropped.
4. **Segment** (`segment.js`). Sentences are cut and re-joined to stay under the graph's
   512-token ceiling. Overflow truncates *silently*, which is why the ceiling is checked
   rather than trusted.
5. **Prepare** (once per voice). Fetch and verify what is missing, then load the graph. The
   state machine is `unprepared → checking → downloading → loading → ready`, with `failed`
   and `cancelled`, and it survives a client disconnecting.
6. **Synthesize.** Kokoro at 24 kHz or Piper at 22.05 kHz, one segment at a time, with a
   180 ms gap between segments so a reply reads as sentences rather than one run-on line.
7. **Return.** A WAV, or headerless PCM with `response_format: "pcm"`.

## Speed

This is the section worth reading before choosing anything. Measured on this host — a
Pentium Gold G5400T, 2 cores / 4 threads, **SSE4.2 only**: no AVX, no AVX2, no FMA, no VNNI.

**Kokoro — every Graph variant above q4**, one 346-token passage and twelve short calls:

| Type | Size | Long passage RTF | Short calls RTF |
|---|---|---|---|
| **uint8** | 169 MB | **2.60** | **2.63** |
| uint8f16 | 109 MB | 2.67 | 2.73 |
| q8f16 | 82 MB | 2.73 | 2.78 |
| q8 (default) | 88 MB | 2.80 | 2.77 |
| fp32 | 310 MB | 2.92 | 2.94 |
| fp16 | 156 MB | 2.97 | 3.05 |

- **The type barely matters: the whole spread is 17%.** On this CPU the variant is a size
  dial, not a performance one, and nothing gets near real time.
- The ordering is **shape-dependent**. At a 96-token passage fp32 measured *fastest* (2.32);
  at 346 tokens it is slower than q8. Trust a measurement at realistic length.
- No `fp8` graph exists in the repository, and WebGPU has no fp8 type either.

**Piper — the pinned voices, same sentence:**

| Voice | Size | Wall clock | Audio | RTF |
|---|---|---|---|---|
| `en_US-amy-medium` | 63 MB | 693 ms | 2.41 s | **0.29** |
| `en_US-lessac-medium` | 63 MB | — | — | not measured |
| `en_US-lessac-high` | 114 MB | 4492 ms | 2.12 s | 2.12 |

- **The quality tier matters more than the engine.** Both rows are Piper, and `high` is about
  **7× slower** than `medium` — slow enough to be *slower than real time*, which is the exact
  property Piper exists to avoid. "Piper is the fast answer" is a claim about medium voices.
  The tier word in the voice label (*Lessac · US high*) is the only warning the pane gives.
- Comparing like with like — a medium Piper voice against Kokoro — the gap is 11.6×. At
  `high` quality it narrows to about 1.2×, and then you are choosing on voice, not speed.

**Threads are not a lever on this CPU.** 1 against 2 is flat for both engines (Kokoro 2.73 →
2.64; Piper 4606 → 4492 ms), and 4 was *slower* than 1 (18.1 s against 15.8 s). Two physical
cores doing memory-heavy work is the ceiling.

**The GPU is not a route.** The Intel UHD 610 on the same die is Vulkan-capable and reports
`shaderFloat16`, but ONNX Runtime's WebGPU provider cannot execute this graph (it fails
building a compute pipeline for `Clip`), and Debian 13 does not package the Intel compute
runtime that OpenVINO would need. Both attempts are in the design record.

## Choosing a voice

**Kokoro** has 54 pinned voices, each a ~0.5 MB style vector on top of one shared graph.
They are listed by label rather than id: `af_heart` reads as *Heart · US female*, derived
mechanically from the id (`a`/`b` American/British, `f`/`m`, then the name). An id that does
not parse is shown unchanged rather than guessed at.

Quality *grades* from the model card are deliberately **not** shown: they are somebody else's
judgement, and this plugin does not assert what it cannot cite. The manifest supports a
`grade` field and the pane would render it — populating it means pinning the card first, the
same way a voice gets pinned.

**Piper** pins three voices and treats `assets.json` as the catalogue, so a voice you have
not downloaded is still selectable, with its size shown before you commit:

| Voice | Label | Size |
|---|---|---|
| `en_US-amy-medium` | Amy · US medium | 63 MB — the fast one |
| `en_US-lessac-medium` | Lessac · US medium | 63 MB |
| `en_US-lessac-high` | Lessac · US high | 114 MB — better, 7× slower |

**To add a voice**, pin it: run `node fetch-piper.mjs <voice-id>`, which downloads it, prints
its sha256 and probe output, and then add the entry to `assets.json`. That is a maintainer's
step — a *user* never needs it, because anything pinned is downloadable from the pane.

## Installing and configuring

The bundle declares its own dependencies (`onnxruntime-node`, `phonemizer`,
`@huggingface/tokenizers`, and `onnxruntime-web` for the benchmark tooling) and installs
them with itself. There is no manual setup step, and no npm script: run the files directly.

```bash
cd /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-tts
pnpm install                 # if the bundle is new or its deps changed
node verify.mjs pre          # 339 checks, offline
```

Configuration is a row in the profile's plugin patch, which overrides the defaults in this
bundle's own `cordis.patch.yml`:

```yaml
- id: tts
  config:
    dataRoot: /root/.dsh/tts        # required: where weights live
    apiEnabled: true
    apiToken: '<token>'
    provider: piper                 # kokoro | piper
    threads: 1
```

The schema is `config.js`. `dataRoot` is deliberately **not** volatile: where the weights live
is deployment configuration, not a user preference. Everything else a user changes lives in
`<dataRoot>/settings.json`, and **the file beats the patch** — an absent key means "never
changed", not "use the default".

**Code reloads live; config and the patch do not.** The profile sets `hmr.root` to this
directory, so editing `plugin.js`, `client.js` or any module takes effect immediately. A
patch or config change needs a restart.

### Where the files land

```
<dataRoot>/settings.json                        user choices
<dataRoot>/preferences.json                     per-chat auto-speak
<dataRoot>/models/kokoro/<revision>/…           one shared graph + tokenizer + 54 style vectors
<dataRoot>/models/piper/en/en_US/amy/medium/en_US-amy-medium/…
```

Piper's layout is the one `fetch-piper.mjs` writes, deliberately: a voice fetched by hand is
recognised rather than downloaded a second time.

## Verifying

```bash
node verify.mjs pre      # offline gate: 4 suites, 339 checks. Run before every restart.
node verify.mjs live     # benchmarks both engines against the running host
```

`verify.mjs live` needs the API token if the route is enabled:

```bash
node verify.mjs live --url http://openmediavault:3080/v1/audio --token '<token>' --label piper
```

The offline suites cover the paths, the pins, the presence logic, the labels, the text filter,
segmentation, delivery compilation and the HTTP surface. Two things are exercised only live,
because they need a real host: the **download path** and the **settings key normalisation**.

## The HTTP API

Mounted at `apiPath` (default `/v1/audio`). Bearer token required unless
`apiAllowAnonymous` is explicitly turned on — this deployment binds to `0.0.0.0` and plugin
routes do not inherit the harness's own authentication.

| Route | Method | What it does |
|---|---|---|
| `/health` | GET | liveness. The one route that needs no token |
| `/voices` | GET | `{ default, voices: [{ id, label, present, bytes }] }` |
| `/status` | GET | preparation state, engine, threads, resolved paths |
| `/prepare` | POST | fetch and load the active voice |
| `/cancel` | POST | abort a download or a prepare |
| `/settings` | GET/POST | the pane's settings `{ provider, voice, piperVoice, toneEnabled, instructions, threads }` |
| `/preference` | GET/POST | per-chat auto-speak, `?sessionId=` |
| `/latest` | GET | whether an assistant message is the newest, for auto-speak |
| `/speech` | POST | `{ input \| messageId, voice, speed, response_format, raw }` → audio |

`/speech` answers `audio/wav`, or headerless `audio/L16` at 24 kHz with
`response_format: "pcm"`, and reports `x-segments`, `x-audio-seconds` and `x-inferred-ms`.

## Things that will bite you

- **Never append a session event type the harness does not ship.** A plugin cannot mark one
  ignorable, and a session containing one becomes unloadable. Per-chat state belongs in
  `preferences.json` — that is why it exists, and the incident is written up in the design
  record.
- **`dataRoot` must be set in the profile patch.** Without it the plugin falls back to
  `<cwd>/.dsh-tts`: every model invisible, and its settings file written into the checkout.
  The mount-time warning that says so exists because the symptom appears nowhere near the
  cause.
- **A `link:`ed bundle does not get the profile's install.** Its dependencies must be
  installed in the bundle directory.
- **The graph truncates silently at 512 tokens.** `segmentChars` is deliberately conservative
  because phoneme count varies with the text.
- **`$comment` keys live inside `assets.json`'s `variants` map.** Anything enumerating it must
  skip keys starting with `$`, or a pseudo-variant with no path and no hash shows up in the
  pane.
- **`raw: true` must be exactly `true`.** A non-literal value does *not* disable the filter —
  a dropped option here fails silently, with audio that still sounds fine, just filtered.

## The design record

This file is the practical entry point. The reasoning, the measurements and the dead ends live
in the harness docs:

- **`docs/dsh/global-plugins.md`** — GP-1 (this plugin) and GP-2 (exposing it as an OpenAI-ish
  API), including the hardware findings, the corrections to earlier claims, and the iGPU work.
- **`docs/dsh/gp1-piper-downloads.md`** — the working notes for the voice-catalogue and
  download work.
