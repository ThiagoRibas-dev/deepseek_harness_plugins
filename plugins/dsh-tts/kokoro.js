/**
 * Kokoro synthesis: text → phonemes → tokens → waveform.
 *
 * Driven directly against `onnxruntime-node`, not through `kokoro-js`. The
 * graph takes three inputs (`input_ids`, `style`, `speed`) and the voice files
 * are plain float32 arrays, so the wrapper library would cost `sharp`,
 * `onnxruntime-web` and `@huggingface/jinja` to do work that fits in this file.
 *
 * The tokenizer is a bare character table: the model's `tokenizer.json` maps
 * roughly 100 IPA characters to ids, and a template wraps the sequence in `$`
 * (id 0). No tokenizer library is involved.
 */
import { readFileSync } from 'node:fs'

/**
 * Load `phonemizer` lazily with stdout muted.
 *
 * Its espeak-ng build is Emscripten output that prints its own source and
 * embedded data file to stdout while the WASM runtime initialises — tens of
 * kilobytes of noise. Left alone it lands in the host log on first use, so the
 * import and the first call are both wrapped.
 */
let espeakModule
function withStdoutMuted(fn) {
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    return fn()
  } finally {
    process.stdout.write = write
  }
}

async function loadEspeak() {
  if (espeakModule === undefined) {
    espeakModule = withStdoutMuted(() => import('phonemizer'))
  }
  return espeakModule
}

/** Kokoro's waveform sample rate. */
/**
 * Load `onnxruntime-node` and return whichever object actually carries
 * `InferenceSession`.
 *
 * Two shapes occur, and the difference cost a live prepare. Under plain `node`,
 * importing this CommonJS package yields a namespace with the named exports *and*
 * a synthesized `default`. Under the harness's plugin loader the namespace
 * carries the named exports but no usable `default`, so destructuring
 * `{ default: ort }` produced undefined and the failure surfaced far away, as
 * "Cannot read properties of undefined (reading 'InferenceSession')".
 *
 * Prefer the namespace when it already exposes the class and fall back to
 * `default`, so neither environment is special-cased by the caller.
 */
export async function loadOrt() {
  const namespace = await import('onnxruntime-node')
  const ort = typeof namespace?.InferenceSession === 'function' ? namespace : namespace?.default
  if (typeof ort?.InferenceSession !== 'function') {
    throw new Error('onnxruntime-node is loaded but exposes no InferenceSession')
  }
  return ort
}

export const SAMPLE_RATE = 24000

/** Voice style vectors are 256 floats per token-count row. */
export const STYLE_DIM = 256

/** Rows available in a voice file (0–509 tokens). */
export const STYLE_ROWS = 510

/** Maximum tokens the graph accepts, including the two `$` sentinels. */
export const MAX_TOKENS = 512

/** espeak-ng language for each voice's leading letter. */
const LANGUAGES = {
  a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi',
  i: 'it', j: 'ja', p: 'pt-br', z: 'cmn',
}

/** Voices whose text pipeline is the English one (normalization + post-processing). */
const ENGLISH = new Set(['a', 'b'])

/**
 * How each voice's language reads in a picker.
 *
 * English keeps the country, because that is the distinction a listener actually hears;
 * every other language speaks for itself.
 */
const LANGUAGE_NAMES = {
  'en-us': 'US', 'en-gb': 'UK', es: 'Spanish', 'fr-fr': 'French', hi: 'Hindi',
  it: 'Italian', ja: 'Japanese', 'pt-br': 'Brazilian Portuguese', cmn: 'Chinese',
}

/**
 * A voice id as a person would read it: `af_heart` → `Heart · US female`.
 *
 * Mechanical, from the id and the same letter table the phonemizer uses — nothing here is
 * recalled from a model card, so there is nothing to get wrong. An id that does not parse
 * is returned unchanged rather than guessed at: a wrong label is worse than a technical
 * one, and this way a broken label always looks wrong instead of looking plausible.
 *
 * @param id - a voice id without its extension, e.g. `af_heart`, `zf_xiaobei`.
 * @returns the label, or the id itself when it cannot be read.
 */
