/**
 * Tool-result retention — the read/write surface behind the settings page.
 *
 * A small HTTP route rather than a typert Remote: it is far less machinery, and
 * the same shape the shipped `dsh-tts` bundle uses for its settings pane.
 *
 * The route is mounted as a **prefix**, so the dispatcher owns every sub-path.
 * It is deliberately unauthenticated: every other caller of this profile already
 * has read and write access to `$DSH_HOME`, where the policy file lives, so a
 * token would protect nothing a caller could not reach directly. Do not copy this
 * reasoning to a route that reaches campaign content or the network.
 *
 * @module @local/dsh-tool-result-policy/route
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalisePolicy, readPolicyFile } from './policy.js'

/** The prefix the page reads its identity from. */
export const PREFIX = '/tool-result-policy'

const json = (status, value) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value, null, 2),
})

/**
 * Routes.
 *
 *   `GET  /tool-result-policy`         → `{ policy, presets, path, problem }`
 *   `PUT  /tool-result-policy`         → write `{ presets, defaults }` and echo the result
 *
 * @param options - `{ path, listPresets, invalidate }`.
 *   `listPresets` lets the page show every preset the deployment knows about,
 *   not only the ones already present in the table, so a new one can be added
 *   without hand-editing the file.
 */
export function routeRequest(request, options) {
  const { method, pathname, body } = request
  const sub = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname

  if (sub !== '' && sub !== '/') return json(404, { error: 'not-found', pathname })

  if (method === 'GET') {
    const { policy, problem } = readPolicyFile(options.path)
    return json(200, {
      path: options.path,
      policy,
      knownPresets: options.listPresets?.() ?? [],
      ...(problem === null ? {} : { problem }),
    })
  }

  if (method === 'PUT') {
    if (body === undefined || body === null || typeof body !== 'object') {
      return json(400, { error: 'invalid-body', message: 'expected a JSON object with `presets` and/or `defaults`' })
    }
    const next = normalisePolicy({
      version: body.version,
      presets: body.presets,
      defaults: body.defaults,
    })
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      writeFileSync(options.path, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      return json(500, { error: 'write-failed', message: String(error?.message ?? error) })
    }
    // Drop the mtime cache so the very next prune pass sees the write, rather
    // than waiting for a stat to disagree. The write itself also changes mtime,
    // so this is belt-and-braces — but a same-millisecond write would otherwise
    // be missed, and the toggle is meant to be live.
    options.invalidate?.()
    return json(200, { path: options.path, policy: next })
  }

  return json(405, { error: 'method-not-allowed', method })
}

/** Adapt `routeRequest` to the Node request/response pair the web server passes. */
export function createRouteHandler(options) {
  return async (req, res) => {
    let result
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      let body
      if (raw.length > 0) {
        try { body = JSON.parse(raw.toString('utf8')) } catch { body = undefined }
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      result = await routeRequest({ method: req.method, pathname: url.pathname, body }, options)
    } catch (error) {
      result = json(500, { error: 'internal', message: String(error?.message ?? error) })
    }
    res.writeHead(result.status, result.headers)
    res.end(result.body)
  }
}
