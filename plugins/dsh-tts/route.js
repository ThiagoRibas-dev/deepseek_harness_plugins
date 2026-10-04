/**
 * The HTTP surface: a standard endpoint other applications — and this feature's
 * own browser client — can call.
 *
 * Two layers on purpose. `routeRequest` is a **pure dispatcher** taking a
 * normalised request and returning a normalised response, so every branch (auth,
 * method, path, size, format) can be tested offline without a server.
 * `createRouteHandler` is the thin adapter that reads a `node:http` request and
 * writes the result, and holds no logic worth testing.
 *
 * Nothing here imports a harness package, which is what keeps it testable.
 *
 * Security shapes everything. The harness binds this deployment to `0.0.0.0:3080`
 * and **named routes bypass authentication entirely** — the webserver's request
 * path is `match → handler → fallback` with optional gzip as the only middleware.
 * The browser's own connection is authenticated by the `connection` layer; a route
 * registered by a plugin is not. So a synthesizer on that port is an open CPU
 * amplifier unless it authenticates itself, and the defaults here reflect that: a
 * token is required, anonymous access must be asked for explicitly, and input is
 * bounded before any work is done.
 */
import { timingSafeEqual } from 'node:crypto'

/** The only output formats offered. Encoders for the rest are out of scope. */
export const SUPPORTED_FORMATS = ['wav', 'pcm']

/** Length-independent constant-time comparison, so a token cannot be probed byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** Whether the request carries an acceptable credential. */
export function isAuthorized(headers, { token, allowAnonymous }) {
  if (allowAnonymous) return true
  if (typeof token !== 'string' || token.length === 0) return false
  const raw = headers?.authorization ?? headers?.Authorization
  if (typeof raw !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match !== null && safeEqual(match[1], token)
}

const json = (status, value, extraHeaders = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  body: Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'),
})

/** Strip a PCM16 WAV's 44-byte header, for clients that want raw samples. */
function stripWavHeader(wav) {
  return Buffer.from(wav.buffer ?? wav, (wav.byteOffset ?? 0) + 44, wav.length - 44)
}

/**
 * Dispatch one request.
 *
 * @param request - `{ method, pathname, query, headers, body }`; `body` is already parsed and
 *   `query` is a URLSearchParams.
 * @param options.enabled - whether the operator has turned the API on.
 * @param options.token - the required bearer token.
 * @param options.allowAnonymous - explicit opt-out of authentication.
 * @param options.maxInputChars - bound applied before any synthesis work.
 * @param options.prefix - the mounted path prefix, e.g. `/v1/audio`.
 * @param options.voices - available voice ids.
 * @param options.defaultVoice - the voice used when the request omits one.
 * @param options.synthesize - `async (text, { voice, speed }) => { wav, seconds, ... }`.
 * @param options.status - `() => object` describing preparation.
 * @param options.prepare - `() => Promise<unknown>`, kicks off preparation.
 * @param options.cancel - `() => Promise<void>`.
 * @param options.readPreference - `(sessionId) => object | undefined`; undefined means no such session.
 * @param options.writePreference - `(sessionId, auto) => object | undefined`.
 * @param options.readSettings - `() => object`; the values the settings controls show.
 * @param options.writeSettings - `(patch) => object`; merges the patch, returns the new values.
 * @param options.resolveMessage - `(sessionId, messageId) => string | undefined`. Returns the text,
 *   possibly empty, when the message exists, and undefined when it does not — the two are reported
 *   differently.
 * @returns `{ status, headers, body }` with a Buffer body.
 */
/**
 * The settings a caller may write over HTTP.
 *
 * Deliberately a separate list from the store's own validators: the store owns what
 * it can *hold*, this owns what the API will *accept*, and the two are allowed to
 * differ as the surface grows.
 */
// `piperVoice` belongs in this list even though the pane's Voice control writes `voice`:
// the two engines keep their choice under different keys, and leaving the Piper key out
// meant a Piper voice could be selected in the pane and silently never saved.
const SETTING_KEYS = new Set(['provider', 'voice', 'piperVoice', 'toneEnabled', 'instructions', 'threads'])