export function voiceLabel(id) {
  const match = /^([a-z])([fm])_([a-z0-9]+)$/.exec(String(id))
  if (match === null) return String(id)
  const [, language, gender, name] = match
  const where = LANGUAGE_NAMES[LANGUAGES[language]]
  if (where === undefined) return String(id)
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${where} ${gender === 'f' ? 'female' : 'male'}`
}

// ---- tokenizer -----------------------------------------------------------

/**
 * Load the model's character table.
 * @param path - `tokenizer.json`
 * @returns the vocabulary, from phoneme character to token id.
 */
export function loadVocab(path) {
  const tokenizer = JSON.parse(readFileSync(path, 'utf8'))
  const vocab = tokenizer?.model?.vocab
  if (vocab === null || typeof vocab !== 'object') {
    throw new Error(`tokenizer at ${path} has no model.vocab`)
  }
  return new Map(Object.entries(vocab))
}

/**
 * Map phonemes to token ids, wrapped in the `$` sentinel the template adds.
 *
 * Characters outside the table are dropped rather than mapped to an unknown
 * id, which is what the model's own normalizer does upstream of this.
 *
 * @returns token ids, truncated to the graph's limit.
 */
export function tokenize(phonemes, vocab) {
  const ids = [0]
  for (const character of phonemes) {
    const id = vocab.get(character)
    if (id !== undefined) ids.push(id)
    if (ids.length >= MAX_TOKENS - 1) break
  }
  ids.push(0)
  return ids
}

// ---- text normalization (English) ----------------------------------------

function splitNumber(match) {
  if (match.includes('.')) return match
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number)
    if (m === 0) return `${h} o'clock`
    return m < 10 ? `${h} oh ${m}` : `${h} ${m}`
  }
  const year = Number.parseInt(match.slice(0, 4), 10)
  if (year < 1100 || year % 1000 < 10) return match
  const left = match.slice(0, 2)
  const right = Number.parseInt(match.slice(2, 4), 10)
  const suffix = match.endsWith('s') ? 's' : ''
  if (year % 1000 >= 100) {
    if (right === 0) return `${left} hundred${suffix}`
    if (right < 10) return `${left} oh ${right}${suffix}`
  }
  return `${left} ${right}${suffix}`
}

