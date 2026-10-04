/**
 * Tool-batch state for the compaction guard's pruning deferral.
 *
 * Pure module: the tool-pairing predicate is injected rather than imported, so
 * this is unit-testable offline and holds no opinion about the harness.
 *
 * Why deferring is necessary: a provider may pin a tool continuation to the
 * exact history it already delivered. Meridian's Antigravity backend compares
 * the delivered prefix against the continuation
 * (`src/proxy/backends/antigravity.ts:86`) and answers 409 when it moved.
 * Rewriting surface nodes mid-turn is therefore invalid on such a route, and
 * the tool-result pruner is a mid-turn rewrite.
 *
 * @module @local/dsh-compaction-guard/lib/pending-batch
 */

/** Pruning-guard defaults, applied when a field is absent from the config. */
export const PRUNE_GUARD_DEFAULTS = Object.freeze({
  deferWhenBatchPending: true,
  contractProviders: Object.freeze(['meridian-antigravity']),
})

/**
 * Normalize untrusted pruning-guard configuration.
 *
 * @param config - the row's guard fields, possibly absent or malformed.
 * @returns a frozen guard configuration.
 */
export function resolvePruneGuard(config = {}) {
  const deferWhenBatchPending = config.deferWhenBatchPending === undefined
    ? PRUNE_GUARD_DEFAULTS.deferWhenBatchPending
    : config.deferWhenBatchPending === true
  const contractProviders = Array.isArray(config.contractProviders)
    ? Object.freeze(config.contractProviders.filter(p => typeof p === 'string' && p.length > 0))
    : PRUNE_GUARD_DEFAULTS.contractProviders
  return Object.freeze({ deferWhenBatchPending, contractProviders })
}

/**
 * Provider name durably routed for the session's latest request.
 *
 * Mirrors the engine's own private `routedTarget` resolution
 * (`compaction-basic/src/index.ts:52`) using public session API.
 *
 * @param session - session to inspect.
 * @returns the provider name, or undefined when none is routed yet.
 */
export function routedProvider(session) {
  const config = session?.requestHeader?.()?.config
  const provider = config?.provider
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

/**
 * Whether the session's surface is mid-turn, meaning the next request would be
 * a tool continuation rather than a fresh user turn.
 *
 * Uses the harness's exported pairing cuts instead of reading events:
 * `balancedBefore` is false when the surface ends with a tool result (a
 * continuation is about to carry it), and `balancedAfter` is false when it ends
 * with an unanswered tool call. Only a cut that is balanced on both sides — a
 * completed assistant turn — is safe to rewrite.
 *
 * An unreadable pairing state defers, because "cannot tell" is not "safe".
 *
 * @param session - session whose surface is inspected.
 * @param pairing - `{ balancedBefore, balancedAfter }`, each `(session, seq) => boolean`.
 * @returns true when pruning must be deferred.
 */
export function isMidTurn(session, pairing) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || nodes.length === 0) return false
  const tail = nodes[nodes.length - 1]
  try {
    return !(pairing.balancedBefore(session, tail) && pairing.balancedAfter(session, tail))
  } catch {
    return true
  }
}

/**
 * Whether a prune pass must be deferred for this session.
 *
 * @param session - session about to be pruned.
 * @param guard - resolved prune-guard configuration.
 * @param pairing - `{ balancedBefore, balancedAfter }` from the harness.
 * @returns true when the prune pass must be skipped.
 */
export function shouldDeferPrune(session, guard, pairing) {
  if (!guard.deferWhenBatchPending) return false
  const provider = routedProvider(session)
  if (provider === undefined || !guard.contractProviders.includes(provider)) return false
  return isMidTurn(session, pairing)
}
