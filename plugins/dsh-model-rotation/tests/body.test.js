import assert from 'node:assert/strict'
import test from 'node:test'
import { applyBodyOverrides, hasBodyOverrides } from '../lib/body.js'

test('set adds or replaces fields without mutating the payload', () => {
  const payload = { model: 'm', max_completion_tokens: 64000, store: false }
  const next = applyBodyOverrides(payload, { set: { max_tokens: 64000, temperature: 0.7 } })
  assert.deepEqual(next, { model: 'm', max_completion_tokens: 64000, store: false, max_tokens: 64000, temperature: 0.7 })
  assert.equal(payload.max_tokens, undefined)
})

test('unset removes named fields and completes a rename', () => {
  const payload = { model: 'm', max_completion_tokens: 64000, store: false }
  const next = applyBodyOverrides(payload, {
    set: { max_tokens: 64000 },
    unset: ['max_completion_tokens', 'store'],
  })
  assert.deepEqual(next, { model: 'm', max_tokens: 64000 })
  assert.equal(payload.max_completion_tokens, 64000)
})

test('no overrides and non-object payloads pass through', () => {
  const payload = { a: 1 }
  assert.equal(applyBodyOverrides(payload, undefined), payload)
  assert.equal(applyBodyOverrides(payload, {}), payload)
  assert.equal(applyBodyOverrides('text', { set: { a: 1 } }), 'text')
  assert.equal(applyBodyOverrides(null, { set: { a: 1 } }), null)
})

test('hasBodyOverrides recognizes real work', () => {
  assert.equal(hasBodyOverrides(undefined), false)
  assert.equal(hasBodyOverrides({}), false)
  assert.equal(hasBodyOverrides({ set: {}, unset: [] }), false)
  assert.equal(hasBodyOverrides({ set: { a: 1 } }), true)
  assert.equal(hasBodyOverrides({ unset: ['a'] }), true)
})
