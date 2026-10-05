/**
 * The HTTP surface the browser half reads its quota snapshot from.
 *
 * Two layers, following the shape this repository already uses elsewhere:
 * `routeQuotaRequest` is a pure dispatcher over a normalised request, so the auth
 * and method branches are testable offline, and `createQuotaRouteHandler` is the
 * thin `node:http` adapter that holds no logic worth testing.
 *
 * The token matters. A route registered by a plugin inherits none of the
 * harness's own authentication, so without one this endpoint would expose the
 * account's usage to anything that can reach the port. The browser is handed the
 * token by document injection, and is already authenticated by the time it has
 * one.
 *
 * Nothing here imports a harness package.
 *
 * @module @local/dsh-meridian-antigravity/lib/quota-route
 */

import { timingSafeEqual } from 'node:crypto'

/** Header the browser half presents its token in. */
export const QUOTA_TOKEN_HEADER = 'x-dsh-meridian-token'

/** Length-independent comparison, so a token cannot be probed byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** What the strip sees before the first read settles. */
const LOADING = Object.freeze({ status: 'loading', windows: [] })

/**
 * Dispatch one already-parsed request.
 *
 * @param request - `method`, `pathname`, `query` and `headers`.
 * @param options - `quota` reader and the expected `token`.
 * @returns a normalised `{ status, headers, body }`.
 */
export function routeQuotaRequest(request, { quota, token }) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  if (request.method !== 'GET') {
    return { status: 405, headers: { ...headers, allow: 'GET' }, body: JSON.stringify({ error: 'method_not_allowed' }) }
  }
  const provided = request.headers?.[QUOTA_TOKEN_HEADER] ?? request.query?.get?.('token') ?? ''
  if (token.length === 0 || !safeEqual(provided, token)) {
    return { status: 403, headers, body: JSON.stringify({ error: 'forbidden' }) }
  }
  // Gated: a burst of browser polls collapses into at most one read a minute.
  quota.requestRefresh('route')
  const snapshot = quota.snapshot() ?? { ...LOADING, fetchedAt: Date.now() }
  return { status: 200, headers, body: JSON.stringify(snapshot) }
}

/**
 * Adapt {@link routeQuotaRequest} to a `node:http` handler.
 *
 * @param options - `quota` reader and the expected `token`.
 * @returns an async `(req, res)` handler.
 */
export function createQuotaRouteHandler(options) {
  return (req, res) => {
    let result
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      result = routeQuotaRequest({
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
      }, options)
    } catch (error) {
      result = {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ error: 'internal', message: String(error?.message ?? error) }),
      }
    }
    res.writeHead(result.status, result.headers)
    res.end(result.body)
  }
}
