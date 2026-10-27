import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLogStore, groupRows, redactSecrets, sanitizeSessionId } from '../lib/log.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'model-rotation-log-'))
}

test('sanitizeSessionId cannot escape the log directory', () => {
  const hostile = sanitizeSessionId('../../etc/passwd')
  assert.equal(hostile.includes('/'), false)
  assert.equal(hostile.includes('\\'), false)
  assert.ok(hostile.length <= 160)
  assert.equal(sanitizeSessionId(''), 'no-session')
  assert.equal(sanitizeSessionId(undefined), 'no-session')
  assert.equal(sanitizeSessionId('session-abc_123'), 'session-abc_123')
})

test('redactSecrets removes known values and caps the message', () => {
  assert.equal(redactSecrets('key=abc123 failed', ['abc123']), 'key=[redacted] failed')
  assert.equal(redactSecrets('short', ['abc']), 'short')
  const long = redactSecrets('x'.repeat(5_000), [])
  assert.ok(long.length < 2_100)
  assert.match(long, /truncated/)
})

test('a request groups into one row with its failed attempts', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir, now: () => 1_000 })
    const id = log.begin({
      sessionId: 'session-1',
      request: 7,
      pool: 'fast',
      model: 'fast',
      turn: 3,
      step: 1,
      member: 'a',
      memberModel: 'model-a',
      cadence: 'request',
      strategy: 'round-robin',
    })
    log.failover(id, {
      sessionId: 'session-1',
      member: 'a',
      memberModel: 'model-a',
      next: 'b',
      nextModel: 'model-b',
      code: 'RATE_LIMIT',
      status: 429,
      message: 'slow down',
      ms: 120,
    })
    log.finish(id, {
      sessionId: 'session-1',
      ok: true,
      committed: true,
      member: 'b',
      memberModel: 'model-b',
      ms: 500,
    })
    const read = log.readSession('session-1')
    assert.equal(read.groups.length, 1)
    const group = read.groups[0]
    assert.equal(group.request, 7)
    assert.equal(group.pool, 'fast')
    assert.equal(group.member, 'b')
    assert.equal(group.memberModel, 'model-b')
    assert.equal(group.outcome, 'ok')
    assert.equal(group.committed, true)
    assert.equal(group.ms, 500)
    assert.equal(group.attempts.length, 1)
    assert.equal(group.attempts[0].code, 'RATE_LIMIT')
    assert.equal(group.attempts[0].status, 429)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a start without an end is pending', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    const { groups } = log.readSession('s')
    assert.equal(groups[0].outcome, 'pending')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed finish adds the terminal attempt and marks the error', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.finish(id, {
      sessionId: 's',
      ok: false,
      member: 'a',
      memberModel: 'm',
      code: 'AUTH',
      status: 401,
      message: 'bad key',
      ms: 30,
      committed: false,
    })
    const group = log.readSession('s').groups[0]
    assert.equal(group.outcome, 'error')
    assert.equal(group.code, 'AUTH')
    assert.equal(group.attempts.length, 1)
    assert.equal(group.committed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSession keeps the newest groups and reports truncation', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    for (let index = 1; index <= 5; index += 1) {
      const id = log.begin({ sessionId: 's', request: index, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
      log.finish(id, { sessionId: 's', ok: true, member: 'a', memberModel: 'm', ms: index })
    }
    const { groups, truncated } = log.readSession('s', { limit: 2 })
    assert.equal(truncated, true)
    assert.deepEqual(groups.map(group => group.request), [4, 5])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a torn trailing line is skipped without failing the read', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.finish(id, { sessionId: 's', ok: true, member: 'a', memberModel: 'm', ms: 5 })
    appendFileSync(log.pathFor('s'), '{"k":"end","id":', 'utf8')
    const { groups } = log.readSession('s')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].outcome, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the file is trimmed once it exceeds the configured size', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir, maxBytes: 800, keepBytes: 400 })
    for (let index = 1; index <= 30; index += 1) {
      const id = log.begin({ sessionId: 's', request: index, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
      log.finish(id, { sessionId: 's', ok: true, member: 'a', memberModel: 'm', ms: index })
    }
    const path = log.pathFor('s')
    assert.ok(statSync(path).size < 1_600, `size ${statSync(path).size}`)
    const { groups } = log.readSession('s')
    assert.ok(groups.length > 0)
    assert.equal(groups[groups.length - 1].request, 30)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listSessions reports files newest first', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 'alpha', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.finish(id, { sessionId: 'alpha', ok: true, member: 'a', memberModel: 'm', ms: 1 })
    log.begin({ sessionId: 'beta', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    const sessions = log.listSessions()
    assert.deepEqual(sessions.map(row => row.sessionId).sort(), ['alpha', 'beta'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groupRows tolerates unknown rows and missing ids', () => {
  const { groups } = groupRows([
    null,
    { k: 'start' },
    { k: 'start', id: 'x', request: 1, pool: 'p' },
    { k: 'nonsense', id: 'x' },
    { k: 'end', id: 'x', ok: true, ms: 2 },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].outcome, 'ok')
})

test('a written log never contains a supplied secret', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.failover(id, {
      sessionId: 's',
      member: 'a',
      memberModel: 'm',
      next: 'b',
      nextModel: 'm2',
      code: 'AUTH',
      message: 'Authorization: Bearer supersecretvalue',
      secrets: ['supersecretvalue'],
      ms: 1,
    })
    const raw = readFileSync(log.pathFor('s'), 'utf8')
    assert.equal(raw.includes('supersecretvalue'), false)
    assert.match(raw, /\[redacted\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a captured body is grouped with its request and capped', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.body(id, { sessionId: 's', body: { model: 'm', store: false, max_tokens: 10 } })
    log.finish(id, { sessionId: 's', ok: true, member: 'a', memberModel: 'm', ms: 3 })
    const group = log.readSession('s').groups[0]
    assert.equal(group.outcome, 'ok')
    assert.deepEqual(JSON.parse(group.requestBody), { model: 'm', store: false, max_tokens: 10 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a very large captured body is truncated', () => {
  const dir = tempDir()
  try {
    const log = createLogStore({ dir })
    const id = log.begin({ sessionId: 's', request: 1, pool: 'p', model: 'p', member: 'a', memberModel: 'm' })
    log.body(id, { sessionId: 's', body: { text: 'x'.repeat(40_000) } })
    const group = log.readSession('s').groups[0]
    assert.ok(group.requestBody.length <= 32_100)
    assert.match(group.requestBody, /truncated/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
