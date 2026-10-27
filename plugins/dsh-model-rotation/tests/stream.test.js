import assert from 'node:assert/strict'
import test from 'node:test'
import { isContentChunk, relayMemberStream } from '../lib/stream.js'

function iteratorOf(chunks, { throwAt, onReturn } = {}) {
  let index = 0
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (throwAt === index) throw new Error('inner boom')
      if (index >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[index++] }
    },
    async return() {
      onReturn?.()
      return { done: true, value: undefined }
    },
  }
}

async function collect(iterator, tracker = {}, options = {}) {
  const yielded = []
  for await (const chunk of relayMemberStream(iterator, tracker, options)) yielded.push(chunk)
  return { yielded, tracker }
}

const start = index => ({ type: 'block-start', index, blockType: 'text' })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const finish = kind => ({ type: 'finish', reason: { kind } })
const errorFinish = code => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: code } } })

test('usage and a buffered block-start do not commit', () => {
  assert.equal(isContentChunk({ type: 'usage', usage: {} }), false)
  assert.equal(isContentChunk(start(0)), false)
  assert.equal(isContentChunk(text(0, '')), false)
  assert.equal(isContentChunk(text(0, 'hi')), true)
  assert.equal(isContentChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: '' }), true)
  assert.equal(isContentChunk({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }), true)
})

test('a pre-content error is reported without yielding the buffered start', async () => {
  let returned = false
  const tracker = {}
  const { yielded } = await collect(
    iteratorOf([
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      start(0),
      errorFinish('RATE_LIMIT'),
    ], { onReturn: () => { returned = true } }),
    tracker,
  )
  assert.deepEqual(yielded.map(chunk => chunk.type), ['usage'])
  assert.equal(tracker.committed, false)
  assert.equal(tracker.failedFinish.reason.kind, 'error')
  assert.equal(tracker.failedFinish.reason.failure.code, 'RATE_LIMIT')
  assert.equal(tracker.finish, undefined)
  assert.equal(returned, true)
})

test('content commits and an error after it is yielded as terminal', async () => {
  const tracker = {}
  const { yielded } = await collect(iteratorOf([
    start(0),
    text(0, 'hello'),
    errorFinish('SERVER'),
  ]), tracker)
  assert.deepEqual(yielded.map(chunk => chunk.type), ['block-start', 'text-delta', 'finish'])
  assert.equal(tracker.committed, true)
  assert.equal(tracker.finish.reason.kind, 'error')
  assert.equal(tracker.failedFinish, undefined)
})

test('a successful finish is yielded and commits', async () => {
  const tracker = {}
  const { yielded } = await collect(iteratorOf([
    start(0),
    text(0, 'hi'),
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    finish('stop'),
  ]), tracker)
  assert.deepEqual(yielded.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(tracker.committed, true)
  assert.equal(tracker.finish.reason.kind, 'stop')
})

test('an empty text delta does not commit', async () => {
  const tracker = {}
  const { yielded } = await collect(iteratorOf([start(0), text(0, ''), errorFinish('TIMEOUT')]), tracker)
  assert.deepEqual(yielded.map(chunk => chunk.type), ['block-start', 'text-delta'])
  assert.equal(tracker.committed, false)
  assert.equal(tracker.failedFinish.reason.failure.code, 'TIMEOUT')
})

test('an inner throw is reported and the iterator is closed', async () => {
  let returned = false
  const tracker = {}
  const { yielded } = await collect(
    iteratorOf([start(0)], { throwAt: 1, onReturn: () => { returned = true } }),
    tracker,
  )
  assert.deepEqual(yielded, [])
  assert.equal(tracker.committed, false)
  assert.equal(tracker.thrown.message, 'inner boom')
  assert.equal(returned, true)
})

test('a consumer that stops early closes the inner iterator', async () => {
  let returned = false
  const iterator = iteratorOf([start(0), text(0, 'a'), text(0, 'b')], { onReturn: () => { returned = true } })
  for await (const _chunk of relayMemberStream(iterator, {})) {
    break
  }
  assert.equal(returned, true)
})

test('runNext wraps every inner next call', async () => {
  let calls = 0
  const tracker = {}
  const { yielded } = await collect(
    iteratorOf([text(0, 'a'), finish('stop')]),
    tracker,
    { runNext: fn => { calls += 1; return fn() } },
  )
  assert.ok(calls >= 2)
  assert.equal(tracker.committed, true)
  assert.ok(yielded.length > 0)
})
