import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_LIMIT, createRouteRequest } from '../lib/route.js'

const TOKEN = 'test-token'

function makeLog(groups = []) {
  return {
    readSession(sessionId, { limit }) {
      return {
        groups: groups.slice(0, limit ?? DEFAULT_LIMIT),
        truncated: false,
        path: `/logs/${sessionId}.jsonl`,
        bytes: 42,
      }
    },
    listSessions() {
      return [{ sessionId: 's', bytes: 1, modified: 1 }]
    },
  }
}

function makeRoute(overrides = {}) {
  return createRouteRequest({
    log: makeLog(),
    engine: { snapshot: pools => [{ pool: 'fast', displayName: 'Fast', members: [...pools.keys()] }] },
    pools: () => new Map([['fast', {}]]),
    token: TOKEN,
    prefix: '/api/model-rotation',
    ...overrides,
  })
}

function request(pathname, { method = 'GET', query = '', headers = { authorization: `Bearer ${TOKEN}` } } = {}) {
  return { method, pathname, query: new URLSearchParams(query), headers }
}

test('a missing or wrong token is refused', () => {
  const route = makeRoute()
  assert.equal(route(request('/', { headers: {} })).status, 401)
  assert.equal(route(request('/', { headers: { authorization: 'Bearer nope' } })).status, 401)
  assert.equal(route(request('/', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200)
})

test('an empty configured token refuses every request', () => {
  const route = makeRoute({ token: '' })
  assert.equal(route(request('/', { headers: { authorization: 'Bearer ' } })).status, 503)
})

test('a query token is accepted', () => {
  const route = makeRoute()
  assert.equal(route(request('/', { headers: {}, query: `token=${TOKEN}` })).status, 200)
})

test('log requires a session id and answers grouped rows', () => {
  const route = makeRoute({
    log: makeLog([{ id: 'x', request: 1, outcome: 'ok' }]),
  })
  assert.equal(route(request('/log')).status, 400)
  const response = route(request('/log', { query: 'sessionId=session-1' }))
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body.toString('utf8'))
  assert.equal(payload.sessionId, 'session-1')
  assert.equal(payload.groups.length, 1)
  assert.equal(payload.path, '/logs/session-1.jsonl')
})

test('log answers a text rendering for a terminal', () => {
  const route = makeRoute({
    log: makeLog([{
      id: 'x', t: Date.UTC(2026, 0, 2, 3, 4, 5), request: 2, pool: 'fast', member: 'a',
      memberModel: 'm', outcome: 'ok', ms: 120, attempts: [],
    }]),
  })
  const response = route(request('/log', { query: 'sessionId=s&format=text' }))
  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /text\/plain/)
  const body = response.body.toString('utf8')
  assert.match(body, /session s — 1 request/)
  assert.match(body, /#2 fast → a \(m\) ok 120ms/)
})

test('health and sessions answer from the injected state', () => {
  const route = makeRoute()
  const health = route(request('/health'))
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body.toString('utf8')).pools[0].pool, 'fast')
  const sessions = route(request('/sessions'))
  assert.equal(sessions.status, 200)
  assert.equal(JSON.parse(sessions.body.toString('utf8')).sessions.length, 1)
})

test('unknown routes and unsupported methods are refused', () => {
  const route = makeRoute()
  assert.equal(route(request('/nope')).status, 404)
  assert.equal(route(request('/log', { method: 'POST', query: 'sessionId=s' })).status, 405)
})

test('a path that merely starts with the prefix is not served', () => {
  const route = makeRoute()
  assert.equal(route(request('/api/model-rotation-extra/log')).status, 404)
})

test('the service root names its endpoints', () => {
  const route = makeRoute()
  const payload = JSON.parse(route(request('/')).body.toString('utf8'))
  assert.equal(payload.service, 'model-rotation')
  assert.ok(payload.endpoints.some(endpoint => endpoint.startsWith('log')))
})
