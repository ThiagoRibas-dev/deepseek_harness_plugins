/**
 * Offline tests for the continuation diagnosis.
 *
 * The module under test imports nothing, so this runs with plain
 * `node --test tests/continuation.test.js` and needs no module-resolution rig.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  analyzeContinuation,
  continuationHint,
  isMeridianToolId,
} from '../lib/continuation.js'

/** An assistant turn that requested the given tool calls. */
const assistant = (provider, ids) => ({
  role: 'assistant',
  source: { kind: 'model', provider, model: `${provider}-model` },
  content: ids.map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })),
})

/** The result answering one tool call. */
const result = id => ({
  role: 'tool',
  toolCallId: id,
  source: { kind: 'tool', callId: id },
  content: [{ type: 'text', text: 'ok' }],
})

/** An ordinary user turn. */
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })

test('Meridian ids are recognised by their prefix', () => {
  assert.equal(isMeridianToolId('toolu_agy_0123456789abcdef'), true)
  assert.equal(isMeridianToolId('call_00_jGUOp5MK3LUnL8kmdn800589'), false)
  assert.equal(isMeridianToolId('toolu_cc_0123456789abcdef'), false)
  assert.equal(isMeridianToolId(''), false)
  assert.equal(isMeridianToolId(undefined), false)
})

test('a request that is not a continuation has nothing to diagnose', () => {
  assert.equal(analyzeContinuation([user('hello'), assistant('deepseek-official', [])]), undefined)
  assert.equal(analyzeContinuation([]), undefined)
  assert.equal(analyzeContinuation(undefined), undefined)
})

test('a Meridian-issued batch is not flagged', () => {
  const diagnosis = analyzeContinuation([
    user('go'),
    assistant('meridian-antigravity', ['toolu_agy_aaaa']),
    result('toolu_agy_aaaa'),
  ])
  assert.equal(diagnosis.results, 1)
  assert.deepEqual(diagnosis.foreign, [])
  assert.equal(continuationHint(diagnosis), undefined)
})

test('a batch issued by another provider is flagged with that provider', () => {
  // The exact shape of turn 34 in session-293cca94.
  const diagnosis = analyzeContinuation([
    user('that worked. take a look at the uncommitted changes'),
    assistant('deepseek-official', ['call_00_jGUOp5MK3LUnL8kmdn800589']),
    result('call_00_jGUOp5MK3LUnL8kmdn800589'),
  ])
  assert.equal(diagnosis.results, 1)
  assert.equal(diagnosis.foreign.length, 1)
  assert.equal(diagnosis.foreign[0].provider, 'deepseek-official')
  const hint = continuationHint(diagnosis)
  assert.match(hint, /issued by deepseek-official/)
  assert.match(hint, /call_00_jGUOp5MK3LUnL8kmdn800589/)
  assert.match(hint, /cannot recognise the batch/)
})

test('only the window Meridian examines is considered', () => {
  // A foreign batch from earlier history, with a completed Meridian turn after
  // it: Meridian looks only after the last assistant message, so this is clean.
  const diagnosis = analyzeContinuation([
    user('go'),
    assistant('deepseek-official', ['call_00_old']),
    result('call_00_old'),
    assistant('meridian-antigravity', []),
    user('next question'),
  ])
  assert.equal(diagnosis, undefined)
})

test('a foreign result inside the examined window is still flagged', () => {
  const diagnosis = analyzeContinuation([
    user('go'),
    assistant('deepseek-official', ['call_00_old']),
    result('call_00_old'),
    // The model changed, and the continuation of the older batch is what goes
    // out. Meridian examines everything after the last assistant message.
    result('call_00_other'),
  ])
  assert.equal(diagnosis.results, 2)
  assert.equal(diagnosis.foreign.length, 2)
})

test('mixed batches name every issuing provider once', () => {
  const diagnosis = analyzeContinuation([
    user('go'),
    assistant('deepseek-official', ['call_00_a']),
    assistant('antigravity', ['call_00_b']),
    result('call_00_a'),
    result('call_00_b'),
  ])
  assert.equal(diagnosis.foreign.length, 2)
  const hint = continuationHint(diagnosis)
  assert.match(hint, /deepseek-official, antigravity/)
})

test('an issuer that cannot be determined still produces a usable hint', () => {
  // The assistant message that made the call is outside the messages we hold.
  const diagnosis = analyzeContinuation([user('go'), result('call_00_orphan')])
  assert.equal(diagnosis.foreign.length, 1)
  assert.equal(diagnosis.foreign[0].provider, undefined)
  const hint = continuationHint(diagnosis)
  assert.match(hint, /issued by another provider/)
  assert.match(hint, /call_00_orphan/)
})

test('a long list of ids is summarised rather than dumped', () => {
  const ids = ['call_00_a', 'call_00_b', 'call_00_c', 'call_00_d']
  const diagnosis = analyzeContinuation([
    user('go'),
    assistant('deepseek-official', ids),
    ...ids.map(result),
  ])
  const hint = continuationHint(diagnosis)
  assert.match(hint, /\+2 more/)
  assert.doesNotMatch(hint, /call_00_c/)
})
