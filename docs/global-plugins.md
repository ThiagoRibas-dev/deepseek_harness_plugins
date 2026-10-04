# DSH Profile-Global Plugins — Backlog

> **Where the bundle lives.** The plugin is no longer inside this repository. It is a profile-global bundle at
> `/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-tts`, installed into the `web` profile by a `link:`
> dependency, so the paths below are written relative to it:
>
> ```sh
> TTS=/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-tts
> ```

> Moving it out of the workspace also moved it out of version control, which is the trade: the bundle is now
> deployed rather than developed in-tree, and its history stops at the commit that removed it.

*Backlog for plugins that belong to the **profile**, not to an agent preset. Kept separate from
[`dd35-future-improvements.md`](dd35-future-improvements.md) on purpose.*

## Why this is a separate document

DSH composes behaviour in two layers, and they have different owners:

| Layer | Supplies | Scoped to | Lives in |
|---|---|---|---|
| **Host / profile** | shared services — tools, prompt registry, agent loop, sessions, storage, settings | every session in the profile | a profile bundle |
| **Preset** | scoped tools, persona, prompt sections, policies for *one* agent | sessions that select that preset | an agent preset |

Everything in the dd35 backlog is a **preset** concern: D&D rules, encounter state, the turn record. It exists
because a *Dungeon Master* agent needs it, and a session running the `standard` preset must not see it.

A text-to-speech mode is the opposite. It has nothing to do with D&D, and it should work for **any** agent in the
profile — the DM, a code assistant, anything. Putting it in the dd35 preset would mean rebuilding it for the next
preset that wants a voice, and it would be invisible to every other session. So it is a profile-global plugin and
it belongs here.

**Status legend** — `IDEA` not started · `SPECCED` design settled, ready to build · `WIP` in progress · `DONE` shipped
**Priority** — P1 wanted or needed now · P2 meaningful quality gain · P3 polish

