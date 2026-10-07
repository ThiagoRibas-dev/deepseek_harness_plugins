/**
 * Meridian failure classification.
 *
 * The contract does not let a harness treat every non-2xx the same way. Some
 * statuses are permanent transcript problems, one is an uncertain outcome that
 * must never be retried under a fresh identity, and only the transient set is
 * eligible for the provider retry policy. This module is the single place that
 * decision is made.
 *
 * @module @local/dsh-meridian-antigravity/lib/errors
 */

import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import { isAgentInterrupted, isContentFiltered } from './failure.js'
import { parseResetWindow, quotaFailure } from './quota.js'

/** HTTP status is not enough: these codes come from the response body. */
const QUOTA_HINTS = /quota|billing|insufficient|subscription|overage/iu
const CONTEXT_HINTS = /context length|context window|too many tokens|prompt is too long|exceeds? the maximum/iu

/**
 * Meridian returns 409 for several unrelated conditions, so the provider message
 * decides the classification and the status alone cannot.
 *
 * `completed history can be replayed` is the pair of conditions Meridian raises
 * after it has already released the process waiting for a tool result: an idle
 * process reclaimed under capacity pressure, or an expired tool deadline. Both
 * are replay-safe, so a retry of the identical request continues from the saved
 * history instead of running a tool again.
 *
 * The restart and reused-id messages are the genuine uncertain-outcome cases.
 * Everything else is a deterministic conflict where re-sending cannot help.
 */
const REPLAYABLE_409 = /completed history can be replayed/iu
const UNCERTAIN_409 = /without a saved response|reused with a different request/iu

/**
 * Parse `Retry-After` as either delta-seconds or an HTTP date.
 * @param headers - response headers.
 * @returns a positive delay in milliseconds, or undefined.
 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (raw == null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  const delta = at - Date.now()
  return delta > 0 ? delta : undefined
}

/** Read the request identity Meridian echoes, for diagnostics only. */
function requestIdOf(headers) {
  const id = headers?.get?.('x-meridian-request-id')
    ?? headers?.get?.('request-id')
    ?? headers?.get?.('x-request-id')
  return typeof id === 'string' && id.length > 0 ? ProviderRequestId(id) : undefined
}

/**
 * Extract Meridian's error envelope without trusting unrelated fields.
 * @param raw - decoded JSON body, when it parsed.
 * @returns the human message and the provider's own error type.
 */
export function meridianErrorDetail(raw) {
  const envelope = typeof raw === 'object' && raw !== null ? raw : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {}
  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : typeof envelope.message === 'string' ? envelope.message : ''
  const type = typeof error.type === 'string' ? error.type : ''
  return { message, type }
}

/**
 * The one `CONTENT_FILTERED` failure, shared by both transports.
 *
 * A blocked generation reaches the harness two ways: as a stream cut carrying
 * Google's policy text, and as an HTTP 502 carrying the same text. The two paths
 * produce the same message and the same classification, so the message is built
 * here once.
 *
 * @param detail - the provider's own text.
 * @param facts - failure facts to carry, when there are any.
 * @returns the non-retryable classification.
 */
function contentFiltered(detail, facts) {
  return new LlmError(
    'Meridian Antigravity produced no reply: the backend blocked the model\'s output with its content'
    + ' filter. The turn cannot be retried as-is, because the same request is blocked the same way.'
    + ` (${detail})`,
    'CONTENT_FILTERED',
    facts,
  )
}

/**
 * Classify one non-2xx Meridian response into a provider-neutral `LlmError`.
 *
 * Retryability is expressed by the code plus the adapter's retry policy, not by
 * this function: `MERIDIAN_CONTINUATION_CONFLICT`, `MERIDIAN_UNCERTAIN_OUTCOME`,
 * `MERIDIAN_NO_SNAPSHOT`, `MERIDIAN_STOP_IN_STRUCTURED_OUTPUT`,
 * `INVALID_REQUEST` and `AUTH` are all deliberately absent from the default
 * retryable set. `MERIDIAN_PENDING_REPLAYABLE` is the single 409 the default
 * policy retries, because Meridian has already released the waiting process for
 * that condition and keeps the completed history a retry replays.
 *
 * The status is not always the whole answer. Two Meridian conditions arrive as a
 * 502 whose body says what actually happened, and classifying them by status
 * alone would both hide them and, for the content filter, retry a turn that can
 * only be refused again.
 *
 * @param raw - decoded JSON body, when it parsed.
 * @param status - HTTP status.
 * @param headers - response headers, for `Retry-After` and request identity.
 * @returns the error to throw at the adapter boundary.
 */
