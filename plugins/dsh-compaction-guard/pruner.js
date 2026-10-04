/**
 * Guarded tool-result pruning.
 *
 * `BasicCompactionEngine` runs the model-free pruner before summarising, at
 * `compaction-basic/src/index.ts:296` (context overflow) and `:324` (pressure).
 * A prune rewrites surface nodes with `replace` ops, which is invalid while a
 * provider is holding a tool continuation pinned to the history it already
 * delivered. This subclass defers the pass in exactly that window.
 *
 * @module @local/dsh-compaction-guard/pruner
 */

import z from '@deepseek-ai/schemastery'
import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { resolvePruneGuard, shouldDeferPrune } from './lib/pending-batch.js'

/** Parent-owned config keys, forwarded verbatim. */
const PRUNE_KEYS = new Set(['thresholdChars', 'headChars', 'tailChars'])

/** The harness's exported pairing cuts, injected so the predicate stays pure. */
const PAIRING = {
  balancedBefore: toolPairingBalancedBefore,
  balancedAfter: toolPairingBalancedAfter,
}

/** No-op result for a deferred pass. */
const DEFERRED = Object.freeze({ pruned: [], charsRemoved: 0 })

/**
 * `ToolResultPruner` that declines to rewrite a surface mid-turn on a route
 * whose continuation contract pins the delivered history.
 */
export class GuardedToolResultPruner extends ToolResultPruner {
  static inject = ['tokenMeter']

  static Config = z.object({
    thresholdChars: z.number().step(1).min(1).default(8192),
    headChars: z.number().step(1).min(0).default(4096),
    tailChars: z.number().step(1).min(0).default(1024),
    deferWhenBatchPending: z.boolean(),
    contractProviders: z.array(z.string()),
  })

  #guard

  /**
   * @param ctx - plugin context.
   * @param config - parent pruning budgets plus this plugin's guard fields.
   */
  constructor(ctx, config = {}) {
    // The parent rejects unknown config keys, so guard fields must not reach it.
    super(ctx, parentConfigOf(config))
    this.#guard = resolvePruneGuard(config)
  }

  /**
   * Prune over-budget tool results, unless doing so would rewrite history that
   * the routed provider has already been given for a pending continuation.
   *
   * @param session - session whose current surface would be rewritten.
   * @returns the parent's prune result, or an empty result when deferred.
   */
  pruneSession(session) {
    if (shouldDeferPrune(session, this.#guard, PAIRING)) {
      this.ctx.logger?.debug?.(
        'compaction-guard: deferring tool-result prune; the surface is mid-turn on a contract provider',
      )
      return { ...DEFERRED }
    }
    return super.pruneSession(session)
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
    if (PRUNE_KEYS.has(key)) parent[key] = value
  }
  return parent
}

export default GuardedToolResultPruner
