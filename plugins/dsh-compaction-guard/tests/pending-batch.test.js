import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isMidTurn,
  resolvePruneGuard,
  routedProvider,
  shouldDeferPrune,
} from '../lib/pending-batch.js'

/**
 * Fake session carrying only what the guards read.
 * @param options - routed provider and surface seqs.
 * @returns a session-shaped object.
 */
function session({ provider, nodes = [1, 2, 3] } = {}) {
  return {
    surface: { nodes },
    requestHeader: () => (provider === undefined ? undefined : { config: { provider, model: 'm' } }),
  }
}

/** Pairing stub with fixed cuts. */
const pairing = (before, after) => ({
  balancedBefore: () => before,
  balancedAfter: () => after,
})

const alwaysBalanced = pairing(true, true)
const resultTail = pairing(false, true) // surface ends with a tool result
const callTail = pairing(true, false) // surface ends with an unanswered tool call

test('routedProvider reads the durable routed config', () => {
  assert.equal(routedProvider(session({ provider: 'meridian-antigravity' })), 'meridian-antigravity')
  assert.equal(routedProvider(session({})), undefined)
  assert.equal(routedProvider({ requestHeader: () => ({ config: { provider: '' } }) }), undefined)
  assert.equal(routedProvider(undefined), undefined)
})

test('a completed assistant turn is not mid-turn', () => {
  assert.equal(isMidTurn(session(), alwaysBalanced), false)
})

test('a surface ending in a tool result is mid-turn', () => {
  assert.equal(isMidTurn(session(), resultTail), true)
})

test('a surface ending in an unanswered tool call is mid-turn', () => {
  assert.equal(isMidTurn(session(), callTail), true)
})

test('an unreadable pairing state defers rather than assuming safety', () => {
  const throwing = {
    balancedBefore: () => { throw new Error('seq not found') },
    balancedAfter: () => true,
  }
  assert.equal(isMidTurn(session(), throwing), true)
})

test('an empty surface is never mid-turn', () => {
  assert.equal(isMidTurn(session({ nodes: [] }), resultTail), false)
  assert.equal(isMidTurn({ surface: {} }, resultTail), false)
  assert.equal(isMidTurn(undefined, resultTail), false)
})

test('the guard defers only for a configured contract provider', () => {
  const guard = resolvePruneGuard({})
  assert.equal(shouldDeferPrune(session({ provider: 'meridian-antigravity' }), guard, resultTail), true)
  assert.equal(shouldDeferPrune(session({ provider: 'meridian-antigravity' }), guard, alwaysBalanced), false)
  // A non-contract provider keeps the shipped behaviour in every position.
  assert.equal(shouldDeferPrune(session({ provider: 'deepseek-official' }), guard, resultTail), false)
  assert.equal(shouldDeferPrune(session({ provider: 'deepseek-official' }), guard, callTail), false)
  // No routed provider means no evidence of a contract.
  assert.equal(shouldDeferPrune(session({}), guard, resultTail), false)
})

test('deferral can be disabled outright', () => {
  const guard = resolvePruneGuard({ deferWhenBatchPending: false })
  assert.equal(shouldDeferPrune(session({ provider: 'meridian-antigravity' }), guard, resultTail), false)
})

test('contractProviders is configurable and replaces the default', () => {
  const guard = resolvePruneGuard({ contractProviders: ['custom-route'] })
  assert.deepEqual([...guard.contractProviders], ['custom-route'])
  assert.equal(shouldDeferPrune(session({ provider: 'meridian-antigravity' }), guard, resultTail), false)
  assert.equal(shouldDeferPrune(session({ provider: 'custom-route' }), guard, resultTail), true)
})

test('resolvePruneGuard defaults deferral on and repairs malformed input', () => {
  assert.equal(resolvePruneGuard({}).deferWhenBatchPending, true)
  assert.deepEqual([...resolvePruneGuard({}).contractProviders], ['meridian-antigravity'])
  const repaired = resolvePruneGuard({ deferWhenBatchPending: 'yes', contractProviders: ['', 7, 'ok'] })
  assert.equal(repaired.deferWhenBatchPending, false)
  assert.deepEqual([...repaired.contractProviders], ['ok'])
})
