/**
 * The delivery compiler: free-form intent and text in, Kokoro parameters out.
 *
 * Kokoro's entire control surface is `voice` and `speed`. There is no prompt, no
 * emotion embedding, and no volume — the "style" in its architecture name is the
 * voice file. So an instructions field cannot be handed to the model; it has to
 * be *compiled* into the parameters the model actually accepts. That is this
 * module, and it is the reason the tone toggle matters: without something that
 * reads the text, the instructions field has nothing to act on.
 *
 * Two inputs, two jobs:
 *   - `instructions` are the user's standing direction ("slow and ominous")
 *   - `text` is what is about to be spoken, read for pace cues
 *
 * The compiler is deliberately honest. Anything it cannot express in `voice` or
 * `speed` is returned in `unhonoured` with a reason, rather than silently
 * dropped — asking an 82M style-vector model for "a hint of rain" and pretending
 * it worked would be worse than saying no.
 */

/**
 * Voice families, best-graded first.
 *
 * Order matters: the model's own quality grades vary enormously (from A to F+),
 * so a mood picks a position within a family rather than a fixed voice. Starting
 * from a graded list is worth more to perceived quality than any tuning.
 */
export const FAMILIES = {
  'af': ['af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_sarah', 'af_nova'],
  'am': ['am_fenrir', 'am_michael', 'am_puck', 'am_echo', 'am_eric', 'am_onyx'],
  'bf': ['bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily'],
  'bm': ['bm_fable', 'bm_george', 'bm_lewis', 'bm_daniel'],
}

/**
 * Words that select a voice family. Absent any, the default family is used.
 *
 * Matched longest-first, so "british woman" beats the bare "woman" inside it.
 * Accent-only hints sit above bare gender hints for the same reason: given
 * "a british voice", the accent is the more specific request.
 */
const FAMILY_HINTS = [
  { family: 'bf', words: ['british woman', 'british female', 'english woman', 'english female'] },
  { family: 'bm', words: ['british man', 'british male', 'english man', 'english male'] },
  { family: 'af', words: ['american woman', 'american female', 'us woman', 'us female'] },
  { family: 'am', words: ['american man', 'american male', 'us man', 'us male'] },
  { family: 'bf', words: ['british', 'english'] },
  { family: 'af', words: ['woman', 'female', 'feminine', 'girl', 'she'] },
  { family: 'am', words: ['man', 'male', 'masculine', 'boy', 'he'] },
]

/**
 * Moods, as a speed multiplier and a position within the family.
 *
 * `pick` indexes into the family list, so a mood leans toward a brighter or
 * heavier voice without hard-coding a name that a future family might not have.
 */
const MOODS = [
  { mood: 'urgent', words: ['urgent', 'frantic', 'panicked', 'alarmed', 'shouted', 'shout', 'yell'], speed: 1.18, pick: 2 },
  { mood: 'tense', words: ['tense', 'anxious', 'nervous', 'wary', 'strained', 'clipped'], speed: 1.08, pick: 1 },
  { mood: 'brisk', words: ['brisk', 'battle', 'military', 'command', 'drill', 'quick', 'fast'], speed: 1.12, pick: 1 },
  { mood: 'warm', words: ['warm', 'kind', 'gentle', 'tender', 'friendly', 'soothing'], speed: 0.94, pick: 0 },
  { mood: 'somber', words: ['somber', 'sad', 'mournful', 'grieving', 'melancholy', 'weary', 'tired'], speed: 0.85, pick: 0 },
  { mood: 'ominous', words: ['ominous', 'menacing', 'sinister', 'threatening', 'dread', 'creepy', 'eerie'], speed: 0.82, pick: 0 },
  { mood: 'calm', words: ['calm', 'measured', 'even', 'flat', 'matter-of-fact', 'neutral', 'steady'], speed: 0.96, pick: 0 },
  { mood: 'playful', words: ['playful', 'light', 'cheerful', 'amused', 'teasing', 'sing-song'], speed: 1.05, pick: 1 },
]

/** Pace words, as multipliers, checked before mood so an explicit pace wins. */
const PACES = [
  { words: ['very slow', 'slowly', 'slow', 'deliberate', 'ponderous'], speed: 0.8 },
  { words: ['measured', 'unhurried', 'steady'], speed: 0.92 },
  { words: ['brisk', 'quickly', 'quick', 'briskly'], speed: 1.15 },
  { words: ['very fast', 'rapid', 'rapidly', 'rushed', 'hurried'], speed: 1.28 },
]

