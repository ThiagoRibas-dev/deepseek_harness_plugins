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
import { batchSpent, meridianErrorDetail, meridianErrorFromText, streamInterrupted } from './errors.js'
import {
  blockedReplyNotice, isSpentBatch, rewrittenContinuationNotice, spentBatchNotice,
} from './failure.js'
import { enforceRequestBudget, serializeRequest } from './serialize.js'
import { writeCapture } from './capture.js'
import { describeMovedMessage } from './diagnostics.js'
import { analyzeContinuation, continuationHint } from './continuation.js'
import { logicalRequestHash } from './idempotency.js'
import { MeridianTranslator, parseSse } from './stream.js'

/** Version of the Messages wire contract this adapter speaks. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The one signal `runTurn` accepts as "make the recovery retry".
 *
 * It is a local marker rather than a provider code: nothing Meridian sends means
 * this, and `runTurn` bounds it to a single attempt by setting `_isRetry`.
 */
const RECOVERY_RETRY_CODE = 'MERIDIAN_CONTINUATION_CONFLICT_RETRY'

/**
 * Run one complete turn as a chunk stream.
 *
 * The only generation-side retry this connector owns is the recovery turn. Two
 * failures owe a reply and take it: a continuation Meridian refused because the
 * prefix moved (a 409 that names a changed delivered history is deterministic and
 * would repeat forever, and Meridian's own error asks for the subsequent assistant
 * response before continuing), and a batch Meridian accepted and then lost.
 * `runTurnAttempt` asks for one retry — the `_isRetry` marker keeps it to one — and
 * this loop answers it with `recoveryTurn`, whose instruction depends on what the
 * tool results are. Either way the appended pair leaves the request ending on a user
 * message, so the retry is an ordinary call rather than a continuation and the
 * prefix constraint no longer applies. Any other failure is rethrown unchanged.
 *
 * @param dependencies - resolved connection, contract, ledger, gate, key resolver.
 * @param options - the provider-neutral harness request.
 * @returns the harness chunk stream for this turn.
 */
export async function* runTurn(dependencies, options) {
  let currentOptions = options
  while (true) {
    try {
      for await (const chunk of runTurnAttempt(dependencies, currentOptions)) {
        yield chunk
      }
      return
    } catch (error) {
      if (error.code === RECOVERY_RETRY_CODE) {
        dependencies.logger?.warn?.(
          'meridian-antigravity: recovery retry, appending the missing assistant turn'
          + ` (${error.reason ?? 'failure'}) and re-sending as an ordinary call`,
        )
        currentOptions = {
          ...currentOptions,
          _isRetry: true,
          // Start a new Meridian conversation for the retry, and keep the turn on
          // it: the calls this retry issues belong there, so their results must
          // continue there too. `conversationKey` reads `_isRetry`.
          messages: [...currentOptions.messages, ...recoveryTurn(currentOptions.messages)],
        }
        continue
      }
      throw error
    }
  }
}

