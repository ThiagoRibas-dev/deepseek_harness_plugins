/**
 * A small FIFO admission gate for Meridian's live-process capacity.
 *
 * Meridian keeps at most `MERIDIAN_AGY_MAX_CONCURRENT` (four) `agy` processes
 * alive, evicts idle and tool-waiting processes to admit new work, and answers
 * a full pool with HTTP 429 and a `Retry-After`. There is no queue on that side,
 * so a harness that fires several conversations at once simply loses its warm
 * processes. Holding a bounded queue here keeps that from happening and leaves
 * headroom for Meridian's own health and catalogue probes.
 *
 * @module @local/dsh-meridian-antigravity/lib/limiter
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** One FIFO gate with a bounded wait and caller cancellation. */
export class TurnGate {
  #limit
  #waitTimeoutMs
  #waiters = []
  #active = 0

  /**
   * @param limit - maximum concurrent turns.
   * @param waitTimeoutMs - how long a turn waits for a slot before failing.
   */
  constructor(limit, waitTimeoutMs) {
    this.#limit = limit
    this.#waitTimeoutMs = waitTimeoutMs
  }

  /**
   * Acquire one slot.
   *
   * A released slot is handed straight to the next waiter, so the active count
   * never dips and races a fresh arrival past the limit.
   *
   * @param signal - caller cancellation.
   * @returns the release function.
   */
  async acquire(signal) {
    if (signal?.aborted === true) throw abortError(signal)
    if (this.#active < this.#limit) {
      this.#active += 1
      return () => this.#release()
    }
    return await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined, signal, onAbort: undefined }
      waiter.timer = setTimeout(() => {
        this.#drop(waiter)
        reject(new LlmError(
          `Meridian Antigravity is at its local concurrency limit (${this.#limit}) and no slot became free within ${this.#waitTimeoutMs} ms`,
          'RATE_LIMIT',
        ))
      }, this.#waitTimeoutMs)
      waiter.timer.unref?.()
      if (signal !== undefined) {
        waiter.onAbort = () => {
          this.#drop(waiter)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#waiters.push(waiter)
    })
  }

  #drop(waiter) {
    const index = this.#waiters.indexOf(waiter)
    if (index !== -1) this.#waiters.splice(index, 1)
    this.#detach(waiter)
  }

  #detach(waiter) {
    clearTimeout(waiter.timer)
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
  }

  #release() {
    const next = this.#waiters.shift()
    if (next === undefined) {
      this.#active = Math.max(0, this.#active - 1)
      return
    }
    // Ownership of the slot transfers; `#active` is unchanged.
    this.#detach(next)
    next.resolve(() => this.#release())
  }
}

function abortError(signal) {
  return signal.reason ?? new LlmError('Meridian Antigravity turn aborted while waiting for a slot', 'ABORTED')
}
