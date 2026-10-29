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

// A named notice is filtered on **both** paths, so the continuation's prefix is
// the opener's wire. Filtering it on the opener alone is what moved the prefix:
// the opener dropped it, the continuation sent it, and Meridian refused every
// continuation of that turn. Measured on `session-857354e7` turns 8-9 — see
// `docs/lessons-learned.md` §3.3.
const noticeMessages = [
  { role: 'user', content: [{ type: 'text', text: 'APPROVAL NOTICE' }], source: { kind: 'user-approval' } },
  player('hello'),
]
const openerWithNotice = wire(noticeMessages)
assert.doesNotMatch(texts(openerWithNotice), /APPROVAL NOTICE/, 'an injected notice is not model input')

const continuationWithNotice = wire([
  ...noticeMessages,
  assistant(['toolu_agy_bbbb']),
  result('toolu_agy_bbbb'),
])
assert.doesNotMatch(texts(continuationWithNotice), /APPROVAL NOTICE/, 'the notice is dropped on a continuation too')
assert.deepEqual(
  continuationWithNotice.slice(0, openerWithNotice.length),
  openerWithNotice,
  'a notice must not move the continuation prefix',
)

// The exception is content-based, not positional: a request that carries no player
// turn keeps its notice, because dropping it would leave nothing to answer.
const noticeOnly = wire([
  { role: 'user', content: [{ type: 'text', text: 'APPROVAL NOTICE' }], source: { kind: 'user-approval' } },
])
assert.match(texts(noticeOnly), /APPROVAL NOTICE/, 'a notice that is the whole request is kept')

// A checkpoint's framing is replaced, its body is not, and the replacement is a
// pure function of the message -- so an opener and its continuation agree on the
// bytes and the pinned prefix never moves.
const checkpointMessage = {
  role: 'user',
  source: { kind: 'compact-checkpoint' },
  content: [{
    type: 'text',
    text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation'
      + ' to free up context. Treat the captured context as established background and build on it without'
      + ' restating it. Continue the task directly from the messages that follow, without acknowledging this'
      + ' checkpoint.\n\n<compacted-summary>\n## Next Step\n- await user selection\n</compacted-summary>',
  }],
}
const framedOpener = wire([checkpointMessage, player('hello')])
const framedText = texts(framedOpener)
assert.match(framedText, /It describes an earlier state/, 'the framing is replaced')
assert.doesNotMatch(framedText, /established background/, 'the old framing does not survive')
assert.match(framedText, /## Next Step\n- await user selection/, 'the summary body is untouched')

const framedContinuation = wire([
  checkpointMessage,
  player('hello'),
  assistant(['toolu_agy_cccc']),
  result('toolu_agy_cccc'),
])
assert.deepEqual(
  framedContinuation.slice(0, framedOpener.length),
  framedOpener,
  'the reframing must not move the continuation prefix',
)

console.log('serialize-notices: ok')
