/**
 * Regression test for notice filtering across a tool continuation.
 *
 * Meridian requires each continuation's prefix to hash to the message list it
 * delivered. Dropping a superseded runtime-context snapshot rewrites that
 * prefix, so it may only happen on the request that starts a turn. This test
 * pins both halves: the turn-start request still filters, and a continuation
 * does not.
 *
 * Needs the module-resolution rig `tests/run.sh` builds.
 */

import assert from 'node:assert/strict'

const { serializeRequest } = await import('../lib/serialize.js')
const { resolveOptions } = await import('../lib/config.js')

const connection = resolveOptions({ baseURL: 'http://127.0.0.1:9' }, {})

const snapshot = text => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context' } })
const player = text => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = calls => ({
  role: 'assistant',
  source: { kind: 'model', provider: 'meridian-antigravity', model: 'claude-sonnet-5-5-medium' },
  content: calls.map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })),
})
const result = id => ({
  role: 'tool',
  toolCallId: id,
  source: { kind: 'tool', callId: id },
  content: [{ type: 'text', text: 'ok' }],
})

/** Serialize and return the wire messages. */
function wire(messages) {
  return serializeRequest({
    options: { model: 'claude-sonnet-5-5-medium', messages },
    connection,
    images: undefined,
    imageAccess: undefined,
    warn: () => {},
    sessionKey: 'session-notices',
  }).body.messages
}

/** Every text block on the wire, flattened. */
function texts(messages) {
  return messages.flatMap(m => (m.content ?? []).map(b => b.text ?? '')).join('\n')
}

// Turn start: only the newest snapshot is sent, as before.
const start = texts(wire([
  snapshot('OLD SNAPSHOT'),
  player('hello'),
  assistant([]),
  snapshot('NEW SNAPSHOT'),
]))
assert.doesNotMatch(start, /OLD SNAPSHOT/, 'a turn start should still drop the superseded snapshot')
assert.match(start, /NEW SNAPSHOT/)

// Continuation, with a snapshot injected after the tool results. The prefix must
// be byte-identical to what Meridian was delivered, so the old snapshot stays.
const continuation = texts(wire([
  snapshot('OLD SNAPSHOT'),
  player('hello'),
  assistant(['toolu_agy_aaaa']),
  result('toolu_agy_aaaa'),
  snapshot('NEW SNAPSHOT'),
]))
assert.match(continuation, /OLD SNAPSHOT/, 'a continuation must not rewrite the delivered prefix')
assert.match(continuation, /NEW SNAPSHOT/, 'the fresh snapshot still rides along after the tool results')

// Order matters: the fresh snapshot must come after the tool result, not before.
const messages = wire([
  snapshot('OLD SNAPSHOT'),
  player('hello'),
  assistant(['toolu_agy_aaaa']),
  result('toolu_agy_aaaa'),
  snapshot('NEW SNAPSHOT'),
])
const order = messages.map(m => (m.content ?? []).map(b => b.text).filter(Boolean).join(''))
assert.ok(order.findIndex(t => /OLD SNAPSHOT/.test(t)) < order.findIndex(t => /NEW SNAPSHOT/.test(t)))

// A trailing notice that names an ignored kind is likewise not removed from a
// continuation, because removing it would move the prefix too.
const withNotice = texts(wire([
  { role: 'user', content: [{ type: 'text', text: 'APPROVAL NOTICE' }], source: { kind: 'user-approval' } },
  player('hello'),
  assistant(['toolu_agy_bbbb']),
  result('toolu_agy_bbbb'),
]))
assert.match(withNotice, /APPROVAL NOTICE/, 'a continuation sends history verbatim')

console.log('serialize-notices: ok')
