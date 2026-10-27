/**
 * Per-request capture context.
 *
 * The member provider is shared across requests and sessions, and pi-ai's
 * `onPayload` hook receives only the payload and the model. This async-local
 * context lets that hook find the log group of the request it is serving,
 * without a global that would race between concurrent sessions.
 *
 * The adapter wraps each inner `iterator.next()` — the call that drives the
 * provider and runs `onPayload` — in `runInCapture`. A member provider that
 * captures or overrides a body reads `currentCapture()` from inside that call.
 *
 * @module @local/dsh-model-rotation/capture-context
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** The storage is process-local and never serialized. */
const storage = new AsyncLocalStorage()

/**
 * Run one provider step inside a capture context.
 * @param context - request facts, including the `body` writer callback.
 * @param fn - the step to run.
 * @returns the step's result.
 */
export function runInCapture(context, fn) {
  return storage.run(context, fn)
}

/**
 * Read the capture context of the current provider step.
 * @returns the context, or undefined when capture is off for this request.
 */
export function currentCapture() {
  return storage.getStore()
}
