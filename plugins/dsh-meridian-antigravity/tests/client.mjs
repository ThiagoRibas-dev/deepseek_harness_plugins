/**
 * Offline checks for the client half (the Models-page card).
 *
 * There is no browser and no React in this environment, so this does not prove
 * how the card looks. What it does prove is everything that can be checked
 * without a renderer: the module-loader contract, the slot key and registration
 * options the section dispatches on, and that the card's first render walks
 * every field without throwing and produces the expected labels and states.
 *
 * The React shim below supplies just enough of the hook API for one depth-first
 * render pass. A component that reads state it never set, calls a hook
 * conditionally, or returns a bad element shape still fails here.
 */

import { strict as assert } from 'node:assert'

// ------------------------------------------------------------------ React shim
let hookCursor = 0
let hookCells = []

const React = {
  createElement(type, props, ...children) {
    const merged = { ...props }
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookCells)) hookCells[index] = typeof initial === 'function' ? initial() : initial
    return [hookCells[index], () => {}]
  },
  useEffect() { hookCursor += 1 },
  useMemo(factory) { hookCursor += 1; return factory() },
  useCallback(fn) { hookCursor += 1; return fn },
}

/** Render one element tree depth-first, giving each component its own hook cells. */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(render)
  if (typeof node.type === 'function') {
    const outerCursor = hookCursor
    const outerCells = hookCells
    hookCursor = 0
    hookCells = []
    try {
      return render(node.type(node.props))
    } finally {
      hookCursor = outerCursor
      hookCells = outerCells
    }
  }
  return render(node.props?.children)
}

/** Every text string in a rendered tree, for content assertions. */
const textsOf = element => render(element).join(' | ')

// ------------------------------------------------------- module-loader capture
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

await import('../client.js')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const requireShim = name => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
}

console.log('\nclient module contract')
test('registers the module under the package name', () => {
  assert.ok(loaded !== undefined, 'window.__ModuleLoader__.load must be called')
  assert.equal(loaded.id, '@local/dsh-meridian-antigravity')
  assert.equal(typeof loaded.factory, 'function')
})

const module = loaded.factory(requireShim)

test('declares the client services the card reads', () => {
  assert.deepEqual(module.inject, ['slots', 'configForms', 'remote.credentials', 'remote.llm'])
})

test('registers into the keyed provider-card slot under its settings namespace', () => {
  let caught
  const ctx = { slots: { inject: (key, callback) => { caught = { key }; callback() }, register: (options, component) => { caught.options = options; caught.component = component } } }
  module.apply(ctx)
  assert.equal(caught.key, 'settings.models.provider-card')
  assert.equal(caught.options.name, 'settings.models.provider-card')
  assert.equal(caught.options.key, module.__components.NS)
  assert.equal(module.__components.NS, 'llm-meridian-antigravity')
  assert.equal(typeof caught.component, 'function')
})

test('registers no other slot', () => {
  const keys = []
  const ctx = { slots: { inject: (key, callback) => { keys.push(key); callback() }, register: () => {} } }
  module.apply(ctx)
  assert.deepEqual(keys, ['settings.models.provider-card'])
})

// ------------------------------------------------------------------ first render
function renderCard({ active = true, keyConfigured = true, status = 'ready', writable = true, value = {}, user = {} } = {}) {
  const form = {
    getSnapshot: () => ({ status, value, base: { baseURL: 'http://openmediavault:3457' }, user, revision: 1, writable, mode: 'host' }),
    subscribe: () => () => {},
    set: async () => true,
  }
  let component
  const ctx = {
    slots: { inject: (key, callback) => callback(), register: (options, next) => { component = next } },
    configForms: { get: ns => { assert.equal(ns, 'llm-meridian-antigravity'); return form } },
    remote: { credentials: { set: async () => ({ ok: true }), unset: async () => ({ ok: true }) }, llm: { discoverModels: async () => ({ ok: true, value: [] }) } },
  }
  module.apply(ctx)
  return { element: component({ provider: { provider: 'meridian-antigravity', displayName: 'Meridian Antigravity', settingsNs: 'llm-meridian-antigravity', settingsPath: [], active }, configured: true, keyConfigured }), ctx, form }
}

console.log('\ncard render')
test('renders the route state and every editable field', () => {
  const { element } = renderCard()
  const text = textsOf(element)
  for (const expected of [
    'Meridian Antigravity connector',
    'route registered',
    'key configured',
    'route meridian-antigravity',
    'Meridian origin',
    'Credential reference',
    'Pinned agy version',
    'Expected backend',
    'Local concurrency limit',
    'Context budget (tokens)',
    'Request byte cap',
    'Refuse to serve a wrong backend or CLI pin',
    'Advertise no tools to session-title helper turns',
    'Store the shared secret',
    'Save key',
    'Clear key',
    'Fetch account models',
  ]) {
    assert.ok(text.includes(expected), `the card must render ${JSON.stringify(expected)}`)
  }
})

test('reports an inactive route and a missing key instead of claiming success', () => {
  const text = textsOf(renderCard({ active: false, keyConfigured: false }).element)
  assert.ok(text.includes('route inactive'))
  assert.ok(text.includes('no key stored'))
  assert.ok(!text.includes('route registered'))
})

test('marks overridden fields and says when the namespace is not writable', () => {
  const overridden = textsOf(renderCard({ value: { baseURL: 'http://elsewhere:3457' }, user: { baseURL: 'http://elsewhere:3457' } }).element)
  assert.ok(overridden.includes('Meridian origin •'), 'an overridden field is marked')
  const locked = textsOf(renderCard({ writable: false }).element)
  assert.ok(locked.includes('is not writable from here'))
})

test('renders before the namespace has resolved', () => {
  const text = textsOf(renderCard({ status: 'loading', value: {}, user: {} }).element)
  assert.ok(text.includes('Meridian Antigravity connector'))
})

test('renders no model chips until discovery has run', () => {
  assert.ok(!textsOf(renderCard().element).includes('advertised by the signed-in account'))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