export async function routeRequest(request, options) {
  const {
    enabled = false, token = '', allowAnonymous = false, maxInputChars = 2000,
    prefix = '/v1/audio', voices = [], defaultVoice = 'af_heart', voiceDetails,
    synthesize, status, prepare, cancel, readPreference, writePreference, resolveMessage,
    readSettings, writeSettings, providers = [], latest,
  } = options
  const query = request?.query ?? new URLSearchParams()

  const pathname = String(request?.pathname ?? '/')
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return json(404, { error: 'not_found', message: `no route at ${pathname}; this API is mounted at ${prefix}` })
  }
  const route = pathname.slice(prefix.length) || '/'
  const method = String(request?.method ?? 'GET').toUpperCase()

  // Health is deliberately reachable without a credential: an operator probing
  // whether the endpoint is alive should not have to hold the token, and it
  // reveals nothing beyond the fact that the plugin is loaded.
  if (route === '/health') {
    return json(200, { plugin: 'tts', enabled, active: enabled })
  }

  if (!enabled) {
    return json(503, {
      error: 'disabled',
      message: 'the TTS API is disabled; set apiEnabled on the tts plugin to turn it on',
    })
  }

  if (!isAuthorized(request?.headers, { token, allowAnonymous })) {
    return json(401, {
      error: 'unauthorized',
      message: allowAnonymous ? 'authorization failed' : 'send the token as "Authorization: Bearer <token>"',
    }, { 'www-authenticate': 'Bearer' })
  }

  if (route === '/voices') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed', allow: ['GET'] }, { allow: 'GET' })
    // Objects rather than bare ids: a picker has to be able to say which voices are not
    // downloaded yet and what they cost, and an id alone cannot. `default` stays a plain
    // id, so a caller that only wants to speak need not reach into the list.
    const detail = typeof voiceDetails === 'function' ? voiceDetails() : voices.map((id) => ({ id, present: true }))
    return json(200, { default: defaultVoice, voices: detail })
  }

  if (route === '/status') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed', allow: ['GET'] }, { allow: 'GET' })
    return json(200, typeof status === 'function' ? status() : {})
  }

  if (route === '/prepare') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed', allow: ['POST'] }, { allow: 'POST' })
    // Deliberately not awaited: preparation downloads ~92 MB, and a caller should
    // get an immediate acknowledgement with state to poll rather than a request
    // that hangs for minutes.
    if (typeof prepare === 'function') {
      Promise.resolve().then(prepare).catch(() => undefined)
    }
    return json(202, typeof status === 'function' ? status() : {})
  }

  if (route === '/cancel') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed', allow: ['POST'] }, { allow: 'POST' })
    if (typeof cancel === 'function') await cancel()
    return json(200, typeof status === 'function' ? status() : {})
  }

  if (route === '/preference') {
    if (method !== 'GET' && method !== 'POST') {
      return json(405, { error: 'method_not_allowed', allow: ['GET', 'POST'] }, { allow: 'GET, POST' })
    }
    const sessionId = method === 'GET' ? query.get('sessionId') : request?.body?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return json(400, { error: 'bad_request', message: 'a "sessionId" is required' })
    }
    if (method === 'GET') {
      if (typeof readPreference !== 'function') return json(503, { error: 'unavailable', message: 'preferences are not available' })
      const state = readPreference(sessionId)
      if (state === undefined) return json(404, { error: 'unknown_session', message: `no live session "${sessionId}"` })
      return json(200, state)
    }
    if (typeof writePreference !== 'function') return json(503, { error: 'unavailable', message: 'preferences are not available' })
    const auto = request?.body?.auto
    if (auto !== null && typeof auto !== 'boolean') {
      return json(400, { error: 'bad_request', message: '"auto" must be true, false, or null to inherit' })
    }
    const state = writePreference(sessionId, auto)
    if (state === undefined) return json(404, { error: 'unknown_session', message: `no live session "${sessionId}"` })
    return json(200, state)
  }

  if (route === '/settings') {
    if (method !== 'GET' && method !== 'POST') {
      return json(405, { error: 'method_not_allowed', allow: ['GET', 'POST'] }, { allow: 'GET, POST' })
    }
    if (method === 'GET') {
      if (typeof readSettings !== 'function') return json(503, { error: 'unavailable', message: 'settings are not available' })
      return json(200, readSettings())
    }
    if (typeof writeSettings !== 'function') return json(503, { error: 'unavailable', message: 'settings are not available' })
    const patch = request?.body
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return json(400, { error: 'bad_request', message: 'send a JSON object of settings to change' })
    }
    // Validated here rather than in the store, because the voice list is the route's
    // to know: a name that is not offered is a caller error, not a storage concern.
    const accepted = {}
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTING_KEYS.has(key)) {
        return json(400, { error: 'bad_request', message: `"${key}" is not a setting this plugin owns` })
      }
      const wrongType = key === 'toneEnabled' ? typeof value !== 'boolean'
        : key === 'threads' ? !Number.isSafeInteger(value)
          : typeof value !== 'string'
      if (wrongType) {
        return json(400, {
          error: 'bad_request',
          message: `"${key}" must be ${key === 'toneEnabled' ? 'a boolean' : key === 'threads' ? 'a whole number' : 'a string'}`,
        })
      }
      if (key === 'threads' && (value < 1 || value > 16)) {
        return json(400, { error: 'bad_request', message: '"threads" must be between 1 and 16' })
      }
      if (key === 'provider' && !providers.includes(value)) {
        return json(400, { error: 'unknown_provider', message: `no provider "${value}"` })
      }
      if (key === 'voice' && voices.length > 0 && !voices.includes(value)) {
        return json(400, { error: 'unknown_voice', message: `no voice "${value}"` })
      }
      accepted[key] = value
    }
    if (Object.keys(accepted).length === 0) {
      return json(400, { error: 'bad_request', message: 'no settings to change' })
    }
    return json(200, writeSettings(accepted))
  }

  if (route === '/latest') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed', allow: ['GET'] }, { allow: 'GET' })
    if (typeof latest !== 'function') return json(503, { error: 'unavailable', message: 'session state is not available' })
    const sessionId = query.get('sessionId')
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return json(400, { error: 'bad_request', message: 'a "sessionId" is required' })
    }
    // Answered from the durable log, so a re-mounted historical node and a reply that
    // just arrived are distinguishable — which no client-side heuristic could do.
    const state = latest(sessionId)
    if (state === undefined) return json(404, { error: 'unknown_session', message: `no live session "${sessionId}"` })
    return json(200, state)
  }

  if (route === '/speech') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed', allow: ['POST'] }, { allow: 'POST' })
    const body = request?.body
    if (typeof body !== 'object' || body === null) {
      return json(400, { error: 'bad_request', message: 'send a JSON object with an "input" string' })
    }
    // Either literal text, or a message to resolve on the host. The browser half
    // holds a message id rather than its text, and the Session already knows how
    // to read it — so the lookup belongs where the Session is, not in the client.
    let input = body.input
    if (typeof input !== 'string' && typeof body.messageId === 'string') {
      if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
        return json(400, { error: 'bad_request', message: 'a "messageId" needs its "sessionId"' })
      }
      if (typeof resolveMessage !== 'function') {
        return json(503, { error: 'unavailable', message: 'message resolution is not available' })
      }
      input = resolveMessage(body.sessionId, body.messageId)
      if (input === undefined) {
        return json(404, { error: 'unknown_message', message: `no assistant message "${body.messageId}"` })
      }
      // Distinct from 404: the message is real, it just has nothing to say. A
      // synthesiser handed an empty string would return an empty WAV and look
      // like it had worked.
      if (typeof input !== 'string' || input.trim().length === 0) {
        return json(400, { error: 'empty_message', message: `message "${body.messageId}" has no spoken text` })
      }
    }
    if (typeof input !== 'string' || input.trim().length === 0) {
      return json(400, { error: 'bad_request', message: 'send an "input" string, or a "messageId" with its "sessionId"' })
    }
    // Bound before any work: an unbounded request is a CPU amplifier on a port.
    if (input.length > maxInputChars) {
      return json(413, {
        error: 'input_too_long',
        message: `"input" is ${input.length} characters; the limit is ${maxInputChars}`,
      })
    }
    const format = body.response_format ?? 'wav'
    if (!SUPPORTED_FORMATS.includes(format)) {
      return json(400, {
        error: 'unsupported_format',
        message: `response_format "${format}" is not supported; this build offers ${SUPPORTED_FORMATS.join(', ')}`,
      })
    }
    const voice = body.voice ?? defaultVoice
    if (voices.length > 0 && !voices.includes(voice)) {
      return json(400, { error: 'unknown_voice', message: `no voice "${voice}"` })
    }
    const speed = body.speed ?? 1
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      return json(400, { error: 'bad_speed', message: '"speed" must be a number between 0.5 and 2' })
    }
    // Opt out of the speech text filter. The service has honoured `raw` since the filter
    // was written; this is the surface that lets a caller ask for it. It matters in both
    // directions: the filter removes things a caller may actually want spoken (table rows,
    // dice notation, stat lines), and a caller that has already cleaned its own text should
    // not have it cleaned twice. Anything other than literal `true` leaves the filter on,
    // so a malformed value cannot switch it off by accident.
    const raw = body.raw === true
    if (typeof synthesize !== 'function') {
      return json(503, { error: 'unavailable', message: 'synthesis is not available' })
    }
    try {
      const result = await synthesize(input, { voice, speed, raw })
      const wav = Buffer.from(result.wav.buffer ?? result.wav, result.wav.byteOffset ?? 0, result.wav.length)
      // How the passage was broken up, so a caller can show progress or explain a
      // long wait without having to guess.
      const meta = {
        ...(result.segments === undefined ? {} : { 'x-segments': String(result.segments) }),
        ...(result.seconds === undefined ? {} : { 'x-audio-seconds': result.seconds.toFixed(2) }),
        ...(result.inferredMs === undefined ? {} : { 'x-inferred-ms': String(result.inferredMs) }),
      }
      if (format === 'pcm') {
        return { status: 200, headers: { 'content-type': 'audio/L16', 'x-sample-rate': '24000', ...meta }, body: stripWavHeader(wav) }
      }
      return { status: 200, headers: { 'content-type': 'audio/wav', ...meta }, body: wav }
    } catch (error) {
      return json(500, { error: 'synthesis_failed', message: String(error?.message ?? error) })
    }
  }

  return json(404, { error: 'not_found', message: `no route ${route} under ${prefix}` })
}

/**
 * Adapt the dispatcher to `node:http`.
 *
 * The handler owns the whole response, which is what `webServer.register` grants
 * — so audio is written as bytes rather than base64.
 */
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
      result = await routeRequest({
        method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, body,
      }, options)
    } catch (error) {
      result = json(500, { error: 'internal', message: String(error?.message ?? error) })
    }
    res.writeHead(result.status, result.headers)
    res.end(result.body)
  }
}
