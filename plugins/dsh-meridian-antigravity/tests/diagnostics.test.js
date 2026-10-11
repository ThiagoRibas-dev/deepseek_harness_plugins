/**
 * Offline tests for the capture diff.
 *
 * This is the module that turns "the prefix moved" into "message 34 moved", which
 * is the difference between an afternoon of session-store archaeology and one log
 * line. The fixtures here are capture records in the shape `lib/capture.js`
 * writes, so the diff is exercised without a live Meridian.
 *
 * Needs no module-resolution rig: `lib/diagnostics.js` imports only node builtins
 * and `lib/capture.js`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { describeMovedMessage, firstDifference, messageText } from '../lib/diagnostics.js'

let dir
before(() => { dir = mkdtempSync(join(tmpdir(), 'meridian-diagnostics-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })

/** A message list: one system message plus one per argument. */
const body = (...extra) => [{ role: 'system', content: 'You are the DM.' }, ...extra]

/** A capture record in the shape `lib/capture.js` writes. */
const capture = (time, session, purpose, messages) => ({
  time, session, purpose, bytes: 1, body: { messages },
})

/** Write captures into a throwaway directory and describe against them. */
function withCaptures(records, run) {
  const scope = mkdtempSync(join(tmpdir(), 'meridian-captures-'))
  try {
    for (const [index, record] of records.entries()) {
      writeFileSync(join(scope, `${1_700_000_000_000 + index}-id${index}.json`), JSON.stringify(record))
    }
    return run(scope)
  } finally {
    rmSync(scope, { recursive: true, force: true })
  }
}

const connection = scope => ({ captureRequestBodies: true, captureDir: scope })

test('the text of a message is its blocks, or a serialisation', () => {
  assert.equal(messageText({ role: 'user', content: 'hello' }), 'hello')
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }] }), 'abcd')
  assert.equal(messageText({ role: 'user', content: [{ type: 'tool_use', id: 'x' }] }), '{"type":"tool_use","id":"x"}')
})

test('a rewrite in place is found even when both dispatches are the same length', () => {
  const before = capture(1, 's', 'chat', body({ role: 'user', content: 'the old snapshot' }))
  const after = capture(2, 's', 'chat', body({ role: 'user', content: 'the new snapshot' }))
  assert.deepEqual(firstDifference(before, after), {
    kind: 'changed', index: 1, role: 'user', beforeChars: 16, afterChars: 16,
  })
})

test('an appended message is reported as added at its index', () => {
  const before = capture(1, 's', 'chat', body({ role: 'user', content: 'one' }))
  const after = capture(2, 's', 'chat', body({ role: 'user', content: 'one' }, { role: 'user', content: 'two' }))
  assert.deepEqual(firstDifference(before, after), {
    kind: 'added', index: 2, role: 'user', beforeChars: 0, afterChars: 3,
  })
})

test('a dropped message is reported as removed', () => {
  const before = capture(1, 's', 'chat', body({ role: 'user', content: 'one' }, { role: 'user', content: 'two' }))
  const after = capture(2, 's', 'chat', body({ role: 'user', content: 'one' }))
  assert.deepEqual(firstDifference(before, after), {
    kind: 'removed', index: 2, role: 'user', beforeChars: 3, afterChars: 0,
  })
})

test('identical dispatches report no difference', () => {
  const messages = body({ role: 'user', content: 'same' })
  assert.equal(firstDifference(capture(1, 's', 'chat', messages), capture(2, 's', 'chat', messages)), undefined)
})

test('the moved message is named from the two most recent captures', () => {
  withCaptures([
    capture(1, 's', 'chat', body({ role: 'user', content: 'a runtime context snapshot' })),
    capture(2, 's', 'chat', body({ role: 'user', content: 'a longer runtime context snapshot, rebuilt' })),
  ], scope => {
    assert.equal(
      describeMovedMessage(connection(scope), 's', 'chat'),
      'message 1 (user) changed, 26 -> 42 chars',
    )
  })
})

test('capture being off is reported as nothing known, not as no difference', () => {
  withCaptures([], scope => {
    assert.equal(describeMovedMessage({ captureRequestBodies: false, captureDir: scope }, 's', 'chat'), '')
  })
})

test('a different session is never compared against', () => {
  withCaptures([
    capture(1, 'other-session', 'chat', body({ role: 'user', content: 'unrelated' })),
    capture(2, 's', 'chat', body({ role: 'user', content: 'mine' })),
  ], scope => {
    // Only one capture belongs to this session: nothing to diff.
    assert.equal(describeMovedMessage(connection(scope), 's', 'chat'), '')
  })
})

test('a different purpose is never compared against', () => {
  withCaptures([
    capture(1, 's', 'title', body({ role: 'user', content: 'name this session' })),
    capture(2, 's', 'chat', body({ role: 'user', content: 'mine' })),
  ], scope => {
    assert.equal(describeMovedMessage(connection(scope), 's', 'chat'), '')
  })
})

test('an unreadable capture is skipped rather than thrown', () => {
  withCaptures([
    capture(1, 's', 'chat', body({ role: 'user', content: 'before' })),
    capture(2, 's', 'chat', body({ role: 'user', content: 'after' })),
  ], scope => {
    writeFileSync(join(scope, '1700000009999-broken.json'), '{ not json')
    assert.equal(describeMovedMessage(connection(scope), 's', 'chat'), 'message 1 (user) changed, 6 -> 5 chars')
  })
})

test('identical dispatches are reported as the history not being what moved', () => {
  withCaptures([
    capture(1, 's', 'chat', body({ role: 'user', content: 'same' })),
    capture(2, 's', 'chat', body({ role: 'user', content: 'same' })),
  ], scope => {
    assert.match(describeMovedMessage(connection(scope), 's', 'chat'), /no message differs/)
  })
})

test('a missing capture directory is not a diagnosis', () => {
  assert.equal(describeMovedMessage(connection(join(dir, 'absent')), 's', 'chat'), '')
})
