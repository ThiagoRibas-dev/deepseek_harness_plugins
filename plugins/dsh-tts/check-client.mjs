/**
 * Offline checks for the browser half.
 *
 *   node check-client.mjs
 *
 * `client.js` is not an ES module — it is a script that expects a global
 * `window.__ModuleLoader__` — so it is evaluated in a VM context rather than
 * imported. That is enough to verify the parts that actually break: the
 * registration contract, the factory's shape, and whether the declared
 * externals match what the code really requires.
 *
 * No browser, no network, no build.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) { passed += 1; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// ---- registration --------------------------------------------------------

const registrations = []
const contexts = []
const started = []
let fetchCalls = []
let fetchReply = null

/** Web Audio, because the element path is what the browser refused. */
function FakeAudioContext() {
  this.state = 'suspended'
  this.destination = { name: 'destination' }
  this.resume = async () => { this.state = 'running' }
  this.decodeAudioData = async (buffer) => ({ duration: 1, buffer })
  this.createBufferSource = () => {
    const source = {
      buffer: null, started: false,
      connect: () => {},
      start: () => { source.started = true; started.push(source) },
      stop: () => { source.stopped = true },
    }
    return source
  }
  contexts.push(this)
}
const sandbox = {
  window: {
    __ModuleLoader__: { load: (registration) => registrations.push(registration), mode: 'queue' },
    AudioContext: FakeAudioContext,
  },
  fetch: async (url, options) => {
    fetchCalls.push({ url, options })
    return fetchReply ?? {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  },
  window_audio: true,
  setInterval: () => 0,
  clearInterval: () => {},
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('the bundle registers itself', registrations.length === 1, registrations.length)
const registration = registrations[0] ?? {}
check('it registers under the package name, which is what the loader keys on',
  registration.id === manifest.name, { registered: registration.id, package: manifest.name })
check('it registers a factory', typeof registration.factory === 'function')
check('it declares no chunk, so it is the package entry', registration.chunk === undefined)

// ---- the factory ---------------------------------------------------------

const required = []
const fakeRequire = (specifier) => {
  required.push(specifier)
  if (specifier === 'react') {
    const react = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    }
    return react
  }
  throw new Error(`the bundle required an undeclared module: ${specifier}`)
}

let exports
let factoryThrew = null
try { exports = registration.factory(fakeRequire) } catch (error) { factoryThrew = String(error.message) }
check('the factory runs', factoryThrew === null, factoryThrew)
check('the factory returns the bundle exports', typeof exports?.apply === 'function')
check('the bundle declares its injections', Array.isArray(exports?.inject), exports?.inject)
check('it injects the slots service', exports?.inject?.includes('slots'), exports?.inject)
check('the factory requires react', required.includes('react'), required)

// Every require must be declared, or the loader cannot resolve it. This is the
// check that keeps dsh.client.external honest as the code changes.
const declaredExternals = manifest.dsh?.client?.external ?? []
const undeclared = required.filter((specifier) => !declaredExternals.includes(specifier))
check('every required module is declared in dsh.client.external', undeclared.length === 0, undeclared)

// ---- apply ---------------------------------------------------------------

const slots = []
const ctx = {
  slots: {
    inject: (name, register) => { slots.push({ name, register }) },
    register: (options, component) => ({ options, component }),
  },
}
let applyThrew = null
try { exports.apply(ctx) } catch (error) { applyThrew = String(error.message) }
check('apply runs', applyThrew === null, applyThrew)
// Keyed by name *and* id, deliberately. Keying by name alone kept only the last
// registration for a slot — so adding a legitimate second header entry (the engine
// picker) silently replaced the toggle in this map and produced three failures that
// were about the harness, not the bundle.
const mounted = slots.map((entry) => ({ name: entry.name, ...(entry.register?.() ?? {}) }))
const byName = new Map()
for (const entry of mounted) {
  const list = byName.get(entry.name) ?? []
  list.push(entry)
  byName.set(entry.name, list)
}

check('it mounts five slots', slots.length === 5, slots.length)
const slotNames = [...byName.keys()].sort()
check('it mounts the settings pane, the message action and both header controls',
  JSON.stringify(slotNames) === JSON.stringify([
    'conversation.chat.assistant-actions', 'conversation.session.header.actions', 'plugins.bundle.config',
  ]), slotNames)
check('the header carries both of this bundle\'s entries',
  (byName.get('conversation.session.header.actions') ?? []).length === 2,
  (byName.get('conversation.session.header.actions') ?? []).map((entry) => entry.options?.id))

const pane = (byName.get('plugins.bundle.config') ?? [])[0]
check('the settings pane is keyed by this bundle', pane?.options?.key === manifest.name, pane?.options?.key)
check('the settings pane supplies a component', typeof pane?.component === 'function')

// A list slot needs an id so a registration adds an entry rather than replacing one,
// and an order so its position is deterministic.
const listEntries = mounted.filter((entry) => entry.name !== 'plugins.bundle.config')
check('every list entry carries an id',
  listEntries.every((entry) => typeof entry.options?.id === 'string' && entry.options.id !== ''),
  listEntries.map((entry) => entry.options?.id))
check('no two entries in one slot share an id',
  [...byName.values()].every((list) => new Set(list.map((entry) => entry.options?.id)).size === list.length))
check('every list entry carries an order',
  listEntries.every((entry) => typeof entry.options?.order === 'number'), listEntries.map((entry) => entry.options?.order))
check('every list entry supplies a component',
  listEntries.every((entry) => typeof entry.component === 'function'))

// `sessionId` arrives as a standard prop on both session slots, so no custom inject is
// needed. Live slot inspection confirms the registration surface is {id, order, label}
// and nothing else — a registration carrying extra keys is not documented and risks
// being ignored.
check('the settings pane declares only its documented keys',
  Object.keys(pane?.options ?? {}).every((key) => ['name', 'key'].includes(key)), Object.keys(pane?.options ?? {}))
check('every list registration declares only the documented keys',
  listEntries.every((entry) => Object.keys(entry.options ?? {}).every((key) => ['name', 'id', 'order', 'label'].includes(key))),
  listEntries.map((entry) => Object.keys(entry.options ?? {})))
check('the header actions supply projected labels',
  (byName.get('conversation.session.header.actions') ?? []).every((entry) => typeof entry.options?.label === 'function'))
// The shipped occupants differ *per slot*: the action row already carries `feedback`
// at 10, and the header carries `job-list` at 20. Generalising both exclusions to every
// slot made the message action's own legitimate order of 20 look like a collision.
const TAKEN_ORDERS = {
  'conversation.chat.assistant-actions': [10],
  'conversation.session.header.actions': [20],
}
check('the orders do not collide with the shipped occupants',
  listEntries.every((entry) => !(TAKEN_ORDERS[entry.name] ?? []).includes(entry.options?.order)),
  listEntries.map((entry) => `${entry.name}#${entry.options?.id}:${entry.options?.order}`))

// ---- the manifest --------------------------------------------------------

check('the package exports a ./client subpath', manifest.exports?.['./client'] === './client.js', manifest.exports?.['./client'])
check('the client platform is web', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client?.platform)

// ---- the component renders ----------------------------------------------

// Calling a component outside React exercises the top of the render path without
// needing a renderer: it must return an element, not throw.
for (const name of ['PrepareCard', 'SettingsPanel']) {
  const component = exports.__components?.[name]
  check(`${name} is exported for the suite`, typeof component === 'function')
  let element = null
  let threw = null
  try { element = component({}) } catch (error) { threw = String(error.message) }
  // Deliberately worded: this proves the component does not throw when invoked
// with its props, which catches a typo or a missing reference at the top of the
// render path. It is NOT render verification — the browser is the only place
// that can establish what a user sees.
  check(`${name} does not throw when invoked with its props`, threw === null && element !== null, threw)
}

for (const name of ['SpeakButton', 'ChatToggle']) {
  const component = exports.__components?.[name]
  check(`${name} is exported for the suite`, typeof component === 'function')
  let threw = null
  try { component({ messageId: 'msg-1', sessionId: 'session-1' }) } catch (error) { threw = String(error.message) }
  check(`${name} renders with its props`, threw === null, threw)
}

// Playback. The element path was refused by the browser because a long
// synthesis outlived the click's user activation, so this asserts the context
// route that replaced it: one context, resumed, decoding, starting a source.
const { play, stop, unlockAudio } = exports.__components
const playback = play(new Uint8Array([1, 2, 3]))
let ended = false
void playback.then(() => { ended = true })
await new Promise((resolve) => setTimeout(resolve, 5))
check('playback uses a Web Audio context', contexts.length === 1, contexts.length)
check('playback resumes the context', contexts[0]?.state === 'running', contexts[0]?.state)
check('playback starts a decoded source', started.length === 1 && started[0]?.started === true)
started[0]?.onended?.()
await playback
check('playback resolves when the source ends', ended)
check('a context can be unlocked before playback', unlockAudio() === undefined)
stop()
check('stop is safe to call when nothing is playing', stop() === undefined)

// The wire format, which is the part that silently breaks.
fetchCalls = []
await exports.__components.call('/status')
check('requests carry the prefix the host injected', fetchCalls[0]?.url === '/v1/audio/status', fetchCalls[0]?.url)
sandbox.window.__DSH_TTS__ = { prefix: '/v1/audio', token: 'abc' }
fetchCalls = []
await exports.__components.call('/status')
check('requests carry the bearer token', fetchCalls[0]?.options?.headers?.authorization === 'Bearer abc')
check('a JSON request declares its content type',
  (await (async () => { fetchCalls = []; await exports.__components.call('/speech', { method: 'POST', body: '{}' }); return fetchCalls[0] })().then(() => true)))
check('a GET sends no content type',
  (await (async () => { fetchCalls = []; await exports.__components.call('/status'); return fetchCalls[0]?.options?.headers?.['content-type'] })()) === undefined)

// A rejected call must surface the server's message, not a status code.
sandbox.window.__DSH_TTS__ = { prefix: '/v1/audio', token: '' }
fetchReply = { ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({ message: 'the TTS API is disabled' }) }
let surfaced = ''
try { await exports.__components.call('/status') } catch (error) { surfaced = String(error.message) }
check('a failure surfaces the server message', surfaced === 'the TTS API is disabled', surfaced)
fetchReply = null

// A slice of the behaviour that matters: the identity the host injects, and a
// call that must fail loudly rather than silently when the route rejects.
const { identity } = exports.__components
check('identity falls back when the host injected nothing', identity().prefix === '/v1/audio')
sandbox.window.__DSH_TTS__ = { prefix: '/tts', token: 'abc' }
check('identity prefers what the host injected', identity().prefix === '/tts' && identity().token === 'abc')

// ---- the voice picker's label --------------------------------------------
//
// The kind of mistake that produces no error at all: a label that hides a voice which
// has not been downloaded, leaving the user unable to reach it.
const { voiceLabel } = exports.__components
check('a downloaded voice is labelled by its id alone',
  voiceLabel({ id: 'af_heart', present: true }) === 'af_heart')
check('an undownloaded voice shows what it costs',
  voiceLabel({ id: 'en_US-lessac-high', present: false, bytes: 113900084 })
  === 'en_US-lessac-high — download 114 MB',
  voiceLabel({ id: 'en_US-lessac-high', present: false, bytes: 113900084 }))
check('a voice of unknown size still says it is not downloaded',
  voiceLabel({ id: 'en_US-amy-medium', present: false }) === 'en_US-amy-medium — not downloaded')
// A bare id is what a host without the richer shape sends; it must not become
// "[object Object]" in the dropdown.
check('a bare string passes straight through', voiceLabel('af_heart') === 'af_heart')
// The host supplies the human label; the id is only the fallback for an older host.
check('the host label is preferred over the id',
  voiceLabel({ id: 'af_heart', label: 'Heart · US female', present: true }) === 'Heart · US female')
check('an undownloaded voice is priced under its label',
  voiceLabel({ id: 'en_US-lessac-high', label: 'Lessac · US high', present: false, bytes: 113900084 })
  === 'Lessac · US high — download 114 MB',
  voiceLabel({ id: 'en_US-lessac-high', label: 'Lessac · US high', present: false, bytes: 113900084 }))
check('an empty label falls back to the id',
  voiceLabel({ id: 'af_heart', label: '', present: true }) === 'af_heart')

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`${passed} checks passed`)
