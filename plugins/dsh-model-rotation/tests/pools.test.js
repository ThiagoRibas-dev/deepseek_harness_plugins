import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveKeyRef, resolvePools } from '../lib/pools.js'

function member(name, overrides = {}) {
  return { name, baseURL: 'https://example.test/v1', model: `model-${name}`, ...overrides }
}

test('deriveKeyRef is stable and POSIX-shaped', () => {
  assert.equal(deriveKeyRef('fast', 'gateway-a'), 'MODEL_ROTATION_FAST_GATEWAY_A_API_KEY')
  assert.equal(deriveKeyRef('gemini-3.8-flash', 'a.b'), 'MODEL_ROTATION_GEMINI_3_8_FLASH_A_B_API_KEY')
  assert.match(deriveKeyRef('pool', 'm'), /^[A-Z_][A-Z0-9_]*$/)
  assert.ok(deriveKeyRef('pool', 'm'.repeat(300)).length <= 128)
})

test('resolvePools materializes members, capacities, and defaults', () => {
  const { pools, errors } = resolvePools({
    fast: {
      displayName: 'Fast pool',
      members: [
        member('a', { contextWindow: 100_000, maxTokens: 8_000 }),
        member('b', { contextWindow: 200_000, maxTokens: 16_000 }),
      ],
    },
  })
  assert.equal(errors.size, 0)
  const pool = pools.get('fast')
  assert.equal(pool.displayName, 'Fast pool')
  assert.equal(pool.members.length, 2)
  assert.equal(pool.members[0].key, 'mr.fast.a')
  assert.equal(pool.members[0].apiKeyEnv, 'MODEL_ROTATION_FAST_A_API_KEY')
  assert.equal(pool.contextWindow, 100_000)
  assert.equal(pool.maxTokens, 8_000)
  assert.equal(pool.strategy, 'round-robin')
  assert.equal(pool.cadence, 'request')
  assert.equal(pool.replay, 'auto')
  assert.equal(pool.cooldownMs, 60_000)
  assert.equal(pool.failover, true)
  assert.equal(pool.maxAttempts, 2)
  assert.deepEqual(pool.input, ['text'])
})

test('resolvePools honours explicit pool capacities and modalities', () => {
  const { pools } = resolvePools({
    smart: {
      members: [member('a', { contextWindow: 10_000 }), member('b', { contextWindow: 20_000 })],
      contextWindow: 40_000,
      maxTokens: 4_000,
      input: ['text', 'image', 'text'],
    },
  })
  const pool = pools.get('smart')
  assert.equal(pool.contextWindow, 40_000)
  assert.equal(pool.maxTokens, 4_000)
  assert.deepEqual(pool.input, ['text', 'image'])
})

test('an invalid member is dropped and named; a usable sibling still serves', () => {
  const { pools, errors } = resolvePools({
    fast: {
      members: [
        member('good'),
        { name: 'bad', baseURL: 'ftp://x', model: 'm' },
      ],
    },
  })
  const pool = pools.get('fast')
  assert.equal(pool.members.length, 1)
  assert.equal(pool.members[0].name, 'good')
  assert.match(pool.diagnostics.join('; '), /bad.*http\(s\) baseURL/)
  assert.equal(errors.size, 0)
})

test('a pool with no usable member is excluded with a diagnostic', () => {
  const { pools, errors } = resolvePools({
    empty: { members: [] },
    broken: { members: [{ name: 'x', model: 'm' }] },
  })
  assert.equal(pools.size, 0)
  assert.match(errors.get('empty'), /no members/)
  assert.match(errors.get('broken'), /http\(s\) baseURL/)
})

test('failover false collapses maxAttempts to one', () => {
  const { pools } = resolvePools({
    fast: { failover: false, maxAttempts: 5, members: [member('a'), member('b'), member('c')] },
  })
  assert.equal(pools.get('fast').maxAttempts, 1)
})

test('maxAttempts is capped by member count and the schema ceiling', () => {
  const { pools } = resolvePools({
    fast: { maxAttempts: 9, members: [member('a'), member('b')] },
  })
  assert.equal(pools.get('fast').maxAttempts, 2)
  const many = resolvePools({
    fast: { maxAttempts: 99, members: Array.from({ length: 20 }, (_, i) => member(`m${i}`)) },
  })
  assert.equal(many.pools.get('fast').maxAttempts, 16)
})

test('duplicate member names are refused and the duplicate is dropped', () => {
  const { pools } = resolvePools({
    fast: { members: [member('a'), member('a')] },
  })
  const pool = pools.get('fast')
  assert.equal(pool.members.length, 1)
  assert.match(pool.diagnostics.join('; '), /declared more than once/)
})

test('a non-object pool document is reported rather than thrown', () => {
  const { pools, errors } = resolvePools(['nope'])
  assert.equal(pools.size, 0)
  assert.match(errors.get('*'), /object keyed by model id/)
  assert.doesNotThrow(() => resolvePools(undefined))
  assert.doesNotThrow(() => resolvePools(null))
})

test('member temperature, compatibility switches, and body overrides resolve', () => {
  const { pools } = resolvePools({
    fast: {
      captureRequestBodies: true,
      members: [member('a', {
        temperature: 0.4,
        compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsStrictMode: false },
        body: { set: { max_tokens: 1234 }, unset: ['store', 'max_completion_tokens'] },
      })],
    },
  })
  const pool = pools.get('fast')
  assert.equal(pool.captureRequestBodies, true)
  const resolved = pool.members[0]
  assert.equal(resolved.temperature, 0.4)
  assert.deepEqual(resolved.compat, { maxTokensField: 'max_tokens', supportsStore: false, supportsStrictMode: false })
  assert.deepEqual(resolved.body, { set: { max_tokens: 1234 }, unset: ['store', 'max_completion_tokens'] })
})

test('unknown compatibility switches are dropped and bad values are diagnosed', () => {
  const { pools } = resolvePools({
    fast: {
      members: [member('a', {
        compat: { maxTokensField: 'max_tokens', chatTemplateKwargs: { a: 1 } },
      })],
    },
  })
  assert.equal(pools.get('fast').members[0].compat.chatTemplateKwargs, undefined)
  const bad = resolvePools({
    fast: { members: [member('a', { compat: { maxTokensField: 'tokens' } })] },
  })
  assert.match(bad.errors.get('fast'), /maxTokensField/)
  const badTemp = resolvePools({
    fast: { members: [member('a', { temperature: 3 })] },
  })
  assert.match(badTemp.errors.get('fast'), /temperature/)
  const badBody = resolvePools({
    fast: { members: [member('a', { body: { unset: [''] } })] },
  })
  assert.match(badBody.errors.get('fast'), /body.unset/)
})

test('captureRequestBodies defaults off', () => {
  const { pools } = resolvePools({ fast: { members: [member('a')] } })
  assert.equal(pools.get('fast').captureRequestBodies, false)
})
