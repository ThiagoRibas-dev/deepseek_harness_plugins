/**
 * Tool-result retention — the prune pass, free of harness imports.
 *
 * Spec: `docs/dsh-tool-result-policy.md` §2.3–2.4.
 *
 * Two policies over one traversal:
 *
 *   1. **Strip** — a result whose tool is classified as transient, entropy or
 *      mutation is replaced wholesale by a one-line marker.
 *   2. **Truncate** — anything else over the budget keeps the head-and-tail
 *      behaviour the shipped pruner already had, so a result from a tool this
 *      policy has never heard of degrades rather than disappearing.
 *
 * The session protocol is deliberately mirrored from
 * `@deepseek-ai/dsh-compaction-tool-result-pruner`: a `compaction/prune` shadow
 * event prices the shadowed node through the injected token meter and is appended
 * immediately *before* its replacement, so pure consumers can subtract the price
 * without keeping per-node state. `index.js` supplies the real session; the tests
 * supply a recording double.
 */
import { elisionMarker, isElided, shouldStrip } from './policy.js'

/** Placeholder the shipped pruner uses for a truncated middle. */
export const TRUNCATION_MARKER = '\n…[trimmed]…\n'

/**
 * Map every recorded tool call to its tool name.
 *
 * A `tool/result` records only a `toolCallId`; the name lives on the
 * `tool-call` block of the assistant message that requested it. Without this
 * lookup the policy cannot classify anything, which is why an unresolvable call
 * is **kept** rather than guessed at.
 *
 * Read from the **surface**, mirroring the shipped pruner: iterate
 * `session.surface.nodes` and `session.eventAt(seq)`, and take the call blocks
 * out of `assistant/message`. Do not reach for a whole-log read —
 * `snapshotEvents()`/`ownEvents()` are deprecated, and **`session.events` does
 * not exist**. The first version of this function read `session.events`; it
 * produced an empty map on every real session, so nothing was ever classified
 * and the strip never fired, while 240 tests passed against a double that had
 * invented the property. A `tool/call` node is still honoured when a surface
 * carries one.
 */
export function toolNamesByCallId(session) {
  const names = new Map()
  for (const seq of session?.surface?.nodes ?? []) {
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
          names.set(block.id, block.name)
        }
      }
      continue
    }
    if (event?.type === 'tool/call') {
      const { callId, name } = event.data ?? {}
      if (typeof callId === 'string' && typeof name === 'string') names.set(callId, name)
    }
  }
  return names
}

/** The tool call a result answers. `source.callId` is the live shape; the rest are fallbacks. */
export function callIdOf(message, eventData) {
  return message?.source?.callId ?? message?.toolCallId ?? eventData?.callId ?? null
}

/** The plain text a result carries, for measuring and for recognising markers. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
}

/** A result already reduced to one text block, or null when nothing changed. */
function asElided(content, marker) {
  const blocks = Array.isArray(content) ? content : []
  if (blocks.length === 1 && blocks[0]?.type === 'text' && blocks[0].text === marker) return null
  return [{ type: 'text', text: marker }]
}

/**
 * Head-and-tail truncation for a kept result.
 *
 * Code-point based, matching the shipped implementation, so a multi-byte
 * character is never cut in half by a byte-oriented slice.
 */
export function truncateContent(content, { headChars, tailChars }) {
  const points = [...textOf(content)]
  if (points.length <= headChars + tailChars + TRUNCATION_MARKER.length) return null
  const text = points.slice(0, headChars).join('')
    + TRUNCATION_MARKER
    + points.slice(points.length - tailChars).join('')
  return [{ type: 'text', text }]
}

/**
 * Plan the pass without touching the session.
 *
 * Returns one decision per candidate result so the caller can commit them in a
 * deliberate order, and so the whole policy is testable against a double.
 *
 * @param session - anything exposing `surface.nodes`, `eventAt(seq)` and `events`.
 * @param options - `{ strip, thresholdChars, headChars, tailChars, measure }`.
 * @returns `[{ seq, callId, toolName, action, content, charsBefore, charsAfter }]`
 *   where `action` is `'strip'`, `'truncate'` or `'keep'`.
 */
