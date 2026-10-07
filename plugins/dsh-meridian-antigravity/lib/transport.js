/**
 * One Meridian turn: health gate, identity, dispatch, streaming, recovery.
 *
 * The transport is deliberately thin about policy. It never retries generation
 * on its own; it presents a stable identity, streams what arrives, and when a
 * stream is cut short before `message_stop` it performs the one recovery the
 * contract sanctions: re-ask the *saved answer* with the same identity and
 * `x-meridian-replay-only: true`, which never starts a model.
 *
 * @module @local/dsh-meridian-antigravity/lib/transport
 */

import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { batchSpent, meridianErrorFromText, streamInterrupted } from './errors.js'
import {
  blockedReplyNotice, isSpentBatch, rewrittenContinuationNotice, spentBatchNotice,
} from './failure.js'
import { enforceRequestBudget, serializeRequest } from './serialize.js'
import { continuationHint } from './continuation.js'
import { logicalRequestHash } from './idempotency.js'
import { MeridianTranslator, parseSse } from './stream.js'

/** Version of the Messages wire contract this adapter speaks. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Run one complete turn as a chunk stream.
 *
 * @param dependencies - resolved connection, contract, ledger, gate, key resolver.
 * @param options - the provider-neutral harness request.
 * @returns the harness chunk stream for this turn.
 */
