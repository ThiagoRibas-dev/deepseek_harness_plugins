/**
 * Offline tests for the quota route dispatcher.
 *
 * Imports only `node:crypto`, so this runs with plain `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { QUOTA_TOKEN_HEADER, routeQuotaRequest } from '../lib/quota-route.js'

const TOKEN = 'a-test-token'

/**
 * A stub reader that records refreshes.
 * @param snapshot - what `snapshot()` returns.
 * @returns the stub and its recorded triggers.
 */
function reader(snapshot) {
  const refreshes = []
  return {
    refreshes,
    quota: { snapshot: () => snapshot, requestRefresh: reason => refreshes.push(reason) },
  }
}

/**
 * @param overrides - request fields to override.
 * @returns a normalised GET request.
 */
function request(overrides = {}) {
  return {
    method: 'GET',
    pathname: '/dsh-meridian/quota',
    query: new URLSearchParams(),
    headers: { [QUOTA_TOKEN_HEADER]: TOKEN },
    ...overrides,
  }
}

test('a request with the token is answered from the cached snapshot', () => {
  const snapshot = { status: 'ready', windows: [{ type: 'gemini', utilization: 0.5 }], fetchedAt: 1 }
  const { quota, refreshes } = reader(snapshot)
  const result = routeQuotaRequest(request(), { quota, token: TOKEN })
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(result.body), snapshot)
  // The read is gated, so a poll is a nudge rather than a fetch.
  assert.deepEqual(refreshes, ['route'])
})

test('the route is closed without a token', () => {
  const { quota, refreshes } = reader({ status: 'ready', windows: [] })
  // Named routes bypass the harness's own authentication, so this is the only
  // thing standing between the LAN and the account's usage.
  assert.equal(routeQuotaRequest(request({ headers: {} }), { quota, token: TOKEN }).status, 403)
  assert.equal(routeQuotaRequest(request({ headers: { [QUOTA_TOKEN_HEADER]: 'wrong' } }), { quota, token: TOKEN }).status, 403)
  assert.equal(routeQuotaRequest(request({ headers: { [QUOTA_TOKEN_HEADER]: 'a-test-token-longer' } }), { quota, token: TOKEN }).status, 403)
  assert.equal(routeQuotaRequest(request({ headers: {} }), { quota, token: '' }).status, 403)
  assert.deepEqual(refreshes, [], 'a refused request must not trigger a read')
})

test('the token may also arrive as a query parameter', () => {
  const { quota } = reader({ status: 'ready', windows: [] })
  const result = routeQuotaRequest(
    request({ headers: {}, query: new URLSearchParams({ token: TOKEN }) }),
    { quota, token: TOKEN },
  )
  assert.equal(result.status, 200)
})

test('only GET is accepted', () => {
  const { quota } = reader({ status: 'ready', windows: [] })
  const result = routeQuotaRequest(request({ method: 'POST' }), { quota, token: TOKEN })
  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'GET')
})

test('a snapshot that has not settled yet answers with loading rather than an error', () => {
  const { quota } = reader(undefined)
  const result = routeQuotaRequest(request(), { quota, token: TOKEN })
  assert.equal(result.status, 200)
  assert.equal(JSON.parse(result.body).status, 'loading')
})

test('every answer is marked no-store', () => {
  const { quota } = reader({ status: 'ready', windows: [] })
  for (const result of [
    routeQuotaRequest(request(), { quota, token: TOKEN }),
    routeQuotaRequest(request({ headers: {} }), { quota, token: TOKEN }),
    routeQuotaRequest(request({ method: 'POST' }), { quota, token: TOKEN }),
  ]) {
    assert.equal(result.headers['cache-control'], 'no-store')
  }
})
