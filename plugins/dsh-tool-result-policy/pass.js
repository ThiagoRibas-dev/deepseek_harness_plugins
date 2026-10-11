/**
 * Tool-result retention — the host-plane strip pass.
 *
 * Spec: `docs/dsh-tool-result-policy.md`.
 *
 * **Why this exists as a pass rather than a `ToolResultPruner` service.** The
 * shipped `web-app` bundle disables the host-plane pruner and gives every preset
 * its own copy inside an isolated realm (`isolate: { toolResultPruner: true }`).
 * A service mounted at the Host plane is therefore invisible to `standard`,
 * `ptc` and `cordis`, and a service mounted in one preset governs exactly that
 * preset. Covering every preset the other way means overriding each shipped
 * preset declaration, which replaces its complete `config.plugins` — ~450 lines
 * of harness configuration copied into this bundle and silently shadowing every
 * future upstream change.
 *
 * A host-plane pass has neither problem. `agent/pre-step` is visible to
 * Host-plane plugins for every session (the same hook `dsh-context-pressure`
 * uses), and `planPrune`/`commitPlan` are pure operations on a `session`, so one
 * mount applies the per-preset policy everywhere.
 *
 * **The turn boundary is the correctness rule, not an optimisation.** A tool
 * result is load-bearing until the turn that produced it is narrated; a
 * mid-turn rewrite would elide the numbers the very next step is about to use.
 * `isMidTurn` is the harness's own pairing test — only a surface whose tail is a
 * completed assistant turn is safe to rewrite. That is stricter than the
 * contract-provider guard, and it applies to every provider, because stripping
 * mid-turn is wrong on all of them.
 *
 * This module imports only pure code, so it is unit-testable offline.
 *
 * @module @local/dsh-tool-result-policy/pass
 */
import { isMidTurn } from '../dsh-compaction-guard/lib/pending-batch.js'
import { resolvePolicy } from './policy.js'
import { commitPlan, planPrune } from './prune-core.js'

/** A pass that declined to run. Frozen: callers only read it. */
export const PASS_NOOP = Object.freeze({ ran: false, pruned: [], charsRemoved: 0 })

/**
 * Build the pass.
 *
 * @param options - wiring.
 * @param options.readPolicy - `(path) => { policy, problem }`, the mtime-keyed cache's `read`.
 * @param options.policyPath - where the preset → boolean table lives.
 * @param options.fallback - the bundle's own default when neither the table nor `defaults` answers.
 * @param options.thresholdChars - results above this are truncated even when kept.
 * @param options.headChars - characters retained from the front of a truncated result.
 * @param options.tailChars - characters retained from the end of a truncated result.
 * @param options.pairing - `{ balancedBefore, balancedAfter }` from the harness.
 * @param options.estimateTokens - `(message) => number`, the meter's own `estimateMessage`, so the
 *   `compaction/prune` shadow price matches what the meter charged the node.
 * @param options.logger - optional `{ debug }`; a debug-only logger is never required.
 * @returns `(session) => { ran, pruned, charsRemoved, reason, agentPreset, source }`.
 */
export function createPrunePass({
  readPolicy,
  policyPath,
  fallback = false,
  thresholdChars = 8192,
  headChars = 4096,
  tailChars = 1024,
  pairing,
  estimateTokens,
  logger,
} = {}) {
  if (typeof readPolicy !== 'function') {
    throw new TypeError('tool-result-policy: createPrunePass needs a readPolicy function')
  }
  if (pairing === undefined
    || typeof pairing.balancedBefore !== 'function'
    || typeof pairing.balancedAfter !== 'function') {
    throw new TypeError('tool-result-policy: createPrunePass needs the harness pairing cuts')
  }

  // Per-session high-water mark. A pass walks every surface node, measured at
  // ~13 ms for a 4,479-result history even after stripping; `agent/pre-step`
  // fires every step, so without this the cost is O(history) per step for a
  // surface that has not changed. Keyed by the session object, which is stable
  // for the session's life. A surface rewrite appends higher sequence numbers,
  // so an unchanged tail means no new result can have arrived.
  const lastSeen = new WeakMap()

  /** The highest surface sequence, or null for an empty/unknown surface. */
  const surfaceTail = (session) => {
    const nodes = session?.surface?.nodes
    return Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1] : null
  }

  return function pruneCompletedTurn(session) {
    if (session === undefined || session === null) return PASS_NOOP

    const agentPreset = session.header?.agentPreset
    const { policy, problem } = readPolicy(policyPath)
    if (problem !== null) logger?.debug?.(`tool-result-policy: ${problem}`)

    // A preset absent from the table follows `defaults`, then the bundle's own
    // default. Off is therefore the state of a fresh install for every preset.
    const { stripTransientResults, source } = resolvePolicy(policy, agentPreset, fallback)
    if (stripTransientResults !== true) {
      return { ...PASS_NOOP, reason: 'policy-off', agentPreset, source }
    }

    const tail = surfaceTail(session)
    if (tail !== null && lastSeen.get(session) === tail) {
      return { ...PASS_NOOP, reason: 'unchanged', agentPreset, source }
    }

    // The whole point of hosting this pass: only rewrite history whose turn is
    // over. `isMidTurn` is false exactly when the tail is a completed turn.
    if (isMidTurn(session, pairing)) {
      // Deliberately not recorded: a running turn is exactly the work a later
      // boundary has to pick up.
      return { ...PASS_NOOP, reason: 'mid-turn', agentPreset, source }
    }

    const plan = planPrune(session, { strip: true, thresholdChars, headChars, tailChars })
    const result = commitPlan(session, plan, { estimateTokens })
    const after = surfaceTail(session)
    if (after !== null) lastSeen.set(session, after)
    return {
      ran: true,
      reason: 'pruned',
      agentPreset,
      source,
      pruned: result.pruned,
      charsRemoved: result.charsRemoved,
    }
  }
}
