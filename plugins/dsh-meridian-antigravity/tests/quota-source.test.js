/**
 * Offline tests for the pooled provider-status reader.
 *
 * The module imports only `./quota.js`, so this runs with plain `node --test`
 * and needs no module-resolution rig. `fetch` is stubbed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createQuotaSource } from '../lib/quota-source.js'

const PAYLOAD = {
  providers: [{
    id: 'antigravity',
    status: 'ok',
    activity: { requests: 3, errors: 0, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
    accounts: [{ id: 'Antigravity account', windows: [{ type: 'gemini', utilization: 0.5, resetsAt: 1 }] }],
  }],
}

/**
 * Build a source with a stubbed transport.
 * @param options - `refreshMs`, and how `fetch` should behave.
 * @returns the source plus the recorded calls.
 */
function sourceWith({ refreshMs = 0, payload = PAYLOAD, fails = false } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (fails) throw new Error('bridge is down')
    return { ok: true, status: 200, json: async () => payload }
  }
  const source = createQuotaSource({
    optionsOf: () => ({ baseURL: 'http://meridian.test', quotaRefreshMs: refreshMs }),
    resolveApiKey: async () => 'a-key',
    logger: undefined,
  })
  return { source, calls, restore: () => { globalThis.fetch = original } }
}

test('a read normalizes into a snapshot', async () => {
  const { source, calls, restore } = sourceWith()
  try {
    await source.requestRefresh('test')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /\/providers\/status$/)
    const snapshot = source.snapshot()
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.windows.length, 1)
    assert.equal(snapshot.activity.requests, 3)
  } finally { restore() }
})

test('concurrent triggers coalesce into one read', async () => {
  const { source, calls, restore } = sourceWith({ refreshMs: 0 })
  try {
    await Promise.all([source.requestRefresh('a'), source.requestRefresh('b'), source.requestRefresh('c')])
    assert.equal(calls.length, 1, 'three triggers in one tick must not become three reads')
  } finally { restore() }
})

test('the floor refuses a trigger a recent read already satisfied', async () => {
  // An hour, so the second trigger is inside the floor however fast the test runs.
  const { source, calls, restore } = sourceWith({ refreshMs: 3_600_000 })
  try {
    await source.requestRefresh('assistant-message')
    const refused = source.requestRefresh('interval')
    assert.equal(refused, undefined, 'the interval trigger should have been satisfied')
    assert.equal(calls.length, 1)
  } finally { restore() }
})

test('a zero floor accepts every sequential trigger', async () => {
  const { source, calls, restore } = sourceWith({ refreshMs: 0 })
  try {
    await source.requestRefresh('a')
    await source.requestRefresh('b')
    assert.equal(calls.length, 2)
  } finally { restore() }
})

test('a failed read becomes a snapshot the strip can explain, not a throw', async () => {
  const { source, restore } = sourceWith({ fails: true })
  try {
    await source.requestRefresh('test')
    const snapshot = source.snapshot()
    assert.equal(snapshot.status, 'error')
    assert.match(snapshot.error, /bridge is down/)
    assert.deepEqual(snapshot.windows, [])
  } finally { restore() }
})

test('a non-2xx response is reported rather than thrown', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  try {
    const source = createQuotaSource({
      optionsOf: () => ({ baseURL: 'http://meridian.test', quotaRefreshMs: 0 }),
      resolveApiKey: async () => 'a-key',
    })
    await source.requestRefresh('test')
    assert.equal(source.snapshot().status, 'error')
    assert.match(source.snapshot().error, /503/)
  } finally { globalThis.fetch = original }
})

test('a credential failure is reported like any other read failure', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => PAYLOAD } }
  try {
    const source = createQuotaSource({
      optionsOf: () => ({ baseURL: 'http://meridian.test', quotaRefreshMs: 0 }),
      resolveApiKey: async () => { throw new Error('no shared secret') },
    })
    await source.requestRefresh('test')
    assert.equal(source.snapshot().status, 'error')
    assert.match(source.snapshot().error, /no shared secret/)
    assert.equal(called, false, 'no request should be attempted without a credential')
  } finally { globalThis.fetch = original }
})

test('a disposed source stops accepting triggers', async () => {
  const { source, calls, restore } = sourceWith({ refreshMs: 0 })
  try {
    await source.requestRefresh('a')
    source.dispose()
    assert.equal(source.requestRefresh('b'), undefined)
    assert.equal(calls.length, 1)
  } finally { restore() }
})

test('the snapshot is undefined before the first read settles', () => {
  const { source, restore } = sourceWith()
  try {
    assert.equal(source.snapshot(), undefined)
  } finally { restore() }
})
