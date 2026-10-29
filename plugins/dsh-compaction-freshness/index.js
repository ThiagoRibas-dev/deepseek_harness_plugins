/**
 * Refresh a stale compaction checkpoint while the agent is idle.
 *
 * Why the hook is `agent/status` and not `agent/pre-step`: `compactNow` runs
 * through `runMaintenance`, whose contract is "run a non-turn maintenance
 * operation only while the agent is idle" and which throws synchronously when the
 * agent is already active. `agent/pre-step` fires mid-turn, so it would always be
 * `busy`. `agent/status` is the idle boundary, and the engine withholds waking
 * input (FIFO) until the refresh settles, so a message sent during it waits rather
 * than races.
 *
 * A refresh rewrites history, which on a provider that pins a continuation to its
 * delivered prefix is a prefix change. That is why this plugin runs only at idle:
 * the request after a refresh is a turn opener, the one shape that may seed a
 * conversation.
 *
 * Spec: `docs/plugins/compaction-freshness.md`.
 *
 * @module @local/dsh-compaction-freshness
 */
import { checkpointState, recordAttempt, resolveConfig, shouldRefresh } from './policy.js'

export const name = 'compaction-freshness'

/**
 * Ceiling on one refresh.
 *
 * `compactNow` runs through `runMaintenance`, which withholds waking input until
 * the task settles — so a summarisation that never returns would hold the user's
 * next message indefinitely. The bound turns that into an abandoned attempt, which
 * the cooldown then spaces out.
 */
const REFRESH_TIMEOUT_MS = 180_000

/** `compaction` is optional: without it the plugin is inert, not broken. */
export const inject = []

/**
 * Register the idle-time listener.
 * @param ctx - plugin context.
 * @param config - row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  // One line at mount, so a restart answers "did apply() run?" without waiting for
  // the first refresh. A plugin that mounts silently is indistinguishable from one
  // whose row was dropped.
  ctx.logger?.info?.(
    `compaction-freshness: mounted (refresh after ${settings.refreshAfterMessages} messages,`
    + ` >= ${settings.cooldownMs} ms apart, max ${settings.maxRefreshes})`,
  )
  if (!settings.enabled) return
  const seen = new WeakMap()

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // Emit-mode event: the refresh runs detached, so a failure must never escape.
    void refresh(ctx, settings, seen, agent).catch(error => {
      ctx.logger?.warn?.(`compaction-freshness: ${String(error)}; leaving the checkpoint alone`)
    })
  })
}

/**
 * Reduce surface nodes to what the policy needs: a seq and a source kind.
 *
 * A surface node may carry its event inline or only its sequence, in which case
 * `session.eventAt(seq)` resolves it. Both shapes are handled so the policy never
 * has to know which one the harness exposed.
 *
 * @param session - the agent's session.
 * @param nodes - `session.surface.nodes`.
 * @returns `[{ seq, source }]`, or the input when it is not an array.
 */
function checkpointEntries(session, nodes) {
  if (!Array.isArray(nodes)) return nodes
  return nodes.map(node => {
    if (node?.source !== undefined || node?.data !== undefined) return node
    const event = typeof session.eventAt === 'function' ? session.eventAt(node?.seq) : undefined
    return event === undefined ? node : { seq: node?.seq, source: event.source }
  })
}

async function refresh(ctx, settings, seen, agent) {
  const compaction = ctx.get('compaction')
  if (typeof compaction?.compactNow !== 'function') return
  const session = agent?.session
  const nodes = session?.surface?.nodes
  const state = checkpointState(checkpointEntries(session, nodes))
  const memory = session === undefined ? undefined : seen.get(session)
  if (!shouldRefresh(state, settings, memory, Date.now())) return
  if (session !== undefined) seen.set(session, recordAttempt(memory, state, Date.now()))
  const result = await compaction.compactNow(agent, AbortSignal.timeout(REFRESH_TIMEOUT_MS))
  if (result !== null) {
    ctx.logger?.info?.(
      `compaction-freshness: refreshed a checkpoint ${state.since} message(s) behind`
      + ` (${result.shadowedTokenCount} tokens shadowed)`,
    )
  }
}