/**
 * Instructions that name a control Kokoro does not have.
 *
 * Listed explicitly so the refusal is specific and useful rather than a generic
 * "unsupported": the user learns *which* part could not be honoured.
 */
const UNSUPPORTED = [
  { words: ['whisper', 'whispering', 'hushed'], reason: 'Kokoro has no volume or breathiness control' },
  { words: ['shout', 'shouting', 'loud', 'volume'], reason: 'Kokoro has no volume control' },
  { words: ['emphasise', 'emphasize', 'stress the word', 'stress'], reason: 'Kokoro has no per-word emphasis control' },
  { words: ['pause', 'pauses', 'silence', 'beat'], reason: 'Kokoro has no pause insertion; punctuation is the only lever' },
  { words: ['accent', 'irish', 'scottish', 'australian', 'french accent', 'german accent'], reason: 'only the published voice set is available' },
  { words: ['laugh', 'giggle', 'sigh', 'cry', 'sob'], reason: 'Kokoro cannot produce non-speech sounds' },
]

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

/** Lowercase word-boundary test, so "slow" does not match "slowly" twice by accident. */
function mentions(haystack, word) {
  return new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(haystack)
}

/**
 * Read pace cues out of the text itself.
 *
 * A crude arousal proxy, and knowingly so: it is a stand-in for a classifier
 * behind the same interface, not a claim to understand the prose. Exclamation
 * marks, capitals and short sentences read as heightened; ellipses, long
 * sentences and heavy subordination read as restrained.
 *
 * @returns a speed multiplier near 1 and the cues that produced it.
 */
export function readTextPace(text) {
  const source = String(text ?? '')
  const sentences = source.split(/[.!?]+/).filter((part) => part.trim().length > 0)
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { multiplier: 1, cues: [] }

  const cues = []
  let multiplier = 1

  const exclamations = (source.match(/!/g) ?? []).length
  if (exclamations > 0) {
    const bump = Math.min(0.12, exclamations * 0.04)
    multiplier += bump
    cues.push(`${exclamations} exclamation${exclamations === 1 ? '' : 's'} (+${bump.toFixed(2)})`)
  }

  const capitals = words.filter((word) => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word))
  if (capitals.length > 0) {
    const bump = Math.min(0.1, capitals.length * 0.03)
    multiplier += bump
    cues.push(`${capitals.length} shouted word${capitals.length === 1 ? '' : 's'} (+${bump.toFixed(2)})`)
  }

  const ellipses = (source.match(/\.\.\.|…/g) ?? []).length
  if (ellipses > 0) {
    const drop = Math.min(0.12, ellipses * 0.04)
    multiplier -= drop
    cues.push(`${ellipses} ellipsis${ellipses === 1 ? '' : 'es'} (−${drop.toFixed(2)})`)
  }

  if (sentences.length > 0) {
    const average = words.length / sentences.length
    if (average > 28) {
      multiplier -= 0.08
      cues.push(`long sentences, ${average.toFixed(0)} words (−0.08)`)
    } else if (average < 6) {
      multiplier += 0.08
      cues.push(`short sentences, ${average.toFixed(0)} words (+0.08)`)
    }
  }

  return { multiplier: clamp(multiplier, 0.8, 1.3), cues }
}

/**
 * Model labels, in the order the emotion classifier emits them.
 *
 * Each carries a pace multiplier. The mapping is arousal, not sentiment: anger
 * and fear are *fast* and sadness is slow, which is why a binary sentiment
 * classifier would have been the wrong instrument — "I am furious" and "I am
 * delighted" are both positive in valence and opposite in pace.
 */
export const TONE_PACE = [
  { label: 'anger', speed: 1.12 },
  { label: 'disgust', speed: 0.92 },
  { label: 'fear', speed: 1.1 },
  { label: 'joy', speed: 1.05 },
  { label: 'neutral', speed: 1 },
  { label: 'sadness', speed: 0.85 },
  { label: 'surprise', speed: 1.08 },
]

/**
 * Turn a classifier's class probabilities into the same shape {@link readTextPace}
 * returns, so the compiler can take either without knowing which it got.
 *
 * The multiplier is the probability-weighted mean rather than the argmax: an
 * 0.4/0.35 split between anger and sadness is genuinely mixed, and picking one
 * would discard that. Confidence is reported so a caller can ignore a shrug.
 *
 * @param probabilities - one probability per {@link TONE_PACE} entry, in order.
 * @returns a pace multiplier near 1, the dominant label, and its probability.
 */
