/**
 * Read-only HTTP surface for the per-session request log and member health.
 *
 * The right-pane tab lives in the browser, which cannot read the Host
 * filesystem, so the plugin exposes the same data over a small JSON prefix.
 * The route authenticates itself: a plugin route inherits none of the harness's
 * own authentication and the web server may be bound to the network, so an
 * empty token means "nobody configured one" and every request is refused.
 *
 * @module @local/dsh-model-rotation/route
 */
import { timingSafeEqual } from 'node:crypto'

/** Default number of request groups one read returns. */
export const DEFAULT_LIMIT = 200

/** Longest request pathname this route answers. */
const MAX_PATH = 512

/**
 * Length-independent comparison, so a token cannot be probed a byte at a time.
 * @param left - supplied token.
 * @param right - configured token.
 * @returns whether both are the same non-empty string.
 */
function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length || a.length === 0 || b.length === 0) return false
  return timingSafeEqual(a, b)
}

/** JSON response with a bounded body. */
function json(status, value) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  }
}

/** Plain-text response. */
function text(status, value) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: Buffer.from(value.endsWith('\n') ? value : `${value}\n`, 'utf8'),
  }
}

/**
 * Extract a bearer token from a normalized request.
 * @param request - `{ headers, query }`.
 * @returns the token, or an empty string.
 */
function presentedToken(request) {
  const headers = request?.headers ?? {}
  const authorization = headers.authorization ?? headers.Authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null) return match[1]
  }
  const headerToken = headers['x-dsh-token'] ?? headers['x-model-rotation-token']
  if (typeof headerToken === 'string') return headerToken
  const queryToken = request?.query?.get?.('token')
  return typeof queryToken === 'string' ? queryToken : ''
}

/**
 * Render one group as a readable line for `format=text`.
 * @param group - grouped request.
 * @returns one line per request.
 */
function groupLine(group) {
  const time = Number.isFinite(group.t) ? new Date(group.t).toISOString().slice(11, 19) : '--:--:--'
  const where = group.turn === undefined ? '' : ` turn ${group.turn}${group.step === undefined ? '' : `/${group.step}`}`
  const outcome = group.outcome === 'ok'
    ? 'ok'
    : `${group.outcome}${group.code === undefined ? '' : ` ${group.code}`}`
  const attempts = group.attempts.length === 0
    ? ''
    : ` | attempts: ${group.attempts.map(attempt => `${attempt.member}=${attempt.code}`).join(', ')}`
  const message = group.message === undefined ? '' : ` | ${group.message}`
  return `${time}${where} #${group.request} ${group.pool} → ${group.member ?? '?'} (${group.memberModel ?? '?'}) ${outcome} ${group.ms ?? '?'}ms${attempts}${message}`
}

/**
 * Build the request dispatcher.
 *
 * @param options - log store, rotation engine, pool reader, token, and prefix.
 * @returns a pure `(request) => response` function.
 */
export function createRouteRequest({ log, engine, pools, token, prefix = '/api/model-rotation' }) {
  return function routeRequest(request) {
    const method = String(request?.method ?? 'GET').toUpperCase()
    const rawPath = String(request?.pathname ?? '/')
    if (rawPath.length > MAX_PATH) return json(414, { error: 'path too long' })
    const path = rawPath === prefix
      ? '/'
      : rawPath.startsWith(`${prefix}/`)
        ? rawPath.slice(prefix.length)
        : rawPath
    if (token.length === 0) {
      return json(503, { error: 'no token is configured for the model-rotation log; set apiToken' })
    }
    if (!safeEqual(presentedToken(request), token)) {
      return json(401, { error: 'unauthorized' })
    }
    if (method !== 'GET' && method !== 'HEAD') return json(405, { error: 'method not allowed' })

    if (path === '/' || path === '') {
      return json(200, {
        service: 'model-rotation',
        endpoints: ['log?sessionId=...', 'health', 'sessions'],
      })
    }

    if (path === '/health') {
      return json(200, { pools: engine.snapshot(pools()) })
    }

    if (path === '/sessions' || path === '/log/sessions') {
      return json(200, { note: 'per-session logs are addressed by session id', sessions: log.listSessions() })
    }

    if (path === '/log') {
      const sessionId = request?.query?.get?.('sessionId')
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return json(400, { error: 'sessionId is required' })
      }
      const limitRaw = Number.parseInt(String(request?.query?.get?.('limit') ?? ''), 10)
      const limit = Number.isSafeInteger(limitRaw) ? limitRaw : DEFAULT_LIMIT
      const read = log.readSession(sessionId, { limit })
      if (String(request?.query?.get?.('format') ?? '') === 'text') {
        const lines = read.groups.map(groupLine)
        return text(200, [
          `session ${sessionId} — ${read.groups.length} request(s)${read.truncated ? ' (older omitted)' : ''}`,
          `file ${read.path}`,
          ...lines,
        ].join('\n'))
      }
      return json(200, {
        sessionId,
        path: read.path,
        bytes: read.bytes,
        truncated: read.truncated,
        groups: read.groups,
        ...read.error === undefined ? {} : { error: read.error },
      })
    }

    return json(404, { error: 'not found', path })
  }
}

/**
 * Adapt the pure dispatcher to the harness web server's raw Node request.
 * @param options - dispatcher options.
 * @returns a `(req, res) => Promise<void>` handler that owns the response.
 */
export function createRouteHandler(options) {
  const routeRequest = createRouteRequest(options)
  return async function handler(req, res) {
    let result
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      result = routeRequest({
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
      })
    } catch (error) {
      result = json(500, { error: 'internal', message: String(error?.message ?? error) })
    }
    res.writeHead(result.status, result.headers)
    if (req.method === 'HEAD') res.end()
    else res.end(result.body)
  }
}
