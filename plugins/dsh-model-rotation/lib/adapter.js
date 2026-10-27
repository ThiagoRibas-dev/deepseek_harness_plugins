/**
 * The rotating LLM adapter.
 *
 * One registered provider route owns every pool. The model id the user selects
 * is the pool key; this adapter plans a member order for the request, rewrites
 * stored replay metadata for the member that will answer, and delegates the
 * wire request to a shared `PiAiAdapter` built over the member profiles.
 *
 * Failover only happens before the first chunk reaches the consumer. A provider
 * stream is not resumable: once a block has been announced, retrying elsewhere
 * would duplicate or reorder output. The log records that case explicitly.
 *
 * @module @local/dsh-model-rotation/adapter
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { errorWorthFailover } from './rotation.js'
import { prepareMessagesForMember } from './replay.js'
import { relayMemberStream } from './stream.js'
import { runInCapture } from './capture-context.js'

/** Session key used when a caller did not stamp one (standalone and test calls). */
export const NO_SESSION = 'no-session'

/**
 * Normalize any thrown value into the failure facts the log and rotation
 * engine use.
 * @param error - adapter or provider error.
 * @returns `{ code, message, status, requestId, cause }`.
 */
export function failureOf(error) {
  const failure = error?.failure
  if (failure !== undefined && typeof failure === 'object' && typeof failure.code === 'string') {
    return {
      code: failure.code,
      message: typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message
        : String(error?.message ?? error),
      status: failure.status,
      requestId: failure.requestId,
      cause: error,
    }
  }
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UNKNOWN'
  return {
    code,
    message: String(error?.message ?? error),
    cause: error,
  }
}

/**
 * Normalize a terminal finish reason's failure facts. A finish chunk always
 * carries a `failure` (the protocol type requires it), but a provider adapter
 * is external code, so this does not trust it.
 * @param failure - `FinishReason.failure`, when present.
 * @param fallbackCode - code to use when the shape is unusable.
 * @returns failure facts without a cause.
 */
function failureFromFinish(failure, fallbackCode = 'UNKNOWN') {
  if (failure !== undefined && typeof failure === 'object' && typeof failure.code === 'string') {
    return {
      code: failure.code,
      message: typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message
        : 'provider stream finished with an error',
      status: failure.status,
      requestId: failure.requestId,
    }
  }
  return { code: fallbackCode, message: 'provider stream finished with an error' }
}

/** Empty 400s are pi-ai's Cerebras overflow heuristic, not a Gemini overflow. */
const EMPTY_400 = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i

/**
 * Correct a known provider-classification false positive before it reaches the
 * user or the agent's context-recovery path. Gemini returns an empty 400 for
 * some rejected requests; pi-ai treats every empty 400 as a context overflow
 * (the Cerebras pattern), which hides the real cause behind a misleading code.
 * @param failure - normalized attempt failure.
 * @param member - member that produced it.
 * @returns the failure, reclassified when it is the Gemini empty-400 shape.
 */
function normalizeMemberFailure(failure, member) {
  if (failure.code === 'CONTEXT_WINDOW_EXCEEDED'
    && EMPTY_400.test(failure.message ?? '')
    && typeof member.baseURL === 'string'
    && member.baseURL.includes('generativelanguage.googleapis.com')) {
    return {
      ...failure,
      code: 'INVALID_REQUEST',
      message: `${failure.message} — Gemini rejected the request with an empty 400; this is not a context`
        + ' overflow. pi-ai classifies every empty 400 as one. The failed request and the response are'
        + ' written to $DSH_HOME/plugin-errors/dsh-model-rotation.log; enable the pool\'s Capture request'
        + ' bodies to see the exact body in the Rotation tab.',
    }
  }
  return failure
}

/**
 * Build the terminal error for a request whose attempts were exhausted.
 * @param pool - the pool that failed.
 * @param failures - one failure per attempted member, in order.
 * @param aborted - whether the caller aborted.
 * @returns an `LlmError` carrying the last failure's code and every attempt in
 *   its message.
 */
function exhaustedError(pool, failures, aborted) {
  const last = failures[failures.length - 1] ?? { code: 'UNKNOWN', message: 'no member was attempted' }
  const code = aborted ? 'ABORTED' : last.code ?? 'UNKNOWN'
  const detail = failures
    .map(entry => `${entry.member}: ${entry.code}${entry.status === undefined ? '' : ` (${entry.status})`} — ${entry.message}`)
    .join('; ')
  const message = aborted
    ? `model rotation: pool "${pool.key}" was aborted`
    : `model rotation: pool "${pool.key}" failed after ${failures.length} attempt(s): ${detail}`
  const options = {
    ...last.status === undefined ? {} : { status: last.status },
    ...last.requestId === undefined ? {} : { requestId: last.requestId },
    ...last.cause === undefined ? {} : { cause: last.cause },
  }
  return new LlmError(message, code, options)
}