export async function* runTurn(dependencies, options) {
  const { connection, contract, ledger, gate, resolveApiKey, logger } = dependencies
  const signal = options.signal
  const warn = once(dependencies.warn)

  // 1. Fail closed before anything else. A different backend or an unpinned CLI
  //    is an operator error on the host, never something to retry through.
  await contract.ensureHealthy(signal)

  // The harness session id is part of request identity. Two sessions that send
  // identical bytes are two logical turns, and Meridian keys both its saved
  // answers and its live-conversation reuse on the identity this adapter sends.
  const scope = typeof options.sessionId === 'string' ? options.sessionId : ''
  const { body, retained, compactionRemapped, continuation } = serializeRequest({
    options,
    connection,
    images: dependencies.images,
    imageAccess: dependencies.imageAccess,
    warn,
    sessionKey: scope,
  })
  // Diagnostic: if a compaction call is still refused by Meridian, this line
  // says whether the re-derivation ran and how much it covered, which separates
  // "the rewrite did not reach the wire" from "Meridian matched the ids anyway".
  if (compactionRemapped !== undefined) {
    logger?.info?.(
      `meridian-antigravity: compaction call re-derived ${compactionRemapped} tool id(s) `
      + 'so Meridian cannot match them to a delivered run',
    )
  }
  const streamingBody = { ...body, stream: true }
  const size = enforceRequestBudget({ body: streamingBody, retained }, connection)
  const hash = logicalRequestHash(body, scope)
  const identity = ledger.begin(hash)
  const headers = Object.freeze({
    ...attributionHeaders(),
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'idempotency-key': identity.id,
  })
  logger?.debug?.(
    `meridian-antigravity: ${identity.reused ? 'reusing' : 'minted'} request identity ${identity.id}`
    + ` for ${options.model} (${size} bytes)`,
  )

  const release = await gate.acquire(signal)
  let succeeded = false
  // Whether a response arrived at all. Any response, 2xx or error, means Meridian
  // received the request, and Meridian consumes an accepted tool batch on the
  // request side, so a failure after this point may already have spent the batch.
  // A connect failure means nothing reached Meridian and a retry is safe. The flag
  // is set where the response arrives rather than inferred from a status code
  // later, so the two cases cannot be confused.
  let reachedMeridian = false
  const idle = idleWatch(signal, connection.streamIdleTimeoutMs)
  try {
    const key = await resolveApiKey(connection)
    const translator = new MeridianTranslator()
    try {
      const response = await sendMessages(connection, streamingBody, headers, key, idle)
      reachedMeridian = true
      if (!response.ok) {
        // Meridian answered, so this is its verdict rather than a lost request.
        const text = await response.text()
        throw withContinuationHint(meridianErrorFromText(response.status, response.headers, text), continuation)
      }
      translator.markReplayed(response.headers.get('x-meridian-response-replayed') === 'true')
      const effective = response.headers.get('x-meridian-effective-model')
      if (effective !== null && effective !== options.model) {
        // Reachable only when Meridian's own budget adaptation is enabled. The
        // harness recorded the slug it asked for, so surface the divergence.
        logger?.warn?.(`meridian-antigravity: requested ${options.model} but Meridian ran ${effective}`)
      }
      if (response.body === null) throw streamInterrupted('response carried no body')
      for await (const event of parseSse(response.body)) {
        idle.pulse()
        for (const chunk of translator.push(event)) yield chunk
      }
      if (idle.expired()) throw idleFailure()
      if (!translator.state.finished) throw streamInterrupted('server closed the stream before message_stop')
      succeeded = true
      ledger.settle(hash, true)
      return
    } catch (error) {
      // Anything that is not already a classified failure came from the
      // transport itself — an undici `terminated`, a reset, a decode fault — and
      // is a cut stream, not a harness error to surface raw.
      const failure = error instanceof LlmError ? error : streamInterrupted(errorMessage(error), error)
      if (idle.expired()) throw spentIfContinuation(idleFailure(failure), continuation, reachedMeridian)
      if (signal?.aborted === true || isAbort(error)) {
        // A cancelled turn is the operator's decision, not a Meridian verdict, so
        // it is reported as such. If it spent the batch, the repair on the next
        // request is what heals it — nothing may be committed on an abort.
        throw new LlmError('Meridian Antigravity turn aborted', 'ABORTED', { cause: error })
      }
      // Meridian consumed the batch and the reply never arrived, so the assistant
      // turn this continuation owes does not exist. Committing a notice in its
      // place leaves the transcript ending on an assistant message, which is what
      // the next request needs; without it every later request re-presents a batch
      // Meridian has already consumed and is refused again.
      //
      // Two failures end here. Meridian reports one of them directly, as the
      // "already consumed" 409. The other is a blocked generation, which Meridian
      // does not report as a spent batch at all: because a blocked generation is
      // not retryable, nothing re-sends the request, so the 409 never appears and
      // this branch has to detect the block itself. A block on a turn with no
      // continuation is not repaired, because no tool result is left unanswered
      // and the user can send the request again.
      const code = failure.failure?.code
      const spent = isSpentBatch(failure.failure?.message ?? failure.message)
      const blocked = code === 'CONTENT_FILTERED' && continuation !== undefined
      // A refused continuation is about to be refused again: the rewritten
      // message is still in the transcript, and every later request re-presents
      // it. Meridian's verdict is the confirmation, so no local guess about the
      // prefix is involved. Left as an error, this repeats for every following
      // turn until an assistant message lands after the tool results, which is
      // what the notice does.
      const rewritten = code === 'MERIDIAN_CONTINUATION_CONFLICT' && continuation !== undefined
      if (connection.repairSpentBatch === true && (spent || blocked || rewritten)) {
        // A blocked turn can arrive late, after the model has streamed most of an
        // answer. That text is kept and the notice says so, rather than being
        // discarded along with the failed turn.
        const shown = translator.state.streamedText
        logger?.warn?.(
          'meridian-antigravity: Meridian consumed this turn\'s tool batch for a reply that was never'
          + ` completed (${shown.length > 0 ? 'a partial reply was delivered' : 'no reply was produced'});`
          + ' committing a notice so the conversation can continue',
        )
        // `spent` wins over `rewritten`: Meridian's "already consumed" text is
        // itself a 409, so it arrives under the same code and is the more
        // specific account of what happened.
        const notice = spent
          ? spentBatchNotice(continuation?.results)
          : rewritten
            ? rewrittenContinuationNotice(continuation?.results)
            : shown.length > 0
              ? blockedReplyNotice(continuation?.results)
              : spentBatchNotice(continuation?.results)
        for (const chunk of translator.closeWith(notice)) yield chunk
        succeeded = true
        ledger.settle(hash, true)
        return
      }
      // Everything below deliberately keeps its own code rather than becoming
      // `MERIDIAN_BATCH_SPENT`, even on a continuation. These are failures that
      // either cannot be retried anyway (`HTTP_499` "Request cancelled", `AUTH`,
      // `INVALID_REQUEST`), or that say something more specific and more useful
      // than "the batch is gone" (`CONTENT_FILTERED`, the transcript conflict).
      // The guard exists to stop a *retry* re-presenting a spent batch; where
      // nothing would be retried there is nothing for it to protect.
      if (!isRecoverable(failure)) throw failure
      // The stream was cut short. Recover the saved answer under the same
      // identity rather than starting a second generation.
      try {
        for (const chunk of await recover({ connection, contract, translator, body, headers, key, signal, logger, failure })) {
          yield chunk
        }
      } catch (recoveryFailure) {
        throw spentIfContinuation(recoveryFailure, continuation, reachedMeridian)
      }
      succeeded = true
      ledger.settle(hash, true)
      return
    }
  } finally {
    if (!succeeded) ledger.settle(hash, false)
    idle.dispose()
    release()
  }
}