export function meridianError(raw, status, headers) {
  const { message: providerMessage, type } = meridianErrorDetail(raw)
  const detail = `${type} ${providerMessage}`
  const retryAfter = retryAfterMs(headers)
  const requestId = requestIdOf(headers)
  const facts = {
    status,
    ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
    ...requestId === undefined ? {} : { requestId },
  }
  const message = providerMessage.length > 0
    ? `Meridian Antigravity: ${providerMessage}`
    : `Meridian Antigravity request failed (${status})`

  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') {
    return new LlmError(message, 'AUTH', facts)
  }
  if (status === 409) {
    if (REPLAYABLE_409.test(providerMessage)) {
      return new LlmError(
        'Meridian released the process that was waiting for this tool result and still holds the completed'
        + ' history. Retrying the identical request continues from that saved history; no tool runs twice.'
        + ` (${message})`,
        'MERIDIAN_PENDING_REPLAYABLE',
        facts,
      )
    }
    // An unreadable 409 (a bare gateway conflict) is not enough to claim the
    // delivered history changed, so only a concrete non-matching provider
    // message is classified as the deterministic continuation conflict.
    if (providerMessage.length === 0 || UNCERTAIN_409.test(providerMessage)) {
      return new LlmError(
        'Meridian reports an uncertain outcome for this request identity: the service either saw the same id with'
        + ' different bytes, or died before saving an identified response. Inspect the harness history and whatever'
        + ' the last tool touched, then decide what remains. Do not retry under a new identity.'
        + ` (${message})`,
        'MERIDIAN_UNCERTAIN_OUTCOME',
        facts,
      )
    }
    return new LlmError(
      'Meridian refused this tool continuation because it no longer matches the turn it already delivered: the'
      + ' delivered history, tool batch, model or execution controls changed between the tool call and its result.'
      + ' A harness that rewrites or compacts the transcript while a tool batch is pending is the usual cause, and'
      + ' re-sending the same request cannot repair it. This is a deterministic transcript conflict, not an'
      + ' uncertain tool outcome.'
      + ` (${message})`,
      'MERIDIAN_CONTINUATION_CONFLICT',
      facts,
    )
  }
  if (status === 404) {
    return new LlmError(
      `Meridian has no saved response for this request identity. (${message})`,
      'MERIDIAN_NO_SNAPSHOT',
      facts,
    )
  }
  if (status === 422) {
    return new LlmError(
      `Meridian stopped inside structured JSON; the schema result was not truncated into a fake success. (${message})`,
      'MERIDIAN_STOP_IN_STRUCTURED_OUTPUT',
      facts,
    )
  }
  if (status === 429) {
    if (!QUOTA_HINTS.test(detail)) return new LlmError(message, 'RATE_LIMIT', facts)
    // The CLI states the window in the message ("Resets in 2h43m43s") and the
    // response seldom carries a retry-after, so read it from the text when the
    // header did not supply one. Carrying it lets the harness say when the model
    // becomes usable again instead of only that it is not.
    const resetAfter = parseResetWindow(detail)
    return new LlmError(message, 'QUOTA', {
      ...facts,
      ...resetAfter === undefined || facts.providerRetryAfterMs !== undefined
        ? {}
        : { providerRetryAfterMs: resetAfter },
    })
  }
  // Read the body before the status, for the two 502s whose text is the only
  // thing that says what happened. A blocked generation must not be retried, and
  // the same block arrives here as a 502 on the very request Meridian consumed a
  // tool batch for — classifying it `SERVER` reopened the deadlock the in-stream
  // fix had closed. The provider message is used as the detail because it is the
  // same sentence the streaming path carries.
  if (isContentFiltered(detail)) {
    return contentFiltered(providerMessage.length > 0 ? providerMessage : detail, facts)
  }
  if (isAgentInterrupted(detail)) {
    return new LlmError(message, 'MERIDIAN_AGENT_INTERRUPTED', facts)
  }
  if (status === 504) return new LlmError(message, 'TIMEOUT', facts)
  if (status >= 500) return new LlmError(message, 'SERVER', facts)
  if (CONTEXT_HINTS.test(detail)) return new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED', facts)
  if (status === 400 || status === 413) {
    // 400 is a transcript or control problem: Meridian rejects unpaired history,
    // a reused id, unsupported sampling knobs and unknown slugs here. Resending
    // the identical body cannot help.
    return new LlmError(
      `${message} (Meridian rejected the request before generation; fix the transcript or the request controls rather than resending it)`,
      'INVALID_REQUEST',
      facts,
    )
  }
  return new LlmError(message, `HTTP_${status}`, facts)
}

