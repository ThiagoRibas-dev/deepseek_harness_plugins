/**
 * Offline checks for the pure logic in this bundle.
 *
 *   node check.js
 *
 * Deliberately no network and no model: everything here is arithmetic, parsing
 * and decision-making that can be verified in milliseconds. The parts that need
 * the 92 MB graph or a download are exercised separately, because a test suite
 * that needs the internet is a test suite that stops being run.
 *
 * Exits non-zero on the first failure so it can gate a commit.
 */
import { encodeWav, MAX_TOKENS, SAMPLE_RATE, STYLE_DIM, STYLE_ROWS, styleFor, tokenize, voiceLabel } from './kokoro.js'
import { compileDelivery, FAMILIES, readTextPace, TONE_PACE, toneToPace } from './delivery.js'
import { joinSamples } from './kokoro.js'
import { isAuthorized, routeRequest, SUPPORTED_FORMATS } from './route.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hardSplit, segmentText, splitSentences } from './segment.js'
import { attachPreference, createPreferenceStore, PREFERENCE_FILE } from './preference.js'
import {
  catalogueVoices, languageFor, phonemesToIds, piperFiles, piperVoiceLabel, scalesFor, voiceParts,
} from './piper.js'
import { createSettingsStore, SETTINGS_FILE } from './settings.js'
import { stripForSpeech, stripMarkdown } from './speech-text.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) { passed += 1; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const voices = Object.values(FAMILIES).flat()

// ---- tokenizer -----------------------------------------------------------

const vocab = new Map([['a', 43], ['b', 44], [' ', 16], ['ˈ', 156], ['?', 6]])
check('tokenize wraps in the $ sentinel', JSON.stringify(tokenize('ab', vocab)) === JSON.stringify([0, 43, 44, 0]))
check('tokenize drops unknown characters', JSON.stringify(tokenize('a?z', vocab)) === JSON.stringify([0, 43, 6, 0]))
const long = tokenize('a'.repeat(MAX_TOKENS * 2), vocab)
check('tokenize truncates to the graph limit', long.length === MAX_TOKENS, long.length)
check('tokenize keeps both sentinels when truncating', long[0] === 0 && long.at(-1) === 0)

// ---- voice indexing ------------------------------------------------------

const synthetic = Float32Array.from({ length: STYLE_ROWS * STYLE_DIM }, (_, i) => i)
check('styleFor clamps below the first row', styleFor(synthetic, 0)[0] === 0)
check('styleFor selects the row after the sentinels', styleFor(synthetic, 3)[0] === STYLE_DIM)
check('styleFor clamps at the last row', styleFor(synthetic, 9999)[0] === (STYLE_ROWS - 1) * STYLE_DIM)
check('styleFor returns exactly one style vector', styleFor(synthetic, 10).length === STYLE_DIM)

// ---- WAV encoding --------------------------------------------------------

