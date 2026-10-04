/**
 * The TTS plugin: a profile-global service that turns text into speech.
 *
 * Deliberately not a tool. The model should not be choosing whether to run a
 * synthesizer any more than it chooses whether to write a transcript — the
 * client decides what to speak, and this service does the speaking.
 *
 * Phase 1 scope: host synthesis plus the preparation state machine that a
 * Prepare card renders. No HTTP route, no client UI, no tone pass yet.
 *
 * The preparation vocabulary (`unprepared · checking · downloading · verify ·
 * loading · ready · failed · cancelled`, byte-level progress, typed failures)
 * follows the harness's SenseVoice provider, because that shape was designed
 * against a real first-run-download problem and is worth matching.
 */
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssetError, cachePath, ensureAsset, isPinned } from './download.js'
import { compileDelivery } from './delivery.js'
import { createToneReader } from './tone.js'
import { attachPreference } from './preference.js'
import { createSettingsStore, settingsPath } from './settings.js'
import { stripForSpeech } from './speech-text.js'
import { catalogueVoices, loadPiperVoice, piperVoiceLabel, synthesizePiper } from './piper.js'
import { createRouteHandler } from './route.js'
import {
  SAMPLE_RATE, STYLE_DIM, STYLE_ROWS, encodeWav, joinSamples, loadOrt, loadVocab, loadVoice, phonemize,
  synthesize, tokenize, voiceLabel,
} from './kokoro.js'
import { segmentText } from './segment.js'

export const name = 'tts'

/** The tool registry, so readiness can be reported to an agent as well as to a UI. */
export const inject = ['tools']

/** The row's config schema, so the Loader validates the patch and the settings
 * service can persist the volatile fields. Declared in `config.js` so it can be
 * checked offline against the real schemastery. */
export { Config } from './config.js'

/**
 * Read one config value.
 *
 * A field declared `.volatile()` arrives from the Loader as a `Volatile`
 * accessor rather than a plain value, because the settings service may replace it
 * at runtime — `speech-to-text` reads its own the same way. Plain values pass
 * through, so the module still works when constructed directly, as the offline
 * suite does.
 */
function setting(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') return value.get() ?? fallback
  return value
}

/** The assets this plugin pins. */
const ASSETS = JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8'))

/** Bytes a full prepare will fetch: the graph, the three small files, and one voice. */
export function setupEstimate(voice = 'af_heart.bin') {
  const voiceBytes = ASSETS.voices[voice]?.bytes ?? 0
  const files = Object.values(ASSETS.files).reduce((sum, f) => sum + f.bytes, 0)
  return {
    recommendedDiskBytes: ASSETS.model.bytes + files + voiceBytes,
    // The graph dominates; ~1.6x its size covers the runtime plus the waveform.
    expectedMemoryBytes: Math.round(ASSETS.model.bytes * 1.6),
    minimumMinutes: 1,
    maximumMinutes: 5,
    // Optional and lazily fetched: only a profile that turns on the tone pass pays
    // this, and the built-in heuristic covers the case where it is never fetched.
    optionalToneBytes: ASSETS.tone.model.bytes
      + Object.values(ASSETS.tone.files).reduce((sum, f) => sum + f.bytes, 0),
  }
}

/** Every voice this build can speak with. */
export function listVoices() {
  // The upstream `voices/` directory also carries `af.bin`, which is 512 rows
  // rather than the 510 a voice file has — an aggregate, not a voice. Selecting it
  // would index past the end of the style table, so voices are filtered by the
  // one property that decides usability rather than by a hardcoded name.
  const expected = STYLE_ROWS * STYLE_DIM * 4
  return Object.entries(ASSETS.voices)
    .filter(([, meta]) => meta.bytes === expected)
    .map(([file, meta]) => {
      const id = file.replace(/\.bin$/, '')
      return {
        id,
        // A grade appears only when the manifest carries one. It is somebody else's
        // judgement, and this file does not assert what it cannot cite — so the field is
        // supported and empty rather than invented.
        ...(typeof meta.grade === 'string' ? { grade: meta.grade } : {}),
        label: voiceLabel(id),
        bytes: meta.bytes,
      }
    })
}

/**
 * Create the preparation state machine for one voice.
 *
 * State is host-owned and survives a client disconnecting; `prepare()` joins an
 * in-flight run rather than starting a second one.
 */