/**
 * Re-ask the saved answer with the same identity and no streaming.
 *
 * `x-meridian-replay-only: true` never starts a model: it either returns the
 * snapshot Meridian already holds, or 404 when there is none. Because the bytes
 * are identical and the identity is unchanged, this is the only recovery path
 * that can complete a partially shown answer without risking a second
 * generation.
 */
async function recover({ connection, contract, translator, body, headers, key, signal, logger, failure }) {
  if (!translator.resumable) throw asTransportFailure(failure)
  let response
  try {
    response = await fetch(`${connection.baseURL}/v1/messages`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { ...headers, 'x-api-key': key, 'x-meridian-replay-only': 'true' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (signal?.aborted === true || isAbort(error)) {
      throw new LlmError('Meridian Antigravity recovery aborted', 'ABORTED', { cause: error })
    }
    throw asTransportFailure(failure)
  }
  if (!response.ok) {
    const text = await response.text()
    const classified = meridianErrorFromText(response.status, response.headers, text)
    contract.invalidate()
    if (classified.code === 'MERIDIAN_NO_SNAPSHOT') {
      // Nothing was saved to recover. The bounded retry may re-ask once under
      // the same identity, where Meridian's own unfinished-request guard decides
      // whether the turn is replayable or must be reconciled by hand.
      logger?.warn?.('meridian-antigravity: no saved answer to recover; re-asking once under the same identity')
      throw asTransportFailure(failure)
    }
    throw classified
  }
  let message
  try {
    message = await response.json()
  } catch (error) {
    throw asTransportFailure(failure, error)
  }
  translator.markReplayed(response.headers.get('x-meridian-response-replayed') === 'true')
  logger?.warn?.('meridian-antigravity: recovered a saved answer after an interrupted stream; no withheld tool is executed twice')
  return translator.resume(message)
}

/**
 * POST the streaming turn and hand back Meridian's response whatever its status.
 *
 * This is the only place a connection failure becomes an error, and it is the
 * boundary `spentIfContinuation` depends on. Throwing here means no response
 * arrived, so Meridian never saw the request and a retry cannot re-present a
 * consumed batch. A non-2xx is an answer from Meridian and means the opposite, so
 * it is returned for the caller to classify.
 *
 * @returns the fetch response, with `ok` still to be checked.
 */
async function sendMessages(connection, body, headers, key, idle) {
  try {
    return await fetch(`${connection.baseURL}/v1/messages`, {
      method: 'POST',
      signal: idle.signal,
      redirect: 'error',
      headers: { ...headers, 'x-api-key': key, accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (idle.expired()) throw idleFailure(error)
    if (idle.signal.aborted || isAbort(error)) {
      throw new LlmError('Meridian Antigravity turn aborted', 'ABORTED', { cause: error })
    }
    throw new LlmError(
      `Meridian Antigravity could not reach ${connection.baseURL}/v1/messages: ${errorMessage(error)}`,
      'TRANSPORT',
      { cause: error },
    )
  }
}

/**
 * Attach the continuation diagnosis to a transcript-conflict failure.
 *
 * Meridian reports a continuation it cannot recognise with the same 409 it uses
 * for a genuinely rewritten transcript, so the provider message alone points the
 * reader at the wrong cause. When this request's trailing tool results were
 * issued by another provider, say so on the error.
 *
 * @param error - the classified failure.
 * @param diagnosis - the continuation analysis recorded at serialization.
 * @returns the error, or a copy carrying the explanation.
 */
function withContinuationHint(error, diagnosis) {
  const hint = continuationHint(diagnosis)
  if (hint === undefined || !(error instanceof LlmError)) return error
  const failure = error.failure
  // Only the deterministic continuation conflict is explained this way. The
  // replayable and uncertain-outcome classes have their own causes.
  if (failure?.code !== 'MERIDIAN_CONTINUATION_CONFLICT') return error
  return new LlmError(`${failure.message}${hint}`, failure.code, {
    ...failure.status === undefined ? {} : { status: failure.status },
    ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
    ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
  })
}

/** Failures a same-identity re-ask can plausibly resolve. */
function isRecoverable(error) {
  const code = error?.failure?.code
  return code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'SERVER' || code === 'MERIDIAN_AGENT_INTERRUPTED'
}

/**
 * Reclassify a cut stream that may have spent the batch it was continuing.
 *
 * A cut stream is retryable in general because no tool block is delivered before
 * `message_stop`. That covers tool execution on the response side, not the
 * request side: Meridian consumes accepted tool results as it receives them, so
 * re-sending the request presents a batch it has already released and is refused
 * with a continuation conflict.
 *
 * `reachedMeridian` separates the two cases. If no response arrived, nothing
 * reached Meridian, so `TRANSPORT` stays retryable and the bounded policy may
 * re-send. If a response did arrive, the batch may already be consumed, and a
 * re-send can only fail again. The cost of the two mistakes is not equal: an
 * unnecessary re-send leaves the session stuck, while a suppressed one reports a
 * single error. So a failure on a continuation is treated as possibly spent
 * unless the connector knows nothing reached Meridian.
 *
 * @param failure - the failure being surfaced.
 * @param continuation - the continuation diagnosis, `undefined` for an ordinary turn.
 * @param reachedMeridian - whether Meridian answered this request at all.
 * @returns the replacement failure, or the original when a retry is still safe.
 */
function spentIfContinuation(failure, continuation, reachedMeridian) {
  if (!reachedMeridian || continuation === undefined) return failure
  if (!isRecoverable(failure)) return failure
  return batchSpent(failure)
}

/** Preserve an already-classified recoverable failure instead of flattening it. */
function asTransportFailure(failure, cause) {
  if (failure instanceof LlmError && isRecoverable(failure)) return failure
  if (failure instanceof LlmError) return failure
  return streamInterrupted(errorMessage(failure), cause ?? (failure instanceof Error ? failure : undefined))
}

function idleFailure(cause) {
  return new LlmError(
    'Meridian Antigravity stream idle timeout; Meridian’s own turn deadline is 300 seconds, so that process is gone',
    'TIMEOUT',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * One idle deadline covering connect and the whole stream read, reset by every
 * arriving frame.
 */
function idleWatch(signal, timeoutMs) {
  const controller = new AbortController()
  const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  let timer
  let expired = false
  const arm = () => {
    timer = setTimeout(() => {
      expired = true
      controller.abort(idleFailure())
    }, timeoutMs)
    timer.unref?.()
  }
  arm()
  return {
    signal: combined,
    pulse: () => {
      clearTimeout(timer)
      arm()
    },
    expired: () => expired,
    dispose: () => clearTimeout(timer),
  }
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Collapse repeated advisor warnings into one line per turn. */
function once(sink) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    if (sink !== undefined) sink(message)
  }
}
