/**
 * Offline tests for quota detection, reset parsing, and status normalization.
 *
 * The module under test imports nothing, so this runs with plain
 * `node --test tests/quota.test.js` and needs no module-resolution rig.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  QUOTA_FAILURE_CODE,
  describeProviderError,
  isQuotaMessage,
  normalizeProviderStatus,
  parseResetWindow,
  quotaFailure,
  quotaSurfaceEnabled,
} from '../lib/quota.js'

/** The exact text relayed by Meridian in session-293cca94. */
const INCIDENT = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h43m43s.'

test('the incident message is recognised as a quota failure', () => {
  assert.equal(isQuotaMessage(INCIDENT), true)
  const failure = quotaFailure(INCIDENT)
  assert.equal(failure.code, QUOTA_FAILURE_CODE)
  // 2h43m43s = 9_823 seconds.
  assert.equal(failure.retryAfterMs, 9_823_000)
})

test('a quota word alone, or an exhausted word alone, is not enough', () => {
  assert.equal(isQuotaMessage('Your quota is 40% used.'), false)
  assert.equal(isQuotaMessage('Rate limit reached. Try again later.'), false)
  assert.equal(isQuotaMessage(''), false)
  assert.equal(isQuotaMessage(undefined), false)
  assert.equal(isQuotaMessage(42), false)
})

test('an exhausted word with a quota word is enough', () => {
  for (const text of [
    'Your usage limit has been reached.',
    'Allowance exceeded for this account.',
    'No remaining credits for this model.',
    'Subscription quota depleted.',
  ]) {
    assert.equal(isQuotaMessage(text), true, text)
  }
})

test('the reset window parses in every unit combination the CLI uses', () => {
  assert.equal(parseResetWindow('Resets in 2h43m43s.'), 9_823_000)
  assert.equal(parseResetWindow('Resets in 43m43s'), 2_623_000)
  assert.equal(parseResetWindow('Resets in 30s'), 30_000)
  assert.equal(parseResetWindow('Resets in 1h'), 3_600_000)
  assert.equal(parseResetWindow('resets in 2h 43m'), 9_780_000)
})

test('an absent or unusable window is undefined, never zero', () => {
  // "Unknown" and "usable now" are different answers, and only one is safe.
  assert.equal(parseResetWindow('quota reached'), undefined)
  assert.equal(parseResetWindow('Resets in 0s'), undefined)
  assert.equal(parseResetWindow('Resets in soon'), undefined)
  assert.equal(parseResetWindow(undefined), undefined)
})

test('a rate-limit message is not classified as quota', () => {
  assert.equal(quotaFailure('Too many requests; retry shortly.'), undefined)
})

test('the live unavailable payload normalizes with its error intact', () => {
  // Captured from the running service, where Meridian's own schema rejects the
  // agy usage report. This is the state the strip has to render well.
  const payload = {
    providers: [
      { id: 'claude', enabled: false, status: 'disabled', accounts: [] },
      {
        id: 'antigravity',
        enabled: true,
        status: 'unavailable',
        error: '[{"code":"invalid_type","path":["command","data","groups",1,"buckets",1,"reset_time"]}]',
        activity: { requests: 61, errors: 3, inputTokens: 581_892, outputTokens: 31_692, cacheReadTokens: 1_960_462 },
        accounts: [{ id: 'Antigravity account', error: 'same', windows: [] }],
      },
    ],
  }
  const snapshot = normalizeProviderStatus(payload, { now: 1 })
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.windows.length, 0)
  assert.match(snapshot.error, /invalid_type/)
  assert.equal(snapshot.activity.requests, 61)
  assert.equal(snapshot.fetchedAt, 1)
})

test('a healthy payload normalizes to windows and ready', () => {
  const payload = {
    providers: [{
      id: 'antigravity',
      status: 'ok',
      accounts: [{
        id: 'Antigravity account',
        windows: [
          { type: 'gemini', utilization: 0.82, resetsAt: 1_700_000_000_000 },
          { type: 'claude', utilization: 1.4, resetsAt: 1_700_000_000_000 },
        ],
      }],
    }],
  }
  const snapshot = normalizeProviderStatus(payload)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.windows.length, 2)
  assert.deepEqual(snapshot.windows[0], {
    account: 'Antigravity account',
    type: 'gemini',
    utilization: 0.82,
    resetsAt: 1_700_000_000_000,
  })
  // Clamped, because a provider should not be able to make the strip overfill.
  assert.equal(snapshot.windows[1].utilization, 1)
})

