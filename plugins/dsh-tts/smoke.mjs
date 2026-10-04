/**
 * Load the plugin module and exercise `apply()` — the check the offline suite
 * cannot make, and whose absence let a broken plugin.js sit committed.
 *
 *   node smoke.mjs
 *
 * `check.js` covers the pure modules; this covers the one everything hangs off.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREFERENCE_FILE } from './preference.js'

register('./smoke-hook.mjs', import.meta.url)

const { apply, listVoices, setupEstimate, Config } = await import('./plugin.js')

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) { passed += 1; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

check('the module exports apply()', typeof apply === 'function')
check('setupEstimate is exported', typeof setupEstimate === 'function')
check('listVoices is exported', typeof listVoices === 'function')

const estimate = setupEstimate('af_heart.bin')
check('the estimate reports a real disk size', estimate.recommendedDiskBytes > 90_000_000, estimate.recommendedDiskBytes)
check('the estimate reports a time range', estimate.minimumMinutes <= estimate.maximumMinutes)
check('54 voices are pinned', listVoices().length === 54, listVoices().length)
// The upstream voices directory also carries af.bin, which is 512 rows rather than
// the 510 a voice has. Offering it would index past the style table.
check('the 512-row aggregate is not offered as a voice',
  !listVoices().some((voice) => voice.id === 'af'), listVoices().slice(0, 2).map((v) => v.id))
check('every offered voice has a full 510-row style table',
  listVoices().every((voice) => voice.bytes === 510 * 256 * 4))
check('voices are named without the .bin suffix', listVoices().every((v) => !v.id.endsWith('.bin')))
check('af_heart is among them', listVoices().some((v) => v.id === 'af_heart'))

/**
 * Every service name the plugin asked for. Tracked so a *forbidden* dependency can
 * be asserted absent: this plugin must never consult the session-projection registry,
 * because a projection requires a session event and appending one is what made
 * conversations unloadable. See `preference.js`.
 */
const asked = []
const effects = []
const tools = []
const routes = []
const indexTaps = []
let provided = null

/** A service lookup that answers only for the names asked about. */
const services = (overrides = {}) => (name) => {
  asked.push(name)
  return {
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    ...overrides,
  }[name]
}

/**
 * A session whose log must never be written. `append` throws, so a regression is a
 * loud failure here rather than an unloadable conversation later.
 */
const sessionById = (id) => (id === 'session-1'
  ? { id: 'session-1', append() { throw new Error('session.append must not be called') } }
  : undefined)

/** A scratch data root, so the preference file never lands in the working tree. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tts-smoke-'))

/**
 * The scoped `inject` form. Cordis exposes an injected service as a property of
 * the scoped context (`webCtx.webServer`), not through `get`, so every stub has to
 * behave that way or it would not exercise the real call shape.
 */
const scopedInject = (target) => (deps, callback) => callback(new Proxy(target, {
  get: (base, property) => {
    if (typeof property === 'string' && !(property in base)) {
      const service = base.get(property)
      if (service !== undefined) return service
    }
    return base[property]
  },
}))

const ctx = {
  inject: (deps, callback) => scopedInject(ctx)(deps, callback),
  provide: (name, value) => { provided = { name, value } },
  effect: (fn) => { effects.push(fn); return () => {} },
  get: (name) => {
    asked.push(name)
    return name === 'webServer' ? {
      register: (route) => { routes.push(route); return () => {} },
      tapIndex: (transform) => { indexTaps.push(transform); return () => {} },
    } : name === 'sessions' ? { get: sessionById } : undefined
  },
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (tool) => { tools.push(tool) } },
}

apply(ctx, { dataRoot: scratch, voice: 'af_heart', autoEnabled: false })
for (const fn of effects) fn()

check('apply() provides the tts service', provided?.name === 'tts')
check('the service exposes synthesize', typeof provided?.value?.synthesize === 'function')
check('the service exposes prepare and cancel', typeof provided?.value?.prepare === 'function' && typeof provided?.value?.cancel === 'function')
check('the service exposes the per-chat preference', typeof provided?.value?.preference === 'function' && typeof provided?.value?.setChatAuto === 'function')
// The regression that matters: no projection is registered, and the registry is not
// even asked for. A projection folds session events, and appending a custom event
// type is precisely what bricked two sessions.
check('the session-projection registry is never consulted', !asked.includes('sessionProjections'))
check('recording a choice does not write to the session',
  provided?.value?.setChatAuto(sessionById('session-1'), true)?.auto === true)
check('the choice lands in the plugin data root', existsSync(join(scratch, PREFERENCE_FILE)))
check('the status tool was registered', tools.some((tool) => tool.name === 'tts_status'), tools.map((t) => t.name))
check('the HTTP route was registered', routes.some((route) => route.kind === 'prefix' && route.path === '/v1/audio'), routes.map((r) => `${r.kind} ${r.path}`))
check('the route owns its own handler', typeof routes[0]?.handler === 'function')
check('the index tap was registered', indexTaps.length >= 1, indexTaps.length)
check('the status tool is read-only', tools.find((t) => t.name === 'tts_status')?.parameters && Object.keys(tools.find((t) => t.name === 'tts_status').parameters).length === 0)

// The Loader supplies volatile fields as accessors, not plain values. This is the
// trap the offline schema validation existed to find: reading `config.voice`
// directly would hand a Volatile object to the synthesizer.
const accessor = (value) => ({ get: () => value })
let volatileProvided = null
const volatileCtx = {
  inject: (deps, callback) => scopedInject(volatileCtx)(deps, callback),
  provide: (name, value) => { volatileProvided = { name, value } },
  effect: (fn) => { fn(); return () => {} },
  get: services(),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: () => {} },
}
let volatileThrew = null
try {
  apply(volatileCtx, {
    dataRoot: join(scratch, 'volatile'),
    voice: accessor('af_bella'),
    speed: accessor(1.2),
    autoEnabled: accessor(true),
    instructions: accessor('slow and ominous'),
    toneEnabled: accessor(false),
  })
} catch (error) { volatileThrew = String(error.message) }
check('a volatile config does not throw', volatileThrew === null, volatileThrew)
check('volatile values are unwrapped, not passed as objects',
  volatileProvided?.value?.voice === 'af_bella', volatileProvided?.value?.voice)
const volSession = { id: 'session-volatile', append() { throw new Error('session.append must not be called') } }
check('the profile default is read through the accessor',
  volatileProvided?.value?.preference(volSession).effective === true)

// Plain values must keep working: the offline suite constructs the plugin that way.
check('plain values still work',
  provided?.value?.preference({ id: 'session-plain' }).effective === false)

check('the config schema is exported for the Loader', Config !== undefined)

// A context where a scoped service never arrives at all: `inject` accepts the
// dependency and simply never runs the callback, which is what a missing `webServer`
// looks like and must not throw.
const bare = {
  inject: () => {},
  provide: () => {},
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
  logger: { warn: () => {} },
  tools: { register: () => {} },
}
let threw = false
try { apply(bare, { dataRoot: join(scratch, 'bare') }) } catch { threw = true }
check('a service that never arrives does not break apply()', !threw)

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`${passed} checks passed`)
