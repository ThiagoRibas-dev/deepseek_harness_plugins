/**
 * Staleness policy for compaction checkpoints.
 *
 * Pure: no harness imports, no I/O, so the decision is unit-testable offline.
 *
 * A compaction checkpoint is a *user-role* message describing the session as it
 * was when the summary was written. Compaction runs under context pressure, not
 * on age, so a session that stays below the threshold keeps a checkpoint that
 * describes an older state indefinitely — measured on `session-d772c4cf`, where a
 * checkpoint 19 hours and 6 turns old kept instructing the model to "await user
 * selection" while the conversation had moved on. See
 * `docs/plugins/compaction-freshness.md`.
 *
 * @module @local/dsh-compaction-freshness/policy
 */

/** Source kind of a landed checkpoint message. */
export const CHECKPOINT_KIND = 'compact-checkpoint'

/**
 * Resolve the plugin's config, applying the documented defaults.
 *
 * @param raw - the row's config, or undefined.
 * @returns a frozen settings object; never throws.
 */
export function resolveConfig(raw) {
  const value = typeof raw === 'object' && raw !== null ? raw : {}
  return Object.freeze({
    enabled: value.enabled !== false,
    refreshAfterMessages: positiveInteger(value.refreshAfterMessages, 40),
    cooldownMs: positiveInteger(value.cooldownMs, 300_000),
    maxRefreshes: positiveInteger(value.maxRefreshes, 3),
  })
}

function positiveInteger(candidate, fallback) {
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback
}

const kindOf = node => node?.source?.kind ?? node?.data?.source?.kind
const seqOf = node => (Number.isInteger(node?.seq) ? node.seq : undefined)

/**
 * How far the surface has moved past the newest checkpoint.
 *
 * Counts *messages*, not turns or minutes: the question is how much context the
 * checkpoint has not seen, and one long turn goes stale as fast as three short
 * ones.
 *
 * @param nodes - `session.surface.nodes`, in surface order.
 * @returns `{ checkpointSeq, since }`, or undefined when no checkpoint has landed.
 */
export function checkpointState(nodes) {
  if (!Array.isArray(nodes)) return undefined
  let index = -1
  for (let position = nodes.length - 1; position >= 0; position -= 1) {
    if (kindOf(nodes[position]) === CHECKPOINT_KIND) { index = position; break }
  }
  if (index === -1) return undefined
  return { checkpointSeq: seqOf(nodes[index]), since: nodes.length - 1 - index }
}

/**
 * Whether a refresh is owed, given the state, the settings and what this session
 * has already spent.
 *
 * A refresh is one summarisation call (measured: ~69k input tokens, ~30 s), so it
 * is deliberately hard to trigger twice: one per checkpoint, a cooldown between
 * attempts, and a cap per session so a pathological session cannot loop.
 *
 * @param state - result of `checkpointState`.
 * @param settings - result of `resolveConfig`.
 * @param memory - `{ checkpointSeq?, attempts?, lastAt? }` for this session.
 * @param now - current epoch milliseconds.
 * @returns whether `compactNow` should run.
 */
export function shouldRefresh(state, settings, memory, now) {
  if (!settings.enabled) return false
  if (state === undefined) return false
  if (state.since < settings.refreshAfterMessages) return false
  const seen = typeof memory === 'object' && memory !== null ? memory : {}
  if (state.checkpointSeq !== undefined && seen.checkpointSeq === state.checkpointSeq) return false
  if ((seen.attempts ?? 0) >= settings.maxRefreshes) return false
  if (typeof seen.lastAt === 'number' && now - seen.lastAt < settings.cooldownMs) return false
  return true
}

/**
 * The next memory record for a session that just attempted a refresh.
 * @param memory - the previous record.
 * @param state - the state the attempt was based on.
 * @param now - current epoch milliseconds.
 * @returns the record to store.
 */
export function recordAttempt(memory, state, now) {
  const seen = typeof memory === 'object' && memory !== null ? memory : {}
  return { checkpointSeq: state.checkpointSeq, attempts: (seen.attempts ?? 0) + 1, lastAt: now }
}