const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 2, -2]))
const view = new DataView(wav.buffer)
const ascii = (at, n) => String.fromCharCode(...wav.subarray(at, at + n))
check('wav has a 44-byte header', wav.length === 44 + 5 * 2, wav.length)
check('wav is RIFF/WAVE', ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE')
check('wav declares 16-bit mono', view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1)
check('wav sample rate matches Kokoro', view.getUint32(24, true) === SAMPLE_RATE && SAMPLE_RATE === 24000)
check('wav data chunk length is right', view.getUint32(40, true) === 5 * 2)
check('wav clips rather than wrapping', view.getInt16(44 + 3 * 2, true) === 32767 && view.getInt16(44 + 4 * 2, true) === -32768)

// ---- delivery ------------------------------------------------------------

const compile = (instructions, text = '', toneEnabled = true, textPace) =>
  compileDelivery({ instructions, text, toneEnabled, voices, textPace })

check('british woman selects the british family', compile('a british woman, warm').voice === 'bf_emma')
check('british man selects the british male family', compile('a british man').voice === 'bm_fable')
check('american man selects the american male family', compile('an american man').voice === 'am_fenrir')
check('a bare gender word falls back to the default family', compile('a woman').voice === 'af_heart')
check('an accent alone outranks an absent gender', compile('british').voice === 'bf_emma')
check('an explicit pace outranks a mood', compile('tense but very slow', 'Something moves.').speed === 0.8)
check('ominous slows down', compile('slow and ominous').speed === 0.8)
check('urgent picks a brighter voice and speeds up', compile('urgent').voice === 'af_nicole')
check('unsupported asks are reported', compile('whisper it').unhonoured.length > 0)
check('unrecognised direction is reported', compile('make it sound better').unhonoured.length === 1)
check('no instructions produce no complaint', compile('').unhonoured.length === 0)
check('an unstated pace with tone off stays neutral', compile('', 'RUN! NOW!', false).speed === 1)
check('tone on reads shouting from the text', compile('', 'RUN! NOW! GO!!!').speed > 1.2)
check('a mood is explained, not asserted', compile('ominous').understood.some((line) => line.includes('ominous')))

check('readTextPace ignores empty text', readTextPace('').multiplier === 1)
check('a pace word must stand alone', compile('slowpoke').understood.every((line) => !line.startsWith('pace')))
check('readTextPace is silent on neutral prose',
  readTextPace('The gate is barred and the yard is quiet tonight.').cues.length === 0)

// ---- tone mapping --------------------------------------------------------

const probs = (spec) => TONE_PACE.map((tone) => spec[tone.label] ?? 0)

const angry = toneToPace(probs({ anger: 1 })).multiplier
const sad = toneToPace(probs({ sadness: 1 })).multiplier
const mixed = toneToPace(probs({ anger: 0.5, sadness: 0.5 })).multiplier
check('tone mapping weights by probability, not argmax', mixed > sad && mixed < angry, { mixed, sad, angry })
check('a confident anger reading speeds up', toneToPace(probs({ anger: 1 })).multiplier > 1.1)
check('a confident sadness reading slows down', toneToPace(probs({ sadness: 1 })).multiplier < 0.9)
check('neutral is exactly unchanged', toneToPace(probs({ neutral: 1 })).multiplier === 1)
check('the dominant label is reported', toneToPace(probs({ fear: 0.8, joy: 0.2 })).dominant === 'fear')
check('confidence is reported', toneToPace(probs({ fear: 0.8, joy: 0.2 })).confidence === 0.8)
check('the multiplier is clamped to a sane range',
  toneToPace(probs({ anger: 1 })).multiplier <= 1.3 && toneToPace(probs({ sadness: 1 })).multiplier >= 0.8)
check('a wrong-length vector is refused rather than guessed',
  toneToPace([1, 2, 3]).multiplier === 1 && toneToPace([1, 2, 3]).dominant === null)
check('a zero vector is refused', toneToPace(probs({})).multiplier === 1)
check('a supplied tone reading overrides the built-in heuristic',
  compile('', 'RUN! NOW!', true, { multiplier: 0.85, cues: ['tone sadness 0.9'] }).speed === 0.85)
check('the heuristic is used when no reading is supplied',
  compile('', 'RUN! NOW!').speed > 1.2)

// ---- per-chat preference -------------------------------------------------
//
// Plugin-owned storage keyed by session id, which replaced a session projection.
// The projection's `session.append('tts/preference', …)` wrote a durable event type
// the harness does not ship, and `Session.append()` cannot set the `ignorable` marker
// the persistence reader demands for an unknown one — so the session stopped loading
// on its next read. The guard that matters is therefore not "does the value
// round-trip" but "is the session never written": `append` throws below, so any
// regression fails here rather than in a user's history.

const preferenceRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-preference-'))
const preferencePath = join(preferenceRoot, PREFERENCE_FILE)

const ctx = { logger: { warn: () => {} } }
const service = {}
check('attachPreference reports success', attachPreference(ctx, service, { dataRoot: preferenceRoot }) === true)
check('attaching touches no file', !existsSync(preferencePath))

const chat = { id: 'session-1' }
const other = { id: 'session-2' }

check('an untouched chat inherits the profile default', service.preference(chat).effective === false)
check('and reports no override', service.preference(chat).auto === null)

// The regression guard, and the reason this section exists: the session log is not a
// place this plugin may write, so `append` throws if it is ever reached.
const appended = []
const session = {
  id: 'session-1',
  append(type, data) { appended.push({ type, data }); throw new Error('session.append must not be called') },
}
service.setChatAuto(session, true)
check('setChatAuto never appends a session event', appended.length === 0, appended)
check('the override takes effect', service.preference(session).effective === true)
check('the override is reported as stored', service.preference(session).auto === true)

check('the choice is durable', createPreferenceStore({ file: preferencePath }).read('session-1') === true)
check('the file carries a format version', JSON.parse(readFileSync(preferencePath, 'utf8')).version === 1)
check('no temporary file is left behind',
  readdirSync(preferenceRoot).every((name) => !name.endsWith('.tmp')), readdirSync(preferenceRoot))

check('a second chat is independent', service.preference(other).effective === false)
service.setChatAuto(other, false)
check('an explicit false is stored, not treated as unset', service.preference(other).auto === false)
check('and false does not fall back to the profile default', service.preference(other).effective === false)

service.setChatAuto(session, null)
check('null restores inheritance', service.preference(session).effective === false)
check('null removes the stored row', createPreferenceStore({ file: preferencePath }).read('session-1') === null)

let threw = false
try { service.setChatAuto(session, 'nope') } catch { threw = true }
check('setChatAuto rejects a non-boolean', threw)
threw = false
try { service.setChatAuto({}, true) } catch { threw = true }
check('setChatAuto needs a live session', threw)

// The profile default is the seed a chat inherits, not a duplicate of the toggle.
const inherited = {}
attachPreference(ctx, inherited, { dataRoot: preferenceRoot, profileDefault: () => true })
check('the profile default seeds a chat with no override',
  inherited.preference({ id: 'session-3' }).effective === true)
check('a stored override still beats the profile default', inherited.preference(other).effective === false)

// A corrupt or hand-edited file degrades to the default instead of taking the plugin
// down: a preference is not worth an error path into apply().
const corruptRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-corrupt-'))
writeFileSync(join(corruptRoot, PREFERENCE_FILE), '{ this is not json')
const warned = []
const resilient = {}
attachPreference({ logger: { warn: (message) => warned.push(message) } }, resilient, { dataRoot: corruptRoot })
check('a corrupt file degrades to the profile default', resilient.preference(chat).effective === false)
check('and it is reported once', warned.length === 1, warned)
resilient.setChatAuto(chat, true)
check('a write repairs the file', createPreferenceStore({ file: join(corruptRoot, PREFERENCE_FILE) }).read('session-1') === true)

// Rows that are not booleans are dropped rather than trusted.
const junkRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-junk-'))
writeFileSync(join(junkRoot, PREFERENCE_FILE),
  JSON.stringify({ version: 1, sessions: { a: true, b: 'yes', c: null, d: false } }))
const junk = createPreferenceStore({ file: join(junkRoot, PREFERENCE_FILE) })
check('a stored true is kept', junk.read('a') === true)
check('a stored false is kept', junk.read('d') === false)
check('a non-boolean row is dropped', junk.read('b') === null && junk.read('c') === null)

// ---- segmentation --------------------------------------------------------

check('blank input yields no segments', segmentText('   \n\n  ').length === 0)
check('a short sentence stays whole', segmentText('The gate is barred.').length === 1)
check('sentences under budget are packed together',
  segmentText('One. Two. Three.', { maxChars: 100 }).length === 1)
check('a paragraph break is always a boundary',
  segmentText('First para.\n\nSecond para.', { maxChars: 100 }).length === 2)
check('every segment respects the budget',
  segmentText('word '.repeat(400), { maxChars: 120 }).every((part) => part.length <= 120))
check('no segment is empty',
  segmentText('word '.repeat(400), { maxChars: 120 }).every((part) => part.trim() !== ''))

// The case that started this: a long message must become speakable rather than
// truncated by the graph's token ceiling.
const passage = Array.from({ length: 40 }, (_, i) =>
  `Paragraph ${i + 1}. It carries a sentence of reasonable length, with punctuation and clauses.`).join('\n\n')
const longSegments = segmentText(passage, { maxChars: 400 })
check('a long passage becomes many segments', longSegments.length > 5, longSegments.length)
check('and every one of them fits', longSegments.every((part) => part.length <= 400))
check('and none of the words are lost',
  longSegments.join(' ').replace(/\s+/g, ' ').length >= passage.replace(/\s+/g, ' ').length - longSegments.length)

// Sentences.
check('a period ends a sentence', splitSentences('One. Two.').length === 2)
check('"3.5 miles" is not two sentences', splitSentences('It is 3.5 miles away.').length === 1)
check('a version number is not a sentence break', splitSentences('Upgrade to 1.2.3 now.').length === 1)
check('an exclamation ends a sentence', splitSentences('Run! Hide!').length === 2)
check('a closing quote stays with its sentence',
  splitSentences('She said "go." Then she left.').length === 2)
check('text with no terminator is one sentence', splitSentences('no punctuation here').length === 1)
check('trailing whitespace is trimmed', splitSentences('Done.   ')[0] === 'Done.')

// Hard splitting, for a sentence longer than the whole budget.
check('a piece within budget is returned as-is', hardSplit('short', 100).length === 1)
check('a long piece splits on word boundaries',
  hardSplit('alpha beta gamma delta', 12).every((part) => part.length <= 12))
check('word-boundary splitting loses nothing',
  hardSplit('alpha beta gamma delta', 12).join(' ') === 'alpha beta gamma delta')
check('an unbreakable token is chopped rather than dropped',
  hardSplit('x'.repeat(250), 100).join('').length === 250)
check('chunks of an unbreakable token all fit',
  hardSplit('x'.repeat(250), 100).every((part) => part.length <= 100))

// Joining rendered audio.
const a = new Float32Array([1, 1, 1])
const b = new Float32Array([2, 2, 2])
check('one part is returned untouched', joinSamples([a], 1000, 100) === a)
check('no gap is added before the first or after the last',
  joinSamples([a, b], 1000, 100).length === 6 + 100, joinSamples([a, b], 1000, 100).length)
const joined = joinSamples([a, b], 1000, 100)
check('the first segment starts at sample zero', joined[0] === 1)
check('the gap between segments is silent',
  joined.slice(3, 103).every((value) => value === 0))
check('the second segment follows the gap', joined[103] === 2)
check('joining nothing yields nothing', joinSamples([], 1000, 100).length === 0)
check('empty parts are ignored rather than becoming gaps',
  joinSamples([a, new Float32Array(0), b], 1000, 100).length === 106)
check('a zero gap still concatenates', joinSamples([a, b], 1000, 0).length === 6)

// ---- HTTP route ----------------------------------------------------------

const WAV = new Uint8Array(44 + 8)
const routeOptions = (over = {}) => ({
  enabled: true, token: 'secret-token', allowAnonymous: false, maxInputChars: 50,
  prefix: '/v1/audio', voices: ['af_heart', 'bf_emma'], defaultVoice: 'af_heart',
  synthesize: async (text, opts) => ({ wav: WAV, seconds: 1, text, opts }),
  status: () => ({ phase: 'ready', steps: [] }),
  prepare: async () => {},
  cancel: async () => {},
  ...over,
})
const ask = (over, request) => routeRequest(request, routeOptions(over))
const withAuth = (request) => ({ headers: { authorization: 'Bearer secret-token' }, ...request })
const post = (pathname, body) => withAuth({ method: 'POST', pathname, body })

check('a path outside the prefix is 404',
  (await ask({}, { method: 'GET', pathname: '/elsewhere' })).status === 404)
check('health is reachable without a credential',
  (await ask({}, { method: 'GET', pathname: '/v1/audio/health' })).status === 200)
check('a disabled API answers 503, not 404',
  (await ask({ enabled: false }, withAuth({ method: 'GET', pathname: '/v1/audio/voices' }))).status === 503)
check('a missing token is 401',
  (await ask({}, { method: 'GET', pathname: '/v1/audio/voices' })).status === 401)
check('a wrong token is 401',
  (await ask({}, { method: 'GET', pathname: '/v1/audio/voices', headers: { authorization: 'Bearer nope' } })).status === 401)
check('a token of the wrong length is rejected',
  isAuthorized({ authorization: 'Bearer secret-token-longer' }, { token: 'secret-token' }) === false)
check('a non-Bearer scheme is rejected',
  isAuthorized({ authorization: 'Basic secret-token' }, { token: 'secret-token' }) === false)
check('anonymous access is honoured only when allowed',
  (await ask({ allowAnonymous: true }, { method: 'GET', pathname: '/v1/audio/voices' })).status === 200
  && (await ask({}, { method: 'GET', pathname: '/v1/audio/voices' })).status === 401)
check('an empty configured token never authorizes',
  isAuthorized({ authorization: 'Bearer ' }, { token: '' }) === false)

const voiceList = await ask({}, withAuth({ method: 'GET', pathname: '/v1/audio/voices' }))
check('voices lists what is installed', voiceList.status === 200 && JSON.parse(voiceList.body).voices.length === 2)
check('the wrong method is 405 with an Allow header',
  (await ask({}, post('/v1/audio/voices'))).status === 405
  && (await ask({}, post('/v1/audio/voices'))).headers.allow === 'GET')
check('status reports preparation',
  JSON.parse((await ask({}, withAuth({ method: 'GET', pathname: '/v1/audio/status' }))).body).phase === 'ready')

let prepared = 0
const prep = await ask({ prepare: async () => { prepared += 1 } }, post('/v1/audio/prepare'))
check('prepare acknowledges immediately with 202', prep.status === 202)
await new Promise((r) => setTimeout(r, 10))
check('prepare is actually kicked off', prepared === 1)

check('speech rejects the wrong method', (await ask({}, withAuth({ method: 'GET', pathname: '/v1/audio/speech' }))).status === 405)
check('speech rejects a missing body', (await ask({}, post('/v1/audio/speech'))).status === 400)
check('speech rejects an empty input', (await ask({}, post('/v1/audio/speech', { input: '   ' }))).status === 400)
check('speech bounds input before working',
  (await ask({}, post('/v1/audio/speech', { input: 'x'.repeat(51) }))).status === 413)
check('speech rejects an unsupported format',
  (await ask({}, post('/v1/audio/speech', { input: 'hi', response_format: 'mp3' }))).status === 400)
check('the unsupported-format message names what is offered',
  JSON.parse((await ask({}, post('/v1/audio/speech', { input: 'hi', response_format: 'mp3' }))).body)
    .message.includes(SUPPORTED_FORMATS.join(', ')))
check('speech rejects an unknown voice',
  (await ask({}, post('/v1/audio/speech', { input: 'hi', voice: 'nope' }))).status === 400)
check('speech rejects a nonsensical speed',
  (await ask({}, post('/v1/audio/speech', { input: 'hi', speed: 99 }))).status === 400)
check('a bad request leaks no stack trace',
  !JSON.parse((await ask({}, post('/v1/audio/speech', { input: '' }))).body).message.includes(' at '))

const spoken = await ask({}, post('/v1/audio/speech', { input: 'The gate is barred.' }))
check('speech returns 200', spoken.status === 200)
check('speech returns audio, not JSON', spoken.headers['content-type'] === 'audio/wav' && Buffer.isBuffer(spoken.body))
check('speech returns the WAV', spoken.body.length === WAV.length)
const pcm = await ask({}, post('/v1/audio/speech', { input: 'The gate is barred.', response_format: 'pcm' }))
check('pcm strips the 44-byte header', pcm.body.length === WAV.length - 44 && pcm.headers['content-type'] === 'audio/L16')

let forwarded = null
await ask({ synthesize: async (text, opts) => { forwarded = { text, opts }; return { wav: WAV } } },
  post('/v1/audio/speech', { input: 'hello', voice: 'bf_emma', speed: 1.2 }))
check('the request reaches synthesis intact',
  forwarded?.text === 'hello' && forwarded.opts.voice === 'bf_emma' && forwarded.opts.speed === 1.2)

check('a synthesis failure is a 500, not a crash',
  (await ask({ synthesize: async () => { throw new Error('model exploded') } },
    post('/v1/audio/speech', { input: 'hi' }))).status === 500)
check('the failure message is surfaced',
  JSON.parse((await ask({ synthesize: async () => { throw new Error('model exploded') } },
    post('/v1/audio/speech', { input: 'hi' }))).body).message === 'model exploded')

// ---- the per-chat preference endpoint ------------------------------------

const live = new Map([['session-1', { auto: null }]])
const prefOptions = {
  readPreference: (id) => (live.has(id) ? { ...live.get(id), effective: live.get(id).auto ?? false } : undefined),
  writePreference: (id, auto) => {
    if (!live.has(id)) return undefined
    live.set(id, { auto })
    return { auto, effective: auto ?? false }
  },
}
const pref = (over, request) => routeRequest(request, routeOptions({ ...prefOptions, ...over }))
const authGet = (pathname, search = '') => withAuth({ method: 'GET', pathname, query: new URLSearchParams(search) })

check('preference needs a session id',
  (await pref({}, withAuth({ method: 'GET', pathname: '/v1/audio/preference' }))).status === 400)
check('an unknown session is 404, not 500',
  (await pref({}, authGet('/v1/audio/preference', 'sessionId=nope'))).status === 404)
check('a known session reads its state',
  (await pref({}, authGet('/v1/audio/preference', 'sessionId=session-1'))).status === 200)
check('a fresh session reports inheritance',
  JSON.parse((await pref({}, authGet('/v1/audio/preference', 'sessionId=session-1'))).body).auto === null)
check('writing a boolean takes effect',
  JSON.parse((await pref({}, withAuth({ method: 'POST', pathname: '/v1/audio/preference', body: { sessionId: 'session-1', auto: true } }))).body).effective === true)
check('the read reflects the write',
  JSON.parse((await pref({}, authGet('/v1/audio/preference', 'sessionId=session-1'))).body).auto === true)
check('null restores inheritance',
  JSON.parse((await pref({}, withAuth({ method: 'POST', pathname: '/v1/audio/preference', body: { sessionId: 'session-1', auto: null } }))).body).effective === false)
check('a non-boolean is rejected',
  (await pref({}, withAuth({ method: 'POST', pathname: '/v1/audio/preference', body: { sessionId: 'session-1', auto: 'yes' } }))).status === 400)
check('writing to an unknown session is 404',
  (await pref({}, withAuth({ method: 'POST', pathname: '/v1/audio/preference', body: { sessionId: 'nope', auto: true } }))).status === 404)
check('another method is 405 with both verbs allowed',
  (await pref({}, withAuth({ method: 'DELETE', pathname: '/v1/audio/preference' }))).headers.allow === 'GET, POST')
check('the preference endpoint also requires the token',
  (await pref({}, { method: 'GET', pathname: '/v1/audio/preference', query: new URLSearchParams('sessionId=session-1') })).status === 401)

// ---- speaking a message by id --------------------------------------------

const byId = { 'msg-1': 'The gate is barred.', 'msg-2': '' }
// Mirrors the real contract: text (possibly empty) when the message exists.
const resolveMessage = (sessionId, messageId) =>
  (sessionId === 'session-1' && Object.hasOwn(byId, messageId) ? byId[messageId] : undefined)
const speak = (over, body) => routeRequest(
  withAuth({ method: 'POST', pathname: '/v1/audio/speech', body }),
  routeOptions({ resolveMessage, ...over }),
)

check('a message id is resolved to its text',
  (await speak({}, { sessionId: 'session-1', messageId: 'msg-1' })).status === 200)
check('the resolved text reaches synthesis',
  (await speak({ synthesize: async (text) => ({ wav: WAV, text }) }, { sessionId: 'session-1', messageId: 'msg-1' })).status === 200)
check('an unknown message is 404', (await speak({}, { sessionId: 'session-1', messageId: 'nope' })).status === 404)
check('a message id without a session is 400',
  (await speak({}, { messageId: 'msg-1' })).status === 400)
check('an empty message is a 400, not a 404',
  (await speak({}, { sessionId: 'session-1', messageId: 'msg-2' })).status === 400)
check('and it says why', JSON.parse((await speak({}, { sessionId: 'session-1', messageId: 'msg-2' })).body).error === 'empty_message')
check('"exists but empty" is distinguishable from "no such message"',
  (await speak({}, { sessionId: 'session-1', messageId: 'msg-2' })).status
  !== (await speak({}, { sessionId: 'session-1', messageId: 'nope' })).status)
check('the input length bound applies to resolved text too',
  (await speak({ maxInputChars: 5 }, { sessionId: 'session-1', messageId: 'msg-1' })).status === 413)
check('literal input still works alongside message resolution',
  (await speak({}, { input: 'hello' })).status === 200)
check('without a resolver, a message id reports 503 not a crash',
  (await speak({ resolveMessage: undefined }, { sessionId: 'session-1', messageId: 'msg-1' })).status === 503)

check('an unknown sub-path under the prefix is 404',
  (await ask({}, withAuth({ method: 'GET', pathname: '/v1/audio/nope' }))).status === 404)

// ---- settings store ------------------------------------------------------
//
// The pane's write path. Same shape as the preference store, so its failure modes are
// the ones already proven: absent file means "use the patch default", a corrupt file
// warns once and degrades, and a refusal changes nothing.

const settingsRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-settings-'))
const settingsFile = join(settingsRoot, SETTINGS_FILE)
const settingsStore = createSettingsStore({ file: settingsFile, logger: { warn: () => {} } })

check('attaching touches no file', !existsSync(settingsFile))
check('an unchanged setting falls back to the patch default',
  settingsStore.get('voice', 'af_heart') === 'af_heart')
settingsStore.set({ voice: 'af_bella', toneEnabled: false })
check('a write is readable', settingsStore.get('voice', 'af_heart') === 'af_bella')
check('a stored false is not mistaken for absent', settingsStore.get('toneEnabled', true) === false)
check('the settings file carries a format version',
  JSON.parse(readFileSync(settingsFile, 'utf8')).version === 1)
check('a fresh store sees the same values',
  createSettingsStore({ file: settingsFile }).get('voice') === 'af_bella')
check('no temporary file is left behind',
  readdirSync(settingsRoot).every((name) => !name.endsWith('.tmp')))

let settingsThrew = false
try { settingsStore.set({ notASetting: 1 }) } catch { settingsThrew = true }
check('a key the store does not own is refused', settingsThrew)
settingsThrew = false
try { settingsStore.set({ toneEnabled: 'yes' }) } catch { settingsThrew = true }
check('a malformed value is refused', settingsThrew)
check('and a refusal changes nothing', settingsStore.get('toneEnabled', true) === false)

// A corrupt or hand-edited file degrades to the defaults instead of breaking the pane.
const brokenRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-settings-broken-'))
writeFileSync(join(brokenRoot, SETTINGS_FILE), '{ this is not json')
const brokenWarned = []
const brokenStore = createSettingsStore({
  file: join(brokenRoot, SETTINGS_FILE),
  logger: { warn: (message) => brokenWarned.push(message) },
})
check('a corrupt settings file degrades to the default',
  brokenStore.get('voice', 'af_heart') === 'af_heart')
check('and it is reported once', brokenWarned.length === 1, brokenWarned)
brokenStore.set({ voice: 'af_nicole' })
check('a write repairs the file',
  createSettingsStore({ file: join(brokenRoot, SETTINGS_FILE) }).get('voice') === 'af_nicole')

// Values this build does not understand are dropped rather than trusted.
const unknownRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-settings-unknown-'))
writeFileSync(join(unknownRoot, SETTINGS_FILE),
  JSON.stringify({ version: 1, settings: { voice: 'af_heart', toneEnabled: 'yes', future: 3 } }))
const unknownStore = createSettingsStore({ file: join(unknownRoot, SETTINGS_FILE) })
check('a stored string is kept', unknownStore.get('voice') === 'af_heart')
check('a malformed stored value is dropped', unknownStore.get('toneEnabled', 'fallback') === 'fallback')
check('a key this build does not know is dropped', unknownStore.get('future', 'fallback') === 'fallback')

// ---- speech text ---------------------------------------------------------
//
// One of these rules touches every word the plugin speaks, and until now none of them
// was tested. The markdown half is the reference implementation supplied for this
// profile; the cases below are its edge cases plus the three documented divergences.

check('bold markers go', stripMarkdown('**The gate is barred.**') === 'The gate is barred.')
check('italic markers go', stripMarkdown('*softly*') === 'softly')
check('underscore emphasis goes', stripMarkdown('_emphasis_') === 'emphasis')
check('strikethrough markers go', stripMarkdown('~~struck~~') === 'struck')
check('heading marks go', stripMarkdown('## Stats') === 'Stats')
check('blockquote marks go', stripMarkdown('> he said') === 'he said')
check('inline code keeps its text', stripMarkdown('run `npm test` now') === 'run npm test now')
check('a thematic break leaves nothing', stripMarkdown('---') === '')
check('three blank lines collapse to one', stripMarkdown('a\n\n\n\nb') === 'a\n\nb')

// The lookarounds that make the reference correct, and that a hand-rolled version gets
// wrong: an underscore inside a word is not emphasis, and a lone asterisk is not a pair.
check('an underscore inside a word survives', stripMarkdown('snake_case_name') === 'snake_case_name')
check('a lone asterisk survives', stripMarkdown('2 * 3') === '2 * 3')

// [beyond the reference] — fenced code, links, and list markers.
check('a fenced block is dropped, not read aloud',
  stripMarkdown('Before.\n```\nconst x = 1\n```\nAfter.') === 'Before.\n\nAfter.')
check('a link keeps its text and loses its target',
  stripMarkdown('see [the map](https://example.com/map.png)') === 'see the map')
check('an image is dropped entirely',
  stripMarkdown('![a wolf](https://example.com/w.png)') === '')
check('list markers go', stripMarkdown('- the gate\n- the wolf') === 'the gate\nthe wolf')

// The mechanics half: shapes that read terribly aloud, and prose that must survive.
check('table rows are dropped', stripForSpeech('| AC | 31 |\n| HP | 88 |') === '')
check('dice notation is dropped', stripForSpeech('Roll 2d6+3 for damage.') === 'Roll for damage.')
check('a stat line is dropped', stripForSpeech('AC 31, touch 12, flat-footed 29') === '')
check('but a sentence mentioning AC survives',
  stripForSpeech('Your AC is 31 while the spell lasts.') === 'Your AC is 31 while the spell lasts.')
check('ordinary prose is untouched',
  stripForSpeech('The gate is barred. Nothing breathes.') === 'The gate is barred. Nothing breathes.')
check('markdown and mechanics compose',
  stripForSpeech('**AC 31**\n\nRoll 1d20+17.') === 'Roll.')
check('an empty string is handled', stripForSpeech('') === '')
check('a non-string is refused rather than thrown on', stripForSpeech(null) === '')

// ---- piper ---------------------------------------------------------------
//
// The construction below was verified against the published `en_US-amy-medium`
// artifact *before* the driver was written: the probe produced 2.33 s of audible
// speech (peak 0.55) at RTF 0.38, and reported "72 ids from 35 symbols" — which is
// exactly `1 + 2n + 1` for n = 35. These checks keep that measured contract honest.

// Only the tokens this construction cares about; the real map has 154 entries.
const piperMap = { '^': [1], '$': [2], '_': [0], ' ': [3], 'h': [30], 'ə': [40] }

check('the id sequence is start, then each phoneme padded, then end',
  JSON.stringify(phonemesToIds('hə', piperMap)) === JSON.stringify([1, 30, 0, 40, 0, 2]))
check('a word boundary is a phoneme like any other, and still gets its pad',
  JSON.stringify(phonemesToIds('h_ə', piperMap)) === JSON.stringify([1, 30, 0, 0, 0, 40, 0, 2]))
check('the id count is 1 + 2n + 1 for n symbols',
  phonemesToIds('həh', piperMap).length === 1 + 2 * 3 + 1)
check('a symbol the map does not carry is skipped, not fatal',
  phonemesToIds('h?ə', piperMap).length === phonemesToIds('hə', piperMap).length)
check('an unmappable phonemizer result yields no ids rather than a bad sequence',
  phonemesToIds('hə', { h: [30] }).length === 0)

// VITS length_scale is the *inverse* of speed: a longer scale is a longer utterance.
check('speed 2 halves the length scale', scalesFor(2, {})[1] === 0.5)
check('speed 0.5 doubles it', scalesFor(0.5, {})[1] === 2)
check('the scales keep the model order: noise, length, noise width',
  JSON.stringify(scalesFor(1, { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }))
  === JSON.stringify([0.667, 1, 0.8]))
check('an absurd speed is clamped, not passed through', scalesFor(99, {})[1] === 0.5)
check('a nonsense speed falls back to the voice default', scalesFor(0, {})[1] === 1)
check('a voice that states its own scales keeps them',
  scalesFor(1, { noise_scale: 0.5, length_scale: 1.2, noise_w: 0.9 })[2] === 0.9)

// The repository layout: the locale is ONE path component. Getting that wrong is the
// 404 the first fetch hit, so it is pinned here rather than remembered.
check('the voice name maps to the repository path',
  voiceParts('en_US-amy-medium')?.dir === 'en/en_US/amy/medium/en_US-amy-medium')
check('a British voice maps to en_GB',
  voiceParts('en_GB-alan-low')?.dir === 'en/en_GB/alan/low/en_GB-alan-low')
check('an unparseable name is refused rather than guessed', voiceParts('amy') === undefined)
check('a path is not a voice name', voiceParts('en/en_US/amy/medium/x') === undefined)
check('piper speaks American for en-us and British for en-gb',
  languageFor('en-us') === 'a' && languageFor('en-gb') === 'b')

// The manifest doubles as the catalogue, so the *paths* it implies are worth pinning: a
// wrong URL is a 404 after a long wait, and a wrong local path is a voice downloaded
// twice because the copy already on disk was never recognised.
const piperManifest = {
  baseUrl: 'https://example.invalid/resolve/main/',
  voices: {
    'en_US-amy-medium': {
      dir: 'en/en_US/amy/medium',
      files: {
        'en_US-amy-medium.onnx': { bytes: 63201294, sha256: 'a'.repeat(64) },
        'en_US-amy-medium.onnx.json': { bytes: 4882, sha256: 'b'.repeat(64) },
      },
    },
  },
}
const catalogueRoot = join(tmpdir(), 'dsh-tts-catalogue')
const catalogueFiles = piperFiles(piperManifest, 'en_US-amy-medium', catalogueRoot)

check('one entry per pinned file, model and config',
  catalogueFiles.length === 2
  && catalogueFiles.map((file) => file.name).sort().join(',')
    === 'en_US-amy-medium.onnx,en_US-amy-medium.onnx.json')
// The URL nests the locale as ONE component and keeps the voice in the filename.
check('the URL is the upstream path, with no voice directory in it',
  catalogueFiles[0].url === 'https://example.invalid/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
  catalogueFiles[0].url)
// The local path does give the voice its own directory, which is what `fetch-piper.mjs`
// already wrote — so a hand-fetched voice is recognised rather than fetched again.
check('the local path matches the layout fetch-piper.mjs writes',
  catalogueFiles[0].dest === join(catalogueRoot, 'en/en_US/amy/medium/en_US-amy-medium/en_US-amy-medium.onnx'),
  catalogueFiles[0].dest)
check('the pin travels in the shape ensureAsset wants',
  catalogueFiles[0].asset.sha256 === 'a'.repeat(64)
  && catalogueFiles[0].asset.bytes === 63201294
  && catalogueFiles[0].asset.path === 'en_US-amy-medium.onnx')
check('an unpinned voice yields no files rather than a guess',
  piperFiles(piperManifest, 'en_US-nobody-medium', catalogueRoot).length === 0)
check('a manifest with no voices section is survivable',
  piperFiles(undefined, 'en_US-amy-medium', catalogueRoot).length === 0)

// Presence is existence, not a hash — hashing every voice to render a picker would read
// hundreds of megabytes. A temporary root tests both answers without a 63 MB fixture.
const catalogue = catalogueVoices(piperManifest, catalogueRoot)
check('the catalogue lists a pinned voice whether or not it is on disk',
  catalogue.length === 1 && catalogue[0].id === 'en_US-amy-medium')
check('a voice with nothing on disk is not present', catalogue[0].present === false)
check('the size is the pins summed, model plus config',
  catalogue[0].bytes === 63201294 + 4882, catalogue[0].bytes)
check('the entry carries the two fields loadPiperVoice reads',
  catalogue[0].path === catalogueFiles[0].dest && catalogue[0].configPath === catalogueFiles[1].dest,
  `${catalogue[0].path} / ${catalogue[0].configPath}`)

const presentRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-present-'))
const presentDir = join(presentRoot, 'en/en_US/amy/medium/en_US-amy-medium')
mkdirSync(presentDir, { recursive: true })
for (const file of catalogueFiles) writeFileSync(join(presentDir, file.name), 'x')
check('a voice whose files exist is present',
  catalogueVoices(piperManifest, presentRoot)[0].present === true)
// One file of two is not a voice: the config is what makes the model drivable.
const halfRoot = mkdtempSync(join(tmpdir(), 'dsh-tts-half-'))
const halfDir = join(halfRoot, 'en/en_US/amy/medium/en_US-amy-medium')
mkdirSync(halfDir, { recursive: true })
writeFileSync(join(halfDir, 'en_US-amy-medium.onnx'), 'x')
check('a model without its config is not present',
  catalogueVoices(piperManifest, halfRoot)[0].present === false)

// ---- voice labels --------------------------------------------------------
//
// Labels are mechanical — the id read through the same letter table the phonemizer uses —
// so there is nothing here to be wrong about except the parse, which is what these pin. An
// unreadable id comes back unchanged on purpose: a technical label always looks wrong,
// while a guessed one looks plausible, and a plausible wrong label is the worse failure.
check('a Kokoro id reads as a person would say it', voiceLabel('af_heart') === 'Heart · US female')
check('a British male voice keeps the country', voiceLabel('bm_george') === 'George · UK male')
check('a multi-letter name is capitalised once', voiceLabel('af_aoede') === 'Aoede · US female')
check('a non-English voice names its language',
  voiceLabel('zf_xiaobei') === 'Xiaobei · Chinese female', voiceLabel('zf_xiaobei'))
check('a Portuguese voice is not labelled American',
  voiceLabel('pf_dora') === 'Dora · Brazilian Portuguese female', voiceLabel('pf_dora'))
check('an unknown language letter is not guessed at', voiceLabel('qf_heart') === 'qf_heart')
check('an id with no name is left alone', voiceLabel('af') === 'af')
check('an empty id survives', voiceLabel('') === '')
check('an extension is not mistaken for part of the name', voiceLabel('af_heart.bin') === 'af_heart.bin')

check('a Piper id reads the same way', piperVoiceLabel('en_US-amy-medium') === 'Amy · US medium')
check('a Piper high-quality voice says so', piperVoiceLabel('en_US-lessac-high') === 'Lessac · US high')
check('an unparseable Piper id is left alone', piperVoiceLabel('amy') === 'amy')

// ---- report --------------------------------------------------------------

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`${passed} checks passed`)