export function planPrune(session, options = {}) {
  const {
    strip = false,
    thresholdChars = 8192,
    headChars = 4096,
    tailChars = 1024,
    measure = (content) => [...textOf(content)].length,
  } = options

  const names = toolNamesByCallId(session)
  const plan = []
  for (const seq of [...(session.surface?.nodes ?? [])]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message ?? {}
    const callId = callIdOf(message, event.data)
    const toolName = names.get(callId) ?? null
    const content = message.content ?? []
    const charsBefore = measure(content)

    // Already elided: a second pass over the same session is free.
    if (isElided(textOf(content))) {
      plan.push({ seq, callId, toolName, action: 'keep', reason: 'already-elided', content: null, charsBefore, charsAfter: charsBefore })
      continue
    }

    if (strip && shouldStrip(toolName)) {
      const next = asElided(content, elisionMarker(toolName, charsBefore))
      // Only if it actually saves room. A five-character result has nothing worth
      // removing, and replacing it with a ninety-character marker would *grow* the
      // history — the opposite of the point.
      if (next !== null && measure(next) < charsBefore) {
        plan.push({ seq, callId, toolName, action: 'strip', content: next, charsBefore, charsAfter: measure(next) })
        continue
      }
    }

    // Kept tools still honour the size budget, which is the shipped behaviour and
    // the safety net for a tool this policy has never classified.
    if (charsBefore > thresholdChars) {
      const next = truncateContent(content, { headChars, tailChars })
      if (next !== null) {
        plan.push({ seq, callId, toolName, action: 'truncate', content: next, charsBefore, charsAfter: measure(next) })
        continue
      }
    }

    plan.push({ seq, callId, toolName, action: 'keep', reason: 'classified-keep', content: null, charsBefore, charsAfter: charsBefore })
  }
  return plan
}

/**
 * Commit a plan to a session.
 *
 * **Descending order.** A surface replacement re-points the node, and committing
 * a lower sequence first could invalidate a higher one still to come; working from
 * the end backwards keeps every not-yet-committed sequence valid. Each replacement
 * is preceded by its `compaction/prune` shadow event, and preserves the complete
 * event data apart from `content`.
 *
 * **`estimateTokens` must be the meter's own `estimateMessage`.** Consumers
 * subtract `shadowedTokenCount` from the token total, so the price has to be the
 * same function that charged the node. There is no `session.tokenMeter`: an
 * earlier version read one, silently wrote `0` for every prune, and left the
 * meter over-counting. The caller supplies `ctx.tokenMeter.estimateMessage`; the
 * character heuristic is only a fallback for a caller with no meter.
 *
 * @param session - session whose surface is rewritten.
 * @param plan - entries from {@link planPrune}.
 * @param options - `{ estimateTokens }`, a `(message) => number` price.
 * @returns `{ pruned, charsRemoved }` in the shape the compaction engine expects.
 */
export function commitPlan(session, plan, { estimateTokens } = {}) {
  const price = typeof estimateTokens === 'function'
    ? estimateTokens
    : (message) => Math.ceil(textOf(message?.content).length / 4)
  const pruned = []
  let charsRemoved = 0
  const actionable = plan.filter((entry) => entry.action !== 'keep').sort((a, b) => b.seq - a.seq)
  for (const entry of actionable) {
    const event = session.eventAt(entry.seq)
    if (event?.type !== 'tool/result') continue
    const original = event.data.message
    const message = { ...original, content: entry.content }
    session.append('compaction/prune', {
      shadowedRange: { start: entry.seq, end: entry.seq },
      shadowedSeqs: [entry.seq],
      shadowedTokenCount: price(original),
    })
    const replacement = session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
      sourceEventSeqs: [entry.seq],
    })
    pruned.push({
      originalSeq: entry.seq,
      replacementSeq: replacement?.seq ?? null,
      callId: entry.callId,
      charsBefore: entry.charsBefore,
      charsAfter: entry.charsAfter,
    })
    charsRemoved += entry.charsBefore - entry.charsAfter
  }
  return { pruned, charsRemoved }
}