/**
 * The rotation adapter registered on the `llm` service.
 */
export class ModelRotationAdapter extends LlmAdapter {
  /**
   * @param deps - route facts, config snapshot reader, rotation engine, the
   *   shared pi-ai adapter, the session log, and the turn/step reader.
   */
  constructor(deps) {
    super()
    this.deps = deps
  }

  /** Describe the one provider route this adapter owns. */
  providerInfo(provider) {
    return { id: provider, name: this.deps.displayName }
  }

  /** List one selectable model per usable pool. */
  async listModels(provider) {
    const { pools } = this.deps.pools()
    return [...pools.values()].map(pool => ({
      provider,
      id: pool.key,
      name: pool.displayName,
      inputModalities: [...pool.input],
    }))
  }

  /** Describe the pool as the model the caller selected. */
  async resolveModel(provider, model) {
    const { pools, errors } = this.deps.pools()
    const pool = pools.get(model)
    if (pool === undefined) {
      const diagnostic = errors.get(model)
      throw diagnostic === undefined
        ? new LlmError(`model rotation: no pool is configured as "${model}"`, 'UNKNOWN_MODEL')
        : new LlmError(`model rotation: pool "${model}" cannot be used: ${diagnostic}`, 'INVALID_CONFIG')
    }
    return {
      provider,
      id: model,
      name: pool.displayName,
      inputModalities: [...pool.input],
      context: { contextWindow: pool.contextWindow },
    }
  }

