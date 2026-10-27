/**
 * Streaming relay between one member's adapter and the rotation adapter's
 * consumer.
 *
 * The relay owns the one rule that makes failover safe: a chunk is *committed*
 * once it carries output the consumer could show. Everything before that can be
 * discarded and retried on another member:
 *
 * - `usage` is metadata. Providers emit it even for a request that then fails
 *   (the harness adapter reports a zero total in that case), so it never
 *   commits.
 * - `block-start` is held back until its block produces something. A provider
 *   that announces a block and then fails would otherwise leave an empty block
 *   in the assembled message after a retry.
 * - A content delta, a `block-end`, or any unknown chunk commits.
 * - A terminal error finish before any content is reported to the caller as
 *   `failedFinish` and is not yielded, so the caller can retry.
 *
 * The relay always closes the inner iterator when it stops early, including
 * when the consumer returns or throws at a yield.
 *
 * @module @local/dsh-model-rotation/stream
 */

/**
 * Classify one non-finish chunk by whether it commits the request.
 * @param chunk - streaming chunk.
 * @returns whether the chunk carries output.
 */
export function isContentChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'usage':
    case 'block-start':
      return false
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text.length > 0
    default:
      return true
  }
}

/**
 * Relay one member stream, mutating a tracker with the outcome.
 *
 * Tracker fields after settlement:
 * - `committed`: whether any output reached the consumer.
 * - `finish`: the terminal finish chunk that was yielded (success, aborted, or
 *   an error received after output).
 * - `failedFinish`: a terminal error finish received before any output. It was
 *   not yielded; the caller may retry.
 * - `thrown`: the raw error thrown by the inner iterator, if any.
 *
 * @param iterator - the member adapter's async iterator.
 * @param tracker - per-attempt outcome object.
 * @param options - optional `runNext(fn)` wrapper around each inner `next()`;
 *   the rotation adapter uses it to expose the request's capture context to
 *   pi-ai's `onPayload` hook.
 * @returns an async iterable of the chunks that should reach the consumer.
 */
export async function* relayMemberStream(iterator, tracker, { runNext } = {}) {
  if (tracker.committed !== true) tracker.committed = false
  const next = typeof runNext === 'function' ? runNext : fn => fn()
  let pendingStarts = []
  let done = false

  function* flushStarts() {
    const starts = pendingStarts
    pendingStarts = []
    for (const start of starts) yield start
  }

  try {
    while (true) {
      let result
      try {
        result = await next(() => iterator.next())
      } catch (error) {
        tracker.thrown = error
        return
      }
      if (result.done === true) {
        done = true
        return
      }
      const chunk = result.value
      if (chunk?.type === 'usage') {
        for (const start of flushStarts()) yield start
        yield chunk
        continue
      }
      if (chunk?.type === 'block-start') {
        pendingStarts.push(chunk)
        continue
      }
      if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error' && tracker.committed !== true) {
          // The request produced no output; discard the unstarted blocks and
          // let the caller try another member.
          pendingStarts = []
          tracker.failedFinish = chunk
          return
        }
        for (const start of flushStarts()) yield start
        tracker.finish = chunk
        tracker.committed = true
        yield chunk
        return
      }
      for (const start of flushStarts()) yield start
      if (isContentChunk(chunk)) tracker.committed = true
      yield chunk
    }
  } finally {
    if (!done) {
      try {
        await iterator.return?.()
      } catch {
        // The inner adapter owns its own abort and teardown; this only closes
        // the iterator it handed out.
      }
    }
  }
}
