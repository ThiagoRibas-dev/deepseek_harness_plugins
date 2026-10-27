import assert from 'node:assert/strict'
import test from 'node:test'
import { createRotationEngine, errorCools, errorWorthFailover } from '../lib/rotation.js'
import { resolvePools } from '../lib/pools.js'

function poolOf(members, overrides = {}) {
  const raw = { members }
  const { pools } = resolvePools({ p: { ...raw, ...overrides } })
  return pools.get('p')
}

function names(plan) {
  return plan.order.map(member => member.name)
}

function member(name) {
  return { name, baseURL: 'https://example.test/v1', model: `model-${name}` }
}

test('round-robin advances once per request', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b'), member('c')])
  assert.deepEqual(names(engine.plan({ pool, sessionId: 's1' })), ['a', 'b', 'c'])
  assert.deepEqual(names(engine.plan({ pool, sessionId: 's1' })), ['b', 'c', 'a'])
  assert.deepEqual(names(engine.plan({ pool, sessionId: 's1' })), ['c', 'a', 'b'])
})

test('fill-first keeps the declared order', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b')], { strategy: 'fill-first' })
  assert.deepEqual(names(engine.plan({ pool })), ['a', 'b'])
  assert.deepEqual(names(engine.plan({ pool })), ['a', 'b'])
})

test('least-recently-used prefers never-used members, then the oldest', () => {
  let clock = 1_000
  const engine = createRotationEngine({ now: () => clock })
  const pool = poolOf([member('a'), member('b'), member('c')], { strategy: 'least-recently-used' })
  const first = engine.plan({ pool })
  assert.deepEqual(names(first), ['a', 'b', 'c'])
  engine.begin({ pool, member: pool.members[0] })
  clock += 10
  const second = engine.plan({ pool })
  assert.deepEqual(names(second), ['b', 'c', 'a'])
})

test('per-turn cadence pins one member for the whole turn', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b'), member('c')], { cadence: 'turn' })
  const first = engine.plan({ pool, sessionId: 's1', turn: 1 })
  assert.equal(first.order[0].name, 'a')
  assert.equal(first.pinned, false)
  engine.begin({ pool, member: first.order[0] })
  const second = engine.plan({ pool, sessionId: 's1', turn: 1 })
  assert.equal(second.order[0].name, 'a')
  assert.equal(second.pinned, true)
  const nextTurn = engine.plan({ pool, sessionId: 's1', turn: 2 })
  assert.equal(nextTurn.order[0].name, 'b')
  assert.equal(nextTurn.pinned, false)
})

test('without a turn number the turn cadence stays sticky, not rotating', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b')], { cadence: 'turn' })
  assert.equal(engine.plan({ pool, sessionId: 's1' }).order[0].name, 'a')
  assert.equal(engine.plan({ pool, sessionId: 's1' }).order[0].name, 'a')
  assert.equal(engine.plan({ pool, sessionId: 's1' }).order[0].name, 'a')
})

test('failover walks the same fixed order within one request', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b'), member('c')])
  const plan = engine.plan({ pool, sessionId: 's1' })
  assert.deepEqual(names(plan), ['a', 'b', 'c'])
  // The next request starts after this plan's primary.
  assert.equal(engine.plan({ pool, sessionId: 's1' }).order[0].name, 'b')
})

test('a cooled member is tried after every healthy member', () => {
  let clock = 1_000
  const engine = createRotationEngine({ now: () => clock })
  const pool = poolOf([member('a'), member('b'), member('c')])
  engine.plan({ pool })
  engine.recordFailure({
    pool,
    member: pool.members[0],
    failure: { code: 'RATE_LIMIT', status: 429, message: 'slow down' },
  })
  const plan = engine.plan({ pool })
  // The cursor walks the *healthy* list, so after `a` drops out the order is
  // the rotated [b, c] with `a` appended as the last resort.
  assert.deepEqual(names(plan), ['c', 'b', 'a'])
  assert.equal(plan.coolingCount, 1)
  assert.equal(plan.allCooling, false)
  clock += 60_001
  const recovered = engine.plan({ pool })
  assert.equal(recovered.coolingCount, 0)
  assert.equal(recovered.allCooling, false)
  assert.ok(recovered.order.some(member => member.name === 'a'))
})

test('all members cooling still plans every member and marks it', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b')])
  engine.plan({ pool })
  for (const member of pool.members) {
    engine.recordFailure({ pool, member, failure: { code: 'SERVER', status: 500, message: 'down' } })
  }
  const plan = engine.plan({ pool })
  assert.equal(plan.allCooling, true)
  assert.equal(plan.order.length, 2)
})

test('success clears failures and cooldown', () => {
  let clock = 1_000
  const engine = createRotationEngine({ now: () => clock })
  const pool = poolOf([member('a')])
  engine.recordFailure({ pool, member: pool.members[0], failure: { code: 'RATE_LIMIT', message: 'x' } })
  let health = engine.snapshot(new Map([[pool.key, pool]]))[0]
  assert.equal(health.members[0].cooling, true)
  assert.equal(health.members[0].failures, 1)
  engine.recordSuccess({ pool, member: pool.members[0] })
  health = engine.snapshot(new Map([[pool.key, pool]]))[0]
  assert.equal(health.members[0].cooling, false)
  assert.equal(health.members[0].failures, 0)
})

test('cooldown classification separates endpoint health from request shape', () => {
  assert.equal(errorCools({ code: 'RATE_LIMIT', status: 429 }), true)
  assert.equal(errorCools({ code: 'SERVER', status: 500 }), true)
  assert.equal(errorCools({ code: 'TIMEOUT' }), true)
  assert.equal(errorCools({ code: 'UNKNOWN', status: 503 }), true)
  assert.equal(errorCools({ code: 'INVALID_REQUEST', status: 400 }), false)
  assert.equal(errorCools({ code: 'UNSUPPORTED_CONTENT' }), false)
  assert.equal(errorWorthFailover({ code: 'ABORTED' }), false)
  assert.equal(errorWorthFailover({ code: 'INVALID_REQUEST' }), true)
})

test('forgetSession drops the turn pin', () => {
  const engine = createRotationEngine({ now: () => 1_000 })
  const pool = poolOf([member('a'), member('b')], { cadence: 'turn' })
  engine.plan({ pool, sessionId: 's1', turn: 1 })
  assert.equal(engine.plan({ pool, sessionId: 's1', turn: 1 }).pinned, true)
  engine.forgetSession('s1')
  assert.equal(engine.plan({ pool, sessionId: 's1', turn: 1 }).pinned, false)
})
