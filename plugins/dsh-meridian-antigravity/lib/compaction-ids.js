/**
 * Tool-identity rewriting for compaction calls.
 *
 * A compaction call replays part of the conversation, so its messages carry the
 * tool ids Meridian handed out when it delivered those calls. Meridian keeps a
 * flat map of tool id to owning run (`antigravityRuntime.ts:391`), looks a
 * request's trailing tool results up in it, and treats any hit as that run's
 * tool continuation, which it then requires to match the delivered batch and
 * history exactly (`antigravity.ts:86`). A compaction replay is not that
 * continuation, so it is refused.
 *
 * Nothing about a summarisation needs those particular ids: no tool is executed
 * from a compaction call, and the ids carry no meaning for the summary text.
 * Re-deriving them removes the only thing that associates the replay with a
 * delivered run.
 *
 * The new ids are a hash of the old ones rather than fresh random values. The
 * transport keys its `idempotency-key` header on a hash of the request bytes,
 * and Meridian refuses a request id that arrives with different bytes, so a
 * random rewrite would break the first retry of a compaction call. A pure
 * function of the old id keeps one logical call byte-stable.
 *
 * @module @local/dsh-meridian-antigravity/lib/compaction-ids
 */

import { createHash } from 'node:crypto'

/** Prefix making a re-derived id recognisable in a transcript or a packet capture. */
const PREFIX = 'toolu_cc_'

/** Hex characters kept from the digest; 24 hex characters is 96 bits. */
const DIGEST_CHARS = 24

/**
 * Deterministically re-derive one tool id.
 *
 * @param id - the id the harness carried into the compaction replay.
 * @returns a stable replacement id, or the input when it is not a usable id.
 */
export function compactionToolId(id) {
  if (typeof id !== 'string' || id.length === 0) return id
  const digest = createHash('sha256').update(id).digest('hex').slice(0, DIGEST_CHARS)
  return `${PREFIX}${digest}`
}

/**
 * Re-derive every tool id in an Anthropic-shaped message list, keeping each
 * `tool_use` paired with the `tool_result` that answers it.
 *
 * The mapping is shared across the whole list, so an id repeated in a later
 * message resolves to the same replacement, and two different ids cannot
 * collapse onto one.
 *
 * @param messages - wire messages from `buildMessages`.
 * @returns the rewritten messages and how many distinct ids were re-derived.
 */
export function remapToolIds(messages) {
  if (!Array.isArray(messages)) return { messages, remapped: 0 }
  const mapping = new Map()
  const resolve = (id) => {
    if (typeof id !== 'string' || id.length === 0) return id
    const existing = mapping.get(id)
    if (existing !== undefined) return existing
    const next = compactionToolId(id)
    mapping.set(id, next)
    return next
  }

  const rewritten = messages.map((message) => {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) {
      return message
    }
    let touched = false
    const content = message.content.map((block) => {
      if (block === null || typeof block !== 'object') return block
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        touched = true
        return { ...block, id: resolve(block.id) }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        touched = true
        return { ...block, tool_use_id: resolve(block.tool_use_id) }
      }
      return block
    })
    return touched ? { ...message, content } : message
  })

  return { messages: rewritten, remapped: mapping.size }
}