async function* runTurnAttempt(dependencies, options) {
  const { connection, contract, ledger, gate, resolveApiKey, logger } = dependencies
  const signal = options.signal
  const warn = once(dependencies.warn)

  // 1. Fail closed before anything else. A different backend or an unpinned CLI
  //    is an operator error on the host, never something to retry through.
  await contract.ensureHealthy(signal)

  // The harness session id is part of request identity. Two sessions that send
  // identical bytes are two logical turns, and Meridian keys both its saved
  // answers and its live-conversation reuse on the identity this adapter sends.
  // `scope` stays the harness id for the ledger, captures and diagnostics; the
  // key on the wire can differ, because rotating it is how a conversation is
  // reset without losing the trail.
  const scope = typeof options.sessionId === 'string' ? options.sessionId : ''
  const sessionKey = conversationKey(scope, options, connection)
  if (sessionKey !== scope) {
    logger?.info?.(
      `meridian-antigravity: starting a fresh Meridian conversation (${connection.conversationMode === 'per-request'
        ? 'per-request mode'
        : 'recovery retry'}; key ${sessionKey})`,
    )
  }
  const { body, retained, compactionRemapped, continuation } = serializeRequest({
    options,
    connection,
    images: dependencies.images,
    imageAccess: dependencies.imageAccess,
    warn,
    sessionKey,
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
  // Opt-in, and written before dispatch so a request that is refused outright is
  // still on disk. A refused continuation is reported as a mismatch against a
  // history this process cannot see, so what was sent is the evidence.
  writeCapture(connection, {
    time: Date.now(),
    identity: identity.id,
    logicalRequestHash: hash,
    session: scope,
    model: options.model,
    purpose: options.purpose ?? null,
    continuation: continuation ?? null,
    bytes: size,
    body: streamingBody,
  }, logger)

  const release = await gate.acquire(signal)
  let succeeded = false
  // Whether a response arrived at all. Any response, 2xx or error, means Meridian
  // received the request, and Meridian consumes an accepted tool batch on the
  // request side, so a failure after this point may already have spent the batch.
  // A connect failure means nothing reached Meridian and a retry is safe. The flag
  // is set where the response arrives rather than inferred from a status code
  // later, so the two cases cannot be confused.
  let reachedMeridian = false
  // Meridian's own words for a refusal. Kept beside the classified error because
  // `LlmError.failure` is a frozen `{ code, message, status, requestId }`, so the
  // provider's text survives only inside a message the notice would otherwise
  // paraphrase. Bounded: this ends up in a transcript.
  let providerBody = ''
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
        providerBody = text
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
      if (idle.expired()) {
        const idleSpent = spentIfContinuation(idleFailure(failure), continuation, reachedMeridian)
        // The deadline expiring mid-stream is the second route to a spent verdict,
        // and it throws from inside this catch — before the repair block — so the
        // retry has to be taken here or not at all.
        throw spentRetry(idleSpent, { continuation, connection, options, logger, scope }) ?? idleSpent
      }
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
      // prefix is involved. The answer is one recovery retry (below), which
      // appends the assistant turn Meridian's error asks for; that retry is an
      // ordinary call, so nothing about the pinned prefix survives it.
      const rewritten = code === 'MERIDIAN_CONTINUATION_CONFLICT' && continuation !== undefined
      if (connection.repairSpentBatch === true && (spent || blocked || rewritten)) {
        // A blocked turn can arrive late, after the model has streamed most of an
        // answer. That text is kept and the notice says so, rather than being
        // discarded along with the failed turn.
        const shown = translator.state.streamedText
        // What Meridian actually said, and — when request capture is on — which
        // message moved between the last two dispatches. Both go on the refusal
        // log line: a notice replaces the error on the spent path, and without the
        // log the only account of the turn would be the connector's paraphrase,
        // which is how a pruner blame outlived an investigation that showed the
        // pruner had nothing to do with it.
        const provider = rewritten ? providerRefusal(providerBody) : ''
        const moved = rewritten
          ? describeMovedMessage(connection, scope, options.purpose ?? null)
          : ''

        // The first failure only asks `runTurn` for the one recovery retry that
        // appends the missing assistant turn. The marker keeps it to one: a
        // failure of the retry falls through to the notice or the error below.
        //
        // A refused continuation only asks `runTurn` for the one recovery retry
        // that appends the missing assistant turn. The marker keeps it to one: a
        // failure of the retry falls through to the notice or the error below.
        if (rewritten && !options._isRetry) {
          throw recoveryRetry({
            logger,
            code,
            failure,
            scope,
            provider,
            moved,
            reason: 'refusal',
          })
        }

        logger?.warn?.(
          'meridian-antigravity: Meridian consumed this turn\'s tool batch for a reply that was never'
          + ` completed (${shown.length > 0 ? 'a partial reply was delivered' : 'no reply was produced'});`
          + ' committing a notice so the conversation can continue',
        )
        logger?.warn?.(
          `meridian-antigravity: refusal detail: code=${code ?? 'unknown'}`
          + ` status=${failure.failure?.status ?? 'unknown'}`
          + ` request=${failure.failure?.requestId ?? 'unknown'}`
          + ` session=${scope === '' ? 'unknown' : scope}`
          + `${provider === '' ? '' : ` provider="${provider}"`}`
          + `${moved === '' ? '' : ` moved=${moved}`}`,
        )
        // `spent` wins over `rewritten`: Meridian's "already consumed" text is
        // itself a 409, so it arrives under the same code and is the more
        // specific account of what happened.
        const notice = spent
          ? spentBatchNotice(continuation?.results)
          : rewritten
            ? rewrittenContinuationNotice(continuation?.results, {
                provider,
                status: failure.failure?.status,
                requestId: failure.failure?.requestId,
                moved,
              })
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
        const spentFailure = spentIfContinuation(recoveryFailure, continuation, reachedMeridian)
        // The replay attempt is the probe that decides "spent": a saved answer
        // means the turn can still be finished from it, and its absence means the
        // batch is gone. That verdict is reached after the repair block above, so
        // this is where a cut turn first knows it is a spent batch. Measured on
        // `session-dc7217e4` turn 2, which died here with `Antigravity turn timed
        // out`: the turn was reported with no reply and no retry.
        throw spentRetry(spentFailure, { continuation, connection, options, logger, scope }) ?? spentFailure
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
 * Ask `runTurn` for the single recovery retry, after recording why.
 *
 * Two paths reach a failure that owes a reply: a refused continuation, and a
 * batch that was spent. Both answer it the same way — append the assistant turn
 * Meridian's error asks for plus a user instruction, then re-send as an ordinary
 * call — so the marker and the log line live here rather than at each site, and
 * cannot drift apart.
 *
 * The log line is not decoration: a notice replaces the error on these paths, so
 * without it the only account of the turn is the connector's own paraphrase.
 *
 * @returns the error to throw; `runTurn` recognises the code and retries once.
 */
function recoveryRetry({ logger, reason, code, failure, scope, provider = '', moved = '' }) {
  const status = failure?.failure?.status ?? 'unknown'
  const requestId = failure?.failure?.requestId ?? 'unknown'
  const session = scope === '' || scope === undefined ? 'unknown' : scope
  logger?.warn?.(
    `meridian-antigravity: ${reason}; retrying once as an ordinary call`
    + ` (attempt 2 of 2, code=${code ?? 'unknown'})`,
  )
  logger?.warn?.(
    `meridian-antigravity: ${reason} detail: code=${code ?? 'unknown'} status=${status}`
    + ` request=${requestId} session=${session}`
    + `${provider === '' ? '' : ` provider="${provider}"`}`
    + `${moved === '' ? '' : ` moved=${moved}`}`,
  )
  return Object.assign(new Error('Retry'), { code: RECOVERY_RETRY_CODE, reason })
}

/**
 * The recovery retry a spent batch is owed, or `undefined` when none may be taken.
 *
 * A batch Meridian accepted and then lost leaves a reply owed and the transcript
 * ending on the tool results that were consumed. A re-send of that continuation
 * can only be refused again, which is why the connector used to stop here. The
 * retry works only because `runTurn` appends an assistant turn and a user
 * instruction: that leaves the request ending on a user message, so it is an
 * ordinary call rather than the continuation whose batch was spent. Meridian
 * accepted exactly that shape live — the conflict retry in `session-dc7217e4`,
 * 61 messages, `continuation: null`.
 *
 * @param failure - the failure that may be a spent batch.
 * @param state - the attempt's continuation diagnosis, connection, options, logger and session key.
 * @returns the marker error to throw, or `undefined` to let the failure through.
 */
function spentRetry(failure, state) {
  const { continuation, connection, options, logger, scope } = state
  const code = failure?.failure?.code ?? failure?.code
  if (code !== 'MERIDIAN_BATCH_SPENT') return undefined
  if (connection.repairSpentBatch !== true) return undefined
  if (continuation === undefined) return undefined
  if (options._isRetry || options.signal?.aborted === true) return undefined
  return recoveryRetry({ logger, code, failure, scope, reason: 'spent batch' })
}

/** The placeholder assistant turn Meridian's error asks for. */
const RECOVERY_ASSISTANT_TEXT = 'Recovering from transcript conflict.'

/** How much of the newest request the recovery turn repeats. */
const RECOVERY_REQUEST_MAX_CHARS = 4_000

/**
 * The player message that arrived *after* the tool results, if there is one.
 *
 * Position is the whole discriminator. A mid-turn continuation ends on the tool
 * results, and the player's request from earlier in the turn is not what the model
 * should answer — "continue your work using the tool results above" is correct
 * there. The case that misdirects is a *new* player turn that arrived while a spent
 * batch was still at the tail: the request then sits after the tool results, and
 * only that one is an instruction to re-issue.
 *
 * Two traps the predicate avoids:
 *
 * - `role: 'user'` does not identify the player. The harness records runtime
 *   context, workspace instructions, the skill catalog and a compaction checkpoint
 *   as user messages, and none is a request. `source.kind === 'user'` is the same
 *   predicate `lib/serialize.js` uses to tell a player turn from an injected notice.
 * - The player's turn is not necessarily last. Those notices are appended *after*
 *   it, so the search runs forward from the last tool result rather than assuming a
 *   position.
 *
 * @param messages - the request being retried.
 * @returns its text, capped, or `undefined` when the tool results are the newest thing.
 */
function requestAfterToolResults(messages) {
  let lastTool = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'tool') { lastTool = index; break }
  }
  if (lastTool === -1) return undefined
  for (let index = lastTool + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    if (!Array.isArray(message.content)) return undefined
    const text = message.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text.trim())
      .filter(line => line.length > 0)
      .join('\n\n')
    if (text.length === 0) return undefined
    return text.length > RECOVERY_REQUEST_MAX_CHARS
      ? `${text.slice(0, RECOVERY_REQUEST_MAX_CHARS)}\n[request truncated for the retry]`
      : text
  }
  return undefined
}

/**
 * How many sessions keep a conversation ordinal.
 *
 * Both the per-request counter and the reset counter live beside the session id
 * rather than in the request, because a request cannot carry state forward. The
 * cap keeps a long-lived adapter from growing a map of finished sessions forever.
 */
const CONVERSATION_ORDINAL_LIMIT = 256

/** Session id to the last ordinal handed out. */
const conversationOrdinals = new Map()

/**
 * Session id to the conversation a repair moved the current turn onto.
 *
 * A repair has to send the request somewhere the old conversation's verdict does
 * not apply, so it rotates the key. But the retry is not a one-off: the model
 * issues **new tool calls** in that conversation, and their results return to the
 * harness as ordinary continuation messages. If the next request went out under the
 * pinned key again, it would present a `tool_result` for a call id that
 * conversation never issued, and Meridian — whose ownership map is keyed by tool id
 * — could not recognise it as a continuation.
 *
 * Measured on `session-10c2aff1`: ten repairs in one turn, one per step, because
 * every continuation after a repair returned to the pinned key.
 *
 * So the switch lasts as long as the turn: sticky while requests are
 * continuations, cleared by the next turn opener, the only request that can safely
 * seed a conversation.
 */
const stickyConversations = new Map()

/**
 * The `meridian_session_key` this dispatch carries.
 *
 * Meridian keys a live CLI conversation by this string, and an exact continuation
 * reuses that process. Three cases send something other than the harness id:
 *
 * - `per-request` mode, where no request is a continuation at all, so Meridian
 *   replays history instead of matching a delivered prefix;
 * - the recovery retry, whose request the old conversation has already refused. A
 *   new key gives it a conversation with no history to disagree with;
 * - every continuation that follows that retry, because the tool calls it issued
 *   live in the new conversation and their results must continue there.
 *
 * The key is suffixed rather than replaced so a capture or a log line still names
 * the harness session it belongs to.
 *
 * @param base - the harness session id, or `''` when the caller supplied none.
 * @param options - the attempt's request; `_isRetry` marks the recovery retry.
 * @param connection - resolved options, for `conversationMode`.
 * @returns the key to put on the wire.
 */
function conversationKey(base, options, connection) {
  if (base.length === 0) return base
  if (connection.conversationMode === 'per-request') {
    return `${base}#p${nextOrdinal(base)}`
  }
  if (options._isRetry === true) {
    const rotated = `${base}#r${nextOrdinal(base)}`
    rememberSticky(base, rotated)
    return rotated
  }
  const sticky = stickyConversations.get(base)
  if (sticky !== undefined) {
    // A continuation must stay in the conversation that issued its tool calls. Any
    // other shape is a new turn starting, so the pin applies again.
    if (analyzeContinuation(options.messages) !== undefined) return sticky
    stickyConversations.delete(base)
  }
  return base
}

/** Record the conversation a repaired turn continues on. */
function rememberSticky(base, key) {
  if (stickyConversations.size >= CONVERSATION_ORDINAL_LIMIT && !stickyConversations.has(base)) {
    const oldest = stickyConversations.keys().next()
    if (!oldest.done) stickyConversations.delete(oldest.value)
  }
  stickyConversations.set(base, key)
}

/** Hand out the next suffix for one session. */
function nextOrdinal(base) {
  const ordinal = (conversationOrdinals.get(base) ?? 0) + 1
  if (conversationOrdinals.size >= CONVERSATION_ORDINAL_LIMIT && !conversationOrdinals.has(base)) {
    const oldest = conversationOrdinals.keys().next()
    if (!oldest.done) conversationOrdinals.delete(oldest.value)
  }
  conversationOrdinals.set(base, ordinal)
  return ordinal
}

/**
 * The two messages the one recovery retry appends.
 *
 * Meridian's error asks for the assistant turn it never delivered, so the pair
 * always starts with a placeholder. What follows it decides which instruction the
 * model treats as current, and the failures that reach here need different
 * answers:
 *
 * - A spent batch, or a continuation refused mid-turn, left tool results that
 *   belong to the request being answered. "Continue your work using the tool
 *   results above" is right.
 * - A continuation refused because a *new player turn* arrived while a spent batch
 *   was still at the tail is the opposite case. `lib/serialize.js` merges that turn
 *   into the tool result, so the request is no longer the last instruction, and
 *   telling the model to continue the previous work answers the previous request.
 *   Measured in `session-dc7217e4`: turns 3 and 5 retried under exactly that
 *   instruction and both repeated the answer to turn 1, while the player's words
 *   sat in the middle of a tool-result turn.
 *
 * So when the newest player message carries text, that text is re-issued as the
 * operative instruction. Text only — images and tool results stay where they are,
 * because re-sending their bytes is the cost this retry exists to avoid — and
 * capped, because a pasted error must not double the request.
 *
 * @param messages - the request being retried.
 * @returns the assistant placeholder and the user instruction.
 */
function recoveryTurn(messages) {
  const request = requestAfterToolResults(messages)
  const lead = 'The previous tool batch was interrupted by a transcript rewrite.'
  const text = request === undefined
    ? `${lead} Please continue your work using the tool results above.`
    : `${lead} The tool results above answer the previous request; they are not the request`
      + ` being answered now. The user's newest message is the instruction, repeated here:\n\n${request}`
  return [
    { role: 'assistant', content: [{ type: 'text', text: RECOVERY_ASSISTANT_TEXT }] },
    { role: 'user', content: [{ type: 'text', text }] },
  ]
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

/**
 * Meridian's own words for a refused continuation, from the raw response body.
 *
 * The body is JSON, so its message and type are preferred; anything unparseable
 * falls back to the raw text. Not truncated here, so the log line and the notice
 * quote the same string and only the notice decides how much fits.
 *
 * @param raw - the response body text of the refused request, or `''`.
 * @returns the provider's message, or `''` when there is none.
 */
function providerRefusal(raw) {
  const text = String(raw ?? '')
  if (text.length === 0) return ''
  try {
    const { message, type } = meridianErrorDetail(text)
    if (typeof message === 'string' && message.length > 0) {
      return typeof type === 'string' && type.length > 0 ? `${type}: ${message}` : message
    }
  } catch {
    // Not JSON, or not the shape Meridian usually sends.
  }
  return text
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
