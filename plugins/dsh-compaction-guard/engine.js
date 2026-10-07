/**
 * Guarded summary compaction.
 *
 * `BasicCompactionEngine` documents `summarize()` as its sole subclass
 * customization hook, and the engine's own retry loop already consults the
 * `compaction/summary-error` waterfall when that hook throws
 * (`compaction-basic/src/region.ts:399-408`). This subclass uses both: it
 * validates the summary the parent produced and throws when the result is not a
 * usable summary, so the bad artifact is never committed.
 *
 * The guard has to sit on the success path. The incident that motivated it
 * produced six `summarization produced no text summary content` failures and
 * then one *successful* summarization whose entire text was
 * `"I can't answer in a 1-token limit."` — well-formed, so no error handler
 * could have seen it, and small enough to pass the engine's size-only check.
 *
 * @module @local/dsh-compaction-guard
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  GUARD_DEFAULTS,
  measureInputChars,
  resolveGuardConfig,
  validateSummary,
} from './lib/summary-quality.js'

/** Guard fields this plugin owns; everything else belongs to the parent. */
const GUARD_KEYS = new Set([
  'minSummaryChars',
  'minRatio',
  'rejectPatterns',
  'maxDegenerateRetries',
])

/** Raised when a summarization returns text that is not a usable summary. */
export class DegenerateSummaryError extends Error {
  /**
   * @param verdict - the failed validation result.
   */
  constructor(verdict) {
    super(`compaction-guard: refused a degenerate summary (${verdict.reason})`)
    this.name = 'DegenerateSummaryError'
    /** Which rule rejected the summary. */
    this.reason = verdict.reason
    /** The rejected text, truncated for logs. */
    this.summaryText = verdict.text.slice(0, 200)
  }
}

/**
 * `BasicCompactionEngine` with a substance check on every accepted summary.
 */
export class GuardedCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = z.object({
    minSummaryChars: z.number().step(1).min(0).default(GUARD_DEFAULTS.minSummaryChars),
    minRatio: z.number().min(0).max(1).default(GUARD_DEFAULTS.minRatio),
    rejectPatterns: z.array(z.string()),
    maxDegenerateRetries: z.number().step(1).min(0).default(GUARD_DEFAULTS.maxDegenerateRetries),
  })

  /**
   * Resolved guard configuration and per-session retry state.
   *
   * Public fields, deliberately. `summarize()` is this class's hook on the
   * success path, and the engine that calls it can be reached through
   * `ctx.compaction`, where Cordis invokes the method with a *shadow* receiver
   * (`createShadowMethod`, `cordis/lib/index.js:116`) rather than the instance.
   * A `#private` field is not installed on that shadow, so `this.#guard` throws
   * and the guard never runs. Never reassign these: a write through the shadow
   * would land on the shadow rather than the instance.
   */
  guard
  /** Most recently rejected summary text, per session, to stop retry convergence. */
  rejected = new WeakMap()
  /** Rejections consumed for the current compaction, per session. */
  attempts = new WeakMap()

  /**
   * @param ctx - plugin context.
   * @param config - guard fields plus any parent compaction fields.
   */
  constructor(ctx, config = {}) {
    // The parent rejects unknown config keys, so guard fields must not reach it.
    super(ctx, parentConfigOf(config))
    this.guard = resolveGuardConfig(config)
    ctx.on('compaction/summary-error', (payload, next) => this.#onSummaryError(payload, next))
  }

  /**
   * Validate the parent's summary before it can become a durable checkpoint.
   *
   * @param input - replayed conversation prefix being condensed.
   * @param agent - the agent owning the session.
   * @param signal - cancellation forwarded to the adapter.
   * @returns the parent's result when it is substantive.
   * @throws DegenerateSummaryError when it is not.
   */
  async summarize(input, agent, signal) {
    const result = await super.summarize(input, agent, signal)
    const verdict = validateSummary(result?.summary, {
      inputChars: measureInputChars(input),
      rejectedText: this.rejected.get(agent.session),
    }, this.guard)

    if (!verdict.ok) {
      this.rejected.set(agent.session, verdict.text)
      this.ctx.logger?.warn?.(
        `compaction-guard: rejected a summary for ${agent.session.id}: ${verdict.reason}`,
      )
      throw new DegenerateSummaryError(verdict)
    }

    // A substantive summary clears the retry state for the next compaction.
    this.rejected.delete(agent.session)
    this.attempts.delete(agent.session)
    return result
  }

  /**
   * Answer the engine's recovery waterfall for our own rejection: retry a
   * bounded number of times, then decline so the compaction fails without
   * committing anything. Foreign errors are passed to `next()` so shipped
   * handlers keep their behaviour.
   *
   * @param payload - waterfall payload.
   * @param next - downstream waterfall continuation.
   * @returns whether summarization should be retried.
   */
  #onSummaryError(payload, next) {
    if (!(payload?.error instanceof DegenerateSummaryError)) return next()
    const tries = this.attempts.get(payload.session) ?? 0
    if (tries >= this.guard.maxDegenerateRetries) {
      this.ctx.logger?.warn?.(
        `compaction-guard: giving up after ${tries} rejected summaries; committing nothing`,
      )
      return false
    }
    this.attempts.set(payload.session, tries + 1)
    this.ctx.logger?.info?.(
      `compaction-guard: retrying summarization after rejection ${tries + 1}/${this.guard.maxDegenerateRetries}`,
    )
    return true
  }
}

/**
 * Strip this plugin's guard fields, leaving only what the parent accepts.
 *
 * @param config - the row's configuration.
 * @returns a config object restricted to parent-owned keys.
 */
function parentConfigOf(config) {
  const parent = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!GUARD_KEYS.has(key)) parent[key] = value
  }
  return parent
}

export default GuardedCompactionEngine
