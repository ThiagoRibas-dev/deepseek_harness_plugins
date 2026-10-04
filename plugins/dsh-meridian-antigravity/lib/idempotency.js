/**
 * Request identity for the Meridian identified-retry contract.
 *
 * Meridian keys recovery on one harness-supplied identity: the `idempotency-key`
 * header. Reusing it for the same bytes returns the same message id, tool ids,
 * arguments and usage without calling `agy` again; reusing it for different
 * bytes is a 409; and minting a fresh one to escape the uncertain-outcome guard
 * is explicitly forbidden.
 *
 * This ledger makes that identity a function of the bytes rather than of a
 * counter the harness would have to persist:
 *
 * - identical bytes that have not yet reached a terminal success reuse their id,
 *   so a transport retry, a retry after a protocol failure, and a recovery
 *   request all present the same identity Meridian recorded;
 * - identical bytes that already succeeded mint a new id, so an intentional
 *   regeneration is a new generation rather than a replay of the previous
 *   answer;
 * - different bytes always mint a new id, so the 409 "same id, different body"
 *   case is unreachable from this adapter;
 * - the harness session id participates, so two sessions that happen to send
 *   identical bytes never share one identity. Meridian keys its saved answers on
 *   the request id and its live-conversation reuse on the request contract, so a
 *   shared identity across sessions could replay one session's answer into
 *   another.
 *
 * The ledger is a derived cache, not a transcript. Its bounds mirror Meridian's
 * own saved-answer bounds, and the harness session log remains the source of
 * truth for what the model saw.
 *
 * @module @local/dsh-meridian-antigravity/lib/idempotency
 */

import { createHash } from 'node:crypto'

/** Meridian's saved-answer window; a later retry is not the same logical turn. */
export const LEDGER_TTL_MS = 30 * 60 * 1_000

/** Meridian's saved-answer entry bound. */
export const LEDGER_MAX_ENTRIES = 128

/**
 * Hash the logical request, deliberately excluding the `stream` control.
 *
 * Recovery re-asks a saved answer with the same identity and no streaming, and
 * Meridian accepts that, so the transport shape must not participate in the
 * identity this adapter computes. The session scope does: Meridian keys both its
 * saved answers and its live-conversation reuse on this identity, so two
 * different sessions that happen to send identical bytes must never share one.
 *
 * @param body - the serialized Messages request body.
 * @param scope - stable identity of the harness session, or the empty string.
 * @returns a stable hex digest.
 */
export function logicalRequestHash(body, scope = '') {
  const { stream: _stream, ...logical } = body
  const digest = createHash('sha256')
  if (typeof scope === 'string' && scope.length > 0) digest.update(scope).update('\u0000')
  return digest.update(JSON.stringify(logical)).digest('hex')
}

/** One remembered logical turn. */
class Entry {
  constructor(id, generation, now) {
    this.id = id
    this.generation = generation
    this.succeeded = false
    this.at = now
  }
}

/**
 * Bounded identity ledger keyed by logical-request hash.
 */
export class TurnLedger {
  #entries = new Map()
  #order = []
  #ttlMs
  #maxEntries

  constructor({ ttlMs = LEDGER_TTL_MS, maxEntries = LEDGER_MAX_ENTRIES } = {}) {
    this.#ttlMs = ttlMs
    this.#maxEntries = maxEntries
  }

  /**
   * Obtain the identity to present for this logical request.
   *
   * @param hash - digest from {@link logicalRequestHash}.
   * @returns the id to send, and whether this is a reuse of an earlier attempt.
   */
  begin(hash) {
    const now = Date.now()
    this.#prune(now)
    const existing = this.#entries.get(hash)
    if (existing !== undefined && !existing.succeeded) {
      existing.at = now
      return { id: existing.id, reused: true, generation: existing.generation }
    }
    const generation = existing === undefined ? 0 : existing.generation + 1
    const entry = new Entry(mintId(hash, generation), generation, now)
    this.#entries.set(hash, entry)
    this.#order.push(hash)
    this.#prune(now)
    return { id: entry.id, reused: false, generation }
  }

  /**
   * Record the terminal outcome of one attempt.
   *
   * A success retires the identity so the next identical request is a new
   * generation. Any failure keeps it reusable, which is what makes the harness's
   * own retry present the identity Meridian already recorded.
   *
   * @param hash - digest from {@link logicalRequestHash}.
   * @param succeeded - whether the attempt reached a terminal success.
   */
  settle(hash, succeeded) {
    const entry = this.#entries.get(hash)
    if (entry === undefined) return
    entry.succeeded = succeeded
    entry.at = Date.now()
  }

  /** Drop expired heads first, then the oldest entries until the bound holds. */
  #prune(now) {
    while (this.#order.length > 0) {
      const oldest = this.#order[0]
      const entry = this.#entries.get(oldest)
      const expired = entry === undefined || now - entry.at >= this.#ttlMs
      const overBound = this.#entries.size > this.#maxEntries
      if (!expired && !overBound) return
      this.#order.shift()
      if (entry !== undefined) this.#entries.delete(oldest)
    }
  }
}

/**
 * Mint an identity inside Meridian's 1..128 character ASCII letter, digit and
 * `._:-` alphabet.
 * @param hash - logical request digest.
 * @param generation - how many times this exact request has already succeeded.
 * @returns the header value.
 */
export function mintId(hash, generation) {
  const base = `dsh-${hash.slice(0, 32)}`
  return generation === 0 ? base : `${base}-r${generation}`
}
