import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  checkpointState, recordAttempt, resolveConfig, shouldRefresh,
} from '../policy.js'

const checkpoint = seq => ({ seq, data: { type: 'user/message', source: { kind: 'compact-checkpoint' } } })
const player = seq => ({ seq, data: { type: 'user/message', source: { kind: 'user' } } })
const assistant = seq => ({ seq, data: { type: 'assistant/message', source: { kind: 'model' } } })
const settings = resolveConfig({})

test('defaults are conservative', () => {
  assert.equal(settings.enabled, true)
  assert.equal(settings.refreshAfterMessages, 40)
  assert.equal(settings.cooldownMs, 300_000)
  assert.equal(settings.maxRefreshes, 3)
})

test('a bad config falls back instead of throwing', () => {
  const resolved = resolveConfig({ refreshAfterMessages: -1, cooldownMs: 'soon', maxRefreshes: 1.5 })
  assert.equal(resolved.refreshAfterMessages, 40)
  assert.equal(resolved.cooldownMs, 300_000)
  assert.equal(resolved.maxRefreshes, 3)
})

test('no checkpoint means nothing to refresh', () => {
  assert.equal(checkpointState([player(1), assistant(2)]), undefined)
  assert.equal(shouldRefresh(undefined, settings, undefined, 0), false)
})

test('the newest checkpoint anchors the measurement', () => {
  const nodes = [checkpoint(1), player(2), player(3), checkpoint(4), player(5), player(6)]
  assert.deepEqual(checkpointState(nodes), { checkpointSeq: 4, since: 2 })
})

test('a stale checkpoint is owed a refresh, a fresh one is not', () => {
  const stale = checkpointState([checkpoint(1), ...Array.from({ length: 40 }, (_, i) => player(i + 2))])
  assert.equal(stale.since, 40)
  assert.equal(shouldRefresh(stale, settings, undefined, 0), true)
  const fresh = checkpointState([checkpoint(1), player(2)])
  assert.equal(shouldRefresh(fresh, settings, undefined, 0), false)
})

test('one attempt per checkpoint, a cooldown between attempts, and a cap', () => {
  const state = checkpointState([checkpoint(9), ...Array.from({ length: 50 }, (_, i) => player(i + 10))])
  const once = recordAttempt(undefined, state, 1_000)
  assert.equal(shouldRefresh(state, settings, once, 2_000), false, 'same checkpoint: done')
  const newer = checkpointState([checkpoint(99), ...Array.from({ length: 50 }, (_, i) => player(i + 100))])
  assert.equal(shouldRefresh(newer, settings, once, 2_000), false, 'cooldown still running')
  assert.equal(shouldRefresh(newer, settings, once, 1_000 + 300_000), true, 'cooldown elapsed')
  const capped = { ...once, attempts: settings.maxRefreshes }
  assert.equal(shouldRefresh(newer, settings, capped, 1_000 + 300_000), false, 'cap reached')
})

test('disabled is inert', () => {
  const state = checkpointState([checkpoint(1), ...Array.from({ length: 50 }, (_, i) => player(i + 2))])
  assert.equal(shouldRefresh(state, resolveConfig({ enabled: false }), undefined, 0), false)
})
