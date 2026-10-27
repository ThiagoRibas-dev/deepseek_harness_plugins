import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal React surface: the factory only destructures hooks; nothing renders. */
class Component {
  constructor(props) { this.props = props; this.state = {} }
  setState(patch) { this.state = { ...this.state, ...patch } }
}

const reactStub = {
  Component,
  createElement: () => null,
  useState: value => [value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory }
    },
  },
}

await import('../client.js')

test('the client bundle registers under its package name', () => {
  assert.equal(loaded.id, '@local/dsh-model-rotation')
  assert.equal(typeof loaded.factory, 'function')
})

test('apply registers the settings page, the tab type, and the tab slots', () => {
  const plugin = loaded.factory(specifier => {
    assert.equal(specifier, 'react')
    return reactStub
  })
  assert.ok(plugin.inject.includes('remote.settings'))
  assert.ok(plugin.inject.includes('remote.credentials'))

  const slotRegistrations = []
  const tabRegistrations = []
  const ctx = {
    slots: {
      inject(_name, body) { body() },
      register(options, component) {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
    effect(body) {
      const disposer = body()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    sidebarRightTabs: {
      register(options) {
        tabRegistrations.push(options)
        return () => {}
      },
    },
    remote: {},
  }
  plugin.apply(ctx)

  const settings = slotRegistrations.find(entry => entry.options.name === 'settings.section')
  assert.equal(settings?.options.id, 'model-rotation')
  assert.equal(settings?.options.label, 'Model Rotation')

  const body = slotRegistrations.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  assert.equal(body?.options.key, '@local/dsh-model-rotation')
  const title = slotRegistrations.find(entry => entry.options.name === 'sidebar.right.pane.tab.title')
  assert.equal(title?.options.key, '@local/dsh-model-rotation')

  assert.equal(tabRegistrations.length, 1)
  assert.equal(tabRegistrations[0].kind, 'model-rotation')
  assert.equal(tabRegistrations[0].keepMounted, true)
  assert.equal(tabRegistrations[0].guide[0].id, '@local/dsh-model-rotation')
})

test('the exported validation and mapping helpers catch malformed pools', () => {
  const { validatePool, poolToSettings, deriveKeyRef, normalizePools } = loaded.factory(() => reactStub).__components

  const draft = {
    displayName: '',
    strategy: 'round-robin',
    cadence: 'request',
    failover: true,
    maxAttempts: '',
    cooldownMs: '60000',
    replay: 'auto',
    contextWindow: '',
    maxTokens: '',
    input: ['text'],
    members: [{
      name: 'a',
      baseURL: 'https://example.test/v1',
      api: 'openai-completions',
      model: 'm',
      apiKeyEnv: '',
      contextWindow: '',
      maxTokens: '',
      headersText: '',
    }],
  }
  assert.equal(validatePool('fast', draft), undefined)
  assert.match(validatePool('bad id', draft), /Pool\/model id/)
  assert.match(validatePool('fast', { ...draft, members: [] }), /at least one member/)
  assert.match(validatePool('fast', {
    ...draft,
    members: [{ ...draft.members[0], baseURL: 'ftp://x' }],
  }), /http\(s\) URL/)
  assert.match(validatePool('fast', {
    ...draft,
    members: [{ ...draft.members[0], headersText: '{oops' }],
  }), /valid JSON/)

  const built = poolToSettings('fast', draft)
  assert.equal(built.id, 'fast')
  assert.equal(built.value.members[0].name, 'a')
  assert.equal(built.value.cooldownMs, 60_000)
  assert.equal(built.value.displayName, undefined)
  assert.equal(deriveKeyRef('fast', 'a'), 'MODEL_ROTATION_FAST_A_API_KEY')

  const normalized = normalizePools({
    fast: { members: [{ name: 'a', baseURL: 'https://x.test', model: 'm' }] },
  })
  assert.equal(normalized.fast.members[0].api, 'openai-completions')
  assert.deepEqual(normalized.fast.input, ['text'])
})

test('the settings store keeps a draft across a remount and saves it with its key', async () => {
  const calls = { credentials: [], mutations: [], credentialReads: [] }
  let saved
  const operations = {
    async describeSettings() {
      return {
        ok: true,
        value: {
          namespaces: [{
            ns: 'model-rotation',
            revision: calls.mutations.length,
            value: { pools: saved === undefined ? {} : { fast: saved } },
            user: {},
          }],
        },
      }
    },
    async mutateSettings(ops, revision) {
      calls.mutations.push({ ops, revision })
      saved = ops[0].value
      return { ok: true, value: {} }
    },
    async describeCredentials(refs) { calls.credentialReads.push(refs); return { ok: true, value: {} } },
    async setCredential(ref, value) { calls.credentials.push({ ref, value }); return { ok: true } },
    async unsetCredential() { return { ok: true } },
  }
  const store = loaded.factory(() => reactStub).__components
    .createRotationSettingsStore(operations, 'model-rotation')

  await store.load()
  assert.equal(store.getSnapshot().status, 'ready')

  store.setNewId('fast')
  store.createPool()
  assert.equal(store.getSnapshot().selected, 'fast')
  store.updateMember('fast', 0, { baseURL: 'https://x.test/v1', model: 'model-a' })
  store.setKey('fast', 0, 'secret-value')

  // A remount reads the same store, so the draft survives.
  const beforeSave = store.getSnapshot()
  assert.equal(beforeSave.pools.fast.members[0].baseURL, 'https://x.test/v1')

  await store.savePool('fast')
  assert.equal(calls.credentials.length, 1)
  assert.equal(calls.credentials[0].ref, 'MODEL_ROTATION_FAST_PRIMARY_API_KEY')
  assert.equal(calls.credentials[0].value, 'secret-value')
  assert.equal(calls.mutations.length, 1)
  assert.deepEqual(calls.mutations[0].ops[0].path, ['pools', 'fast'])
  assert.equal(calls.mutations[0].ops[0].value.members[0].model, 'model-a')
  const afterSave = store.getSnapshot()
  assert.equal(afterSave.notice.includes('Saved pool'), true)
  assert.equal(afterSave.pools.fast.members[0].model, 'model-a')
})

test('compatibility, body overrides, temperature, and capture map through the form', () => {
  const { normalizePools, poolToSettings, validatePool } = loaded.factory(() => reactStub).__components
  const baseMember = {
    name: 'a',
    baseURL: 'https://example.test/v1',
    api: 'openai-completions',
    model: 'm',
    apiKeyEnv: '',
    contextWindow: '',
    maxTokens: '',
    headersText: '',
    temperature: '0.4',
    compat: { maxTokensField: 'max_tokens', supportsStore: 'false', supportsUsageInStreaming: '', supportsStrictMode: 'false' },
    bodySetText: '{"max_tokens": 1234}',
    bodyUnsetText: 'store, max_completion_tokens',
  }
  const draft = {
    displayName: '',
    strategy: 'round-robin',
    cadence: 'request',
    failover: true,
    maxAttempts: '',
    cooldownMs: '60000',
    replay: 'auto',
    contextWindow: '',
    maxTokens: '',
    input: ['text'],
    captureRequestBodies: true,
    members: [baseMember],
  }
  assert.equal(validatePool('fast', draft), undefined)
  const built = poolToSettings('fast', draft)
  assert.equal(built.value.captureRequestBodies, true)
  assert.equal(built.value.members[0].temperature, 0.4)
  assert.deepEqual(built.value.members[0].compat, {
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  })
  assert.deepEqual(built.value.members[0].body, {
    set: { max_tokens: 1234 },
    unset: ['store', 'max_completion_tokens'],
  })

  const normalized = normalizePools({
    fast: {
      captureRequestBodies: true,
      members: [{
        name: 'a',
        baseURL: 'https://example.test/v1',
        model: 'm',
        temperature: 0.2,
        compat: { maxTokensField: 'max_tokens' },
        body: { set: { max_tokens: 10 }, unset: ['store'] },
      }],
    },
  })
  assert.equal(normalized.fast.captureRequestBodies, true)
  assert.equal(normalized.fast.members[0].temperature, '0.2')
  assert.equal(normalized.fast.members[0].compat.maxTokensField, 'max_tokens')
  assert.match(normalized.fast.members[0].bodySetText, /max_tokens/)
  assert.equal(normalized.fast.members[0].bodyUnsetText, 'store')

  assert.match(validatePool('fast', { ...draft, members: [{ ...baseMember, temperature: '3' }] }), /temperature/)
  assert.match(validatePool('fast', { ...draft, members: [{ ...baseMember, bodySetText: '{oops' }] }), /valid JSON/)
  assert.match(validatePool('fast', { ...draft, members: [{ ...baseMember, compat: { ...baseMember.compat, maxTokensField: 'tokens' } }] }), /token field/)
})
