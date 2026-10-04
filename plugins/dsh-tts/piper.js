/**
 * Piper: a second synthesis provider, for speed.
 *
 * ## Why it exists
 *
 * Kokoro sounds better and is unusable in real time on this host. Measured on the
 * same box, same sentence:
 *
 * | | Weights | RTF | 2.33 s of audio |
 * |---|---|---|---|
 * | Kokoro q8 | 88 MB | 2.73 | ~6.4 s |
 * | Kokoro fp32 | 310 MB | 2.32 | ~5.4 s |
 * | **Piper `en_US-amy-medium`** | 64 MB | **0.38** | **0.88 s** |
 *
 * The reason is architectural. Kokoro is a *style-vector* TTS whose cost is dominated
 * by a vocoder that generates every sample; Piper is VITS, an order of magnitude
 * cheaper per second of speech and designed for Raspberry-Pi-class CPUs. On a CPU
 * with no AVX at all, that difference is the whole game.
 *
 * ## The contract, verified rather than recalled
 *
 * Everything below was read off the published `en_US-amy-medium` artifact by
 * `fetch-piper.mjs`, whose probe produced real speech (peak 0.55, 2.33 s, RTF 0.38):
 *
 * - inputs: `input` (int64 `[1, N]`), `input_lengths` (int64 `[1]`),
 *   `scales` (float32 `[3]`)
 * - output: `output`, shape `[1, 1, 1, N]`, float32
 * - `audio.sample_rate` **22050** — not Kokoro's 24000
 * - `phoneme_id_map` carries `^` = 1 (start), `$` = 2 (end), `_` = 0 (pad)
 * - the sequence is: `^`, then each phoneme followed by a pad, then `$`
 * - word boundaries are `_`; espeak's spaces are replaced with it
 *
 * The lesson from the session-projection incident applies here too: the contract was
 * *measured* before a line of driver was written, because a plausible-looking guess
 * about someone else's seam is exactly what cost two conversations.
 *
 * The phonemizer is the one already in the bundle — Piper uses espeak-ng IPA, and so
 * does Kokoro, so `phonemize()` is shared rather than duplicated.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadOrt, phonemize } from './kokoro.js'

/** Only used when a voice config omits `audio.sample_rate`, which none do. */
const FALLBACK_SAMPLE_RATE = 22050

/** VITS defaults from the published configs, used when `inference` is absent. */
const DEFAULT_INFERENCE = { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }

/**
 * Parse a Piper voice name into repository path parts.
 *
 * `en_US-amy-medium` → `en/en_US/amy/medium/`. The locale is a single directory
 * component — `en_US`, not `en/US` — which is the mistake that made the first fetch
 * 404, so it is stated here rather than left to be rediscovered.
 *
 * @param voice - e.g. `en_US-amy-medium`, `en_GB-alan-low`.
 * @returns the parts, or undefined when the name does not parse.
 */
export function voiceParts(voice) {
  const match = /^([a-z]{2})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/.exec(voice)
  if (match === null) return undefined
  const [, family, region, name, quality] = match
  const locale = `${family}_${region}`
  return { family, locale, name, quality, dir: `${family}/${locale}/${name}/${quality}/${voice}` }
}

/**
 * A Piper id as a person would read it: `en_US-amy-medium` → `Amy · US medium`.
 *
 * Built on {@link voiceParts}, the already-tested parser for these names, so a name that
 * parses in one place parses in both. An unparseable id comes back unchanged rather than
 * guessed at.
 */
export function piperVoiceLabel(id) {
  const parts = voiceParts(id)
  if (parts === undefined) return String(id)
  // English keeps the country, matching how the Kokoro voices read (`Heart · US female`);
  // other languages keep their own tag, since "de DE" is no more readable than "de_DE".
  const [family, region] = parts.locale.split('_')
  const where = family === 'en' ? region : parts.locale
  return `${parts.name.charAt(0).toUpperCase()}${parts.name.slice(1)} · ${where} ${parts.quality}`
}

/** The phoneme id for one symbol, tolerating both `id` and `[id]` shapes. */
function idOf(idMap, symbol) {
  const entry = idMap[symbol]
  if (Array.isArray(entry)) return entry[0]
  return typeof entry === 'number' ? entry : undefined
}

