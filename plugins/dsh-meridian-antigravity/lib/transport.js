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
import { meridianErrorFromText, streamInterrupted } from './errors.js'
import { enforceRequestBudget, serializeRequest } from './serialize.js'
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
  const { body, retained, compactionRemapped } = serializeRequest({
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
  const idle = idleWatch(signal, connection.streamIdleTimeoutMs)
  try {
    const key = await resolveApiKey(connection)
    const translator = new MeridianTranslator()
    try {
      const response = await dispatch(connection, streamingBody, headers, key, idle)
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
      if (idle.expired()) throw idleFailure(failure)
      if (signal?.aborted === true || isAbort(error)) {
        throw new LlmError('Meridian Antigravity turn aborted', 'ABORTED', { cause: error })
      }
      if (!isRecoverable(failure)) throw failure
      // The stream was cut short. Recover the saved answer under the same
      // identity rather than starting a second generation.
      for (const chunk of await recover({ connection, contract, translator, body, headers, key, signal, logger, failure })) {
        yield chunk
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

/** POST the streaming turn and classify a non-2xx without retrying generation. */
async function dispatch(connection, body, headers, key, idle) {
  let response
  try {
    response = await fetch(`${connection.baseURL}/v1/messages`, {
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
  if (response.ok) return response
  const text = await response.text()
  throw meridianErrorFromText(response.status, response.headers, text)
}

/** Failures a same-identity re-ask can plausibly resolve. */
function isRecoverable(error) {
  const code = error?.failure?.code
  return code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'SERVER'
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
