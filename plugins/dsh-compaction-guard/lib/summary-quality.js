/**
 * Summary substance validation for the compaction guard.
 *
 * Pure module: no harness imports, so every rule here is unit-testable offline.
 *
 * The harness already checks that a summary is *smaller* than the span it
 * replaces (`compaction-basic/src/region.ts:418`). It never checks that the
 * summary is a summary. A one-sentence non-answer is trivially smaller, so it
 * passes and the whole conversation is shadowed with it. These rules supply the
 * missing substance check.
 *
 * @module @local/dsh-compaction-guard/lib/summary-quality
 */

/** Guard defaults, applied when a field is absent from the resolved config. */
export const GUARD_DEFAULTS = Object.freeze({
  minSummaryChars: 400,
  minRatio: 0,
  rejectPatterns: [],
  maxDegenerateRetries: 2,
})

/**
 * Normalize untrusted guard configuration.
 *
 * @param config - the row's guard fields, possibly absent or malformed.
 * @returns a frozen, fully populated guard configuration.
 */
export function resolveGuardConfig(config = {}) {
  const minSummaryChars = Number.isInteger(config.minSummaryChars) && config.minSummaryChars >= 0
    ? config.minSummaryChars
    : GUARD_DEFAULTS.minSummaryChars
  const minRatio = typeof config.minRatio === 'number' && config.minRatio >= 0 && config.minRatio <= 1
    ? config.minRatio
    : GUARD_DEFAULTS.minRatio
  const rejectPatterns = Array.isArray(config.rejectPatterns)
    ? config.rejectPatterns.filter(pattern => typeof pattern === 'string' && pattern.length > 0)
    : []
  const maxDegenerateRetries = Number.isInteger(config.maxDegenerateRetries)
    && config.maxDegenerateRetries >= 0
    ? config.maxDegenerateRetries
    : GUARD_DEFAULTS.maxDegenerateRetries
  return Object.freeze({ minSummaryChars, minRatio, rejectPatterns, maxDegenerateRetries })
}

/**
 * Concatenate the text of a summary's content blocks.
 *
 * @param blocks - summary content, as returned by the summarizer.
 * @returns trimmed text, or the empty string when there is no text block.
 */
export function summaryText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Total character count of the text being summarized, for the optional
 * relative floor. Only consulted when `minRatio` is above zero.
 *
 * @param input - the summarizer input (system, tools and shadowed messages).
 * @returns Unicode code-unit count of all text blocks.
 */
export function measureInputChars(input) {
  const messages = input?.messages
  if (!Array.isArray(messages)) return 0
  let chars = 0
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text'
        && typeof block.text === 'string') {
        chars += block.text.length
      }
    }
  }
  return chars
}

/**
 * Decide whether a summary is substantive enough to commit.
 *
 * Rule order is deliberate: the absolute floor is the load-bearing check that
 * rejects the observed failure, the repeat check stops a retry loop from
 * converging on the same rejected text, and the pattern and ratio rules are
 * optional defence in depth.
 *
 * @param blocks - summary content returned by the summarizer.
 * @param context - `inputChars` (optional) and `rejectedText` (optional).
 * @param config - resolved guard configuration.
 * @returns `{ ok: true, text }` or `{ ok: false, reason, text }`.
 */
export function validateSummary(blocks, context = {}, config = GUARD_DEFAULTS) {
  const text = summaryText(blocks)

  if (text.length === 0) return { ok: false, reason: 'summary contains no text', text }
  if (text.length < config.minSummaryChars) {
    return {
      ok: false,
      reason: `summary is ${text.length} characters, below the ${config.minSummaryChars}-character floor`,
      text,
    }
  }

  const rejectedText = context.rejectedText
  if (typeof rejectedText === 'string' && rejectedText.length > 0 && text === rejectedText) {
    return { ok: false, reason: 'summary is identical to the previously rejected summary', text }
  }

  const inputChars = context.inputChars
  if (config.minRatio > 0 && Number.isFinite(inputChars) && inputChars > 0) {
    const required = Math.ceil(inputChars * config.minRatio)
    if (text.length < required) {
      return {
        ok: false,
        reason: `summary is ${text.length} characters, below ${config.minRatio} of the ${inputChars}-character input`,
        text,
      }
    }
  }

  for (const pattern of config.rejectPatterns) {
    if (text.includes(pattern)) {
      return { ok: false, reason: `summary matches rejected pattern ${JSON.stringify(pattern)}`, text }
    }
  }

  return { ok: true, text }
}
