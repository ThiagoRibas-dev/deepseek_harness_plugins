/**
 * Pooled provider-status reader.
 *
 * One reader per plugin instance, however many triggers or browsers ask. Both
 * triggers — an assistant response, and a timer — call `requestRefresh`, which
 * accepts a request only once the configured floor has passed since the last
 * attempt, so whichever fires first satisfies the other.
 *
 * A minute is not an arbitrary floor. Meridian starts at most one background
 * status refresh per 10 seconds and only when none is in flight
 * (`antigravityRuntime.ts:501`), and the `agy -p /usage` call behind it runs at
 * most once per 60 seconds on success or 10 after a failure (`:508`), with
 * concurrent callers sharing one promise (`:509`). A one-minute cadence is
 * therefore Meridian's own refresh rate, and most reads return its cache.
 *
 * A read never throws into a turn. Reading quota is a convenience; a turn must
 * not wait on it, and a failure to read quota is not a failure to serve.
 *
 * @module @local/dsh-meridian-antigravity/lib/quota-source
 */

import { normalizeProviderStatus } from './quota.js'

/** Bound on one status read, so a hung bridge cannot pin a refresh forever. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * @param dependencies - `optionsOf` for the live connection, `resolveApiKey` for
 *   the credential, and an optional logger.
 * @returns a reader with a cached snapshot and two ways to drive it.
 */
export function createQuotaSource({ optionsOf, resolveApiKey, logger }) {
  let snapshot
  let lastAttempt = 0
  let inFlight
  let disposed = false

  async function read() {
    const connection = optionsOf()
    const key = await resolveApiKey(connection)
    const response = await fetch(`${connection.baseURL}/providers/status`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': key, accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Meridian answered /providers/status with ${response.status}`)
    return normalizeProviderStatus(await response.json())
  }

  async function refresh(reason) {
    try {
      snapshot = await read()
    } catch (error) {
      // Kept as a snapshot rather than thrown, so the strip can show why the
      // quota is unknown instead of showing nothing at all.
      const message = error instanceof Error ? error.message : String(error)
      snapshot = { status: 'error', error: message, windows: [], fetchedAt: Date.now() }
      logger?.debug?.(`meridian-antigravity: quota read (${reason}) failed: ${message}`)
    }
    return snapshot
  }

  return {
    /** The last reading, or undefined before the first attempt settles. */
    snapshot: () => snapshot,

    /**
     * Accept a trigger when the floor has passed, and coalesce concurrent ones.
     *
     * @param reason - recorded in debug logging, to tell the triggers apart.
     * @returns the in-flight read, or undefined when this trigger was satisfied
     *   by a recent one.
     */
    requestRefresh(reason) {
      if (disposed) return undefined
      const floor = Math.max(0, optionsOf().quotaRefreshMs ?? 0)
      const now = Date.now()
      if (now - lastAttempt < floor) return undefined
      lastAttempt = now
      inFlight ??= refresh(reason).finally(() => { inFlight = undefined })
      return inFlight
    },

    /** Stop accepting triggers. An in-flight read is allowed to settle. */
    dispose() { disposed = true },
  }
}
