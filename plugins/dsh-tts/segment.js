/**
 * Split a passage into speech-sized segments.
 *
 * Two reasons this exists, and the second is the important one.
 *
 * The obvious reason is the request limit: a long message should be read aloud
 * rather than refused.
 *
 * The real reason is that **the graph silently truncates**. `tokenize` stops at
 * `MAX_TOKENS`, so any passage past roughly 512 phonemes was not rejected — it was
 * cut off mid-sentence and returned as though complete. Segmenting makes long text
 * correct rather than merely permitted.
 *
 * Pure and synchronous, so the boundary behaviour is testable without a model.
 */

/** Sentence-final punctuation, plus the closing marks that follow it. */
const TERMINATORS = '.!?…'
const CLOSERS = `"'"”’)]`

/**
 * Split one paragraph into sentences.
 *
 * Deliberately conservative: a missed boundary costs a natural pause, while a
 * spurious one chops a sentence in half. Numbers are the case that matters —
 * "3.5 miles" must not become two sentences — so a period with a digit on both
 * sides is never a boundary. Abbreviations still split ("Dr. Smith"), which is
 * accepted because the damage is a short pause inside a name.
 *
 * @param text - one paragraph, with no paragraph breaks of its own.
 * @returns sentences, with their punctuation.
 */
export function splitSentences(text) {
  const parts = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (!TERMINATORS.includes(text[i])) continue
    const before = text[i - 1] ?? ''
    const after = text[i + 1] ?? ''
    if (/\d/.test(before) && /\d/.test(after)) continue
    let end = i + 1
    while (end < text.length && TERMINATORS.includes(text[end])) end += 1
    while (end < text.length && CLOSERS.includes(text[end])) end += 1
    const next = text[end] ?? ''
    if (next !== '' && !/\s/.test(next)) continue
    const piece = text.slice(start, end).trim()
    if (piece !== '') parts.push(piece)
    start = end
    i = end - 1
  }
  const tail = text.slice(start).trim()
  if (tail !== '') parts.push(tail)
  return parts
}

/**
 * Break a piece that is still over budget, preferring word boundaries.
 *
 * @param piece - text that may exceed the budget.
 * @param maxChars - the budget.
 * @returns pieces each within the budget, unless a single word cannot be.
 */
export function hardSplit(piece, maxChars) {
  if (piece.length <= maxChars) return [piece]
  const out = []
  let current = ''
  for (const word of piece.split(/\s+/)) {
    if (word.length > maxChars) {
      // An unbroken token longer than the whole budget — a URL, a base64 blob.
      // Chopping mid-token is ugly; refusing to speak is worse.
      if (current !== '') { out.push(current); current = '' }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars))
      continue
    }
    if (current === '') { current = word; continue }
    if (current.length + 1 + word.length <= maxChars) { current += ` ${word}`; continue }
    out.push(current)
    current = word
  }
  if (current !== '') out.push(current)
  return out
}

/** Sentence terminators and trailing whitespace are not themselves spoken. */
const trimEdges = (value) => value.trim()

/**
 * Segment a passage for synthesis.
 *
 * Paragraph breaks are always segment boundaries — a pause between them is what
 * the writer intended — while sentences are packed together up to the budget so
 * that short prose does not become a string of choppy utterances.
 *
 * @param text - the passage to speak.
 * @param options.maxChars - the per-segment budget.
 * @returns segments in order; empty for blank input.
 */
export function segmentText(text, { maxChars = 400 } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (source.trim() === '') return []
  const budget = Math.max(1, Math.floor(maxChars))

  const segments = []
  for (const paragraph of source.split(/\n{2,}/)) {
    let current = ''
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of hardSplit(sentence, budget)) {
        const candidate = trimEdges(piece)
        if (candidate === '') continue
        if (current === '') { current = candidate; continue }
        if (current.length + 1 + candidate.length <= budget) {
          current = `${current} ${candidate}`
          continue
        }
        segments.push(current)
        current = candidate
      }
    }
    if (current !== '') segments.push(current)
  }
  return segments
}