/**
 * Build one utterance's id sequence: start, each phoneme followed by a pad, end.
 *
 * Verified against the real model — this exact construction produced speech, and the
 * probe in `fetch-piper.mjs` re-checks it on any newly fetched voice.
 *
 * @param phonemes - espeak IPA with word boundaries already marked `_`.
 * @param idMap - the voice's `phoneme_id_map`.
 * @returns the id sequence, or an empty array when the map carries no start token.
 */
export function phonemesToIds(phonemes, idMap) {
  const bos = idOf(idMap, '^')
  if (bos === undefined) return []
  const pad = idOf(idMap, '_')
  const ids = [bos]
  for (const symbol of phonemes) {
    const id = idOf(idMap, symbol)
    if (id === undefined) continue
    ids.push(id)
    if (pad !== undefined) ids.push(pad)
  }
  const eos = idOf(idMap, '$')
  if (eos !== undefined) ids.push(eos)
  return ids
}

/**
 * VITS synthesis scales: `[noise, length, noise width]`.
 *
 * Speed is the plugin's convention — 1 is the voice's own pace, 2 is twice as fast —
 * and VITS's `length_scale` is its *inverse*: a longer scale means a longer utterance.
 * Getting this backwards would make "slower" sound faster, so it is one pure function
 * with a test rather than an inline expression.
 *
 * @param speed - the plugin's speaking rate.
 * @param inference - the voice config's `inference` block, if it has one.
 * @returns the three scales, in the model's order.
 */
export function scalesFor(speed = 1, inference = {}) {
  const settings = { ...DEFAULT_INFERENCE, ...inference }
  const rate = Number.isFinite(speed) && speed > 0 ? Math.min(Math.max(speed, 0.5), 2) : 1
  return [settings.noise_scale, settings.length_scale / rate, settings.noise_w]
}

/** espeak language letter for a Piper config: Kokoro's convention, 'a' American, 'b' British. */
export function languageFor(espeakVoice = 'en-us') {
  return espeakVoice.endsWith('-gb') ? 'b' : 'a'
}

/** Whether `dir` holds a Piper voice: a model with its sibling config. */
function isVoiceDirectory(dir) {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.onnx')) continue
    try {
      statSync(join(dir, `${entry}.json`))
      return true
    } catch {
      // A model without its config cannot be driven, so it is not a voice.
    }
  }
  return false
}

/** Collect every directory under `root` that holds a complete voice. */
function walk(root, found) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    if (isVoiceDirectory(child)) found.push(child)
    else walk(child, found)
  }
  return found
}

/**
 * Every Piper voice already on disk, so the picker reflects what is actually
 * available rather than a hardcoded list of things that were never fetched.
 *
 * @param root - the Piper models root, e.g. `$DSH_HOME/tts/models/piper`.
 * @returns one entry per voice, cheapest first.
 */
export function listPiperVoices(root) {
  const voices = []
  for (const directory of walk(root, [])) {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.onnx')) continue
      const model = join(directory, entry)
      let config
      try {
        config = JSON.parse(readFileSync(`${model}.json`, 'utf8'))
      } catch {
        continue
      }
      voices.push({
        id: basename(entry, '.onnx'),
        path: model,
        configPath: `${model}.json`,
        bytes: statSync(model).size,
        sampleRate: config.audio?.sample_rate ?? FALLBACK_SAMPLE_RATE,
        language: languageFor(config.espeak?.voice),
        speakers: config.num_speakers ?? 1,
        inference: config.inference ?? {},
      })
    }
  }
  return voices.sort((a, b) => a.bytes - b.bytes)
}

/**
 * The files that make up one pinned voice, and where each comes from.
 *
 * Two different paths, and confusing them is the bug this function exists to prevent:
 *
 * - the **URL** nests by locale, name and quality only, with the voice name in the
 *   *filename* — `en/en_US/amy/medium/en_US-amy-medium.onnx`
 * - the **local path** gives the voice its own directory —
 *   `en/en_US/amy/medium/en_US-amy-medium/en_US-amy-medium.onnx`
 *
 * The second matches what `fetch-piper.mjs` already wrote, so a voice fetched by hand is
 * recognised instead of being downloaded a second time.
 *
 * Deliberately pure: no filesystem and no network, so the download path can be tested
 * without either. That is the seam the `check.js` cases use.
 *
 * @param piper - the `piper` section of `assets.json`.
 * @param voice - a voice id, e.g. `en_US-amy-medium`.
 * @param root - the Piper models root.
 * @returns one entry per file, or `[]` when the voice is not pinned.
 */