function createPreparation({ dataRoot, voice, threads = () => 1 }) {
  const listeners = new Set()
  let state = { phase: 'unprepared' }
  let running = null
  let cancelled = false
  let loaded = null
  // A fresh controller per run, so a cancelled prepare does not poison the next one.
  let lifetime = new AbortController()

  const emit = (next) => {
    state = { ...next }
    for (const listener of listeners) listener()
  }

  // The estimate travels with the snapshot so a Prepare card can show what a first
  // run costs *before* it starts. Without it the card silently omits the size line,
  // which defeats the point of having one.
  const snapshot = () => ({ ...state, estimate: setupEstimate(`${voice}.bin`) })
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const voiceFile = `${voice}.bin`
  const voiceMeta = ASSETS.voices[voiceFile]
  if (voiceMeta === undefined) throw new Error(`unknown voice "${voice}"`)

  /** Resolve and verify every pinned asset, then load the graph. */
  async function run() {
    const root = join(dataRoot, 'models', 'kokoro', ASSETS.revision.slice(0, 12))
    const paths = {
      model: cachePath(root, ASSETS.model.path),
      voice: cachePath(root, `voices/${voiceFile}`),
    }
    const steps = [
      { kind: 'check', status: 'pending' },
      { kind: 'model', status: 'pending' },
      { kind: 'voice', status: 'pending' },
      { kind: 'verify', status: 'pending' },
      { kind: 'load', status: 'pending' },
    ]
    const setStep = (kind, status) => {
      const step = steps.find((s) => s.kind === kind)
      if (step) step.status = status
    }
    const report = (phase, extra = {}) => {
      if (cancelled) throw new AssetError('preparation cancelled', { reason: 'cancelled' })
      emit({ phase, steps: steps.map((s) => ({ ...s })), ...extra })
    }

    report('checking', { step: 'check', startedAt: Date.now() })
    const totalBytes = ASSETS.model.bytes + Object.values(ASSETS.files).reduce((n, f) => n + f.bytes, 0) + voiceMeta.bytes
    let completedBytes = 0

    setStep('check', 'complete')
    setStep('model', 'running')
    report('downloading', { step: 'model', resource: ASSETS.model.path, completedBytes, totalBytes })

    const onProgress = ({ completedBytes: done, phase }) => {
      if (phase === 'downloading') {
        emit({
          phase: 'downloading', step: 'model', resource: ASSETS.model.path,
          completedBytes: completedBytes + done, totalBytes, steps: steps.map((s) => ({ ...s })),
        })
      }
    }

    // Small files first: they are quick, and a failure here costs seconds.
    for (const [file, meta] of Object.entries(ASSETS.files)) {
      await ensureAsset({
        url: ASSETS.baseUrl + file, asset: { ...meta, path: file },
        dest: cachePath(root, file), signal: lifetime.signal,
      })
      completedBytes += meta.bytes
    }
    await ensureAsset({
      url: ASSETS.baseUrl + ASSETS.model.path, asset: { ...ASSETS.model, path: ASSETS.model.path },
      dest: paths.model, signal: lifetime.signal, onProgress,
    })
    completedBytes += ASSETS.model.bytes
    setStep('model', 'complete')
    setStep('voice', 'running')

    await ensureAsset({
      url: ASSETS.baseUrl + `voices/${voiceFile}`, asset: { ...voiceMeta, path: voiceFile },
      dest: paths.voice, signal: lifetime.signal,
    })
    setStep('voice', 'complete')
    setStep('verify', 'running')
    report('checking', { step: 'verify', startedAt: Date.now() })

    const tokenizer = cachePath(root, 'tokenizer.json')
    const ok = await isPinned(paths.model, ASSETS.model, lifetime.signal)
    if (!ok) throw new AssetError('model failed verification after download', { reason: 'integrity' })
    setStep('verify', 'complete')
    setStep('load', 'running')
    report('loading', { step: 'load', startedAt: Date.now() })

    const ort = await loadOrt()
    // The thread count is read here rather than captured at mount, so changing it in
    // the settings pane lands on the next prepare. `1` is the measured default on this
    // host; `2` is the untested and more interesting value on a 2-core CPU.
    const session = await ort.InferenceSession.create(paths.model, { intraOpNumThreads: threads() })
    const vocab = loadVocab(tokenizer)
    const voiceData = loadVoice(paths.voice)
    setStep('load', 'complete')
    loaded = { session, vocab, voiceData, voice, sampleRate: SAMPLE_RATE }
    emit({ phase: 'ready', steps: steps.map((s) => ({ ...s })) })
    return loaded
  }

  return {
    snapshot,
    subscribe,
    get loaded() { return loaded },
    prepare() {
      if (state.phase === 'ready') return Promise.resolve(loaded)
      if (running === null) lifetime = new AbortController()
      cancelled = false
      running ??= run().catch((error) => {
        running = null
        emit({
          phase: 'failed',
          message: error.message,
          ...(error instanceof AssetError ? { download: error.download } : {}),
        })
        throw error
      })
      return running
    },
    async cancel() {
      cancelled = true
      lifetime.abort(new AssetError('preparation cancelled', { reason: 'cancelled' }))
      running = null
      emit({ phase: 'cancelled' })
    },
  }
}