  /** Stream one request through the planned member order. */
  async *stream(options) {
    const { pools, errors } = this.deps.pools()
    const pool = pools.get(options.model)
    if (pool === undefined) {
      const diagnostic = errors.get(options.model)
      throw diagnostic === undefined
        ? new LlmError(`model rotation: no pool is configured as "${options.model}"`, 'UNKNOWN_MODEL')
        : new LlmError(`model rotation: pool "${options.model}" cannot be used: ${diagnostic}`, 'INVALID_CONFIG')
    }
    if (pool.members.length === 0) {
      throw new LlmError(`model rotation: pool "${pool.key}" has no members`, 'INVALID_CONFIG')
    }

    const sessionId = options.sessionId === undefined ? NO_SESSION : String(options.sessionId)
    const position = this.deps.positions(sessionId)
    const plan = this.deps.engine.plan({ pool, sessionId, turn: position?.turn })
    if (plan.order.length === 0) {
      throw new LlmError(`model rotation: pool "${pool.key}" has no usable member`, 'INVALID_CONFIG')
    }

    const first = plan.order[0]
    const request = this.deps.log.nextRequest(sessionId)
    const group = this.deps.log.begin({
      sessionId,
      request,
      pool: pool.key,
      model: options.model,
      turn: position?.turn,
      step: position?.step,
      purpose: options.purpose,
      member: first.name,
      memberModel: first.model,
      cadence: pool.cadence,
      strategy: pool.strategy,
      allCooling: plan.allCooling,
      coolingCount: plan.coolingCount,
    })
    const requestStarted = Date.now()
    const failures = []
    let committed = false
    let attempts = 0

    for (let index = 0; index < plan.order.length; index += 1) {
      if (attempts >= pool.maxAttempts) break
      const member = plan.order[index]
      attempts += 1
      this.deps.engine.begin({ pool, member })
      const attemptStarted = Date.now()
      let failure
      let finishChunk
      let iterator
      try {
        const prepared = prepareMessagesForMember(options.messages, {
          route: options.provider,
          member,
          mode: pool.replay,
        })
        const inner = this.deps.inner()
        const stream = inner.stream({
          ...options,
          provider: member.key,
          model: member.model,
          messages: prepared.messages,
        })
        if (process.env.DSH_MODEL_ROTATION_DEBUG === '1') {
          console.error(
            '[model-rotation] inner adapter', inner?.constructor?.name,
            'stream', typeof stream, stream?.constructor?.name,
            'iterable', typeof stream?.[Symbol.asyncIterator],
          )
        }
        iterator = stream[Symbol.asyncIterator]()
      } catch (error) {
        if (process.env.DSH_MODEL_ROTATION_DEBUG === '1') {
          console.error('[model-rotation] attempt setup failed for', member.key, error)
        }
        failure = failureOf(error)
      }

      if (iterator !== undefined) {
        const tracker = {
          committed: false,
          finish: undefined,
          failedFinish: undefined,
          thrown: undefined,
        }
        // Capture is opt-in per pool. The async-local context reaches pi-ai's
        // `onPayload` from inside each provider step, so concurrent sessions
        // cannot cross their captured bodies.
        const capture = pool.captureRequestBodies === true
          ? {
            pool: pool.key,
            member: member.key,
            body: payload => this.deps.log.body(group, { sessionId, body: payload }),
          }
          : undefined
        const runNext = capture === undefined ? undefined : fn => runInCapture(capture, fn)
        for await (const chunk of relayMemberStream(iterator, tracker, { runNext })) {
          yield chunk
        }
        committed = committed || tracker.committed === true
        finishChunk = tracker.finish
        if (tracker.thrown !== undefined) {
          if (process.env.DSH_MODEL_ROTATION_DEBUG === '1') {
            console.error('[model-rotation] inner threw for', member.key, tracker.thrown)
          }
          failure = normalizeMemberFailure(failureOf(tracker.thrown), member)
        } else if (tracker.failedFinish !== undefined) {
          if (process.env.DSH_MODEL_ROTATION_DEBUG === '1') {
            console.error(
              '[model-rotation] inner finish error', member.key,
              tracker.failedFinish.reason?.failure,
            )
          }
          failure = normalizeMemberFailure(failureFromFinish(tracker.failedFinish.reason.failure, 'PI_AI_ERROR'), member)
        }
      }

      const attemptMs = Date.now() - attemptStarted
      const requestMs = Date.now() - requestStarted

      if (finishChunk !== undefined) {
        const reason = finishChunk.reason
        if (reason.kind !== 'error' && reason.kind !== 'aborted') {
          this.deps.engine.recordSuccess({ pool, member })
          this.deps.log.finish(group, {
            sessionId,
            ok: true,
            committed: true,
            member: member.name,
            memberModel: member.model,
            ms: requestMs,
          })
          return
        }
        const terminalFailure = normalizeMemberFailure(failureFromFinish(reason.failure, reason.kind === 'aborted' ? 'ABORTED' : 'PI_AI_ERROR'), member)
        this.deps.engine.recordFailure({ pool, member, failure: terminalFailure })
        failures.push({
          member: member.name,
          code: terminalFailure.code,
          status: terminalFailure.status,
          message: terminalFailure.message,
          ms: attemptMs,
        })
        this.deps.log.finish(group, {
          sessionId,
          ok: false,
          aborted: reason.kind === 'aborted',
          committed: true,
          member: member.name,
          memberModel: member.model,
          code: terminalFailure.code,
          status: terminalFailure.status,
          message: terminalFailure.message,
          ms: requestMs,
        })
        return
      }

      if (failure === undefined) {
        failure = { code: 'PI_AI_ERROR', message: 'provider stream ended without a finish chunk' }
      }

      this.deps.engine.recordFailure({ pool, member, failure })
      failures.push({
        member: member.name,
        code: failure.code,
        status: failure.status,
        message: failure.message,
        ms: attemptMs,
      })
      const next = plan.order[index + 1]
      const aborted = options.signal?.aborted === true || failure.code === 'ABORTED'
      const canFailover = !committed && !aborted && errorWorthFailover(failure)
        && next !== undefined && attempts < pool.maxAttempts

      if (canFailover) {
        this.deps.log.failover(group, {
          sessionId,
          member: member.name,
          memberModel: member.model,
          next: next.name,
          nextModel: next.model,
          code: failure.code,
          status: failure.status,
          message: failure.message,
          ms: attemptMs,
        })
        continue
      }

      this.deps.log.finish(group, {
        sessionId,
        ok: false,
        aborted,
        committed,
        member: member.name,
        memberModel: member.model,
        code: failure.code,
        status: failure.status,
        message: failure.message,
        ms: requestMs,
      })
      throw exhaustedError(pool, failures, aborted)
    }

    // The loop only exits early when `maxAttempts` was reached between
    // attempts; every failing attempt above either continues or throws.
    const lastMember = plan.order[Math.min(attempts, plan.order.length) - 1] ?? first
    this.deps.log.finish(group, {
      sessionId,
      ok: false,
      committed,
      member: lastMember.name,
      memberModel: lastMember.model,
      code: failures[failures.length - 1]?.code ?? 'UNKNOWN',
      message: 'model rotation: attempt limit reached with no successful member',
      ms: Date.now() - requestStarted,
    })
    throw exhaustedError(pool, failures, options.signal?.aborted === true)
  }
}
