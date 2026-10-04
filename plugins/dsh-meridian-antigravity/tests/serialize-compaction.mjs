/**
 * Integration test for the compaction gating in request serialization.
 *
 * Asserts that a compaction call reaches the wire with re-derived tool ids and
 * no tools, and that an ordinary conversation call is untouched. Needs the
 * module-resolution rig `tests/run.sh` builds, because `lib/serialize.js`
 * imports `@deepseek-ai/dsh-llm`.
 */

import assert from 'node:assert/strict'

const { serializeRequest } = await import('../lib/serialize.js')
const { resolveOptions } = await import('../lib/config.js')

const connection = resolveOptions({ baseURL: 'http://127.0.0.1:9' }, {})

const TOOLS = [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }]

/** A conversation shaped the way the harness derives one. */
const harnessMessages = () => [
  { role: 'user', content: [{ type: 'text', text: 'run the thing' }] },
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      id: 'toolu_agy_0123456789abcdef',
      name: 'bash',
      arguments: '{"command":"ls"}',
    }],
  },
  {
    role: 'tool',
    toolCallId: 'toolu_agy_0123456789abcdef',
    source: { kind: 'tool', callId: 'toolu_agy_0123456789abcdef' },
    content: [{ type: 'text', text: 'file.txt' }],
  },
]

/**
 * @param purpose - the call purpose the harness sets on the options.
 * @returns the serialized request result.
 */
function serialize(purpose) {
  return serializeRequest({
    options: { model: 'claude-sonnet-5-5-medium', messages: harnessMessages(), tools: TOOLS, purpose },
    connection,
    images: undefined,
    imageAccess: undefined,
    warn: () => {},
    sessionKey: 'session-serialize-compaction',
  })
}

/** Every tool id appearing on the wire, from calls and results alike. */
function wireIds(body) {
  return body.messages.flatMap(message => message.content.flatMap((block) => {
    if (block.type === 'tool_use') return [block.id]
    if (block.type === 'tool_result') return [block.tool_use_id]
    return []
  }))
}

const compaction = serialize('compaction')

assert.equal(compaction.compactionRemapped, 1, 'a compaction call must re-derive its tool ids')
assert.equal(compaction.body.tools, undefined, 'a compaction call must not advertise tools')

const ids = wireIds(compaction.body)
assert.equal(ids.length, 2, 'the call and its result should both be present')
assert.match(ids[0], /^toolu_cc_[0-9a-f]{24}$/, 'the call id should be re-derived')
assert.equal(ids[1], ids[0], 'the result must answer the re-derived call id')
assert.doesNotMatch(JSON.stringify(compaction.body), /toolu_agy_/, 'no delivered id may survive')

const conversation = serialize(undefined)
assert.equal(conversation.compactionRemapped, undefined, 'conversation traffic must not be rewritten')
assert.ok(Array.isArray(conversation.body.tools), 'a conversation call keeps its tools')
assert.equal(wireIds(conversation.body)[0], 'toolu_agy_0123456789abcdef', 'conversation ids are untouched')

// The transport keys its idempotency header on a hash of the request bytes and
// Meridian refuses an id that arrives with different bytes, so one logical
// compaction call must serialise identically on every attempt.
assert.equal(
  JSON.stringify(serialize('compaction').body),
  JSON.stringify(compaction.body),
  'compaction serialization must be byte-stable across attempts',
)

// The continuation diagnosis must survive serialization, because the transport
// attaches it to a transcript-conflict failure. The batch below was issued by
// another provider, which is the case Meridian cannot continue.
const foreign = serializeRequest({
  options: {
    model: 'claude-sonnet-5-5-medium',
    tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [{ type: 'tool-call', id: 'call_00_foreign', name: 'bash', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_00_foreign',
        source: { kind: 'tool', callId: 'call_00_foreign' },
        content: [{ type: 'text', text: 'ok' }],
      },
    ],
  },
  connection,
  images: undefined,
  imageAccess: undefined,
  warn: () => {},
  sessionKey: 'session-serialize-continuation',
})
assert.equal(foreign.continuation?.foreign?.length, 1, 'a foreign batch must be diagnosed')
assert.equal(foreign.continuation.foreign[0].provider, 'deepseek-official')

console.log('serialize-compaction: ok')