export function toneToPace(probabilities) {
  if (!Array.isArray(probabilities) || probabilities.length !== TONE_PACE.length) {
    return { multiplier: 1, cues: [], dominant: null, confidence: 0 }
  }
  const total = probabilities.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0)
  if (total <= 0) return { multiplier: 1, cues: [], dominant: null, confidence: 0 }

  let weighted = 0
  let best = { label: null, p: -1 }
  TONE_PACE.forEach((tone, index) => {
    const p = (Number.isFinite(probabilities[index]) ? probabilities[index] : 0) / total
    weighted += tone.speed * p
    if (p > best.p) best = { label: tone.label, p }
  })

  return {
    multiplier: clamp(weighted, 0.8, 1.3),
    cues: [`tone ${best.label} ${best.p.toFixed(2)} → ×${weighted.toFixed(2)}`],
    dominant: best.label,
    confidence: best.p,
  }
}

/**
 * Compile intent and text into the parameters Kokoro accepts.
 *
 * @param options.instructions - the user's standing direction, free text.
 * @param options.text - the passage about to be spoken.
 * @param options.toneEnabled - whether the text is read for pace at all.
 * @param options.defaultVoice - the voice when nothing overrides it.
 * @param options.voices - available voice ids, used to validate a family pick.
 * @returns the chosen voice and speed, what was understood, and what was not.
 */
export function compileDelivery({
  instructions = '', text = '', toneEnabled = true, defaultVoice = 'af_heart', voices = [], textPace,
} = {}) {
  const stated = String(instructions ?? '').toLowerCase()
  const understood = []
  const unhonoured = []

  // 1. Refusals first, so an unsupported request is reported even if other words match.
  for (const rule of UNSUPPORTED) {
    for (const word of rule.words) {
      if (mentions(stated, word)) {
        unhonoured.push({ asked: word, reason: rule.reason })
        break
      }
    }
  }

  // 2. Voice family, taking the most specific match rather than the first.
  let family
  let best = null
  for (const hint of FAMILY_HINTS) {
    for (const word of hint.words) {
      if (!mentions(stated, word)) continue
      const words = word.split(' ').length
      if (best === null || words > best.words) best = { family: hint.family, word, words }
    }
  }
  if (best !== null) {
    family = best.family
    understood.push(`family ${best.family} (from "${best.word}")`)
  }
  if (family === undefined) family = defaultVoice.slice(0, 2)

  // 3. Pace, then mood. An explicit pace outranks a mood's built-in speed.
  let speed = 1
  let paceStated = false
  for (const pace of PACES) {
    const match = pace.words.find((word) => mentions(stated, word))
    if (match !== undefined) {
      speed = pace.speed
      paceStated = true
      understood.push(`pace ×${pace.speed} (from "${match}")`)
      break
    }
  }

  let pick = 0
  for (const mood of MOODS) {
    const match = mood.words.find((word) => mentions(stated, word))
    if (match !== undefined) {
      if (!paceStated) speed = mood.speed
      pick = mood.pick
      understood.push(`mood ${mood.mood} (from "${match}")`)
      break
    }
  }

  // 4. The text's own pace, when the user has not fixed one. `textPace` lets the
  // caller supply a classifier reading; the built-in heuristic is the fallback.
  if (toneEnabled && !paceStated) {
    const read = textPace ?? readTextPace(text)
    if (read.multiplier !== 1) {
      speed *= read.multiplier
      understood.push(`text pace ×${read.multiplier.toFixed(2)} (${read.cues.join(', ')})`)
    }
  }

  // 5. Instructions that changed nothing are worth saying out loud. The compiler
  // can only recognise the vocabulary above, so "make it sound better" would
  // otherwise be accepted in silence. Nuance *mixed into* a recognised request
  // ("melancholy, with a hint of rain") cannot be detected this way — that limit
  // is real and is documented rather than papered over.
  if (stated.trim().length > 0 && understood.length === 0 && unhonoured.length === 0) {
    unhonoured.push({
      asked: stated.trim(),
      reason: 'no recognised delivery direction; the compiler knows pace, mood, accent and gender words only',
    })
  }

  // 6. Resolve the family pick against what is actually installed.
  const candidates = (FAMILIES[family] ?? []).filter((voice) => voices.length === 0 || voices.includes(voice))
  const voice = candidates[pick] ?? candidates[0] ?? defaultVoice

  return {
    voice,
    speed: Math.round(clamp(speed, 0.6, 1.6) * 100) / 100,
    family,
    understood,
    unhonoured,
    ...(unhonoured.length > 0
      ? { note: `${unhonoured.length} instruction(s) could not be honoured; Kokoro exposes only voice and speed.` }
      : {}),
  }
}
