/**
 * Prompt budget: keep one dispatch under the size the provider will actually accept.
 *
 * `agy` keeps about 192,000 bytes of one input step and drops the remainder, and a
 * started or replayed conversation sends its whole history in that step with the
 * history last — so what gets dropped is the newest content, which is the message
 * the user just sent. Meridian 1.83.0 and later shorten to fit
 * (`MERIDIAN_AGY_MAX_PROMPT_BYTES`, default 190,000) and can signal the overflow to
 * the client, but this deployment cannot rely on that alone: the connector has to
 * know, before dispatch, that a request is too large.
 *
 * Everything here is a pure calculation over three numbers, so the units and the
 * conversion are configuration rather than code. Measured on 2026-10-29 by pairing
 * a capture with the prompt the CLI recorded for the same request:
 * 270,285 body bytes produced a 174,944-character prompt, i.e. a ratio of 0.647.
 * See docs/plugins/dsh-meridian-antigravity/prompt-budget.md.
 *
 * @module @local/dsh-meridian-antigravity/lib/budget
 */

/**
 * Defaults, chosen so that an unconfigured connector behaves like the measured
 * deployment: bytes, the measured ratio, and 5% headroom below the limit.
 */
export const DEFAULT_PROMPT_BUDGET = Object.freeze({
  enabled: true,
  /** `bytes`, `chars` or `tokens`: the unit both `limit` and the measurement use. */
  unit: 'bytes',
  /** `estimate` multiplies the body by `ratio`; `body` compares the body directly. */
  measure: 'estimate',
  /** Budget in `unit`. 190,000 is Meridian's documented default for the CLI cap. */
  limit: 190_000,
  /** Body bytes to prompt bytes. Empirical; re-measure when the provider changes. */
  ratio: 0.647,
  /** Bytes per token, used only when `unit` is `tokens`. */
  charsPerToken: 4,
  /** Fraction of the limit held back as headroom, so an overshoot still fits. */
  margin: 0.05,
})

const finite = (candidate, fallback, min) =>
  (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= min ? candidate : fallback)

/**
 * Fill in and freeze a budget from partial configuration.
 * @param raw - the row's `promptBudget`, or undefined.
 * @returns a frozen budget; never throws.
 */
export function resolvePromptBudget(raw) {
  const value = typeof raw === 'object' && raw !== null ? raw : {}
  const unit = value.unit === 'chars' || value.unit === 'tokens' ? value.unit : 'bytes'
  const margin = Math.min(Math.max(finite(value.margin, DEFAULT_PROMPT_BUDGET.margin, 0), 0), 0.9)
  return Object.freeze({
    enabled: value.enabled !== false,
    unit,
    measure: value.measure === 'body' ? 'body' : 'estimate',
    limit: Math.floor(finite(value.limit, DEFAULT_PROMPT_BUDGET.limit, 0)),
    ratio: finite(value.ratio, DEFAULT_PROMPT_BUDGET.ratio, 0.01),
    charsPerToken: Math.max(finite(value.charsPerToken, DEFAULT_PROMPT_BUDGET.charsPerToken, 1), 1),
    margin,
  })
}

/**
 * Convert a body size into the budget's unit and compare it with the limit.
 *
 * `chars` and `bytes` share a number here: the prompt is ASCII apart from the
 * conversation's own text, and treating them separately would imply a precision
 * this estimate does not have.
 *
 * @param bodyBytes - the serialized request size, as `enforceRequestBudget` returns it.
 * @param budget - a resolved budget.
 * @returns the measurement, including whether it exceeds the effective limit.
 */
export function measurePrompt({ bodyBytes, budget }) {
  const promptBytes = budget.measure === 'body' ? bodyBytes : bodyBytes * budget.ratio
  const divisor = budget.unit === 'tokens' ? budget.charsPerToken : 1
  const value = Math.round(promptBytes / divisor)
  const effectiveLimit = Math.floor(budget.limit * (1 - budget.margin))
  return {
    value,
    unit: budget.unit,
    limit: budget.limit,
    effectiveLimit,
    exceeded: budget.enabled && value > effectiveLimit,
    ratio: budget.ratio,
    measure: budget.measure,
    bodyBytes,
  }
}

/**
 * One line naming every number that produced the verdict, so a log or an error
 * message is enough to explain it without reproducing the calculation.
 * @param measurement - result of `measurePrompt`.
 * @returns a human-readable sentence.
 */
export function describePromptBudget(measurement) {
  const { value, unit, limit, effectiveLimit, margin, bodyBytes, ratio, measure } = measurement
  const how = measure === 'body' ? `${bodyBytes} body bytes` : `${bodyBytes} body bytes × ${ratio}`
  return `estimated prompt ${value.toLocaleString('en-US')} ${unit} against an effective limit of`
    + ` ${effectiveLimit.toLocaleString('en-US')} (${limit.toLocaleString('en-US')} less`
    + ` ${Math.round(margin * 100)}% headroom), from ${how}`
}
