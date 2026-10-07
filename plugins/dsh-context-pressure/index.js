/**
 * Pre-compaction context-pressure nudge.
 *
 * Compaction's own pressure trigger defaults to 80% of the window
 * (`compaction-basic/types.ts:11`). Once it fires, earlier history is replaced
 * by a summary the model never got to influence. This plugin steers one notice
 * into the running turn shortly before that happens, so the model can persist
 * whatever it would need to resume.
 *
 * Delivery uses `agent.steer(...)`, which targets `next-step` and wakes the
 * driver (`agent-loop/src/agent.ts:166`) — the same primitive the UI uses for
 * busy-enter steering.
 *
 * @module @local/dsh-context-pressure
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULTS, classify, renderMessage, resolveConfig } from './lib/pressure.js'

export { DEFAULTS, classify, renderMessage, resolveConfig } from './lib/pressure.js'

/** Loader-facing schema for the row's config. */
export const Config = z.object({
  warnRatio: z.number().min(0).max(1).default(DEFAULTS.warnRatio),
  rearmRatio: z.number().min(0).max(1).default(DEFAULTS.rearmRatio),
  message: z.string(),
})

export const name = 'context-pressure'

/** `llm` supplies the window; `tokenMeter` supplies the measurement. */
export const inject = ['llm', 'tokenMeter']

/**
 * Source kind for the injected message.
 *
 * Its own kind, deliberately. `MessageSourceMap` is a merge-extensible sum type
 * whose consumers "fall through unknown kinds" (`dsh-llm/src/message.ts:103`),
 * so declaring one is the supported move, and every other in-tree producer does
 * it — `runtime-context`, `model-selection`, `skill-catalog`, `goal`.
 *
 * The earlier choice to reuse `kind: 'user'` was not safe. Reusing it makes the
 * notice indistinguishable from a real prompt to any consumer that switches on
 * the kind, and one did: `dd35-memory` recorded these notices to
 * `campaign_log.md` and to the turn transcripts as the player's own words. The
 * text marking the message as automatic was never enough, because the consumer
 * had no reason to read the text.
 *
 * `user` remains the correct *role* — the notice is model-facing input, not a
 * system instruction — and the kind is what keeps it from being read as a
 * prompt.
 */
const NOTICE_SOURCE = Object.freeze({ kind: 'context-pressure' })

/**
 * Register the pre-step nudge.
 *
 * Mounted at the host plane: session events bubble to ancestor contexts, so one
 * host listener sees every agent. Mounting this inside a preset group as well
 * would register a second listener and steer twice.
 *
 * @param ctx - plugin context.
 * @param config - row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const warned = new WeakSet()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      if (!signal.aborted) await consider(ctx, settings, warned, agent, signal)
    } catch (error) {
      // A nudge is never worth failing a turn for.
      ctx.logger?.warn?.(`context-pressure: ${String(error)}; continuing the turn`)
    }
    return next()
  })
}

/**
 * Measure the window and steer a notice when the warn band is crossed.
 *
 * @param ctx - plugin context.
 * @param settings - resolved configuration.
 * @param warned - sessions already nudged in the current pressure episode.
 * @param agent - agent whose next request is being prepared.
 * @param signal - the step's cancellation signal.
 */
async function consider(ctx, settings, warned, agent, signal) {
  const session = agent.session
  const target = session.requestHeader()?.config
  if (target === undefined || target.provider.length === 0 || target.model.length === 0) return

  const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const contextWindow = info?.context?.contextWindow
  if (typeof contextWindow !== 'number' || contextWindow <= 0) return

  // Output tokens are charged to the same window, so they are not usable input.
  const reserved = target.maxTokens ?? info.defaultMaxTokens ?? 0
  const usable = Math.max(1, contextWindow - reserved)
  const used = ctx.tokenMeter.measure(session).totalTokens

  const verdict = classify(used / usable, warned.has(session), settings)
  if (verdict === 'rearm') {
    warned.delete(session)
    return
  }
  if (verdict !== 'warn') return

  warned.add(session)
  const percent = Math.round((used / usable) * 100)
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: renderMessage(settings.message, { percent, used, window: usable }) }],
    source: NOTICE_SOURCE,
  }))
  ctx.logger?.info?.(
    `context-pressure: nudged ${session.id} at ${percent}% (${used}/${usable} tokens)`,
  )
}
