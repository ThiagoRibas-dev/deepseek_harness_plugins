/**
 * Regression test for the continuation prefix across a runtime-context refresh.
 *
 * Meridian requires each continuation's prefix to hash to the message list it
 * delivered. The runtime-context snapshot is re-injected whenever the session's
 * file or approval policy is restated, and it lands *before* the pending tool
 * batch, so it moves that prefix.
 *
 * The connector used to filter superseded snapshots on the request that starts a
 * turn and send a continuation verbatim. Each half was defensible; together they
 * caused the failure, because the opener delivered a prefix without the superseded
 * snapshot and the continuation put it back.
 *
 * Measured on a failing `dd35` turn by diffing the request captures: the snapshot
 * was the ONLY difference between the opener and its continuation -- messages 0
 * and 28, byte-identical once the snapshot was removed. Meridian answered
 * `409 invalid_request_error: Pending Antigravity tool continuation changed its
 * delivered history or tool batch`, and the turn was lost.
 *
 * So the snapshot never reaches the wire, and the property that matters is now
 * asserted directly: a continuation's prefix is byte-identical to the opener's.
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

// The snapshot never reaches the wire -- not on a turn start, and not on a
// continuation. Sending it is what let the prefix move.
const start = wire([
  snapshot('OLD SNAPSHOT'),
  player('hello'),
  assistant([]),
  snapshot('NEW SNAPSHOT'),
])
assert.doesNotMatch(texts(start), /SNAPSHOT/, 'a runtime-context snapshot must not reach the wire')

const continuation = wire([
  snapshot('OLD SNAPSHOT'),
  player('hello'),
  assistant(['toolu_agy_aaaa']),
  result('toolu_agy_aaaa'),
  snapshot('NEW SNAPSHOT'),
])
assert.doesNotMatch(texts(continuation), /SNAPSHOT/, 'a continuation must not carry a snapshot either')

// The contract, stated directly: whatever the harness does to the snapshot
// between the two requests, the continuation's prefix is the opener's wire.
const opener = wire([snapshot('AS OF TURN 1'), player('hello')])
for (const midTurn of ['AS OF TURN 1', 'AS OF TURN 2', '']) {
  const next = wire([
    ...(midTurn === '' ? [] : [snapshot(midTurn)]),
    player('hello'),
    assistant(['toolu_agy_aaaa']),
    result('toolu_agy_aaaa'),
  ])
  assert.deepEqual(
    next.slice(0, opener.length),
    opener,
    `a snapshot reading ${JSON.stringify(midTurn)} must not move the continuation prefix`,
  )
  assert.equal(next.length, opener.length + 2, 'the tool call and its result are the only additions')
}

// A trailing notice is still left alone on a continuation. Removing one of those
// would move the prefix for the same reason the snapshot did.
const withNotice = texts(wire([
  { role: 'user', content: [{ type: 'text', text: 'APPROVAL NOTICE' }], source: { kind: 'user-approval' } },
  player('hello'),
  assistant(['toolu_agy_bbbb']),
  result('toolu_agy_bbbb'),
]))
assert.match(withNotice, /APPROVAL NOTICE/, 'a continuation sends history verbatim')

console.log('serialize-notices: ok')