export function piperFiles(piper, voice, root) {
  const entry = piper?.voices?.[voice]
  if (entry === undefined) return []
  return Object.entries(entry.files).map(([name, meta]) => ({
    name,
    url: `${piper.baseUrl}${entry.dir}/${name}`,
    dest: join(root, entry.dir, voice, name),
    // `ensureAsset` wants the pin in the shape `{ bytes, sha256, path }`.
    asset: { ...meta, path: name },
  }))
}

/**
 * Every pinned voice, on disk or not — the manifest used as a catalogue.
 *
 * Presence is existence rather than a hash check: verifying one voice means reading
 * 63–114 MB, which is far too much work to do while rendering a picker. Verification
 * happens in `prepare`, through `ensureAsset`, where a corrupted file fails loudly
 * instead of quietly.
 *
 * The returned entry carries `path` and `configPath`, which is all `loadPiperVoice`
 * reads, so a catalogue entry and a `listPiperVoices` entry are interchangeable.
 *
 * @param piper - the `piper` section of `assets.json`.
 * @param root - the Piper models root.
 * @returns one entry per pinned voice, in manifest order.
 */
export function catalogueVoices(piper, root) {
  return Object.entries(piper?.voices ?? {}).map(([id, entry]) => {
    const files = piperFiles(piper, id, root)
    const model = files.find((file) => file.name.endsWith('.onnx'))
    const config = files.find((file) => file.name.endsWith('.onnx.json'))
    return {
      id,
      dir: entry.dir,
      files,
      path: model?.dest,
      configPath: config?.dest,
      bytes: files.reduce((sum, file) => sum + file.asset.bytes, 0),
      present: files.every((file) => existsSync(file.dest)),
    }
  })
}

/**
 * Open one voice: the graph, its id map, and the facts needed to drive it.
 *
 * @param voice - an entry from {@link listPiperVoices}, or any `{path, configPath}`.
 * @param options.threads - ONNX intra-op threads, matching the Kokoro provider's knob.
 * @returns everything {@link synthesizePiper} needs.
 */
export async function loadPiperVoice(voice, { threads = 1 } = {}) {
  const config = JSON.parse(readFileSync(voice.configPath, 'utf8'))
  const ort = await loadOrt()
  const session = await ort.InferenceSession.create(voice.path, { intraOpNumThreads: threads })
  return {
    session,
    idMap: config.phoneme_id_map ?? {},
    sampleRate: config.audio?.sample_rate ?? FALLBACK_SAMPLE_RATE,
    inference: config.inference ?? {},
    language: voice.language ?? languageFor(config.espeak?.voice),
    speakers: config.num_speakers ?? 1,
    id: voice.id,
  }
}

/**
 * Speak one already-segmented passage.
 *
 * Segmentation happens above this function, in the shared segmenter, so one call is
 * one utterance — which also matches how Piper's own pipeline phonemizes per sentence.
 *
 * @returns the waveform, its sample rate, and how long inference took.
 */
export async function synthesizePiper(loaded, { text, speed = 1 }) {
  const phonemes = await phonemize(text, loaded.language)
  // Piper marks word boundaries with the pad symbol rather than a space.
  const ids = phonemesToIds(phonemes.replace(/\s+/g, '_'), loaded.idMap)
  if (ids.length === 0) {
    throw new Error(`piper voice "${loaded.id}" has no usable phoneme ids for this text`)
  }

  const { Tensor } = await loadOrt()
  const feeds = {
    input: new Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
    input_lengths: new Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new Tensor('float32', Float32Array.from(scalesFor(speed, loaded.inference)), [3]),
  }
  // A multi-speaker voice requires the speaker id; a single-speaker graph rejects it.
  if (loaded.speakers > 1) {
    feeds.sid = new Tensor('int64', BigInt64Array.from([0n]), [1])
  }

  const started = Date.now()
  const results = await loaded.session.run(feeds)
  const ms = Date.now() - started
  const output = results[loaded.session.outputNames[0]]
  return {
    samples: Float32Array.from(output.data),
    sampleRate: loaded.sampleRate,
    phonemes,
    tokens: ids.length,
    inferredMs: ms,
  }
}
