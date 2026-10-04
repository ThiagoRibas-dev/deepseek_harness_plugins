/**
 * Offline tests for compaction tool-identity rewriting.
 *
 * The module under test imports only `node:crypto`, so this runs with plain
 * `node --test tests/compaction-ids.test.js` and needs no module-resolution rig.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compactionToolId, remapToolIds } from '../lib/compaction-ids.js'

/** A wire message list shaped the way `buildMessages` emits one. */
const wire = () => [
  { role: 'user', content: [{ type: 'text', text: 'run the thing' }] },
  { role: 'assistant', content: [
    { type: 'text', text: 'calling a tool' },
    { type: 'tool_use', id: 'toolu_agy_aaaa', name: 'bash', input: { command: 'ls' } },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_agy_aaaa', content: [{ type: 'text', text: 'file.txt' }] },
  ] },
]

test('a re-derived id is stable and recognisable', () => {
  const once = compactionToolId('toolu_agy_aaaa')
  const twice = compactionToolId('toolu_agy_aaaa')
  assert.equal(once, twice)
  assert.match(once, /^toolu_cc_[0-9a-f]{24}$/)
  assert.notEqual(once, 'toolu_agy_aaaa')
})

test('different ids produce different replacements', () => {
  assert.notEqual(compactionToolId('toolu_agy_aaaa'), compactionToolId('toolu_agy_bbbb'))
})

test('a call and its result keep the same replacement', () => {
  const { messages, remapped } = remapToolIds(wire())
  const call = messages[1].content.find(block => block.type === 'tool_use')
  const result = messages[2].content.find(block => block.type === 'tool_result')
  assert.equal(remapped, 1)
  assert.match(call.id, /^toolu_cc_/)
  assert.equal(result.tool_use_id, call.id)
})

test('the original ids are gone from the request entirely', () => {
  const { messages } = remapToolIds(wire())
  assert.doesNotMatch(JSON.stringify(messages), /toolu_agy_/)
})

test('rewriting is deterministic across calls', () => {
  // The transport keys its idempotency header on a hash of the request bytes and
  // Meridian refuses an id that arrives with different bytes, so a retry of one
  // logical compaction call must serialise to identical output.
  assert.deepEqual(remapToolIds(wire()).messages, remapToolIds(wire()).messages)
})

test('an id repeated across messages resolves once', () => {
  const repeated = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'a', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'a', input: {} }] },
  ]
  const { messages, remapped } = remapToolIds(repeated)
  assert.equal(remapped, 1)
  const ids = messages.flatMap(m => m.content.map(b => b.id ?? b.tool_use_id))
  assert.equal(new Set(ids).size, 1)
})

test('a result whose call is absent from the replay is still rewritten', () => {
  // A compaction region can start after the call it answers; the id must not
  // survive just because the matching tool_use is outside the region.
  const orphan = [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_orphan', content: [{ type: 'text', text: 'x' }] },
  ] }]
  const { messages, remapped } = remapToolIds(orphan)
  assert.equal(remapped, 1)
  assert.doesNotMatch(JSON.stringify(messages), /toolu_orphan/)
})

test('messages without tool blocks are returned untouched', () => {
  const plain = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  const { messages, remapped } = remapToolIds(plain)
  assert.equal(remapped, 0)
  assert.deepEqual(messages, plain)
})

test('non-array input is returned as-is', () => {
  assert.deepEqual(remapToolIds(undefined), { messages: undefined, remapped: 0 })
  assert.deepEqual(remapToolIds(null), { messages: null, remapped: 0 })
})

test('an unusable id is left alone rather than mangled', () => {
  const weird = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '', content: [] }] }]
  const { messages, remapped } = remapToolIds(weird)
  assert.equal(remapped, 0)
  assert.equal(messages[0].content[0].tool_use_id, '')
})