| ID | Item | Priority | Effort | Status |
|---|---|---|---|---|
| [GP-1](#gp-1--kokoro-tts-a-spoken-reply-mode) | Kokoro TTS: a spoken-reply mode | P2 | ~3–5 days | `WIP` *(phase 4a reverted)* |
| [GP-2](#gp-2--expose-tts-as-a-standard-server-api) | Expose TTS as a standard server API | P2 | ~1–2 days | `DONE` *(host half)* |

> **⚠ Phase 4a was reverted after it corrupted two session logs.** The per-chat preference is no longer a session
> projection: `session.append('tts/preference', …)` wrote an event type the harness does not know, and the append
> API cannot set the `ignorable` marker the persistence reader requires for one — so those sessions stopped loading
> entirely. Read [The session-projection route poisoned the
> log](#the-session-projection-route-poisoned-the-log) before touching per-session plugin state. The preference is
> now a plugin-owned file; nothing else in GP-1 is affected.

---

## GP-1 — Kokoro TTS: a spoken-reply mode

**Priority P2 · Effort ~3–5 days · Status `WIP` — model layer and integration pattern both settled; phase 4a
reverted, see the [incident](#the-session-projection-route-poisoned-the-log)**

### What it is

A profile-global plugin that can read the assistant's reply aloud, with three user-facing controls:

1. **A TTS toggle** — speak replies, or don't.
2. **A tone toggle** — when on, classify the reply's sentiment/tone before speaking it and let that drive delivery.
3. **An instructions field** — free text describing how it should sound ("slow and ominous", "clipped and
   military", "warm, like telling a child a story").

Selected per the user's request as the next plugin after the dd35 work, and as the first profile-global one.

The provisioning pattern is not speculative: DSH already ships one local-ONNX plugin with a Prepare button, and it
is installed and active in this profile. See [Provisioning](#provisioning--take-the-mechanics-own-the-vocabulary).

### The model, measured

[Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) is an 82M-parameter Apache-2.0 TTS model. The
published ONNX repo is public and ungated (709k downloads, 267 likes), so the weights are plain unauthenticated
HTTPS and can be fetched the same way [FI-10](dd35-future-improvements.md#fi-10--the-onnx-inference-substrate)
already specifies for Laya.

| Variant | File | Size |
|---|---|---|
| **`q8` — the practical pick** | `onnx/model_quantized.onnx` | **88 MB** |
| `q8f16` | `onnx/model_q8f16.onnx` | 82 MB |
| `uint8f16` | `onnx/model_uint8f16.onnx` | 109 MB |
| `fp16` | `onnx/model_fp16.onnx` | 156 MB |
| `q4f16` | `onnx/model_q4f16.onnx` | 147 MB |
| `uint8` | `onnx/model_uint8.onnx` | 169 MB |
| `fp32` | `onnx/model.onnx` | 310 MB |
| `q4` | `onnx/model_q4.onnx` | 291 MB (no real saving — avoid) |

Plus **~0.5 MB per voice** file (`voices/af_heart.bin` and 53 others).

Three consequences, and they are all good news:

- **88 MB is small.** An order of magnitude under the Laya bundle, and in the same class as the embedders in
  FI-14/FI-15. This feature is viable on a host that could not afford Laya.
- **No quantization step.** The repository ships eight pre-quantized graphs, so unlike Laya there is no one-time
  Python pass — pick a file and fetch it. (The repo's 1.35 GiB total is eight variants plus all 54 voices; a single
  working set is ~90 MB.)
- **`env.cacheDir` is settable**, so the same cache-and-pin discipline as FI-10 applies unchanged.

### Measured on this host — the finding that changes the plan

Phase 1 was built and measured rather than assumed, and the numbers are not the published ones.

**The pipeline works.** Text to IPA to tokens to waveform is correct end to end: `ðə kˈæɹɐvˌæn ɪz ɐ pˈaɪɚ.
nˈʌθɪŋ bɹˈiːðz. kˈɛnə wˈɑːtʃᵻz fɹʌmðə ɹˈɪdʒ, ænd dʌznˌɑːt kˈʌm dˈaʊn.` for a test sentence, 96 tokens, 6.05 s of
audio, peak amplitude 0.44 — real speech, not silence, as a 290 KB PCM16 WAV.

**The host cannot run it in real time.**

| Measured | Value |
|---|---|
| CPU | Intel **Pentium Gold G5400T**, 2 cores / 4 threads @ 3.1 GHz |
| SIMD | **`sse4_2` only** — no AVX, no AVX2, no AVX-512, **no VNNI**, no F16C |
| Model load | 1.2 s (fine) |
| Phonemization | 0.8 s once, then cached (fine) |
| **Synthesis, steady state** | **~15.8 s for 6.05 s of audio — RTF ≈ 2.6** |
| Warmup | none; run 1 ≈ run 2 ≈ run 3 |
| 4 threads vs 1 | **slower** (18.1 s vs 15.8 s) — 2 physical cores, and memory-bound |

The cause is the SIMD floor, not the model. onnxruntime's INT8 kernels need AVX-512 VNNI for their fast path; below
AVX2 they fall back to generic code. The published 15.6 ms figure was measured on a CPU with VNNI, and this is a
different class of machine for this workload — a NAS part chosen for idle power, not vector throughput.

**What this invalidates.** Streaming synthesis cannot keep up: at RTF 2.6 a multi-paragraph reply falls further behind
with every sentence, so the audio would trail the text by minutes. Sentence-by-sentence streaming was the design's
answer to latency, and it does not survive this hardware.

**What survives.**

- **[GP-2](#gp-2--expose-tts-as-a-standard-server-api) becomes the primary path, not an add-on.** The obvious fix is
  to run inference where the CPU is capable and call it — which is exactly the HTTP API already specced. This
  inverts the priority of the two items.
- **The per-message button becomes the main interaction**, with auto-TTS demoted to an opt-in the user understands
  will lag. On demand, ~15 s per sentence is tolerable for a deliberate "read me that".
- **Ambient mode**, if wanted: synthesize in the background, play when ready, and *drop* rather than queue once
  behind — behaving like a radio, never pretending to be synchronised.
- **The pipeline is not wasted.** Weights, checksums, phonemization, tokenizer and WAV encoding are correct and
  host-independent; only the inference step needs a better CPU.

**The variants were then tested, and the answer is settled.** There was a real hypothesis worth checking: INT8 on a
CPU without VNNI is *emulated*, so plain fp32 might actually be faster.

| Variant | Size | RTF | Synthesis (96 tokens, 6.08 s audio) |
|---|---|---|---|
| **fp32** | 310 MB | **2.32** | 14.1 s |
| q8f16 | 82 MB | 2.98 | 17.5 s |
| q8 (the original pin) | 88 MB | 2.73 | 16.9 s |

The hypothesis holds — **fp32 is the fastest on this host**, by ~15% — but it does not come close to rescuing real
time. 14 seconds to produce 6 seconds of speech is still RTF 2.3.

**So the pin stays on q8.** The graph that is fastest *here* is not the graph that is fastest where this should
actually run: on a VNNI-capable CPU, INT8 is the fast path by a wide margin, and the 15% local gain is not worth
either the 4× download or giving up quantization where it matters. This is a host problem to route around, not a
model-choice problem to tune.

**Corrected 2026-10-03.** The sweep in [The six-type sweep](#the-six-type-sweep--2026-10-03) reversed this ordering
at a realistic passage length — fp32 2.92 against q8 2.80 — and found the whole spread between all six types to be
17%. The conclusion above survives, and is in fact strengthened: this is a host problem, not a model-choice problem.
The specific claim that fp32 is fastest *here* does not.

What remains untested is whether an AVX2-capable machine is reachable on the LAN — one `lscpu` on another box would
answer it, and it decides whether the fix is a config change or new hardware.

### The constraint that shapes the whole design

**Kokoro has no instruction input.** Its complete control surface is:

```js
tts.generate(text, { voice, speed })   // and nothing else
```

The model is conditioned on phonemes, a 256-dimension **voice style vector**, and a scalar speed. There is no
prompt, no natural-language direction, no emotion embedding. The "style" in its architecture name
(`style_text_to_speech_2`) *is* the voice file.

So an instructions field **cannot be passed to Kokoro**. It has to be *compiled* into the parameters Kokoro
actually accepts:

```
instructions ──► compiler ──► delivery spec ──► Kokoro
     text ──► tone classifier ──┘   {voice, speed, segmentation}
```

This is why the tone toggle is not a nice-to-have alongside the instructions field — **it is the only mechanism by
which the instructions field can do anything at all.** The user's two "extra" controls are actually one feature:
a compiler from intent to a delivery spec.

It also lands exactly on the decision-model work in Part II:

| Source | Question | Primitive |
|---|---|---|
| tone classifier | "which of these 7 tones is this passage?" | `choice` |
| tone classifier | "how intense is it? (0–4)" | `score` |
| instructions compiler | "given 'slow and ominous', which voice?" | `choice` over the voice list |
| instructions compiler | "how much slower than baseline?" | `score` |

The voice list is the delivery space, and it is small enough to be criteria: 54 voices, with quality grades that
matter enormously — `af_heart` is graded **A**, `af_bella` **A−**, `bf_emma` **B−**, and several are **D** or **F+**.
Defaulting to a good voice and letting the classifier choose only among the good ones is better than defaulting to
whatever is first in the list.

### Streaming is the latency answer

`kokoro-js` exposes a sentence-level stream:

```js
const stream = tts.stream(splitter)
for await (const { text, phonemes, audio } of stream) { /* play audio */ }
```

That matters more than raw speed. A DM reply is several paragraphs, and synthesizing it whole before playing a
sample means seconds of silence. Streaming sentence-by-sentence lets playback start as soon as the first clause is
voiced — and because the source text is itself being generated token by token, the two streams can overlap: speech
begins while the model is still writing. **This is the single most important property for the feature to feel
alive rather than laggy.**

### Segmentation — sentence and paragraph coalescing

Reply text arrives as `text-delta` chunks, so the unit handed to Kokoro is a **segment**: not a token, not the whole
reply. The rule:

- split on sentence boundaries;
- speak a sentence immediately once it is at least `MIN_CHARS`;
- hold a shorter one and **keep accumulating** until the buffer reaches `MIN_CHARS`;
- **flush unconditionally** at a paragraph boundary and at end of message;
- split anything over `MAX_CHARS` at a clause boundary before synthesizing.

> **One correction to the rule as first stated.** "Wait for the next sentence and send both together" is a single
> step, and two short sentences can still be under the threshold — `"Yes."` + `"No."` is eight characters. It has to
> be a **loop** that accumulates until the buffer is big enough, with paragraph-end and end-of-message as the escape
> hatches that stop a slow trickle from being held indefinitely.

| Knob | Why it exists |
|---|---|
| `MIN_CHARS` (~60) | a two-word segment sounds clipped and costs a full model call to produce |
| `MAX_CHARS` (~400) | one 2,000-character sentence means a long synthesis with no playback until it finishes |
| `FLUSH_MS` (~700) | a gap in generation — a tool call, a stall — must not hold a buffered fragment hostage |
| clause fallback | over-long sentences split at `,` `;` `—` `:` before any hard word split |

Traps worth writing down, because each becomes a bug report otherwise:

- **Scan the buffer, not the delta.** `\n\n` and `."` routinely straddle two chunks. Match against the accumulated
  string and consume only what is complete.
- **Abbreviations break naive splitting.** Fantasy prose is full of `Mr. Vance`, `Dr.`, `St.`, `etc.`, plus numbers
  like `3.5` and `1,200 gp`. Keep a small guard list and a decimal rule; a split on `Mr.` is audible.
- **Never speak `reasoning-delta`.** The stream carries reasoning alongside text. Filter to `text-delta`, and use
  `block-start`'s `blockType` to skip reasoning and tool blocks outright.
- **Filter before segmenting, not after.** Code fences, stat blocks, dice notation and table rows must be removed
  before the buffer is scanned, or a boundary lands inside a code block and it gets read aloud.
- **Emit in order, from a bounded queue.** Synthesis is slower than generation, so segments queue; a mute or stop
  must cancel the queue, not only the segment in flight.
- **The tail is the classic miss.** The last buffered fragment has no following sentence to merge with. End of
  message must flush it — and that is exactly the segment a naive implementation drops.

### The controls, concretely

| Control | Where | Kind |
|---|---|---|
| **Auto-TTS for this chat** | chat header or beside the composer | per-session, via a session projection |
| Profile default | settings pane | boolean setting, seeds new chats |
| Tone classification | settings pane | boolean setting; off means a fixed baseline voice+speed |
| Instructions | settings pane | free text; compiled per reply, or cached until changed |
| **Speak this message** | on every assistant message | one-shot action, independent of the toggles |

The chat-level toggle and the per-message button are **the same operation with different triggers** — "speak this
message" — so they share one implementation and differ only in what starts them.

Design notes:

- **The instructions field should be optional and cached.** Recompiling identical instructions every turn is waste;
  compile on change, and recompile when the tone of a passage diverges sharply from the compiled default.
- **Tone when the toggle is off is not "no delivery"** — it is a fixed baseline (one good voice, speed 1.0).
- **Never speak mechanical text.** Dice results, stat blocks, DCs, and markdown tables read terribly aloud. The
  text needs a filter that strips or summarizes mechanics before phonemization, and that filter is worth more to
  perceived quality than the model is.
- **Skip code blocks and paths entirely**, since the plugin is profile-global and will run against coding sessions
  too.

### Dependency strategy — the thing to get right

`kokoro-js` is the fast path, but its dependency tree is heavier than the feature deserves. `kokoro-js@1.2.1`
depends on `@huggingface/transformers` (resolving to 3.8.1), which brings:

| Dependency | Why it is there | Needed here? |
|---|---|---|
| `onnxruntime-node` | runs the model | **yes** |
| `phonemizer` | espeak-ng phonemization, **WASM, 2.6 MB, zero deps** | **yes** |
| `sharp` ^0.34 | image processing | **no** — a second native module for an audio feature |
| `onnxruntime-web` (prerelease) | browser runtime | **no** |
| `@huggingface/jinja` | chat templates | **no** |

Kokoro is simple enough to drive directly. The graph takes three inputs and the rest is a small amount of code:

```
input_ids  int64   [1, N]
style      float32 [1, 256]
speed      float32 [1]
   → waveform → RawAudio(data, 24000 Hz)
```

and the voice file is a plain float32 array indexed by token count (`offset = clamp(tokens − 2, 0, 509) × 256`).
Porting phonemization is the only real work — ~200 lines, mostly text normalization (numbers, currency,
abbreviations), all of which is readable upstream.

**Recommended order: prove it with `kokoro-js`, then replace it.** The audio-delivery path is the unknown and the
dependency surface is the known; de-risking the unknown first is right, and swapping the model driver afterwards is
a contained change behind the same interface. If the `sharp` dependency turns out to be unacceptable at install
time, the direct driver becomes the plan rather than an optimization.

### Provisioning — take the mechanics, own the vocabulary

The harness already ships a local-ONNX plugin that downloads its own weights on demand, behind a **Prepare
button** — and it is installed and active in this profile right now:

```
@deepseek-ai/dsh-experimental-voice-input-bundle   (v0.1.7-rc.1)
  └── speech-to-text          core service + provider registry + persisted selection
  └── speech-to-text-sensevoice   local SenseVoice ONNX, managed sherpa-onnx worker
  └── api-speech-to-text      the Host↔Client Remote
  └── client-ui-voice-input   the browser UI: mic button, and the preparation card
```

Source: `packages/experimental/*` in the DSH checkout. Its **mechanics** are worth taking; its **conventions** are
not — see the note at the end of this section. Adopting the mechanics answers every integration question this spec
previously left open.

#### The composition is twelve lines

```yaml
- insert:
    - id: tts
      name: '@local/dsh-text-to-speech'
      config:
        defaultProvider: kokoro-local
    - id: tts-kokoro
      name: '@local/dsh-text-to-speech-kokoro'
      config:
        dataRoot: !!js dshHomePath('tts', 'kokoro')
    - id: api-tts
      name: '@local/dsh-api-tts'
    - id: ui-tts
      name: '@local/dsh-client-ui-tts'
```

Four packages, same layering as speech: service → provider → remote → UI. Note `dataRoot: !!js
dshHomePath('tts', 'kokoro')` — `dshHomePath` is a Loader global, and this is the **model-cache convention**.
SenseVoice resolves to `$DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx/`, so Kokoro lands at
`$DSH_HOME/tts/kokoro/models/…` with no bespoke cache logic.

#### The preparation shape worth stealing

`@deepseek-ai/dsh-experimental-speech-to-text/types` solves the problem GP-1 has. It is named for speech but is
really a general "download a model, show progress, let the user retry" interface, and it has already thought about
the cases a first draft forgets:

| Piece | Shape |
|---|---|
| `prepare(options?)` / `cancel()` / `snapshot()` / `subscribe()` | the four controls the UI needs |
| Phases | `unprepared · checking · downloading · loading · waking · ready · standby · failed · cancelled · cancelling` |
| Steps | `check · model · vad · verify · load` — rendered as a staggered list with state dots |
| Progress | `{ phase: 'downloading', resource, completedBytes, totalBytes? }` — real bytes, not a fake percentage |
| Failures | `reason: network · dns · timeout · certificate · http · integrity · storage · unknown`, each with localized **advice** |
| `setupEstimate` | `recommendedDiskBytes · expectedMemoryBytes · minimumMinutes · maximumMinutes` shown *before* the download |

For Kokoro the estimate is trivial to fill honestly: **89 MB disk, ~0.4 GB memory, under a minute** — which is a
much better first-run pitch than SenseVoice's.

The implementation is worth copying almost line for line (`speech-to-text-sensevoice/src/runtime.ts`):

- a **`runtime/assets.json` lock committed in the package**, one entry per precision, each `{ name, url, sha256, bytes }` — the pin lives in code, not in config
- download to `<destination>.<uuid>.part`, **hash while streaming**, verify size *and* sha256, then publish with an atomic `rename`
- abort immediately on a byte-count overrun — that is the integrity signal, not a post-hoc check
- `mkdir(root, { recursive: true })` and `mode: 0o600` on the partial file
- **multi-origin fallback**: HEAD-probe the configured origins (Hugging Face, `hf-mirror.com`, …), prefer the first that answers, and fall through on failure
- a `modelDirectory` override that skips the download entirely, for a host with pre-staged weights
- an explicit platform allowlist

For Kokoro the pinned set is three files: the chosen graph (`model_quantized.onnx`, 88 MB) plus the tokenizer and
config, all resolved at a fixed Hugging Face revision — and then one ~0.5 MB voice file per voice actually used.

#### Where the toggles and the field live

Both answers, from `client-ui-voice-input/src/client/mount.ts`:

```ts
export const inject = ['remote', 'slots', 'locale']

ctx.slots.inject('plugins.bundle.config',     () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE, locale: NS, inject: () => actions }, SettingsComponent))
ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: BUNDLE, locale: NS, inject: () => actions }, SetupPrompt))
ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({ name: 'conversation.input.activity', locale: NS, inject: () => actions }, ComposerControl))
```

So: the **two toggles and the instructions field** are a component registered at `plugins.bundle.config` (which is
also where the preparation card goes — it is the plugin's settings pane), and a mute/speak control belongs at
`conversation.input.activity` beside the composer.

Persistence is the `settings` service. A plugin declares its settings as **`Volatile` Config fields** and writes
them back through the profile:

```ts
static Config = z.object({
  defaultProvider: z.string().min(1).required().volatile(),
  enabled:        z.boolean().default(false).volatile(),
  toneEnabled:    z.boolean().default(false).volatile(),
  instructions:   z.string().default('').volatile(),
})

async configure(patch) {
  const settings = this.ctx.get('settings')
  await settings.update(entry, patch)     // writes into this plugin's profile entry
}
```

`VoicePreparation` in the existing UI is exactly this shape — provider and language selects that read from the
readiness snapshot and call `configure()`. **The settings-pane controls are more fields of the same kind**, not a new
mechanism.

Note the limit, though: `settings.update()` writes to the plugin's **profile entry**, which is profile-global. The
per-chat toggle is therefore not a profile setting — it lives in a session projection, and the profile entry holds
only the default it inherits from. See [The per-chat preference is a session
projection](#the-per-chat-preference-is-a-session-projection).

#### Who decides what to speak

"Active, open session only" is knowledge the **client** has and the host does not. That single fact settles the
architecture: **the client decides what to speak; the host only synthesizes.**

It also makes automatic mode and the per-message button the same feature — both are "speak this message", one
triggered by a button and one by a new assistant message arriving. And because the client is already rendering the
stream, the deltas are in hand, so segmentation happens where the text already is.

Host-side `agent/assistant-stream` still earns its place for what a client cannot serve: a headless consumer, an
external API caller, a profile with no browser attached. Keep it as the whole-message path.

**Share the segmenter.** Segmentation is a pure function over a text stream, so it belongs in one module used by both
drivers rather than written twice and drifting.

This compounds with [GP-2](#gp-2--expose-tts-as-a-standard-server-api): if the client fetches `/v1/audio/speech`
per segment, then automatic TTS, the per-message button, and every external client become one implementation with
three triggers.

#### Audio to the browser

Binary already crosses the Remote as **base64**, and the STT client does exactly that in the other direction
(`audioBase64()` in `client-ui-voice-input/src/client/audio.ts`). So a synthesized WAV can return the same way with
no new surface and no attachment service.

The honest caveat: base64 inflates by ~33%, so a 3 MB reply WAV becomes 4 MB of JSON over the Remote. Sentence-level
streaming is what makes that tolerable — chunks are tens of KB each, and playback starts on the first one.

**[GP-2](#gp-2--expose-tts-as-a-standard-server-api) proposes a better answer**: register an HTTP route and have the
browser fetch it like any other client, which removes the inflation and leaves one code path instead of two. Decide
this in phase 3 rather than after — it changes where synthesis results are produced.

### Phases

| Phase | Work | Risk |
|---|---|---|
| **1** ✅ | Host synthesis: pinned assets, verified fetch, WAV from a fixture. **Done and measured** — `{assets,download,kokoro}.js` in `$TTS` | done |
| **2a** ✅ | Bundle manifest and the host half: `plugin.js` with the preparation state machine, `package.json`, `cordis.patch.yml`. **Verified against a stub `ctx`, then installed live** — the Host now composes an `include:tts` row | done |
| **2b** | The client bundle: closure factory, Prepare card and settings pane registered | **built; message button and playback remain** |
| **4a** ⛔ | ~~The per-chat preference as a session projection~~ — **reverted**, it corrupted two session logs
([incident](#the-session-projection-route-poisoned-the-log)). Rebuilt as plugin-owned storage behind the same
service surface | redone |
| **5a** ✅ | The instruction compiler: intent and text to `{voice, speed}`, with refusals. **Done and verified** — 9/9 checks | done |
| **5b** ✅ | An ONNX tone classifier behind `readTextPace`'s interface, degrading to the heuristic. **Done and verified end to end** | done |
| **4b** ✅ *(host half)* | The config schema, so settings can persist. **Validated against the real schemastery offline** | client half pending |
| **3** | TTS Remote and browser playback of a real reply | medium — base64 volume and playback lifecycle |
| **4** | The two toggles and the instructions field as volatile settings | low — same shape as the provider selects |
| **5** | Tone classifier and instruction compiler | medium — depends on Part II's substrate |
| **6** | Direct `onnxruntime-node` driver, dropping `sharp` and the web runtime | low, and only worth doing once 1–5 work |

Phases 1–4 deliver the feature the user asked for. 5 is what makes the instructions field real. 6 is cleanup.

**Phase 2 dropped from "highest risk" to "copy a working pattern"** once the SenseVoice bundle was found. The
remaining genuine unknowns are now only phase 3's details and one open question below.

### Two provisioning gotchas, both found by installing

**A `link:`ed bundle does not get its own dependencies installed.** The profile's pnpm added `@local/dsh-tts` to
`dependencies` and `bundles` and symlinked it, then reported "Already up to date" — leaving `onnxruntime-node` and
`phonemizer` absent. The `dd35` preset never hit this because it declares no dependencies at all, only host-provided
peers. A self-authored bundle has to be self-contained: `pnpm install` **inside the bundle directory**, with its own
`pnpm-workspace.yaml` and a `node_modules/` that is gitignored. Worth knowing before debugging a module-not-found at
first synthesis.

**The native build script turned out not to be needed.** pnpm 11 ignores `onnxruntime-node`'s postinstall by default
and no longer reads `pnpm.onlyBuiltDependencies` from `package.json` (the setting moved to `pnpm-workspace.yaml`), so
the earlier assumption was that installation would need `approvedBuilds`. Empirically it did not: after install the
platform bindings are present under `bin/napi-v3/linux/{arm64,x64}`, and both `onnxruntime-node` and `phonemizer`
import successfully from the bundle. Whatever supplies those binaries, it is not the postinstall — so the install is
cheaper and less privileged than assumed.

**On verifying activation.** The Host composes an `include:tts` row pointing at the plugin module, which is the patch
dialect and module resolution working. Its Config `status` reads `absent`, which means *no Config schema declared*
rather than *not loaded* — `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-agent` are certainly live and read the
same, while rows that declare a schema read `schema`. Positively confirming that `apply()` ran needs the GUI's plugin
list or the Host log, neither of which is reachable from inside a session; that check is owed.

### An offline suite, and why one module had to move

`node $TTS/check.js` runs the pure suite in well under a second — tokenizer, voice-row indexing, WAV encoding,
the delivery compiler, and the session projection — with **no network and no model**. That is deliberate: the parts
needing the 92 MB graph or a download are exercised separately, because a suite that needs the internet is a suite
that stops being run.

Writing it produced a finding worth keeping. **`@deepseek-ai/*` bare specifiers resolve under the Host's plugin
loader but not under plain `node`.** `plugin.js` imports `@deepseek-ai/dsh-tools`, which the Host resolves for
`file://` plugins — the `dd35` preset does exactly this and demonstrably works — but which `node` cannot resolve from
this directory. So any module importing one is untestable offline.

Two consequences:

- **The projection moved to `preference.js`**, which imports nothing from `@deepseek-ai`. That is better structure
  anyway: a projection definition is not a Cordis-plugin concern, and it now has no dependency on the plugin loader.
- **Do not "fix" this by stubbing `@deepseek-ai/dsh-tools` into `$TTS/node_modules`.** Node resolves a symlinked
  bundle from its real path, so a stub there would shadow the Host's real package and break the live plugin. The
  offline suite works around the resolution problem by testing the modules that have no such import, not by lying to
  the resolver.

### Verified end to end, and a hole in the suite that let a bug through

The compiler was wired into `synthesize()` in phase 5a but never confirmed to change the **audio** until now. Running
the real path — plugin, compiler, phonemizer, ONNX graph, WAV — gives:

| Instructions | Voice | Speed | Audio | |
|---|---|---|---|---|
| *(none)* | af_heart | 1.00 | 5.30 s | baseline |
| "very slow and ominous" | af_heart | **0.80** | **6.33 s** | same voice, so this isolates `speed`: +19% |
| "urgent" | **af_nicole** | 1.18 | 6.92 s | the mood moved the voice within the family |
| "a british man" | **bm_fable** | 1.00 | 5.42 s | family selection reached the model |
| "whisper this" | af_heart | 1.00 | 5.30 s | refused, and honestly unchanged |

Note that duration is not a clean speed proxy across rows: a mood changes *both* the voice and the speed, and a
voice's style vector carries its own pacing. The `very slow` row is the one that isolates the speed parameter
because its voice is unchanged.

**The refactor that made this possible also hid a bug.** Extracting the projection into `preference.js` moved it out
from *above* `ASSETS`, `setupEstimate` and `listVoices`, and removing the block from its start to the end marker
deleted those three as well. `check.js` reported 48 passes on the broken file, because it no longer imports
`plugin.js` at all — the suite had quietly stopped covering the one module everything else hangs off.

Why it cannot simply be fixed in the suite: `plugin.js` imports `@deepseek-ai/dsh-tools`, which does not resolve
under plain `node`, and a stub cannot be placed at `$TTS/node_modules` without risking the live plugin — Node
resolves a symlinked bundle from its real path, so that stub would shadow the Host's real package.

**So the guard uses a loader hook instead, and there are two suites now:**

| Command | Covers | Cost |
|---|---|---|
| `node $TTS/check.js` | the pure modules — tokenizer, style indexing, WAV, the compiler, the projection | 48 checks, no network, no model, under a second |
| `node $TTS/smoke.mjs` | module load and `apply()` — the layer the other suite cannot reach | 16 checks, no network, no model |

`smoke.mjs` registers a **resolution hook** that maps `@deepseek-ai/dsh-tools` to a four-line stub, which avoids
`node_modules` entirely so nothing the Host resolves can be affected. It was verified the honest way: removing the
`listVoices` export makes it exit non-zero with a link error, and restoring it passes. A guard that has not been
seen to fail is not yet a guard.

### Editing a mounted bundle needs a restart

Worth knowing before debugging a plugin that seems not to have changed. The HMR module watcher **skips any module
whose URL contains `/node_modules/`**, and with no `roots` configured it watches only the profile patch and manifest.
A bundle mounted through the profile's `node_modules` is therefore not hot-reloaded: an edit to `plugin.js` takes
effect on the next `dsh web` restart, not on save.

That is how the current live state should be read: the bundle is installed and its row composes, but the running
instance predates the session-projection and status-tool additions, so those are committed and unit-verified rather
than live.

### The client half needs the monorepo build — a real constraint

The host half is a plain `.js` file in this workspace, which is why phase 1 and 2a could be built and verified without
touching the DSH checkout. **The client half cannot be done that way.**

A client plugin declares itself with a `dsh.client` block in `package.json` that names its `inject` list, and must
export a `./client` bundle — the loader rejects a package that declares `dsh.client` without one. Every client plugin
in the checkout is TypeScript/TSX built to `lib/client.js` by `tsdown`; **none ships as plain JavaScript**, and there
is no shared-externals or import map that would hand a hand-written bundle React and the `@deepseek-ai/dsh-client-ui-*`
primitives it needs.

**What a client bundle actually is — corrected.** This section previously concluded the format "is not one to
hand-write". Reading further shows that is wrong, and the error was in what the format needs:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-tts-client',        // must match the graph row: the package name
  factory: (require) => {             // runs once, at materialization
    const React = require('react')    // resolved from the shell's module table
    return { apply, inject }
  },
})
```

The decisive fact is that **React is in the shell's shared module table**:

```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
] as const
```

So a client bundle does **not** carry React, and does not need a bundler to provide it — it receives `require` into
the module table and pulls React from there. A plain `.js` file that self-registers is a legitimate client bundle.
Bundles load as a classic `<script src>`, registration is by package name, and the factory returns the bundle's
exports.

**Consequence: the client half does not require editing the DSH checkout at all.** The seven-step procedure below is
what the *TypeScript* path needs; it is not mandatory. The alternative — hand-written `React.createElement`, no JSX,
no CSS modules — keeps the bundle inside this workspace, which was the whole objection.

**But there is a prerequisite this surfaced, and it is not optional.** The client has no channel to the Host. The
speech plugin pairs a client UI with a **typert Remote** package (`api-speech-to-text`), and GP-1 has no equivalent —
so a client could render a Prepare card but could not ask the host to prepare anything, or fetch audio.

Two ways to close that, and the second is already specced:

1. Build a typert Remote for TTS, mirroring `api-speech-to-text` — a host half, a generated client face, and a
   package to hold both.
2. **Use an HTTP route** — which is exactly [GP-2](#gp-2--expose-tts-as-a-standard-server-api).

GP-2 was written as a nice-to-have for third-party clients. It is in fact on the critical path for this feature's own
UI, because a route is far less machinery than a Remote and is already designed. **That reorders the work: GP-2 before
2b/3/4c.**

> **Built.** The route now exists in `route.js`, registered as a prefix route on the `webServer` service. See the
> [GP-2 section](#built-and-verified) for what it serves and the 31 offline checks covering it.

**And here is what building one actually takes**, which is less than the three-option framing implied:

| Step | Detail |
|---|---|
| 1 | Create `packages/<group>/<name>/` — the workspace glob is `packages/*/*`, so it joins automatically |
| 2 | `package.json` with `main`, an `exports["./client"]` entry, and a `dsh.client` block naming `inject` and `external` |
| 3 | `src/index.ts` (the host marker) and `src/client/` (the actual UI, React/TSX) |
| 4 | `tsdown.config.ts`, one line: `export default clientBundle('<package-name>', ['lib/types/index.js'])` |
| 5 | **Add the package path to `tsconfig.client.json`'s `references` list** — 80 explicit entries, not a glob |
| 6 | `pnpm --filter <package> bundle` (the per-package `bundle` script is just `tsdown`), or the repo-wide `pnpm run build:lib:client` |
| 7 | Install the bundle into the profile, as with the host half |

So the realistic choice is **not** three options — it is one: a package inside the DSH checkout, built by the
pipeline that already exists. The only real decision is whether that is acceptable, and the honest framing is that
the *host* contract is ours for free while the *client* contract is imposed by the shell no matter what.

**A consequence worth flagging before committing to it:** the running harness executes from this checkout
(`WorkingDirectory=/export/DownloadsSSD/AI/TEXT/deepseek-harness`), so adding a package there means editing the tree
that is serving this session, and a broken client build can affect the Web GUI rather than just the TTS feature.

### Decisions taken

- **Reply text comes from `agent/assistant-stream`** — `text-delta` chunks — with the completed message as the
  fallback. Frames are transient (the loop appends one final `assistant/message` carrying the same stream), so a
  client that joined late uses the durable path.
- **Scope is the active, open session only.** A profile-global listener sees every agent's stream, so this is an
  explicit filter rather than a default. Subagents and background sessions are never spoken.
- **We are not following the `dsh-experimental-*` conventions.** These plugins are for this profile, not for
  upstream: the contract, naming and packaging are ours. That also retires the version risk of depending on an
  `rc` package's types. The mechanics in the previous section are still worth copying, because they are hard-won.
- ~~**The per-chat preference is a session projection**~~ — **reverted**, see the
  [incident](#the-session-projection-route-poisoned-the-log). The profile setting is still the default a chat
  inherits; the per-chat override is now a plugin-owned file, because a custom session event cannot be written
  safely at all.
- **The chat toggle is gated on model readiness.** See below.

### The per-chat preference is a session projection

> **⛔ Superseded — and this is what broke session loading.** Read
> [The session-projection route poisoned the log](#the-session-projection-route-poisoned-the-log) first. The
> analysis below is kept because it is *why* the design looked right, and because the same reasoning will
> resurface for any per-session plugin state.

The toggle is per conversation — *this chat has a voice* — and a conversation nobody has toggled yet needs a value,
which is the profile default. So the model is **profile default + per-session override**, not one or the other, and
the profile setting is not a duplicate of the toggle: it is the seed.

The DSH-native home is `ctx.sessionProjections`, the service `time-context`, `tmux-context`, `agent-instructions`
and `session-reference` all fold their per-session state with. The contract:

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { ttsPreference: { auto: boolean | null } }  // null = inherit
  interface SessionProjectionMap      { ttsPreference: { auto: boolean | null } }  // client-visible
}

ctx.sessionProjections.register({
  key: 'ttsPreference',
  stateVersion: 1,
  stateSchema: z.object({ auto: z.boolean().nullable() }),
  init: () => ({ auto: null }),                        // a new chat inherits the profile default
  apply: (state, event) =>
    event.type === 'tts/preference' ? { auto: event.data.auto } : state,   // same reference = zero work
  wire: { viewSchema: schema, view: (state) => state },   // how the chat toggle reads it
})
```

Four constraints the contract imposes, each with a consequence worth knowing before writing the code:

| Constraint | Consequence |
|---|---|
| `apply` is a **pure synchronous fold over committed session events** | the choice has to be recorded as a session event — a custom `'tts/preference'` added to `SessionEventMap` |
| Returning the **same state reference** produces zero downstream work | an uninterested event must `return state`, never a copy |
| `state` must be **plain JSON** | it is the precondition for the persisted projection cache |
| `stateVersion` invalidates persisted rows | bump it whenever the fold's meaning changes, or cached rows from the old unit fold forward into nonsense |

Record it as a **non-surface** event, like `turn/start`, so `session.append('tts/preference', { auto })` needs no
surface metadata.

What this buys: the preference is **durable and replayable**. It survives host restart and session resume, a forked
or resumed conversation carries its own setting, and the client renders it through the `wire` view with no bespoke
plumbing.

**The cost, stated plainly: a UI preference becomes part of the durable conversation log** — one small event per
toggle change. That is the price of the projection route, and it is worth paying for resume and client visibility,
but it is a real choice rather than a free one.

And a clarification, since "not client-side" could read as contradicting the `wire` view: the client does not
**own** the state. `wire` is a read-only projection of host state, which is exactly how the chat toggle gets to
display it. The client reads; the host holds.

#### Built and verified

> **The 15 checks passed and the bug shipped anyway.** Two of them — *"`setChatAuto` appends a durable event"* —
> asserted the exact behaviour that made the log unreadable. A green suite over the wrong invariant is worse than
> no suite, because it is evidence. The suites now assert the read path's assumption instead: that the session is
> never written to.

The projection is implemented in `plugin.js` and covered by 15 checks against a stub registry:

| Behaviour | Why it matters |
|---|---|
| `init` returns `{ auto: null }` | tri-valued, so "inherit" is distinct from "off" |
| a foreign event returns the **same state reference** | the registry compares by `Object.is`; an unchanged reference is what produces zero downstream work |
| a no-op change returns the same reference | toggling to the value it already had must not publish |
| `apply` folds only `'tts/preference'` | one event type, one meaning |
| the schema rejects a non-boolean `auto` | and accepts `null` |
| `setChatAuto` appends a durable event | so the choice survives resume and reaches the client through the wire view |
| `null` restores inheritance | overriding is reversible |

**No schema library was needed.** The registry's erased runtime type for `stateSchema` is structural —
`{ parse(value): unknown }` — and it is only called when seeding from the persisted projection cache, so a
three-field object does not justify a zod dependency.

Whether the custom event is *legal* was checked rather than assumed: `Session.append` runs a validator that only
inspects known surface types and `request/header`, so an unrecognised `'tts/preference'` payload passes, subject to
the ordinary JSON-serializability rule.

**Still owed on this half:** the settings-pane controls need a `Config` schema (schemastery) so the values can be
persisted through `settings.update()` into the plugin's profile entry. That is deliberately not done yet — the plugin
is live and a schema mistake would fail the row and could stop sessions composing, which is not worth risking for a
UI that does not exist.

### Phase 5a — the instruction compiler

This is the half of phase 5 that needs no model, and it is the half that makes the instructions field work at all.
`delivery.js` compiles standing direction plus the passage itself into the only two controls Kokoro has.

**What it maps.** Voice family from accent and gender words, longest match first; pace from explicit pace words;
mood from a vocabulary of eight; and, when tone is on and no pace was stated, a pace read out of the text itself —
exclamation marks, shouted capitals, ellipses, and sentence length, returning the cues it used so the choice is
explainable rather than mysterious. The family is then resolved against the voices actually installed, and a mood
picks a *position* in the family rather than a fixed name, because the model's own quality grades run from A to F+
and starting from a graded list is worth more than any tuning.

**What it refuses.** A deliberate list of asks Kokoro cannot honour — volume, whisper, per-word emphasis, inserted
pauses, accents beyond the published voices, non-speech sounds — each with the specific reason. The spec is explicit
that the compiler must say so rather than pretend, and an 82M style-vector model given "a hint of rain" is exactly
the case that requirement was written for.

**One hole the tests found and closed.** Mixed instructions like *"melancholy, with a hint of rain"* are accepted
because `melancholy` is recognised while the rest is invisible — inherent to a keyword compiler. But instructions
that produced *nothing* were previously accepted in silence too, so *"make it sound better"* now returns an explicit
`unhonoured` with the reason. The residual limit is documented rather than papered over.

**A bug the first test run caught:** *"a british woman"* selected `af_heart`, an American voice, because the hint
table tested the generic word `woman` before the compound `british woman`. Family selection now takes the most
specific match rather than the first, which is verified for `british woman → bf_emma`, `british man → bm_fable`,
`american man → am_fenrir`, bare `woman → af_heart`, and bare `british → bf_emma`.

**What is left of phase 5** is the classifier proper — an ONNX model behind `readTextPace`'s interface, which is the
reason the heuristic is a separate exported function rather than inlined. It is the one part of phase 5 that needs a
model decision, and it is optional: the compiler works without it.

### Phase 5b — the tone classifier, and a correction

Filed as "needs a model choice" and, before that, assumed unaffordable on this CPU. Both were wrong: the choice was
makeable with evidence, and the cost assumption did not survive a measurement.

**The measurement that corrected me.** Nobody benchmarked the classifier, because I had assumed a second model on a
CPU with no AVX would be ruinous. It is not:

| Model | Work | Measured |
|---|---|---|
| Kokoro | 6 s of audio | **~15,800 ms** |
| Emotion classifier | 32 tokens | ~96 ms |
| Emotion classifier | 64 tokens | ~190 ms |
| Emotion classifier | 128 tokens | ~400 ms |

**~3 ms per token, or roughly 2% of the synthesis it accompanies.** The host is slow at *audio generation*, not at
transformer inference — the vocoder producing 145,200 samples is the expensive part, not the encoder. A blanket "this
machine cannot afford another model" was the wrong generalisation, and only measuring showed it.

**The choice.** `j-hartmann/emotion-english-distilroberta-base` exported to ONNX (82.5 MB, quantized, public and
ungated), because its seven classes are *arousal* labels — anger and fear fast, sadness slow. A binary sentiment
model would have been the wrong instrument: "I am furious" and "I am delighted" share a valence and are opposite in
pace. Verified on known affect: *"She laughed, delighted…"* → joy 0.84; *"What was that sound?"* → surprise 0.74;
*"Get out of my sight before I have you flogged."* → anger 0.39 with fear 0.16.

**The tokenizer, which was the real cost.** RoBERTa is byte-level BPE, and hand-writing merges was the expensive part
of this phase. It turned out to be unnecessary: `@huggingface/tokenizers` is **zero dependencies and 361 KB**, and
constructs directly from the Hub's `tokenizer.json` — so `transformers.js` and its `sharp` dependency stay out of the
bundle entirely.

**Integration is deliberately soft.** The classifier is opt-in, fetched lazily on first tone-classified synthesis
rather than during prepare, and **degrades to the heuristic on any failure** — a missing second model must never stop
speech. `setupEstimate` reports the optional bytes separately so a Prepare card can show them as optional. The
classifier reading is passed into the pure compiler as `textPace`, which keeps `compileDelivery` synchronous and
offline-testable while the model plumbing stays outside it.

`toneToPace` takes the probability-weighted mean rather than the argmax: a 0.4/0.35 split between anger and sadness is
genuinely mixed, and picking one would discard that. Confidence is reported so a caller can ignore a shrug.

### Phase 4b — the config schema, and the trap it was written to catch

The host half of the settings work: a `Config` schema so the Loader validates the patch and the settings service can
persist the user-settable fields. Declared in `config.js`, which imports only schemastery, so it can be checked
offline against the **real library** before it is ever handed to the Loader.

**Why it is validated rather than assumed.** The Loader validates a row's `config` against this schema at mount, and a
schema that rejects the shipped patch takes the plugin down. So the schema was run against the real schemastery and
seven config shapes:

| Input | Result |
|---|---|
| the shipped patch config | **accepted** |
| an empty config | accepted, defaults applied |
| a missing `dataRoot` | accepted |
| an unknown extra key | **passed through** — the object is not strict, so a patch typo is not caught |
| `speed: 99` | rejected — `$.speed expected number <= 2 but got 99` |
| `voice: 5` | rejected — `$.voice expected string but got 5` |
| `autoEnabled: 'yes'` | rejected — `$.autoEnabled expected boolean but got yes` |

Volatility was checked the same way: exactly the five intended keys report as volatile, and `dataRoot` — deployment
configuration rather than a user preference — does not.

**The trap, found before it shipped.** A field declared `.volatile()` does **not** arrive as a plain value. It arrives
as an accessor object, because the settings service may replace it at runtime:

```js
Config({ dataRoot: '/x', voice: 'af_bella' })
// → { dataRoot: '/x', voice: <accessor>, ... }   and voice.get() === 'af_bella'
```

The plugin was reading `config.voice` directly and passing the result to the synthesizer — which would have handed a
`Volatile` object where a voice name belongs, and failed at the first syllable. A `setting()` helper now unwraps an
accessor when present and passes plain values through, so the plugin works both under the Loader and when constructed
directly by the offline suite. That dual behaviour is itself checked: the smoke test applies the plugin with
accessor-shaped config and with plain values.

Volatile fields are also now read **per use** rather than captured at mount. A value snapshotted at mount would never
see a settings change, which is the entire point of declaring it volatile.

**How it was validated offline**, given that `@deepseek-ai/schemastery` does not resolve from the bundle: a
**resolution hook** maps that one specifier to the real `vendor/schemastery/lib/index.mjs` in the checkout. The
shipped smoke harness uses a *different* hook with an inert stub, because the suite checks wiring rather than
semantics. Neither touches `node_modules`, so nothing the Host resolves is shadowed.

### Readiness gating

The chat toggle is **disabled until a model is prepared**, reading the preparation state GP-1 already tracks, with
the Prepare card offered in place of a toggle that cannot work. First use should be an invitation to download, not a
trap that fails into an error. The per-message button behaves the same way.

The message-level button stays independent of the chat toggle — it speaks one message on demand whether or not
automatic mode is on, which is what makes it useful for a reply the user did not expect to want read aloud.

### Open questions

None open. Everything above is decided; what remains is implementation.

### Built and verified

`route.js` implements the surface as **two layers on purpose**: `routeRequest` is a pure dispatcher taking a
normalised request and returning a normalised response, and `createRouteHandler` is the thin adapter that reads a
`node:http` request and writes the result. The dispatcher holds every branch worth testing and imports nothing from
the harness, so **auth, method, path, size and format are all covered offline** — 31 checks, no server, no model.

| Endpoint | |
|---|---|
| `GET {prefix}/health` | liveness, deliberately reachable without a credential, revealing only that the plugin loaded |
| `GET {prefix}/voices` | the installed voices and the default |
| `GET {prefix}/status` | preparation state, for a Prepare card to poll |
| `POST {prefix}/prepare` | starts preparation and returns **202 immediately**, rather than holding a request open for a 92 MB download |
| `POST {prefix}/cancel` | cancels it |
| `POST {prefix}/speech` | `{ input, voice?, speed?, response_format? }` to `audio/wav` or raw `audio/L16` |
| `GET`/`POST {prefix}/preference` | the per-chat auto-speak override, by `sessionId` |

**The API is a setting, so it registers once and gates per request.** A mounted route cannot be re-registered live, so
`apiEnabled` is read per request and a disabled API answers **503 rather than 404** — the operator can toggle it
without a restart. The option object is built from getters for the same reason, so a rotated token takes effect too.

**Security is why this needed its own item, and the defaults follow from it.** The deployment binds `0.0.0.0:3080`
and plugin routes inherit none of the harness's own authentication, so: a token is required, anonymous access must be
asked for explicitly, comparison is constant-time and length-checked, a non-`Bearer` scheme is rejected, an empty
configured token never authorises, and input is bounded **before** any work. Errors carry a message and never a stack
trace.

**One consequence that was not obvious:** a prefix route means the dispatcher owns every sub-path, so an unknown one
answers 404 itself instead of falling through to the SPA's `index.html` — which would have returned an HTML page with
status 200 to a client expecting audio.

**Not yet verified live**, like everything else in the bundle: HMR does not watch `node_modules`, so the route appears
on the next `dsh web` restart.

### Phase 2b — the browser half, built without a bundler

`client.js` is a plain script that self-registers:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-tts',          // must equal the package name — the loader's key
  factory: (require) => {
    const React = require('react')   // from the shell's module table, not bundled
    return { inject: ['slots'], apply(ctx) { … }, __components: { … } }
  },
})
```

and `package.json` gains `exports["./client"]` plus a `dsh.client` block naming `platform`, `inject` and `external`.
No build step, no package in the DSH checkout, no `sharp`. What is given up is JSX, TSX and CSS modules — components
use `React.createElement` and inline styles.

It registers one slot so far: `plugins.bundle.config`, keyed by this bundle, rendering a Prepare card (estimate before
download, phase, byte progress, step list, Prepare and Cancel) and the settings controls (voice, tone pass, delivery
instructions). It talks to the host over the HTTP route rather than a typert Remote, which is why it injects only
`slots`.

**The credential.** The route authenticates itself, because plugin routes inherit none of the harness's own
authentication — so the browser half needs the token, and the page is only ever served to an already-authenticated
browser. The host bridges that with `webServer.tapIndex`, injecting
`window.__DSH_TTS__ = { prefix, token }` into the document. A rotated token needs a page refresh; that is the trade for
not inventing a second authentication story. The tap is guarded, so a webserver without `tapIndex` warns instead of
taking the plugin down.

**Verified offline, with no browser.** `node check-client.mjs` evaluates the script in a VM context with a stubbed
`__ModuleLoader__`, then exercises the contract — 24 checks:

| Checked | Why it matters |
|---|---|
| registers once, under the package name | the loader keys every bundle by the graph row it executes, so a mismatched `id` is a silent no-load |
| registers a factory, and no chunk | it is the package entry, not a lazy chunk |
| the factory returns `apply` and `inject` | the client plugin contract |
| `inject` includes `slots` | without it the component has nowhere to mount |
| **every `require` is declared in `dsh.client.external`** | keeps the manifest honest as the code changes; an undeclared require cannot resolve |
| `apply` registers `plugins.bundle.config` keyed by the bundle | the pane a Settings page renders |
| both components render an element | the top of the render path, without a renderer |
| `identity()` prefers the injected value | the route credential actually reaches the client |

**The per-chat toggle now has its write path.** `GET`/`POST {prefix}/preference` takes a `sessionId` and reads or
writes the session projection through the host, which is what keeps the client from owning that state:

- the write calls `setChatAuto`, which appends a durable session event, so the choice survives resume
- an unknown session id is a **404, not a 500** — "no such session" is a caller error and the two should not look alike
- `auto` must be `true`, `false`, or `null`, the last meaning *inherit the profile default*
- it authenticates like everything else on the route

#### Where the two remaining controls mount

Located, and the scopes matter:

| Slot | Kind | Scope | Owner props | Use |
|---|---|---|---|---|
| `conversation.chat.assistant-actions` | `list` | session | `{ messageId }` | the per-message speak button |
| `conversation.session.header.actions` | `list` | session | `ConversationHeaderActionOwnerProps` | the chat-level toggle |

**Both are `scope: 'session'`, so `inject(sessionId)` hands the component its session** — which is exactly what the
per-chat preference needs, and why the toggle does not have to guess or be told.

**`conversation.input.activity` was the obvious home and is the wrong one**: it is `kind: 'single'`, and the voice-input
plugin already occupies it. A second registration there would collide with the microphone button. The session header
is the better place for a chat-level control regardless.

A `list` slot takes an `id`, so a registration adds an entry rather than replacing one, and `order` positions it —
`ui-message-feedback` uses `id: 'feedback'`, `order: 10`, which is the pattern to follow.

#### Speaking a message by id

The action slot hands over a `messageId`, not the text. Rather than teach the client to read message content,
`POST {prefix}/speech` now accepts `{ sessionId, messageId }` as an alternative to `{ input }`, and the host resolves it
where the Session already is — which also works for a message the client never rendered.

That needed one contract decision: the resolver returns the text **possibly empty** when the message exists, and
`undefined` when it does not, so the route can answer **404 for "no such message" and 400 for "nothing to say"**. A
synthesiser handed an empty string returns an empty WAV and looks like it worked, so the two are worth separating.

**Corrections live slot inspection produced.** Two of them, and both would have shipped:

1. **`sessionId` is a `standardProp`**, passed to every component in a session-scoped slot. My registration was
   carrying `inject: (sessionId) => ({ sessionId })` to obtain something the slot already hands over.
2. **The documented registration surface is `{ id, order, label }` and nothing else.** The catalog lists exactly
   those three, so a registration carrying extra keys is undocumented and risks being ignored.
3. And `order`: the header slot already has occupants at `-30`, `-10` and **`20`** — my toggle was registering at 20
   too. It now uses 25.

`ConversationHeaderActionOwnerProps` is `{ children?: never }` — the header entries receive **no owner-specific
values**, which is why the toggle reads its state from the preference endpoint rather than any prop.

#### Playback

`play()` swaps a single slot rather than queueing: two overlapping voices are worse than losing the earlier one, and a
button press is an explicit request to hear *this* now. The object URL is revoked when the audio ends or is replaced,
so repeated presses do not accumulate blobs.

#### The adapter, finally exercised

`check.js` covers the pure dispatcher and the module smoke test only proves the route *registers*. Neither ran
`createRouteHandler` — the part that reads a real `node:http` request, parses its body and query string, and writes
bytes to a real response. That is a separate failure surface: a body read wrongly, a query string missed, or a Buffer
handed to `res.end` as an object would all pass the pure suite and break in service.

`check-http.mjs` therefore starts a **real server on loopback** and talks to it over the wire — 21 checks, including
that the audio is byte-identical to what synthesis returned, that malformed JSON is a 400 rather than a crash, and
that a synthesis throw is a 500 after which the server still answers.

#### On verification limits

The bundled guidance is explicit: with no browser control, verification is limited to syntax, manifest validation and
the live client slot, and emulating React or the DOM to compensate is not verification. So the framing matters:

| Established | Not established |
|---|---|
| the bundle registers, under the package name, with the slots the live tree confirms exist | **what the controls look like** |
| every `require` is declared in `dsh.client.external` | that they sit well beside the shipped ones |
| components do not throw at the top of the render path with their props | that pressing them speaks |
| the HTTP adapter works over a real socket | that the harness's own route serves them |

The VM suite stubs React and the DOM, so its component checks are structural, not visual, and are worded that way. **No
part of this bundle has run inside a real session** — the restart is still owed.

### The first live run, and the three bugs it found

Worth recording in full, because all three were invisible to 201 passing offline checks.

**1. The route was never registered.** `attachHttpRoute` asked for the service with `ctx.get('webServer')`, got
`undefined` because it did not exist yet at apply time, warned to a log nobody reads, and returned. Every request then
fell through to the SPA as a **404 with an empty body** — and the client UI mounted perfectly, because it does not
depend on the route. The scoped `ctx.inject(deps, cb)` form is how the rest of the harness waits for a service that
arrives later; `gateway` and `client/modules` both use it.

**2. `onnxruntime-node`'s namespace shape differs.** Under plain `node`, importing that CommonJS package yields a
namespace with the named exports *and* a synthesized `default`. **Under the harness's plugin loader the namespace
carries the named exports but no usable `default`** — so `const { default: ort } = await import(...)` produced
`undefined`, and the failure surfaced far away as *"Cannot read properties of undefined (reading 'InferenceSession')"*
during prepare. `loading the model` had already succeeded; the error was in the very next line.

The lesson is about where the error pointed, not the fix: nothing about that message says "the loader resolves this
package differently than your test does", and my standalone probe showed `default` present and working.

**3. `af.bin` is not a voice.** The upstream `voices/` directory carries it alongside the real voices, and it is
**524288 bytes = 512 rows** where every actual voice is **522240 = 510 rows** — an aggregate, not a voice.
`listVoices()` was offering it, and selecting it would have indexed past the end of the style table. It is now filtered
by the one property that decides usability (the byte size implied by `STYLE_ROWS`), not by a hardcoded name, so the
list is 54.

**And a fourth finding, about the fix itself:** adding the `hmr` watch root did **not** take effect on reload. The
watcher reads its roots when it is constructed, so a config change to them does nothing until the next start. That is
why the corrected module still needs one restart even though the profile patch itself hot-reloads fine — the
`apiEnabled` and `apiToken` overrides did take effect immediately.

What the live run did establish: the route answers on `/v1/audio`; an unauthenticated request is **401**; `/voices`
returns the pinned list; `/status` reports real preparation state; and `/prepare`, `/cancel`, `/health` and the
`503 when disabled` path all behave as the offline suite said they would.

### Not in scope

- **Voice cloning or a custom voice.** Kokoro's voices are fixed style vectors.
- **A wake word or speech-to-text.** This is text-out only; input stays typed — and speech-in already exists as the
  SenseVoice bundle.
- **Instruction conditioning that Kokoro cannot honour.** No amount of prompt engineering will make an 82M
  style-vector model act on the words "sounding rather melancholy, with a hint of rain". The compiler must map
  intent onto `voice` and `speed`, and where it cannot, it must say so rather than pretend.

---

## GP-2 — Expose TTS as a standard server API

**Priority P2 · Effort ~1–2 days · Status `SPECCED` — depends on [GP-1](#gp-1--kokoro-tts-a-spoken-reply-mode)**

### What it is

A setting on the TTS plugin that publishes synthesis as an **HTTP endpoint other applications can call** — so the
harness stops being the only consumer of its own voice. Enabled per profile, off by default.

Split from GP-1 deliberately: it has a different consumer (external clients, not the GUI), it is independently
shippable, and it carries a **security surface** that deserves to be reviewed on its own rather than skimmed as a
paragraph of a larger feature.

### The surface already exists

The harness ships `@deepseek-ai/dsh-host-webserver` (service name `webServer`), and a plugin registers into it:

```ts
const webServer = ctx.get('webServer')
ctx.effect(() => webServer.register({
  kind: 'prefix',
  path: '/v1/audio',
  handler: (req, res) => { /* owns the full response lifecycle */ },
}))
```

The handler signature is `(req: IncomingMessage, res: ServerResponse) => void | Promise<void>` and — quoting the
source — it **"owns the full response lifecycle (may hold the response open, e.g. SSE)"**. That matters twice over:

- **Audio streams as real bytes.** No base64, no attachment service, no `Content-Length` gymnastics: write
  `audio/wav` and pipe. This is a better path than the Remote for anything large.
- **A route cannot collide.** Duplicate `(kind, path)` throws, and registration is order-independent.

### Speak OpenAI's dialect, not a bespoke one

"Standard" should mean *the shape clients already implement*, so the translation layer is ours rather than theirs:

```
POST /v1/audio/speech
Authorization: Bearer <token>
Content-Type: application/json

{ "model": "kokoro", "input": "…", "voice": "af_heart",
  "response_format": "wav", "speed": 1.0 }
  → 200 audio/wav
```

That is the de-facto standard, understood by Open WebUI, SillyTavern and most TTS tooling. Add `GET
/v1/audio/voices` for discovery and `GET /v1/models` so a client can find `kokoro` without configuration.

**Map the OpenAI voice names onto Kokoro's.** `alloy`, `echo`, `fable`, `nova`, `onyx`, `shimmer` (and the rest)
should resolve to sensible Kokoro voices, so an existing client works unmodified on day one. Anything not in the
list falls through to a Kokoro name, which costs nothing and lets power users reach all 54.

**Supported formats, honestly.** Kokoro emits float32 at 24 kHz, so `wav` and `pcm` are free — a header and a
conversion. `mp3`, `opus`, `aac` and `flac` need an encoder this plugin does not have; **reject them with a clear
400 naming the supported set** rather than shipping a silently broken `mp3` or dragging in ffmpeg.

### The setting

| Field | Default | Notes |
|---|---|---|
| `apiEnabled` | `false` | off by default; requires a token unless anonymous is explicitly allowed |
| `apiToken` | generated on first enable | shown once in the settings pane, with a copy control |
| `apiPath` | `/v1/audio` | prefix route |
| `apiAllowAnonymous` | `false` | refuses to enable without an explicit acknowledgement |
| `apiMaxInputChars` | e.g. `2000` | bounds one request's work |

All `Volatile` Config fields persisted through `settings.update()`, exactly like GP-1's toggles.

### Security — read this part

**Two confirmed facts combine badly:**

1. This deployment binds the webserver to **`0.0.0.0:3080`** (`lan.patch.yml`), so the port is LAN-reachable.
2. **Named routes bypass authentication entirely.** The request path in `webserver/src/index.ts` is literally
   `match(rawPath) → handler → fallback`, with optional gzip as the only middleware. The browser's own connection is
   authenticated by the `connection` layer; a route registered by a plugin is **not**.

So a TTS route without its own auth is an open CPU amplifier: one unauthenticated `POST` can pin cores for seconds,
from anywhere on the network. Minimum bar:

- **Token required by default.** Constant-time comparison, `Authorization: Bearer`. Never accept it in a query
  string — that lands in logs and referrers.
- **Refuse to enable without a token** unless `apiAllowAnonymous` is explicitly turned on, and make that field's
  description say plainly what it does.
- **Cap concurrent synthesis** (one or two) and queue or return `429` beyond it. Without this, "two clients" is a
  denial of service against the agent loop, because the model shares CPU with the turn.
- **Bound input length and reject early**, before the model is loaded or run.
- **Log the bind address and effective path on enable**, so "this is on the LAN" is visible rather than inferred.
- Obscurity is not a control: a token is. A less guessable default path is fine, but it is not the mechanism.

### This should probably become the only synthesis path

The browser UI needs audio too, and the obvious first implementation hands it base64 frames over the Remote. But
once this route exists, **the client plugin can simply fetch it** — which removes the ~33% base64 inflation, makes
the browser path identical to the external one, and leaves exactly one code path to test, instrument and rate-limit.

Worth deciding during GP-1's phase 3 rather than discovering later, since it changes where synthesis results are
produced and who owns buffering.

### Not in scope

- **Streaming synthesis over the API** (chunked responses as sentences complete). The route can hold a response
  open, so it is possible, but no mainstream client consumes it — ship whole-response first.
- **A queue, job API, or webhook callback.** This is a synchronous text-in/audio-out endpoint.
- **A management UI beyond the settings pane** — no accounts, no per-key quotas, no usage dashboard.

---

## The session-projection route poisoned the log

*Recorded after a live failure in which two conversations became unloadable. Kept in full because the failure
mode is silent, delayed, and disqualifies a whole class of plugin state — not only this feature.*

### What was seen

Opening one conversation showed:

```
Failed to load history: failed to observe session "session-05161aa9-…": session
"session-05161aa9-…" contains event type "tts/preference" (seq 6669) unknown to this
harness and not marked ignorable; refusing to interpret the log — it was likely written
by a newer harness (raw log: …/session.v4.jsonl.zstd)
```

The diagnosis offered by that message is wrong, and understandably so: nothing in this profile was newer than
the harness. The event was written by *this* build, by our own plugin, and the reader was right to refuse it.

### The mechanism

| Fact | Where |
|---|---|
| The persistence **read** path refuses any stored event type outside the generated `KNOWN_SESSION_EVENT_TYPES` unless the envelope carries `ignorable: true` | `session-persistence/src/storage-contract.ts` (`validateStoredEvents`) |
| `Session.append()` **cannot set that marker** — its only option object is surface metadata (`surfaceOp`, `sourceEventSeqs`) | `core/session/src/index.ts` (`append`) |
| The generated vocabulary documents the marker as *"the compatibility mechanism"* for downstream plugin events | `core/session/src/known-event-types.ts` |

`ignorable` is reachable exclusively through the seed/restore/import paths — `Session.create`, `Session.fromRestore`,
the JSONL decoder. Every test that exercises it constructs a session from seed events; none appends one.

So for an out-of-repo plugin **the documented escape hatch has no producer API**, and appending a custom event
type is not merely unwise — it cannot be done safely. `'tts/preference'` was appended, accepted (the append-side
validator inspects only known surface types and `request/header`), persisted, and the conversation died on its
next load.

The refusal itself is correct and worth keeping: an unknown *required* event may change how the rest of the log is
reconstructed, so failing closed beats resuming from a gutted transcript.

### Why the existing verification did not catch it

The spec checked legality and concluded it was fine:

> *"Whether the custom event is legal was checked rather than assumed: `Session.append` runs a validator that only
> inspects known surface types and `request/header`, so an unrecognised `'tts/preference'` payload passes, subject
> to the ordinary JSON-serializability rule."*

That check was real, correct, and about the **wrong seam**. The append path and the read path are different
components with different policies, and only the read path decides whether a stored session can be reconstructed.

Worse, the suite asserted the defect as the feature: `check.js` verified *"setChatAuto records one durable event"*.
15/15 green. A test protects only the invariant it names, and this one named the bug. The suites now assert the
opposite — `append` is never reached, proven with a session whose `append` throws — because "the value
round-trips" was never the property that mattered.

### Blast radius

| | |
|---|---|
| Sessions affected | **2** (`05161aa9…`, `6c135ed1…`), identified through the projection cache: a `ttsPreference` row exists only for a session that stored a choice |
| Campaign data | **untouched** — transcripts and turn memory live under `campaign/`, written by the `dd35-memory` plugin, which does not pass through this path |
| The plugin mid-incident | **live**, so any further toggle would have poisoned whatever conversation it was used in |

### Recovery

The repair is a marker rewrite: decode the log's concatenated-Zstandard container, add `"ignorable": true` to the
stored rows of the offending type, and write it back. Nothing else about the log changes — sequences, times,
payloads and every other row are preserved, and the header keeps its own frame, which the reader asserts. That is
exactly what the marker is for: an informational record whose absence cannot change how the rest of the log is read.

A one-off tool did this, verifying the container with the reader's own structural rules and re-reading what it was
about to write before writing it. **It has since been deleted**, deliberately: the write path is fixed, so there is
nothing left to repair, and a recovery script that outlives its incident is a script someone eventually runs by
mistake.

**The harness must be stopped first.** It holds the log open and appends frames at its own offset, so a rewrite
underneath a running process sends later appends to the replaced inode and silently loses them. Stop `dsh web`,
repair, restart — one operation, since the restarted process must also carry the plugin fix.

**What actually happened:** the first affected conversation was **archived rather than repaired**. Its record is
kept in [session-05161aa9-report.md](session-05161aa9-report.md), reconstructed from the projection cache — which
survives a log that will not load, and is the reason that cache is worth knowing about.

The orphaned `ttsPreference` row in the projection cache needs no attention: `restore` iterates *registered* units
rather than stored rows, so an unowned row is never read and is dropped at the next checkpoint.

### The decisions this changes

- **The per-chat preference is plugin-owned state.** A JSON file under the plugin's `dataRoot`, keyed by session
  id, atomic write, in-memory first, and a failure degrades to a warning — a preference is not worth an error path
  into `apply()`.
- **The projection registry is not consulted at all**, and `smoke.mjs` asserts the plugin never asks for it. A
  projection is a pure fold over committed session events, so keeping one without a legal event is not a smaller
  design; it is a broken one.
- **The service surface is unchanged.** `plugin.js`, `route.js` and the browser half were untouched, because the
  client has always read and written through `GET/POST {prefix}/preference` rather than a projection wire view.
- **One property was given up.** The log route bought "a fork carries its own setting". A fork has a new session id
  and now inherits the profile default again. That is coherent on its own terms — a new conversation starts from the
  default — and the property was never actually available: the only mechanism offering it bricks the log.
- **The upstream gap is worth reporting.** `known-event-types.ts` names `ignorable` as the mechanism for downstream
  plugins while `append` cannot produce it. Either the marker needs a producer API, or the documentation should say
  that plugin state does not belong in the session log. Until one of those happens, this rule stands.

**Standing rule: never `session.append()` an event type the harness does not ship.** It follows that per-session
plugin state has exactly two legal homes — plugin-owned storage, or a config field — and it generalises past this
feature: anything that must survive a restart and is *not* part of the conversation belongs outside the log.

---

## GP-1 as built — 2026-10-02

*Written after the plugin became usable end to end. Everything here was verified on the live host; where an earlier
claim in this document is now wrong, [Corrections](#corrections-to-this-document) lists it rather than quietly
rewriting the history.*

### What shipped

| Piece | Where | State |
|---|---|---|
| Settings write path | `settings.js`, `GET/POST /settings` | live |
| Pane controls — Voice, Tone, Delivery, Threads | `client.js` at `plugins.bundle.config` | live; they were inert local state before |
| Provider registry | `plugin.js` — `kokoro` and `piper` behind one `synthesize()` | live |
| Engine picker | the chat header beside the Speaking toggle (`tts-provider`) | live |
| Per-engine voice memory | settings keys `voice` / `piperVoice` | live |
| Auto-speak, completion mode | `client.js` — a renderless `tts-auto` entry | live |
| Speech text filter | `speech-text.js`, applied in `synthesize()` | live |
| Piper driver | `piper.js` — contract measured before it was written | live |
| Voice pins | `assets.json` — 54 Kokoro style vectors, 3 Piper models | the three Piper hashes come from real fetches |
| Gate and benchmark tool | `verify.mjs` (`pre`, `live`) | live |

### Measured on this host

| | audio | wall clock | RTF |
|---|---|---|---|
| Kokoro `af_bella`, threads 2 | 3.05 s | 8050 ms | 2.64 |
| Piper `en_US-amy-medium`, threads 2 | 2.41 s | 693 ms | **0.29** |

- **Piper is 11.6× faster on the same sentence, and 3.4× faster than real time.**
- **`threads: 2` bought ~3% over the documented single-thread figure (2.73)** — flat. The work is
  contention- or cache-bound, not compute with an idle core. Caveat stated: the threads-1 number predates this
  sentence, so the clean A/B is `verify.mjs live --label … --vs …`.
- The two engines differ by an order of magnitude in *weight*: a Kokoro voice is a ~0.5 MB style vector on top of
  one shared 92 MB graph, while a Piper voice is a 63–114 MB model. That is why their voice lists behave
  differently, and why their download stories will too.
- **The voice's quality tier matters more than the engine choice, and only a live run showed it.** The 0.29 above
  is `en_US-amy-medium`. The same sentence through `en_US-lessac-high` measured **4492 ms for 2.12 s of audio —
  RTF 2.12**: about 7× slower, and no longer faster than real time. So "Piper is the fast answer" is a claim about
  *medium* voices. A `high` voice is a quality choice that costs Kokoro-class latency, and the tier word in its
  label (*Lessac · US high*) is the only warning the pane gives. The difference between the two engines shrinks
  from 11.6× to 1.2× once the comparison is between two voices a user might actually pick.
- **`threads` was flat again for Piper** — 4492 ms at 1 thread against 4606 ms at 2 — the same result as Kokoro's
  threads experiment, from a different engine. Two physical cores are the ceiling, and no setting changes that.

### The hardware conclusion

`lscpu` on the G5400T: **no `avx`, no `avx2`, no `fma`, no `avx512*`** — SSE2/SSE4 kernels, four floats per
instruction. That, not memory bandwidth, is the bottleneck, and the decisive evidence is that **fp32 (310 MB) runs
15% faster than q8 (88 MB)** — which a bandwidth-bound workload cannot do.

- **Overclocking is unavailable** — locked 35 W T-series part, no external clock generator on that board.
- **Cores are not the lever** — the threads experiment says so.
- **AVX2 + FMA is the lever** — same socket, 35 W envelope (i3-9100T class). For a 1–2 thread load a T part turbos
  near its 65 W sibling, because its TDP only binds when every core is loaded. Expect ~2–3×, not 5×.
- RAM is already dual-channel (8+4 GB, Intel flex mode) and non-ECC; 2400 MT/s is the CPU's ceiling, not the DIMMs'.

### The six-type sweep — 2026-10-03

The variant question was reopened with a proper sweep: every type above q4, both workload shapes, best of three, one
script, one machine state. `bench-inference.mjs` downloads and hash-verifies each graph *before* measuring any of
them, and refuses to run if the long input would cross the graph's token ceiling. That guard fired on the first
attempt — the passage needed exactly 512 tokens — and stopping was correct: `tokenize` truncates silently, so the
run would have measured a short waveform and reported a flattering RTF. The input is now assembled to a token budget
instead of being a fixed literal. Phonemization is timed once and excluded from every measurement below.

| Type | Size | Long passage RTF | Twelve short calls RTF | Per call |
|---|---|---|---|---|
| **uint8** | 169 MB | **2.60** | **2.63** | 5180 ms |
| uint8f16 | 109 MB | 2.67 | 2.73 | 5392 ms |
| q8f16 | 82 MB | 2.73 | 2.78 | 5399 ms |
| q8 | 88 MB | 2.80 | 2.77 | 5374 ms |
| fp32 | 310 MB | 2.92 | 2.94 | 5697 ms |
| fp16 | 156 MB | 2.97 | 3.05 | 5903 ms |

Long passage: 65 words, 346 tokens, ~20.5 s of audio. Short calls: twelve *distinct* utterances, one run each, so
no runtime can cache a repeat and flatter itself.

**Four findings, three of which change what this document says.**

1. **The data type barely matters here.** The whole spread is **17%** — 2.60 to 3.05 — and nothing comes close to
   real time. On this CPU the graph choice is a size dial, not a performance one, and no variant rescues the speed.
2. **uint8 measured fastest in both shapes**, which contradicts the reasoning in
   [The model, measured](#the-model-measured) that uint8 is pointless on x86. That reasoning assumes AVX-512 VNNI,
   where *signed* int8 gets the fast path. This CPU has no VNNI at all, so every integer graph runs the same generic
   kernels and the order falls out of operator mix and layout instead. 6% for twice the download, so the shipped
   default does not change over it.
3. **The earlier "fp32 is fastest" result did not reproduce.** At 346 tokens fp32 measured 2.92 against q8's 2.80 —
   the opposite order from the 96-token measurement (2.32 against 2.73). Both are best-of-N on the same box, so the
   likely explanation is the *shape*: fp32's larger working set plausibly suffers more as the sequence grows. That is
   a hypothesis, not a finding, and the honest guidance is that the ordering is **shape-dependent**.
4. **Per-call overhead is negligible** — +45 to +148 ms on a ~5,400 ms call, so 1–3%. Speaking sentence by sentence
   costs essentially nothing extra on this machine, which removes one anticipated objection to the streaming design.

The five graphs that were not already pinned all verified against digests taken from the repository's tree API,
where an LFS entry's `oid` is the file's sha256. That mapping was confirmed by the one file the plugin had been
verifying against from the start: `model_quantized.onnx`'s listing digest is byte-identical to its pin.

### The iGPU question, answered — 2026-10-03

An Intel UHD Graphics 610 (Coffee Lake, Gen 9.5) sits on the same die as that CPU, and the hypothesis worth testing
was that it might outrun two SSE4.2 cores. It was chased to a conclusion rather than dismissed. The conclusion is
negative, and only part of that is about the hardware.

**What turned out to be true:**

- **The iGPU is reachable.** `vulkaninfo` reports it through Mesa's ANV driver at **Vulkan 1.4.305**, and it
  advertises **`shaderFloat16 = true`**, `shaderInt8 = true` and 16-bit storage — so half-precision shaders were
  never the obstacle. Mesa's software `llvmpipe` also appears as a device, which is a standing trap for any
  measurement here: the adapter actually returned must be printed, or a CPU number can be reported as a GPU one.
  Both bench scripts do.
- **Debian 13 does not package the Intel compute runtime.** `intel-opencl-icd`, `intel-level-zero-gpu` and `libze1`
  are in neither trixie's archive nor its non-free component (confirmed by reading `/var/lib/apt/lists/` rather than
  trusting `apt-cache`, which is how we know the sources were fine and the software is absent). So OpenVINO's GPU
  plugin is unavailable **via apt**. Not in Debian is not the same as unavailable, though: Intel publishes its own
  `.deb` files on the `intel/compute-runtime` releases, and that is the one conventional route still untried.
- **Vulkan needs none of that**, so `onnxruntime-web`'s WebGPU provider was driven directly under **Deno** — headless,
  no native addon, no browser, and with real wall-clock timings. Chrome headless was rejected for this purpose:
  getting output out of a JS-driven page means virtual time, and virtual time distorts `performance.now()` past
  usefulness.
- **It got a long way, then failed on the model.** Adapter acquired, wasm runtime loaded, sessions created, WebGPU
  kernels dispatching. It died building a compute pipeline: **`ShaderModule with 'Clip' label is invalid`**. So
  ORT 1.30's WebGPU provider cannot execute this graph on this driver — an operator/provider incompatibility, not a
  capacity problem. Memory is a *separate* constraint: the run was later OOM-killed on the 156 MB fp16 graph with
  the harness already holding ~3.6 GB.

**What the attempt cost, and what it was worth.** Nearly all of the effort went into packaging rather than hardware.
Deno's ESM loader will not import a module over `https`; its `fetch` will not read `file://`; ORT requires its glue
module and its wasm binary to be the same build, and in 1.30 the WebGPU path uses the `asyncify` pair rather than
the `jsep` one. A guessed version number produced a `LinkError` that looked like a deep incompatibility and was not
one. The tooling is kept because the *setup* is the reusable part: `bench-webgpu-deno.js` and `bench-webgpu.html`.

**The verdict.** The iGPU is capable but unreachable for this model: the graph does not fit the provider, and the
alternative runtime is not packaged. The workaround would be graph surgery — rewriting the int64 arithmetic so the
WebGPU provider accepts it — which would break the sha256 pins, and the pin discipline is worth more than the
speed. The lever for Kokoro remains a CPU with AVX2, not this GPU.

### Auto-speak: why completion mode needed no stream hook

The spec above assumed the client holds the deltas. Ours does not — this client is slot-based. But the shell offers
something better: `conversation.chat.assistant-actions` renders from `TurnTailNodeView` **only when `closing !==
null`**, and it carries `closing.finalNode.messageId`. So **the mount is the completion signal**, the id is the
durable reference, and the host already resolves and segments the text. No stream, no client-side segmenter, no
chunk markers.

| Situation | Behaviour |
|---|---|
| Opening a chat | silent — a 1.2 s priming window, with everything visible recorded as seen |
| Turning the toggle on | armed from that moment; replies already on screen stay quiet |
| A reply completing while armed | spoken once, through the same `/speech` call the button makes |
| A re-mount (scroll back, then forward) | already seen → quiet |
| A burst of mounts | treated as a transcript render, not a reply |

**Residual gap, recorded rather than hidden:** a *single* node scrolled in from a region that was never rendered
during priming can still read one old reply. The fix is known and cheap — ask the host whether this is the newest
assistant message, which a scrolled-in node never is — and it *deletes* the burst heuristic when it lands.

**Streaming mode is deferred, not abandoned.** It matters for the engine it was designed for: at Kokoro's RTF 2.64
a thirty-second reply ends with ~79 s of silence, while Piper's 0.29 makes completion mode tolerable. The viable
route is a host-side chunked endpoint that keeps the shared `segment.js` (the client opens it only for the open
chat); a client-side driver would need a slot entry to reach the chat snapshot, which is unverified. A
client-side *segmenter* is ruled out — the client bundle cannot import the host's `segment.js`, so it would be a
second copy of the rules with the most traps in the codebase.

### The speech text filter

`stripForSpeech` — markdown, then mechanics — applied once in `synthesize()` before segmentation, so the button,
auto-speak and the HTTP API all inherit it and the tone classifier reads cleaner input. `raw: true` is the escape
hatch at the service level; it is not yet exposed on the route.

The markdown half is the reference implementation supplied for this profile (`openclaw/openclaw`,
`src/shared/text/strip-markdown.ts`) — same order, same regexes — with three additions marked `[beyond the
reference]`: fenced code blocks dropped entirely, links reduced to their text (images dropped), and list markers
removed. The mechanics half is ours: table rows, dice notation, and lines that are *only* stat fragments.

### Corrections to this document

Claims elsewhere in this file that the implementation proved wrong, kept visible rather than quietly edited:

- **"HMR does not watch … an edit needs a restart."** Wrong for *code*: the profile patch sets `hmr.root` to the
  plugin directory, and `plugin.js`, `client.js` and new modules all reload live — auto-speak worked on the first
  try with no reload. Only **config and patch** changes need a restart.
- **"A plugin's only storage failure mode is an unknown event type."** No: a profile `config:` override can drop a
  bundle's own `dataRoot`, and the plugin then falls back to `<cwd>/.dsh-tts` — every model invisible, and its
  settings file written into the checkout. The fix is to state `dataRoot` in the profile patch, and the mount
  warning that now says so out loud exists because the symptom ("voice is not on disk") appears nowhere near the
  cause.
- **Phase 4b's client half is done** — the settings pane persists through `GET/POST /settings`, and the values are
  resolved file-then-config so the shipped patch stays a default rather than a duplicate.
- **"Not yet verified live"** no longer applies to the route, the browser half, or either engine.
- **"The variants were then tested, and the answer is settled."** It was not settled. A longer-passage sweep reversed
  the ordering and shrank the entire spread to 17% — see [The six-type sweep](#the-six-type-sweep--2026-10-03). The
  earlier table is left standing above, unedited, because *the difference between the two measurements* is itself
  the finding: a 96-token passage and a 346-token passage rank these graphs differently.
- **"fp32 is the fastest on this host", and the hardware conclusion built on it.** The claim that fp32 beat q8 by 15%
  does not survive a realistic passage length, where it is 12% *slower*. The SIMD argument it supported is unaffected
  — the threads experiment and the fp32/q8 crossing both still point at instruction width, not bandwidth.

### Piper voice downloads, and the two voice keys — 2026-10-03

The manifest was always meant to be the catalogue — its own comment says so — but three places still
behaved as though voices arrived by hand. This session made the code match the design.

**What changed.**

- **`piper.js` gained `piperFiles` and `catalogueVoices`.** The first is deliberately pure: given the
  manifest, a voice and a root, it returns each file's **URL** and its **local path**. Those are not
  the same shape, and confusing them is the bug the function exists to prevent. The URL nests the
  locale as one component with the voice name in the *filename*
  (`en/en_US/amy/medium/en_US-amy-medium.onnx`); the local path gives the voice its own directory,
  which is what `fetch-piper.mjs` already wrote. Pure means the download path is testable with no
  network and no filesystem, which is where the eleven new `check.js` cases live.
- **`providerVoices('piper')` reads the catalogue rather than the disk**, so a pinned voice is
  selectable before it has been fetched. `activeVoice`'s fallback prefers a voice that *is* on disk,
  so switching engines starts speaking rather than starting a 63 MB download.
- **`createPiperPreparation` downloads what is missing** through `ensureAsset` — the same verified
  path Kokoro's graph takes — emitting `downloading → loading → ready`, and re-verifying the model
  after a fetch. It also gained an `AbortController`: cancel previously did nothing, which was
  harmless when there was nothing to cancel and is not harmless now.
- **The estimate is per voice, from the pins**: 63,206,176 bytes for a medium, 113,900,084 for
  `lessac-high`. The constant it replaced assumed 64 MiB for every voice, understating the
  high-quality one by nearly half.
- **`/voices` answers with `{ id, present, bytes }`** rather than bare ids, for both engines — a Kokoro
  style vector is fetched per voice exactly as a Piper model is, so an unfetched Kokoro voice was just
  as invisible. The pane labels an unfetched voice with its cost, and the Prepare card says *Download
  voice* when Piper is active.

**A bug this surfaced.** `SETTING_KEYS` in `route.js` did not list `piperVoice`, so choosing a Piper
voice in the pane was *rejected*: the pane wrote `voice`, the host stores Piper's choice under
`piperVoice`, and nothing reported the mismatch — the selection simply did not stick. Rather than teach
the client about two keys, `writeSettings` now accepts either and normalises through `setVoice`, which
validates the name against the active engine and stores it under that engine's key. The pane sends
`voice` and knows about one key. `check-http.mjs` had **no `/settings` coverage at all**, which is why
this survived; it now has five checks.

**Also landed since the list below was written:** `raw: true` reaches the HTTP route, so an external
caller can ask for unfiltered text. Three checks, including one for a non-literal value — `raw: 'yes'`
must *not* switch the filter off, since a dropped or misread option here fails silently: the audio
still comes back, just filtered, which looks exactly like success at the HTTP layer.

### Voice labels — 2026-10-03

The picker used to show raw ids. Both engines now answer with a `label` beside the id, each from one
mechanical rule: `af_heart` → *Heart · US female*, `en_US-lessac-high` → *Lessac · US high*.

The Kokoro side reads the id through the same letter table the phonemizer uses (`a` American, `b`
British, and so on), so nothing is recalled from a model card and there is nothing to get wrong. An id
that does not parse comes back **unchanged** rather than guessed at, which is deliberate: a technical
label always looks wrong, while a plausible wrong one is invisible — and the suite pins that behaviour
across six malformed shapes. The pane prefers the label and keeps the id as the value it saves.

**Grades are deliberately absent.** The model card publishes a quality grade per voice, and showing them
was the original plan. They are not shown because we hold no pinned copy of that card: a grade is
somebody else's judgement, and this plugin does not assert what it cannot cite. `listVoices()` already
reads an optional `grade` from the manifest and the pane would render one, so filling them in is a
matter of pinning the card first — the fetch-and-record-the-hash discipline `fetch-piper.mjs` uses for a
voice.

### Still open

- **Kokoro voice grades** — the labels themselves are done (see the section above); the grades are not, for the
  reason given there. No pinned copy of the model card means no citable grade, and the mechanism is in place and
  empty rather than filled with something plausible.
- **Kokoro variant selection** — the sweep turns this into a size/quality dial rather than a speed one, and the
  per-variant descriptions are already pinned in `assets.json` beside the hashes. The `kokoroModel` setting itself is
  unimplemented; the descriptions are what the pane would show. Note that whatever implements it must skip the
  `$comment` key that sits inside `variants`, or a pseudo-variant with no path and no hash will appear in the pane.
- **The plugin must install its own requirements.** A feature that needs a package has to bring it — declared in the
  bundle's `package.json` and installed with the bundle, never a line of instruction. Two traps are already recorded
  in this file: a `link:`ed bundle does not receive the profile's install, and a profile `config:` override can
  silently drop `dataRoot`. This governs the tone classifier's model and any future WebGPU provider alike.

Closed since this list was written, in the session that followed it: the **readiness gate** (the toggle is now
disabled with a pointer to the Prepare card until a model is ready), **`verify.mjs`'s three defects** (the mount
point defaults to `/v1/audio`, a rejection now reports its status and body instead of a JSON parse error, and a URL
carrying `?token=` is accepted), **`check.js` coverage for `speech-text.js`** (23 checks — they caught a real
regular-expression bug in the fenced-code rule), and **the newest-message check** that replaced auto-speak's
mount-burst heuristic with a question the host can answer from the durable log.

### Streaming mode: verified, and it can only be host-side

Two questions were open. Both now have answers, and the second removes a decision we would otherwise have made on
preference rather than on fact.

**Can the browser watch the reply being written?** No. The slot map in `ui-chat`'s contract declares what each
extension point hands over, and the one this plugin uses is:

```ts
'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
```

`AssistantActionOwnerProps` is `{ messageId }` — an id and nothing else: no hooks, no live text. The turn-tail slot
is the same, offering a turn number, a sequence and a file opener. Exactly one slot in that map carries chat state,
`conversation.chat.node`, which declares `hookContext` and `inject: ChatNodeInjected`. But it is `keyed`:
registering there **replaces the chat's own renderer for that node kind**, so a plugin would have to reimplement how
assistant messages are drawn in order to listen to them. That is not a reasonable price for a voice feature.

The client therefore cannot stream, and the host does all of it — which is also the simpler design, since the
segmenter that already exists and is already tested stays the only copy.

**Does the host hook exist?** Yes, and this was checked in the code rather than assumed:

```ts
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
```

It is an ordinary scoped event, so consuming it is a one-line `ctx.on(...)` — the same shape as the
`agent/turn-stopping` hook the dd35 memory plugin already uses. The generated API catalog describes it as
*"Process-local assistant-stream publication. Chunk frames are transient; the loop appends one final v2
`assistant/message` or `assistant/attempt` with the same stream before a committed end frame."* There is also a
working precedent in the tree for the pattern we want: `packages/bundle/headless/src/index.ts` subscribes to that
event and streams the assistant's output outward, using `lastAssistantStreamChunk` from
`@deepseek-ai/dsh-llm/assistant-stream`.

**The design that follows.** The host watches the reply arrive, cuts it into speakable sentences with the existing
segmenter, synthesizes each one, and sends raw audio back over a single HTTP response held open for the duration of
the reply. The browser appends what it receives to one continuous playback queue and aborts the request when muted
or stopped. A webhook is the wrong instrument here — that is server-to-server — and a WebSocket would add machinery
the chunked response does not need.

To feel like one voice rather than clips, three things have to change together, and each is deliberate:

- **No WAV header per piece.** Today each request returns a complete WAV and the browser plays it as one sound;
  two of them leave an audible gap and each restarts playback. Streaming sends raw samples at a stated sample rate
  into a single queue.
- **No 180 ms silence between segments.** `joinSamples` inserts that because separate clips need a gap. A continuous
  stream does not, and the padding is audible.
- **Accept the residual seam.** Each sentence is synthesized on its own, so intonation restarts at every boundary.
  Removing that means synthesizing longer blocks, which costs latency. That is a trade, not a defect.

**Which engines can stream is a runtime question, not a design one.** The numbers measured here — Kokoro 2.64
against Piper 0.29 — describe this CPU, which has no AVX at all. The same Kokoro graph on a host with AVX2 lands
under 1.0, and this plugin is profile-global and may run anywhere. Hard-coding "this engine cannot keep up" would
bake one machine's benchmark into the architecture, which is the same mistake as assuming the eventual target was
VNNI-capable when the pin was chosen.

So streaming is a mode available to **every** provider, and whether it keeps up is observed rather than assumed.
The engine already reports `inferredMs` and the produced audio length for every piece, so that ratio is available
live, per utterance. If synthesis falls behind the incoming text by more than a chosen margin, the honest responses
are to say so and let the listener decide, or to stop enqueueing — not to have decided in advance that a given
engine cannot.

A first sound about a second into the reply is the floor on any engine, since nothing can be synthesized until a
complete phrase exists.

**Still unverified, and the next single check:** the exact shape of `AssistantStreamFrame` — which field carries the
text delta. The union lives in `packages/llm/llm/src/assistant-stream.ts`, and one read settles it.