export function apply(ctx, config = {}) {
  const dataRoot = setting(config.dataRoot, join(process.cwd(), '.dsh-tts'))
  // Say it out loud. A `dataRoot` lost in a profile override silently relocates every
  // model *and* every stored setting, and the only symptom is a puzzling "voice is not
  // on disk" a long way from the cause — which is exactly how this was found.
  if (setting(config.dataRoot, undefined) === undefined) {
    ctx.logger?.warn?.(`tts: no dataRoot configured; falling back to ${dataRoot} — models and settings will look misplaced`)
  }
  // The pane's write path. A stored value beats the shipped config, and an absent key
  // means the user never changed it — so the patch stays the default, not a duplicate.
  const settings = createSettingsStore({ file: settingsPath(dataRoot), logger: ctx.logger })
  const defaultVoice = settings.get('voice', setting(config.voice, 'af_heart'))
  const speed = setting(config.speed, 1)
  // Volatile fields are read per use rather than captured here: the settings
  // service replaces them at runtime, and a value snapshotted at mount would
  // never see the change.
  const profileDefault = () => setting(config.autoEnabled, false)
  const standingInstructions = () => settings.get('instructions', setting(config.instructions, ''))
  const toneWanted = () => settings.get('toneEnabled', setting(config.toneEnabled, true))
  const segmentBudget = () => setting(config.segmentChars, 400)
  // Clamped in code as well as in the schema, so a hand-edited profile entry cannot
  // hand onnxruntime a fractional or absurd thread count. The stored value wins over
  // the config, and it is read when a session is created — so a change lands on the
  // next prepare, which for a new engine or voice is immediate.
  const onnxThreads = () => Math.max(1, Math.min(16, Math.round(settings.get('threads', setting(config.threads, 1)))))

  // The tone classifier is opt-in and lazy: it is a second model, and nothing
  // should fetch 82 MB for a profile that never turns the tone pass on. Failure
  // is non-fatal by design — the built-in text heuristic always works.
  let toneReader
  let toneUnavailable = false
  const toneFor = async (text) => {
    if (toneUnavailable) return null
    if (toneReader === undefined) {
      try {
        const root = join(dataRoot, 'models', 'tone', ASSETS.tone.revision.slice(0, 12))
        for (const [file, meta] of Object.entries(ASSETS.tone.files)) {
          await ensureAsset({
            url: ASSETS.tone.baseUrl + file, asset: { ...meta, path: file }, dest: cachePath(root, file),
          })
        }
        await ensureAsset({
          url: ASSETS.tone.baseUrl + ASSETS.tone.model.path,
          asset: { ...ASSETS.tone.model, path: ASSETS.tone.model.path },
          dest: cachePath(root, ASSETS.tone.model.path),
        })
        toneReader = await createToneReader({
          model: cachePath(root, ASSETS.tone.model.path),
          tokenizerJson: cachePath(root, 'tokenizer.json'),
          tokenizerConfig: cachePath(root, 'tokenizer_config.json'),
        })
        ctx.logger?.info?.('tts: tone classifier ready')
      } catch (error) {
        toneReader = null
        toneUnavailable = true
        ctx.logger?.warn?.(`tts: tone classifier unavailable, using the text heuristic: ${error.message}`)
      }
    }
    if (toneReader === null) return null
    try { return await toneReader.read(text) } catch { return null }
  }

  const preparations = new Map()
  const forVoice = (voice) => {
    let preparation = preparations.get(voice)
    if (preparation === undefined) {
      preparation = createPreparation({ dataRoot, voice, threads: onnxThreads })
      preparations.set(voice, preparation)
    }
    return preparation
  }

  // ---- providers -----------------------------------------------------------
  //
  // Two engines behind one service. Measured on this host, same sentence: Kokoro
  // RTF 2.32–2.73 (quality), Piper RTF 0.38 (fast). The choice is profile-wide rather
  // than per-chat, because it decides which graph is resident and nothing yet needs
  // two chats to disagree about it.
  const piperRoot = join(dataRoot, 'models', 'piper')
  /** The manifest as a catalogue: every pinned voice, fetched or not. */
  const piperCatalogue = () => catalogueVoices(ASSETS.piper, piperRoot)
  const piperPreparations = new Map()

  /** The engines this build offers, in the order a picker should show them. */
  const PROVIDERS = [
    { id: 'kokoro', engine: 'kokoro-local', name: 'Kokoro (quality, slow)' },
    { id: 'piper', engine: 'piper-local', name: 'Piper (fast)' },
  ]

  /**
   * What one Piper voice costs, from its pins rather than from a constant.
   *
   * The disk figure is exact: the pins record 63,206,176 bytes for a medium voice and
   * 113,900,084 for `lessac-high`. The memory figure applies the same rule of thumb
   * Kokoro's estimate uses — 1.6× the graph, covering the runtime and the waveform.
   */
  const piperEstimate = (entry) => {
    const bytes = entry?.bytes ?? 64 * 1024 * 1024
    return {
      recommendedDiskBytes: bytes,
      expectedMemoryBytes: Math.round(bytes * 1.6),
      minimumMinutes: 1,
      maximumMinutes: 2,
    }
  }

  const providerId = () => (settings.get('provider', setting(config.provider, 'kokoro')) === 'piper' ? 'piper' : 'kokoro')
  /** Which stored key holds the active engine's voice. */
  const voiceKey = (id) => (id === 'piper' ? 'piperVoice' : 'voice')
  const providerVoices = (id) => (id === 'piper'
    ? piperCatalogue().map((entry) => entry.id)
    : listVoices().map((entry) => entry.id))

  /** The active voice: the user's choice, else that engine's own default. */
  const activeVoice = () => {
    const id = providerId()
    // Piper's fallback is the first voice already on disk. Flipping the engine should
    // start speaking, not start a 63 MB download because of manifest order.
    const catalogue = id === 'piper' ? piperCatalogue() : []
    const fallback = id === 'piper'
      ? (catalogue.find((entry) => entry.present) ?? catalogue[0])?.id ?? ''
      : defaultVoice
    return settings.get(voiceKey(id), fallback) || fallback
  }

  /**
   * Piper's preparation: fetch what is missing, verify it, then load it.
   *
   * The manifest is the catalogue, so a pinned voice is selectable *before* it has been
   * fetched — and this is where the fetch happens, through `ensureAsset`, which is the
   * same verified path Kokoro's graph takes. Nothing here needs a command run by hand,
   * which was the point of making the manifest the catalogue in the first place.
   *
   * Phases and step kinds deliberately mirror Kokoro's: the pane renders one vocabulary,
   * and a second dialect would show up as a card that never updates.
   */
  const createPiperPreparation = (voice) => {
    const listeners = new Set()
    let state = { phase: 'unprepared' }
    let loaded = null
    let running = null
    let cancelled = false
    // A fresh controller per run, so a cancelled download does not poison the next one.
    let lifetime = new AbortController()
    const emit = (next) => { state = { ...next }; for (const listener of listeners) listener() }
    const entry = () => piperCatalogue().find((candidate) => candidate.id === voice)
    return {
      snapshot: () => ({
        ...state,
        estimate: piperEstimate(entry()),
        // One step, because for Piper the graph *is* the voice. `status` is derived from
        // the phase rather than tracked separately, so the two cannot disagree.
        steps: [{
          kind: 'voice',
          status: loaded !== null ? 'complete' : (state.phase === 'unprepared' ? 'pending' : 'running'),
        }],
      }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      get loaded() { return loaded },
      prepare() {
        if (loaded !== null) return Promise.resolve(loaded)
        if (running !== null) return running
        const meta = entry()
        if (meta === undefined) {
          // Pinned voices *are* the catalogue, so reaching here means the id is not in the
          // manifest at all — a different fault from "pinned but not fetched", and it
          // needs a different fix, so it gets a different message.
          const message = `piper voice "${voice}" is not in the manifest — pin it in assets.json to offer it`
          emit({ phase: 'failed', message })
          return Promise.reject(new Error(message))
        }
        cancelled = false
        lifetime = new AbortController()
        running = (async () => {
          const missing = meta.files.filter((file) => !existsSync(file.dest))
          const totalBytes = missing.reduce((sum, file) => sum + file.asset.bytes, 0)
          let done = 0
          if (missing.length > 0) {
            emit({ phase: 'downloading', step: 'voice', resource: meta.id, completedBytes: 0, totalBytes })
            for (const file of missing) {
              const before = done
              await ensureAsset({
                url: file.url, asset: file.asset, dest: file.dest, signal: lifetime.signal,
                onProgress: ({ completedBytes, phase }) => {
                  if (phase !== 'downloading') return
                  emit({
                    phase: 'downloading', step: 'voice', resource: file.name,
                    completedBytes: before + completedBytes, totalBytes,
                  })
                },
              })
              done += file.asset.bytes
            }
            // Only after a fetch: re-reading 63 MB on every prepare to confirm what was
            // already confirmed last time would cost more than it protects.
            const model = meta.files.find((file) => file.name.endsWith('.onnx'))
            const ok = await isPinned(model.dest, model.asset, lifetime.signal)
            if (!ok) throw new AssetError('piper voice failed verification after download', { reason: 'integrity' })
          }
          if (cancelled) throw new AssetError('preparation cancelled', { reason: 'cancelled' })
          emit({ phase: 'loading', step: 'voice' })
          const session = await loadPiperVoice(meta, { threads: onnxThreads() })
          loaded = session
          emit({ phase: 'ready' })
          return session
        })().catch((error) => {
          running = null
          emit({ phase: cancelled ? 'cancelled' : 'failed', message: error.message })
          throw error
        })
        return running
      },
      async cancel() {
        // Aborting matters now in a way it never did before: a 63 MB fetch over a slow
        // link is exactly the thing a user presses Cancel on.
        cancelled = true
        lifetime.abort()
        running = null
        emit({ phase: 'cancelled' })
      },
    }
  }

  const forPiperVoice = (voice) => {
    let preparation = piperPreparations.get(voice)
    if (preparation === undefined) {
      preparation = createPiperPreparation(voice)
      piperPreparations.set(voice, preparation)
    }
    return preparation
  }

  /** The preparation the UI and the route should be talking about right now. */
  const activePreparation = () => (providerId() === 'piper' ? forPiperVoice(activeVoice()) : forVoice(activeVoice()))

  /**
   * Speak through Piper, one segment at a time.
   *
   * The delivery compiler still runs, so speed and the refusal list are shared with
   * Kokoro — but the voice family is constrained to the one model on disk, which turns
   * "a british woman" into a no-op rather than a lie.
   */
  const speakPiper = async (text, options = {}) => {
    const voice = options.voice ?? activeVoice()
    const wantsTone = options.toneEnabled ?? toneWanted()
    const plan = compileDelivery({
      instructions: options.instructions ?? standingInstructions(),
      text,
      toneEnabled: wantsTone,
      defaultVoice: voice,
      voices: [voice],
      ...(wantsTone ? { textPace: await toneFor(text) ?? undefined } : {}),
    })
    const loaded = await forPiperVoice(voice).prepare()
    const speed = options.speed ?? plan.speed
    const started = Date.now()

    const segments = segmentText(text, { maxChars: segmentBudget() })
    const rendered = []
    for (const segment of segments) {
      rendered.push((await synthesizePiper(loaded, { text: segment, speed })).samples)
    }
    // Piper's own rate, not Kokoro's — 22 050 Hz — and `encodeWav` takes it per call.
    const samples = joinSamples(rendered, loaded.sampleRate)
    return {
      wav: encodeWav(samples, loaded.sampleRate),
      seconds: samples.length / loaded.sampleRate,
      segments: segments.length,
      inferredMs: Date.now() - started,
      voice,
      delivery: plan,
    }
  }

  const service = {
    /** Provider facts, mirroring the shape a preparation UI expects. */
    get info() {
      const id = providerId()
      const provider = PROVIDERS.find((entry) => entry.id === id)
      return {
        id: provider.engine,
        name: provider.name,
        location: 'host-local',
        voices: service.voiceDetails(),
        // Per voice, not per engine: the pins record each voice's real size, and
        // `lessac-high` is nearly twice a medium.
        setupEstimate: id === 'piper'
          ? piperEstimate(piperCatalogue().find((entry) => entry.id === activeVoice()))
          : setupEstimate(),
      }
    },
    /** The active engine's voice. A getter, because the engine can change under it. */
    get voice() { return activeVoice() },
    get preparation() { return activePreparation() },

    // `attachHttpRoute` is a top-level function, so it cannot see this closure. Everything
    // the route needs is therefore reached through `service`. Referencing these directly
    // inside its options object threw `providerVoices is not defined` on every request —
    // the pane printed the error and the Voice picker came back empty.
    /** The active engine, the thread count its sessions were built with, and where
     * the plugin believes its files live — because "the voice is not on disk" is
     * indistinguishable from "we looked in the wrong place" without them. */
    engine: () => ({
      provider: providerId(),
      threads: onnxThreads(),
      dataRoot,
      piperRoot,
      settingsFile: settingsPath(dataRoot),
      settingsExists: existsSync(settingsPath(dataRoot)),
      voiceList: providerVoices(providerId()),
    }),
    /** The active engine's voices, for the route's picker and its validation. */
    listVoices: () => providerVoices(providerId()),
    /**
     * Voices with the two extra facts a picker needs: whether the files are on disk, and
     * how big they are.
     *
     * Both engines need this, not just Piper — a Kokoro style vector is fetched per voice
     * exactly as a Piper model is, so an unfetched Kokoro voice is just as invisible
     * without it. Presence is existence rather than a hash: hashing every voice to render
     * a list would read hundreds of megabytes.
     */
    voiceDetails: () => {
      if (providerId() === 'piper') {
        return piperCatalogue().map(({ id, present, bytes }) => ({
          id, present, bytes, label: piperVoiceLabel(id),
        }))
      }
      const root = join(dataRoot, 'models', 'kokoro', ASSETS.revision.slice(0, 12))
      return listVoices().map((entry) => ({
        id: entry.id,
        label: entry.label,
        ...(entry.grade === undefined ? {} : { grade: entry.grade }),
        bytes: entry.bytes,
        present: existsSync(cachePath(root, `voices/${entry.id}.bin`)),
      }))
    },
    /** The engines on offer, for the route's validation. */
    providers: PROVIDERS.map((entry) => ({ id: entry.id, name: entry.name })),

    /** Current preparation state for the selected voice. */
    snapshot: () => activePreparation().snapshot(),
    subscribe: (listener) => activePreparation().subscribe(listener),
    prepare: () => activePreparation().prepare(),
    cancel: () => activePreparation().cancel(),

    /** Switch engines. Profile-wide, and stored, so it survives a restart. */
    setProvider(id) {
      if (!PROVIDERS.some((entry) => entry.id === id)) throw new Error(`unknown provider "${id}"`)
      settings.set({ provider: id })
      return providerId()
    },

    /** Select a voice; a different voice needs its own model prepared. */
    setVoice(voice) {
      const id = providerId()
      if (!providerVoices(id).includes(voice)) throw new Error(`unknown voice "${voice}" for ${id}`)
      // The pane's choice outlives the process; the config is only its default.
      settings.set({ [voiceKey(id)]: voice })
      return activeVoice()
    },

    /**
     * Speak one segment.
     *
     * Intent is compiled into Kokoro's two real controls before anything is
     * synthesized, so `instructions` and the tone pass actually reach the audio
     * rather than being decorative config.
     *
     * @returns WAV bytes, the audio duration, how long synthesis took, and the
     *   delivery plan that was used — including anything that could not be honoured.
     */
    async synthesize(text, options = {}) {
      // One filter, first, so every engine and every trigger inherits it: markdown markers
      // and tabletop mechanics read terribly aloud, and the tone classifier reads this
      // same string. `raw: true` is the escape hatch for a caller that wants the source
      // text read verbatim. Reassigning the parameter keeps the dispatch below — and the
      // Piper path it hands off to — working on the filtered text.
      if (options.raw !== true) text = stripForSpeech(text)
      // One service, two engines: the active provider decides which pipeline runs.
      if (providerId() === 'piper') return speakPiper(text, options)
      const wantsTone = options.toneEnabled ?? toneWanted()
      const plan = compileDelivery({
        instructions: options.instructions ?? standingInstructions(),
        text,
        toneEnabled: wantsTone,
        defaultVoice: service.voice,
        voices: listVoices().map((entry) => entry.id),
        // A classifier reading when one is available; otherwise undefined and the
        // compiler falls back to its own heuristic.
        ...(wantsTone ? { textPace: await toneFor(text) ?? undefined } : {}),
      })
      // An explicit voice still wins: the caller asked for a specific one.
      const voice = options.voice ?? plan.voice
      const loaded = await forVoice(voice).prepare()
      const speed = options.speed ?? plan.speed
      const started = Date.now()

      // Segment before synthesizing, not after: `tokenize` stops at MAX_TOKENS, so
      // a long passage used to be truncated mid-sentence and returned as though it
      // were complete. Segmenting is a correctness fix, not just a length one.
      const segments = segmentText(text, { maxChars: segmentBudget() })
      const rendered = []
      for (const segment of segments) {
        const phonemes = await phonemize(segment, voice.slice(0, 1))
        const ids = tokenize(phonemes, loaded.vocab)
        rendered.push(await synthesize(loaded.session, {
          inputIds: ids, voice: loaded.voiceData, speed,
        }))
      }

      // Joined as samples and encoded once, so the WAV header describes the whole
      // passage rather than the first segment.
      const samples = joinSamples(rendered, loaded.sampleRate)
      return {
        wav: encodeWav(samples, loaded.sampleRate),
        seconds: samples.length / loaded.sampleRate,
        segments: segments.length,
        inferredMs: Date.now() - started,
        voice,
        delivery: plan,
      }
    },
  }

  ctx.provide('tts', service)
  // The read/write pair behind the settings pane. Values are validated in `route.js`
  // (which owns the voice list) and stored in `settings.js` (which owns what it can
  // hold); reading resolves file-then-config, so the patch stays a default.
  const readSettings = () => ({
    provider: providerId(),
    providers: PROVIDERS.map((entry) => ({ id: entry.id, name: entry.name })),
    voice: service.voice,
    voices: providerVoices(providerId()),
    toneEnabled: toneWanted(),
    instructions: standingInstructions(),
    threads: onnxThreads(),
  })
  const writeSettings = (patch) => {
    // The engine first, so a voice written alongside it is validated against the
    // engine it belongs to.
    if (typeof patch.provider === 'string') service.setProvider(patch.provider)
    // Either key means "the active engine's voice". The pane sends `voice` and never has to
    // know that Piper keeps its choice under `piperVoice` — but `piperVoice` is a
    // legitimate key for an API caller, so both are accepted and normalised here rather
    // than in the client. Either way the write goes through `setVoice`, which validates the
    // name against the active engine and throws before anything is stored; a raw
    // `settings.set` would do neither.
    const requested = typeof patch.voice === 'string' ? patch.voice
      : (typeof patch.piperVoice === 'string' ? patch.piperVoice : undefined)
    if (requested !== undefined) service.setVoice(requested)
    const rest = { ...patch }
    delete rest.provider
    delete rest.voice
    delete rest.piperVoice
    if (Object.keys(rest).length > 0) settings.set(rest)
    return readSettings()
  }
  // The per-chat preference is plugin-owned state, not a session event. It used to be
  // a session projection, and appending `'tts/preference'` made every session that
  // touched it unloadable — `Session.append()` cannot set the `ignorable` marker the
  // persistence reader requires for an unknown type. `preference.js` carries the full
  // explanation; the file it writes lands beside the models under `dataRoot`.
  attachPreference(ctx, service, { profileDefault, dataRoot })
  attachHttpRoute(ctx, config, service, { setting, listVoices, dataRoot, readSettings, writeSettings })
  registerStatusTool(ctx, service)
  ctx.logger?.info?.(`tts: kokoro ready to prepare (${listVoices().length} voices, ${setupEstimate().recommendedDiskBytes} bytes)`)
}

/**
 * A read-only readiness report.
 *
 * The *synthesis* path is deliberately a service rather than a tool — the model
 * should not be choosing whether to speak. Reporting readiness is the opposite
 * case: it is exactly the kind of question a model or a user should be able to
 * ask, and it is the only surface that proves from inside a session that this
 * plugin actually loaded.
 */
function registerStatusTool(ctx, service) {
  const render = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  ctx.tools.register(defineTool({
    name: 'tts_status',
    description:
      'Report the state of local text-to-speech: whether the model is prepared, how much disk and memory it needs, '
      + 'the selected voice, and the voices available. Read-only; it does not download or synthesize anything.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    execute() {
      const state = service.snapshot()
      return {
        // Where the plugin thinks it is, first: a path problem and a files problem
        // look identical from the outside otherwise.
        ...service.engine(),
        provider: service.info.id,
        location: service.info.location,
        voice: service.voice,
        preparation: state.phase,
        steps: state.steps?.map((step) => `${step.kind}:${step.status}`) ?? [],
        ready: state.phase === 'ready',
        estimate: service.info.setupEstimate,
        voiceCount: service.info.voices.length,
        ...(state.message === undefined ? {} : { message: state.message }),
      }
    },
  }))
}