/**
 * Build a failure for a response that is not Meridian's documented envelope.
 *
 * A gateway that is not Meridian still returns an authoritative status, and the
 * text it carries may be Meridian's own wording passed through verbatim. That
 * matters for exactly the two conditions this module reads out of the body: a
 * content filter or a dropped agent connection recorded as a plain 502 would
 * otherwise fall back to the status and become retryable `SERVER` again, which
 * is the deadlock this connector exists to avoid.
 *
 * Only those two are read from a raw body. A 409 with no envelope stays the
 * conservative uncertain outcome, because an unreadable conflict is not enough
 * to claim the delivered history moved.
 *
 * @param status - HTTP status.
 * @param headers - response headers.
 * @param body - raw text read from the response.
 * @returns the classified error.
 */
export function meridianErrorFromText(status, headers, body) {
  let raw
  try {
    raw = JSON.parse(body)
  } catch (_nonJsonGatewayError) {
    raw = undefined
  }
  const error = meridianError(raw, status, headers)
  if (raw !== undefined || body.length === 0) return error
  const facts = {
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
  }
  // Classification reads the whole body; only the *message* is capped, so an
  // error page that prefixes a long HTML preamble before the provider's own
  // wording is still recognised.
  const detail = body.slice(0, 400)
  if (isContentFiltered(body)) return contentFiltered(detail, facts)
  if (isAgentInterrupted(body)) {
    return new LlmError(`Meridian Antigravity: ${detail}`, 'MERIDIAN_AGENT_INTERRUPTED', facts)
  }
  return new LlmError(`${error.message} [${detail}]`, error.code, facts)
}

/**
 * An interrupted stream: either one the backend refused to generate, or a real
 * transport fault.
 *
 * A transport fault is marked `TRANSPORT` so the bounded retry policy may re-ask
 * with the same identity, which is safe with respect to *tool execution* because
 * no tool block is ever delivered before `message_stop`. That is not the whole
 * story on a continuation: Meridian consumes the accepted tool results on the
 * request side, so a retry can re-present a batch it has already released. The
 * transport therefore reclassifies a cut stream on a continuation as
 * `MERIDIAN_BATCH_SPENT` rather than relying on this code alone.
 *
 * A blocked generation must not be retried: the backend refused to produce the
 * output, so the same bytes are blocked again, and a retry only reaches
 * Meridian's spent-batch refusal. That is how a content filter used to leave a
 * conversation permanently stuck. It is classified `CONTENT_FILTERED` instead,
 * which the retry policy does not retry.
 *
 * A quota failure arrives the same way, as an error event inside an otherwise
 * successful stream, and keeps its own `QUOTA` classification so the reset window
 * stated in the message becomes the retry-after the harness reports.
 */
export function streamInterrupted(detail, cause) {
  const quota = quotaFailure(detail)
  if (quota !== undefined) {
    return new LlmError(
      `Meridian Antigravity refused the turn: the subscription quota is exhausted (${detail})`,
      quota.code,
      {
        ...quota.retryAfterMs === undefined ? {} : { providerRetryAfterMs: quota.retryAfterMs },
        ...cause === undefined ? {} : { cause },
      },
    )
  }
  if (isContentFiltered(detail)) {
    return contentFiltered(detail, cause === undefined ? undefined : { cause })
  }
  return new LlmError(
    `Meridian Antigravity stream ended before message_stop (${detail})`,
    'TRANSPORT',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * A continuation whose tool result Meridian accepted and whose reply never arrived.
 *
 * Replaces a retryable classification once the transport knows the request was a
 * continuation Meridian had already answered: the batch is spent, so re-sending
 * the same body can only be refused as a continuation conflict. Deliberately
 * absent from the retry policy, so the harness reports the failure instead of
 * producing a second, less legible one.
 *
 * @param failure - the cut-stream failure being replaced.
 * @returns the non-retryable replacement, carrying the original's facts.
 */
export function batchSpent(failure) {
  const facts = failure?.failure ?? {}
  return new LlmError(
    'Meridian accepted this turn\'s tool results and the generation ended before any reply, so the batch is'
    + ' spent: re-sending the same request can only be refused as a continuation conflict. The conversation'
    + ' itself is intact. Re-issue the instruction as a new message, or fork the session from before this'
    + ` turn. (${failure instanceof Error ? failure.message : String(failure)})`,
    'MERIDIAN_BATCH_SPENT',
    {
      ...facts.status === undefined ? {} : { status: facts.status },
      ...facts.requestId === undefined ? {} : { requestId: facts.requestId },
      ...facts.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: facts.providerRetryAfterMs },
      ...failure instanceof Error ? { cause: failure } : {},
    },
  )
}

/** A saved answer that does not extend what was already shown. */
export function replayDiverged(detail) {
  return new LlmError(
    `Meridian replay does not extend the text already shown (${detail}); refusing to splice a different answer into visible output`,
    'MERIDIAN_REPLAY_DIVERGED',
  )
}