function flipMoney(match) {
  const bill = match[0] === '$' ? 'dollar' : 'pound'
  if (Number.isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`
  if (!match.includes('.')) {
    return `${match.slice(1)} ${bill}${match.slice(1) === '1' ? '' : 's'}`
  }
  const [b, c] = match.slice(1).split('.')
  const d = Number.parseInt(c.padEnd(2, '0'), 10)
  const coins = match[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence'
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`
}

function pointNumber(match) {
  const [a, b] = match.split('.')
  return `${a} point ${b.split('').join(' ')}`
}

/**
 * Normalize English text for espeak, so numbers, currency and abbreviations are
 * spoken rather than spelled. Ported from the reference implementation; the
 * order of these passes matters.
 */
export function normalizeEnglish(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“').replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/、/g, ', ').replace(/。/g, '. ').replace(/！/g, '! ')
    .replace(/，/g, ', ').replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNumber)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim()
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]'
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRe(PUNCTUATION)}]+\\s*)+`, 'g')

/** Split on a regex while keeping the delimiters, which `String.split` will not do. */
function splitKeeping(text, regex) {
  const out = []
  let previous = 0
  for (const match of text.matchAll(regex)) {
    if (previous < match.index) out.push({ punctuation: false, text: text.slice(previous, match.index) })
    if (match[0].length > 0) out.push({ punctuation: true, text: match[0] })
    previous = match.index + match[0].length
  }
  if (previous < text.length) out.push({ punctuation: false, text: text.slice(previous) })
  return out
}

/**
 * Phonemize text for a voice.
 *
 * Punctuation is carried through verbatim rather than phonemized, because the
 * model uses it for phrasing and pauses.
 */
export async function phonemize(text, language = 'a') {
  const code = LANGUAGES[language]
  if (code === undefined) throw new Error(`unsupported voice language "${language}"`)
  const { phonemize: espeak } = await loadEspeak()
  const english = ENGLISH.has(language)
  const normalized = english ? normalizeEnglish(text) : text.trim()
  const sections = splitKeeping(normalized, PUNCTUATION_PATTERN)
  const parts = await withStdoutMuted(() => Promise.all(sections.map(async (section) =>
    section.punctuation ? section.text : (await espeak(section.text, code)).join(' '))))
  let phonemes = parts.join('')

  if (english) {
    phonemes = phonemes
      .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
      .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
      .replace(/ʲ/g, 'j')
      .replace(/r/g, 'ɹ')
      .replace(/x/g, 'k')
      .replace(/ɬ/g, 'l')
      .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
      .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    if (language === 'a') phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
  }
  return phonemes.trim()
}

// ---- voice and inference -------------------------------------------------

/**
 * Load a voice style file.
 * @returns 510 rows of 256 floats, indexed by token count.
 */
export function loadVoice(path) {
  const buffer = readFileSync(path)
  const expected = STYLE_ROWS * STYLE_DIM * 4
  if (buffer.length !== expected) {
    throw new Error(`voice ${path} is ${buffer.length} bytes, expected ${expected}`)
  }
  // The file is little-endian float32; copy rather than view, so the buffer is
  // not kept alive by the Float32Array.
  return Float32Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, STYLE_ROWS * STYLE_DIM))
}

/**
 * The style row the model selects for a given token count.
 *
 * Kokoro conditions on one row chosen by sequence length, which is why a short
 * sentence and a long one sound different even in the same voice.
 */
export function styleFor(voice, tokenCount) {
  const row = Math.min(Math.max(tokenCount - 2, 0), STYLE_ROWS - 1)
  return voice.subarray(row * STYLE_DIM, (row + 1) * STYLE_DIM)
}

/**
 * Run one synthesis pass.
 *
 * @param session - an `onnxruntime-node` InferenceSession.
 * @param inputIds - token ids from {@link tokenize}.
 * @param voice - style rows from {@link loadVoice}.
 * @param speed - speaking rate, 1 being the model's default.
 * @returns mono float32 samples at {@link SAMPLE_RATE}.
 */
export async function synthesize(session, { inputIds, voice, speed = 1 }) {
  const { Tensor } = await loadOrt()
  const ids = BigInt64Array.from(inputIds, (id) => BigInt(id))
  const feeds = {
    input_ids: new Tensor('int64', ids, [1, inputIds.length]),
    style: new Tensor('float32', styleFor(voice, inputIds.length), [1, STYLE_DIM]),
    speed: new Tensor('float32', Float32Array.from([speed]), [1]),
  }
  const { waveform } = await session.run(feeds)
  return Float32Array.from(waveform.data)
}

// ---- WAV -----------------------------------------------------------------

/**
 * Encode mono float32 samples as a PCM16 WAV.
 *
 * Kokoro already emits 24 kHz mono, so this is a 44-byte header and a
 * conversion — no resampling, no encoder.
 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at, value) => { for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/**
 * Concatenate rendered segments into one waveform.
 *
 * A gap is inserted *between* segments and never before the first or after the
 * last, so a passage that was split for length does not acquire a leading or
 * trailing silence — the caller's timing stays honest.
 *
 * @param parts - waveforms in order.
 * @param sampleRate - samples per second, for converting the gap.
 * @param gapMs - silence between segments.
 * @returns one waveform, or an empty one when there is nothing to join.
 */
export function joinSamples(parts, sampleRate = SAMPLE_RATE, gapMs = 180) {
  const pieces = parts.filter((part) => part !== undefined && part.length > 0)
  if (pieces.length === 0) return new Float32Array(0)
  if (pieces.length === 1) return pieces[0]
  const gap = Math.max(0, Math.round((gapMs / 1000) * sampleRate))
  const total = pieces.reduce((sum, part) => sum + part.length, 0) + gap * (pieces.length - 1)
  const out = new Float32Array(total)
  let at = 0
  pieces.forEach((part, index) => {
    if (index > 0) at += gap
    out.set(part, at)
    at += part.length
  })
  return out
}