/**
 * Serve the HTTP surface, when the harness has a webserver to serve it on.
 *
 * Registered as a *prefix* route, so the dispatcher owns every sub-path and can
 * answer 404 itself rather than falling through to the SPA's index.html.
 *
 * The option object is built from getters rather than values so that every
 * volatile setting is read per request. A token captured at mount could not be
 * rotated, and an operator turning the API on would have to restart.
 */
function attachHttpRoute(ctx, config, service, { setting, listVoices, readSettings, writeSettings }) {
  const prefix = setting(config.apiPath, '/v1/audio')

  // `webServer` is NOT guaranteed to exist when this plugin applies, and the
  // failure is silent: `ctx.get` returned undefined, so neither the route nor the
  // index tap was ever registered, and every request fell through to the SPA as a
  // 404 with an empty body. That is precisely what the first live run showed.
  //
  // The scoped `ctx.inject(deps, cb)` form is how the rest of the harness waits
  // for a service that may arrive later — `gateway` and `client/modules` both use
  // it — so the callback runs when the service exists, not when this plugin
  // happens to load.
  ctx.inject(['webServer'], (webCtx) => {
  const webServer = webCtx.webServer
  const options = {
    get enabled() { return setting(config.apiEnabled, false) },
    get token() { return setting(config.apiToken, '') },
    get allowAnonymous() { return setting(config.apiAllowAnonymous, false) },
    get maxInputChars() { return setting(config.apiMaxInputChars, 2000) },
    // These are getters rather than values because the engine can change while the route
    // is mounted: `routeRequest` re-reads its options on every request, so a switch is
    // visible immediately instead of after a restart. All three read through `service`,
    // which is the only scope this function shares with `apply`.
    get defaultVoice() { return service.voice },
    get voices() { return service.listVoices() },
    // Presence and size, so a picker can label a voice that has not been downloaded yet.
    get voiceDetails() { return service.voiceDetails() },
    get providers() { return service.providers.map((entry) => entry.id) },
    prefix,
    synthesize: (text, opts) => service.synthesize(text, opts),
    status: () => ({ ...service.snapshot(), ...service.engine(), voice: service.voice }),
    prepare: () => service.prepare(),
    cancel: () => service.cancel(),
    // The per-chat toggle is a session projection, which is host state — so the
    // client reads and writes it through here rather than owning it. Resolving
    // the id is what makes the write durable: `setChatAuto` appends a session
    // event, so the choice survives resume.
    readPreference: resolveSession(ctx, (session) => service.preference(session)),
    writePreference: resolveSession(ctx, (session, auto) => service.setChatAuto(session, auto)),
    // The settings pane's own values, which are profile-wide rather than per-chat.
    readSettings,
    writeSettings,
    /**
     * Everything a watcher needs to decide whether to speak, in one call: the newest
     * assistant message in the session, plus the chat's stored preference.
     *
     * "Is this the newest?" is what separates a reply that just arrived from a node
     * scrolled back into view, and only the host can answer it — the durable log is where
     * that order lives. Returning the preference alongside keeps the client to one read
     * instead of two, which also shrinks the window in which a toggle flipped mid-reply
     * could leave the two answers disagreeing.
     *
     * A linear scan rather than `findLast`, so a small thing does not depend on the
     * host's Node version.
     */
    latest: (sessionId) => {
      const session = ctx.get?.('sessions')?.get(sessionId)
      if (session === undefined) return undefined
      const messages = session.deriveMessages()
      const newest = messages.slice().reverse().find((message) => message.role === 'assistant')
      return { messageId: newest?.id, ...service.preference(session) }
    },
    // The browser half knows a message id, not its words. Reading the text where
    // the Session already is keeps that logic out of the client and works for a
    // message the client never rendered.
    resolveMessage: (sessionId, messageId) => {
      const session = ctx.get?.('sessions')?.get(sessionId)
      if (session === undefined) return undefined
      const message = session.deriveMessages().find((entry) => entry.id === messageId)
      if (message === undefined || message.role !== 'assistant') return undefined
      // Returns the text even when it is empty: "exists but nothing to say" and
      // "no such message" are different answers, and the route reports them
      // differently rather than calling both a 404.
      return (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
    },
  }
  webCtx.effect(() => webServer.register({
    kind: 'prefix', path: prefix, handler: createRouteHandler(options),
  }), 'tts.http-route')

  // The route authenticates itself, because plugin routes inherit none of the
  // harness's own authentication — so the browser half needs the credential, and
  // the page is only ever served to an already-authenticated browser. Injecting
  // it into the document is the standard way to bridge that; a rotated token
  // needs a page refresh, which is an acceptable trade for not having a second
  // authentication story.
  if (typeof webServer.tapIndex !== 'function') {
    ctx.logger?.warn?.('tts: webServer has no tapIndex; the browser half will not receive its credential')
    return
  }
  webCtx.effect(() => webServer.tapIndex((html) => {
    const identity = { prefix, token: setting(config.apiToken, '') }
    const tag = `<script>window.__DSH_TTS__=${JSON.stringify(identity).replace(/</g, '\\u003c')}</script>`
    return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
  }), 'tts.index-identity')
  ctx.logger?.info?.(`tts: HTTP API mounted at ${prefix} (enabled: ${setting(config.apiEnabled, false)})`)
  })

  // A dependency that never resolves is invisible: the callback above simply does
  // not run, and the plugin looks healthy while its API does not exist. That is
  // how the first live run failed, so say so out loud instead.
  if (ctx.get?.('webServer', false) === undefined) {
    ctx.logger?.info?.('tts: webServer is not up yet; the HTTP API will mount when it is')
  }
}

/**
 * Wrap a per-session call so it returns `undefined` for an unknown id.
 *
 * The route turns that into a 404 rather than a 500, because "no such session"
 * is a caller error and the two should not look alike.
 */
function resolveSession(ctx, use) {
  return (sessionId, ...rest) => {
    const sessions = ctx.get?.('sessions')
    if (sessions === undefined) return undefined
    const session = sessions.get(sessionId)
    if (session === undefined) return undefined
    return use(session, ...rest)
  }
}