test('a window without a usable utilization is dropped rather than shown as zero', () => {
  const payload = {
    providers: [{ id: 'antigravity', accounts: [{ windows: [{ type: 'gemini' }, { type: 'claude', utilization: 0.1 }] }] }],
  }
  const snapshot = normalizeProviderStatus(payload)
  assert.equal(snapshot.windows.length, 1)
  assert.equal(snapshot.windows[0].type, 'claude')
})

test('a response without the provider says so instead of reporting empty quota', () => {
  assert.equal(normalizeProviderStatus({ providers: [] }).status, 'unavailable')
  assert.match(normalizeProviderStatus({ providers: [] }).error, /did not include/)
  assert.equal(normalizeProviderStatus({ providers: [{ id: 'claude' }] }).status, 'missing')
  assert.equal(normalizeProviderStatus(undefined).status, 'unavailable')
})

// ---- making the provider's own error readable ------------------------------

/** The error Meridian returns for this account, verbatim from /providers/status. */
const SCHEMA_REJECTION = '[\n  {\n    "expected": "string",\n    "code": "invalid_type",\n'
  + '    "path": [\n      "command",\n      "data",\n      "groups",\n      1,\n      "buckets",\n'
  + '      1,\n      "reset_time"\n    ],\n    "message": "Invalid input: expected string, received undefined"\n  }\n]'

test('a schema rejection names the field and the mismatch', () => {
  // It used to reach the strip raw, so the composer showed `Quota unavailable — [`
  // and an indented blob. The array is structured; say what it says.
  const described = describeProviderError(SCHEMA_REJECTION)
  assert.match(described, /command\.data\.groups\[1\]\.buckets\[1\]\.reset_time/)
  assert.match(described, /expected string, received undefined/)
  assert.doesNotMatch(described, /\n/)
  assert.ok(described.length < 400)
})

test('several issues are listed together', () => {
  const described = describeProviderError(JSON.stringify([
    { code: 'invalid_type', path: ['a', 0], message: 'expected string, received undefined' },
    { code: 'too_small', path: ['b'], message: 'expected number >= 0' },
  ]))
  assert.match(described, /a\[0\] — expected string/)
  assert.match(described, /b — expected number >= 0/)
  assert.match(described, /; /)
})

test('an issue with no path, or no message, still reads', () => {
  assert.match(describeProviderError(JSON.stringify([{ code: 'custom', message: 'the report was empty' }])), /the report was empty/u)
  assert.match(describeProviderError(JSON.stringify([{ code: 'invalid_type', path: ['x'] }])), /x — invalid_type/u)
})

test('anything that is not a schema array is passed through', () => {
  // Transport failures must read exactly as they did before.
  assert.equal(describeProviderError('HTTP 500'), 'HTTP 500')
  assert.equal(describeProviderError('  [not json'), '[not json')
  assert.equal(describeProviderError('[]'), '[]')
  assert.equal(describeProviderError('[1,2,3]'), '[1,2,3]')
  assert.equal(describeProviderError(''), '')
  assert.equal(describeProviderError(undefined), undefined)
})

test('a rejection reaches the snapshot readable, not raw', () => {
  const snapshot = normalizeProviderStatus({
    providers: [{ id: 'antigravity', status: 'unavailable', error: SCHEMA_REJECTION }],
  })
  assert.equal(snapshot.status, 'unavailable')
  assert.match(snapshot.error, /^the usage report did not match the shape Meridian expects: command\./u)
})

// ---- the one switch --------------------------------------------------------

test('only an explicit false turns the surface off', () => {
  // Anything unset keeps the previous behaviour, so an older config does not
  // silently lose the surface.
  assert.equal(quotaSurfaceEnabled({ quotaEnabled: false }), false)
  assert.equal(quotaSurfaceEnabled({ quotaEnabled: true }), true)
  assert.equal(quotaSurfaceEnabled({}), true)
  assert.equal(quotaSurfaceEnabled(undefined), true)
  // A falsy non-boolean is not a deliberate disable.
  assert.equal(quotaSurfaceEnabled({ quotaEnabled: 0 }), true)
  assert.equal(quotaSurfaceEnabled({ quotaEnabled: '' }), true)
})
