/**
 * Integration checks for the HTTP adapter.
 *
 *   node check-http.mjs
 *
 * `check.js` covers the pure dispatcher, and the module smoke test only proves
 * the route *registers*. Neither runs `createRouteHandler` — the part that reads
 * a real `node:http` request, parses its body and query string, and writes bytes
 * to a real response. That is a distinct failure surface: a body read wrong, a
 * query string missed, or a Buffer handed to `res.end` as an object would all
 * pass the pure suite and break in service.
 *
 * So this starts an actual server on loopback and talks to it over the wire.
 * Still no harness, no browser, and no model.
 */
import { createServer } from 'node:http'
import { createRouteHandler } from './route.js'

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) { passed += 1; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const WAV = Buffer.alloc(44 + 8, 7)
// What the last settings write handed the host, so the route's allowlist and its
// pass-through can both be asserted rather than assumed.
let written
const options = {
  enabled: true, token: 'secret-token', allowAnonymous: false, maxInputChars: 50,
  prefix: '/v1/audio', voices: ['af_heart'], defaultVoice: 'af_heart',
  synthesize: async (text, opts) => ({ wav: WAV, text, opts }),
  status: () => ({ phase: 'ready' }),
  prepare: async () => {},
  cancel: async () => {},
  readPreference: () => ({ auto: null, effective: false }),
  writePreference: (id, auto) => ({ auto, effective: auto ?? false }),
  resolveMessage: () => 'resolved from the host',
  readSettings: () => ({ provider: 'kokoro', voice: 'af_heart' }),
  writeSettings: (patch) => { written = patch; return { ...patch } },
}

const server = createServer(createRouteHandler(options))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/audio`
const auth = { authorization: 'Bearer secret-token' }

try {
  const health = await fetch(`${base}/health`)
  check('health answers over the wire', health.status === 200)
  check('health is JSON', (health.headers.get('content-type') ?? '').includes('application/json'))

  const denied = await fetch(`${base}/voices`)
  check('an unauthenticated request is 401 over the wire', denied.status === 401)
  check('the 401 advertises the scheme', denied.headers.get('www-authenticate') === 'Bearer')
  check('the 401 body is the dispatcher message',
    JSON.parse(await denied.text()).error === 'unauthorized')

  const voices = await fetch(`${base}/voices`, { headers: auth })
  check('an authenticated GET works', voices.status === 200)
  // `/voices` answers with objects now, not bare ids: a picker needs presence and size to
  // label a voice that has not been downloaded. This server passes no `voiceDetails`,
  // which is the path taken by anything without a catalogue — ids, all marked present.
  const voiceList = JSON.parse(await voices.text()).voices
  check('the JSON body survives the adapter', voiceList[0]?.id === 'af_heart', JSON.stringify(voiceList[0]))
  check('a voice with no catalogue behind it is reported present', voiceList[0]?.present === true)

  // The settings allowlist is the only thing between a write and the store, and it has to
  // name every key the host can hold. `piperVoice` was missing from it, which made a Piper
  // voice selectable in the pane and impossible to save — a failure that produced no error
  // anywhere, just a choice that did not stick.
  const postSettings = (payload) => fetch(`${base}/settings`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const saveVoice = await postSettings({ voice: 'af_heart' })
  check('a settings write is accepted', saveVoice.status === 200, saveVoice.status)
  check('the accepted patch reaches the host', written?.voice === 'af_heart', written)
  const savePiper = await postSettings({ piperVoice: 'en_US-amy-medium' })
  check('the Piper voice key is a setting this plugin owns', savePiper.status === 200, savePiper.status)
  check('and it reaches the host unchanged', written?.piperVoice === 'en_US-amy-medium', written)
  const saveBogus = await postSettings({ nonsense: 'x' })
  check('an unknown key is still refused', saveBogus.status === 400, saveBogus.status)

  // The query string is parsed by the adapter, not the dispatcher.
  const pref = await fetch(`${base}/preference?sessionId=session-1`, { headers: auth })
  check('a query parameter reaches the dispatcher', pref.status === 200)
  const missing = await fetch(`${base}/preference`, { headers: auth })
  check('a missing query parameter is still a 400', missing.status === 400)

  // The request body is read by the adapter, not the dispatcher.
  const spoken = await fetch(`${base}/speech`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'The gate is barred.' }),
  })
  check('a POST body is parsed', spoken.status === 200)
  check('audio comes back as bytes with the right type',
    spoken.headers.get('content-type') === 'audio/wav')
  const audio = new Uint8Array(await spoken.arrayBuffer())
  check('the audio is byte-identical to what synthesis returned',
    audio.length === WAV.length && audio[0] === 7 && audio.at(-1) === 7, audio.length)
  check('no JSON wrapper leaked into the audio', audio.length === 52)

  const bad = await fetch(`${base}/speech`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{ not json',
  })
  check('malformed JSON is a 400, not a crash', bad.status === 400)

  const empty = await fetch(`${base}/speech`, { method: 'POST', headers: auth })
  check('a body-less POST is a 400', empty.status === 400)

  const wrong = await fetch(`${base}/speech`, { method: 'GET', headers: auth })
  check('the wrong method is a 405 over the wire', wrong.status === 405)

  // `raw` must reach synthesis. The service has honoured it since the text filter was
  // written and this is the surface that lets a caller ask for it — asserted rather than
  // assumed, because a dropped option fails *silently*: the audio still comes back, just
  // filtered, which is indistinguishable from success at the HTTP layer.
  let seenOptions
  const recorder = createServer(createRouteHandler({
    ...options,
    synthesize: async (text, opts) => { seenOptions = opts; return { wav: WAV, text, opts } },
  }))
  await new Promise((resolve) => recorder.listen(0, '127.0.0.1', resolve))
  const recorderBase = `http://127.0.0.1:${recorder.address().port}/v1/audio`
  const post = (payload) => fetch(`${recorderBase}/speech`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await post({ input: 'The gate is barred.', raw: true })
  check('raw: true reaches synthesis', seenOptions.raw === true)
  await post({ input: 'The gate is barred.' })
  check('omitting raw leaves the filter on', seenOptions.raw === false)
  await post({ input: 'The gate is barred.', raw: 'yes' })
  check('a non-literal raw cannot switch the filter off', seenOptions.raw === false)
  await new Promise((resolve) => recorder.close(resolve))

  const unknown = await fetch(`${base}/nope`, { headers: auth })
  check('an unknown sub-path is a 404 with no HTML fallback', unknown.status === 404)
  check('the 404 body is JSON, not an index page',
    (unknown.headers.get('content-type') ?? '').includes('application/json'))

  // A handler that throws must not take the server down.
  const hostile = createServer(createRouteHandler({
    ...options,
    synthesize: async () => { throw new Error('model exploded') },
  }))
  await new Promise((resolve) => hostile.listen(0, '127.0.0.1', resolve))
  const hostileBase = `http://127.0.0.1:${hostile.address().port}/v1/audio`
  const failed = await fetch(`${hostileBase}/speech`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'anything' }),
  })
  check('a synthesis throw is a 500 over the wire', failed.status === 500)
  check('the failure message reaches the caller',
    JSON.parse(await failed.text()).message === 'model exploded')
  // The server must still answer afterwards.
  check('the server survives the failure',
    (await fetch(`${hostileBase}/health`)).status === 200)
  await new Promise((resolve) => hostile.close(resolve))
} finally {
  await new Promise((resolve) => server.close(resolve))
}

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`${passed} checks passed`)
