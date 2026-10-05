/**
 * Offline conformance tests for the Meridian Antigravity connector.
 *
 * These run against a scriptable fake Meridian over loopback: no live service,
 * no subscription quota, and no CLI pin required. They assert the behaviours the
 * Meridian Antigravity contract makes a harness responsible for, and the ones
 * that are cheap to regress:
 *
 *   connect fails closed on the wrong backend or CLI version; an unadvertised
 *   slug is a hard error; sampling, thinking and structured-output controls are
 *   never sent; the slug is the effort interface; tool calls are held until
 *   `message_stop`; an interrupted stream executes nothing and recovers the
 *   saved answer under the same identity; identity is session-scoped and
 *   content-addressed; every Meridian failure has one classification, with a
 *   409 split by its provider message; and an oversized request asks for image
 *   offload instead of truncating.
 *
 * Run with `./tests/run.sh`, which builds the module-resolution rig this file
 * needs (a profile plugin resolves `@deepseek-ai/*` through the harness loader,
 * which plain Node does not provide).
 */

import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'

const plugin = await import('../index.js')
const { resolveOptions, normalizeBaseURL } = await import('../lib/config.js')
const { MeridianContract } = await import('../lib/contract.js')
const { TurnLedger, logicalRequestHash } = await import('../lib/idempotency.js')
const { TurnGate } = await import('../lib/limiter.js')
const { runTurn } = await import('../lib/transport.js')
const { MeridianTranslator } = await import('../lib/stream.js')
const { serializeRequest, enforceRequestBudget, filterNoticeMessages } = await import('../lib/serialize.js')

// --------------------------------------------------------------- fake Meridian
const state = {
  health: {
    status: 'healthy',
    version: '1.76.1',
    backend: 'antigravity',
    support: { tier: 'preview', cliVersion: '1.2.7', verifiedCliVersion: '1.2.7' },
    capabilities: { nativeReasoning: false, thinkingBudgets: false },
  },
  models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-medium', 'gpt-oss-120b-medium'],
  requests: [],
  nextStatus: undefined,
  script: undefined,
  lastHeaders: undefined,
  rawHealth: undefined,
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')

  if (url.pathname === '/health') {
    if (state.rawHealth !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(state.rawHealth)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state.health))
    return
  }
  if (url.pathname === '/v1/models') {
    if (req.headers['x-api-key'] !== 'test-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing API key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: state.models.map(id => ({ id, display_name: id, object: 'model' })) }))
    return
  }
  if (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens') {
    state.lastHeaders = req.headers
    const body = raw.length === 0 ? undefined : JSON.parse(raw)
    state.requests.push({ headers: req.headers, body })

    if (state.nextStatus !== undefined) {
      const pending = state.nextStatus
      state.nextStatus = undefined
      res.writeHead(pending.status, { 'content-type': 'application/json', ...(pending.headers ?? {}) })
      res.end(JSON.stringify(pending.body ?? { type: 'error', error: { type: 'invalid_request_error', message: 'refused' } }))
      return
    }
    if (state.script !== undefined) {
      state.script(req, res, body)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', model: body.model, content: [], usage: { input_tokens: 11, output_tokens: 0 } } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 11, output_tokens: 2 } }))
    res.write(sse('message_stop', { type: 'message_stop' }))
    res.end()
    return
  }
  res.writeHead(404)
  res.end('{}')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------- rig
const silentLogger = { debug() {}, info() {}, warn() {} }

function connectionOf(overrides = {}) {
  return resolveOptions({
    baseURL: BASE,
    apiKeyEnv: 'TEST_KEY',
    requireHealthGate: true,
    healthTtlMs: 0,
    catalogueTtlMs: 0,
    ...overrides,
  })
}

function deps(connection, overrides = {}) {
  const contract = new MeridianContract({ resolveApiKey: async () => 'test-key', logger: silentLogger })
  contract.bind(connection)
  return {
    connection,
    contract,
    ledger: new TurnLedger(),
    gate: new TurnGate(4, 1_000),
    resolveApiKey: async () => 'test-key',
    images: new Map(),
    logger: silentLogger,
    warn() {},
    ...overrides,
  }
}

const user = text => ({ role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text }] })
/** One injected user-role notice, as DSH records a harness state change. */
const notice = (kind, text) => ({ role: 'user', id: `n-${kind}-${text}`, source: { kind }, content: [{ type: 'text', text }] })
/** An assistant turn, so a notice can be the trailing user message. */
const assistantTurn = text => ({ role: 'assistant', id: 'a1', source: { kind: 'model' }, content: [{ type: 'text', text }] })
const baseOptions = extra => ({ provider: 'meridian-antigravity', model: 'gemini-3.8-flash-low', messages: [user('hi')], ...extra })

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

async function expectFailure(promise, code) {
  try {
    await promise
  } catch (error) {
    const actual = error.failure?.code ?? error.code
    assert.equal(actual, code, `expected ${code}, got ${actual}: ${error.message}`)
    return error
  }
  return assert.fail(`expected failure ${code}, but the call succeeded`)
}

let passed = 0
const failures = []
async function test(name, fn) {
  state.nextStatus = undefined
  state.script = undefined
  state.rawHealth = undefined
  state.requests = []
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// -------------------------------------------------------------------- tests
console.log('\nhealth gate')
await test('accepts the pinned backend and CLI version', async () => {
  await deps(connectionOf()).contract.ensureHealthy()
})

await test('refuses a different backend', async () => {
  const saved = state.health
  state.health = { ...saved, backend: 'combined' }
  try {
    await expectFailure(deps(connectionOf()).contract.ensureHealthy(), 'MERIDIAN_UNSUPPORTED_SERVICE')
  } finally { state.health = saved }
})

await test('refuses a different agy version', async () => {
  const saved = state.health
  state.health = { ...saved, support: { ...saved.support, cliVersion: '1.3.0' } }
  try {
    await expectFailure(deps(connectionOf()).contract.ensureHealthy(), 'MERIDIAN_UNSUPPORTED_SERVICE')
  } finally { state.health = saved }
})

await test('refuses a process that is not Meridian', async () => {
  state.rawHealth = '{"ok":true}'
  await expectFailure(deps(connectionOf()).contract.ensureHealthy(), 'MERIDIAN_UNSUPPORTED_SERVICE')
})

console.log('\ncatalogue')
await test('an unadvertised slug is a hard error with no substitution', async () => {
  await expectFailure(deps(connectionOf()).contract.resolveModel('meridian-antigravity', 'claude-sonnet-4-6'), 'UNKNOWN_MODEL')
})

await test('advertises the account catalogue with per-family modalities', async () => {
  const rig = deps(connectionOf())
  const models = await rig.contract.listModels('meridian-antigravity')
  assert.equal(models.length, 4)
  const byId = new Map(models.map(model => [model.id, model]))
  assert.deepEqual(byId.get('gemini-3.8-flash-low').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('claude-sonnet-5-5-medium').inputModalities, ['text'])
  const resolved = await rig.contract.resolveModel('meridian-antigravity', 'gemini-3.8-flash-high')
  assert.equal(resolved.provider, 'meridian-antigravity')
  assert.ok(resolved.context.contextWindow > 0)
})

console.log('\nrequest shape')
await test('never sends temperature, top_p, top_k, thinking or output controls', async () => {
  const connection = connectionOf()
  const { body } = serializeRequest({
    options: baseOptions({ temperature: 0.7 }),
    connection,
    images: new Map(),
  })
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config', 'output_format']) {
    assert.ok(!(banned in body), `${banned} must not be sent`)
  }
  assert.equal(body.max_tokens, 32768)
  assert.equal(body.model, 'gemini-3.8-flash-low')
})

await test('the slug is the effort interface and a mismatch is refused', async () => {
  const connection = connectionOf()
  serializeRequest({ options: baseOptions({ model: 'gemini-3.8-flash-high', reasoningEffort: 'high' }), connection, images: new Map() })
  await expectFailure(Promise.resolve().then(() => serializeRequest({
    options: baseOptions({ model: 'gemini-3.8-flash-low', reasoningEffort: 'high' }), connection, images: new Map(),
  })), 'UNSUPPORTED_REASONING_EFFORT')
  await expectFailure(Promise.resolve().then(() => serializeRequest({
    options: baseOptions({ model: 'gpt-oss-120b-medium', reasoningEffort: 'high' }), connection, images: new Map(),
  })), 'UNSUPPORTED_REASONING_EFFORT')
})

await test('sends a matching effort only when the deployment asks for it', async () => {
  const off = connectionOf()
  const withoutOverride = serializeRequest({
    options: baseOptions({ model: 'gemini-3.8-flash-high', reasoningEffort: 'high' }), connection: off, images: new Map(),
  }).body
  assert.ok(!('output_config' in withoutOverride))
  const on = connectionOf({ sendEffortOverride: true })
  const withOverride = serializeRequest({
    options: baseOptions({ model: 'gemini-3.8-flash-high', reasoningEffort: 'high' }), connection: on, images: new Map(),
  }).body
  assert.deepEqual(withOverride.output_config, { effort: 'high' })
})

await test('honors options.system and the latest in-history system snapshot', async () => {
  const connection = connectionOf()
  const fromOption = serializeRequest({ options: baseOptions({ system: 'TOP' }), connection, images: new Map() }).body
  assert.equal(fromOption.system, 'TOP')
  const messages = [
    { role: 'system', id: 's1', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'OLD' }] },
    user('hi'),
    { role: 'system', id: 's2', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'NEW' }] },
  ]
  const fromHistory = serializeRequest({ options: baseOptions({ messages }), connection, images: new Map() }).body
  assert.equal(fromHistory.system, 'NEW')
  assert.equal(fromHistory.messages.length, 1)
})

await test('tool results are arrays, lead their turn, and drop harness-only markers', async () => {
  const connection = connectionOf()
  const messages = [
    user('go'),
    {
      role: 'assistant',
      id: 'a1',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [
        { type: 'text', text: 'using a tool' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      ],
    },
    { role: 'tool', id: 't1', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
    { role: 'developer', id: 'd1', source: { kind: 'test' }, content: [{ type: 'tool-addition', toolName: 'later' }] },
  ]
  const { body } = serializeRequest({
    options: baseOptions({ messages, tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }] }),
    connection,
    images: new Map(),
  })
  const toolResult = body.messages.find(message => message.content.some(block => block.type === 'tool_result'))
  assert.ok(Array.isArray(toolResult.content[0].content), 'tool_result content must be an array')
  assert.equal(toolResult.content[0].content[0].text, 'file body')
  assert.notEqual(toolResult.content[0].text, 'file body')
  assert.deepEqual(body.tools, [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }])
  assert.ok(!JSON.stringify(body).includes('tool-addition'))
})

await test('session-title helper turns advertise no tools', async () => {
  const connection = connectionOf()
  const { body } = serializeRequest({
    options: baseOptions({ purpose: 'session-title', tools: [{ name: 'read', description: 'd', parameters: {} }] }),
    connection,
    images: new Map(),
  })
  assert.equal(body.tools, undefined)
})

await test('images are inlined as base64 with the declared media type', async () => {
  const connection = connectionOf()
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const images = new Map([['sha256:abc', { data: bytes, mediaType: 'image/png', width: 1, height: 1 }]])
  const messages = [{
    role: 'user',
    id: 'u1',
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }],
  }]
  const { body } = serializeRequest({ options: baseOptions({ messages }), connection, images })
  const block = body.messages[0].content[0]
  assert.equal(block.type, 'image')
  assert.equal(block.source.type, 'base64')
  assert.equal(block.source.media_type, 'image/png')
  assert.equal(block.source.data, bytes.toString('base64'))
})

await test('an oversized request asks for image offload instead of truncating', async () => {
  const connection = connectionOf({ maxRequestBytes: 200 })
  const images = new Map([['sha256:abc', { data: Buffer.alloc(4_000), mediaType: 'image/png', width: 10, height: 10 }]])
  const messages = [{
    role: 'user',
    id: 'u1',
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 4_000, width: 10, height: 10 } }],
  }]
  const serialized = serializeRequest({ options: baseOptions({ messages }), connection, images })
  const error = await expectFailure(
    Promise.resolve().then(() => enforceRequestBudget(serialized, connection)),
    'IMAGE_OFFLOAD_REQUIRED',
  )
  assert.equal(error.failure.offloadImages, 1)
})

console.log('\nstreaming and tool holding')
await test('a complete turn emits text then finish', async () => {
  const chunks = await collect(runTurn(deps(connectionOf()), baseOptions()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['hello'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.inputTokens, 11)
})

await test('tool calls are withheld until message_stop', async () => {
  state.script = (req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_t', model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'planning' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a"}' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 9 } }))
    res.write(sse('message_stop', { type: 'message_stop' }))
    res.end()
  }
  const chunks = await collect(runTurn(deps(connectionOf()), baseOptions()))
  const toolEnd = chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(toolEnd > 0)
  assert.equal(chunks[toolEnd].block.arguments, '{"path":"a"}')
  assert.equal(chunks[toolEnd].block.id, 'toolu_1')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'planning'))
})

await test('a held tool block is never emitted before message_stop', async () => {
  const translator = new MeridianTranslator()
  const emitted = []
  emitted.push(...translator.push({ type: 'message_start', message: { id: 'm', usage: {} } }))
  emitted.push(...translator.push({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  emitted.push(...translator.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }))
  emitted.push(...translator.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read' } }))
  emitted.push(...translator.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }))
  emitted.push(...translator.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }))
  assert.ok(!emitted.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
  const final = translator.push({ type: 'message_stop' })
  assert.ok(final.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
})

await test('a thinking block never becomes a reasoning channel', async () => {
  state.script = (req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_r', model: body.model, content: [], usage: {} } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }))
    res.write(sse('message_stop', { type: 'message_stop' }))
    res.end()
  }
  const chunks = await collect(runTurn(deps(connectionOf()), baseOptions()))
  assert.ok(!chunks.some(chunk => chunk.type === 'reasoning-delta'), 'no reasoning channel may be built')
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['visible'])
})

await test('a stream cut after the first tool block executes nothing and recovers', async () => {
  const connection = connectionOf()
  const seen = { replay: 0 }
  const contract = new MeridianContract({ resolveApiKey: async () => 'test-key', logger: silentLogger })
  contract.bind(connection)
  state.script = (req, res, body) => {
    if (req.headers['x-meridian-replay-only'] === 'true') {
      seen.replay += 1
      res.writeHead(200, { 'content-type': 'application/json', 'x-meridian-response-replayed': 'true' })
      res.end(JSON.stringify({
        id: 'msg_cut',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          { type: 'text', text: 'planning' },
          { type: 'tool_use', id: 'toolu_9', name: 'read', input: { path: 'a' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 9 },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_cut', model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'planning' } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'read' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }))
    // Truncated: no tool stop, no message_delta, no message_stop. The delay lets
    // the frames above reach the client before the socket dies.
    res.flushHeaders?.()
    setTimeout(() => res.socket?.destroy(), 60)
  }
  const chunks = await collect(runTurn({ ...deps(connection), contract }, baseOptions()))
  assert.equal(seen.replay, 1, 'exactly one replay-only recovery')
  const tool = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(tool.block.id, 'toolu_9')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.ok(!chunks.some(chunk => chunk.type === 'usage'), 'a replayed answer contributes no usage chunk')
})

await test('a stream cut mid-text resumes only the missing suffix', async () => {
  const connection = connectionOf()
  const contract = new MeridianContract({ resolveApiKey: async () => 'test-key', logger: silentLogger })
  contract.bind(connection)
  state.script = (req, res, body) => {
    if (req.headers['x-meridian-replay-only'] === 'true') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-meridian-response-replayed': 'true' })
      res.end(JSON.stringify({
        id: 'msg_half', content: [{ type: 'text', text: 'hello world' }], stop_reason: 'end_turn', usage: {},
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_half', model: body.model, content: [], usage: {} } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }))
    res.flushHeaders?.()
    setTimeout(() => res.socket?.destroy(), 60)
  }
  const chunks = await collect(runTurn({ ...deps(connection), contract }, baseOptions()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['hello ', 'world'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await test('recovery refuses to splice a divergent answer', async () => {
  const translator = new MeridianTranslator()
  translator.push({ type: 'message_start', message: { id: 'msg_x', usage: {} } })
  translator.push({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  translator.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'AAAA' } })
  await expectFailure(Promise.resolve().then(() => translator.resume({
    id: 'msg_x', content: [{ type: 'text', text: 'BBBB' }], stop_reason: 'end_turn',
  })), 'MERIDIAN_REPLAY_DIVERGED')
})

await test('an empty terminal stop is a retryable EMPTY_RESPONSE', async () => {
  state.script = (req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_e', model: body.model, content: [], usage: {} } }))
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }))
    res.write(sse('message_stop', { type: 'message_stop' }))
    res.end()
  }
  const chunks = await collect(runTurn(deps(connectionOf()), baseOptions()))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

console.log('\nidentity')
await test('identical bytes reuse one id; a new turn mints another', async () => {
  const rig = deps(connectionOf())
  await collect(runTurn(rig, baseOptions()))
  const first = state.requests.at(-1).headers['idempotency-key']
  await collect(runTurn(rig, baseOptions()))
  const second = state.requests.at(-1).headers['idempotency-key']
  assert.notEqual(first, second, 'a completed turn is not replayed for a regenerate')
  await collect(runTurn(rig, baseOptions({ messages: [user('different')] })))
  assert.notEqual(second, state.requests.at(-1).headers['idempotency-key'])
})

await test('a failed turn keeps its identity so the retry is a replay, not a new generation', async () => {
  const rig = deps(connectionOf())
  state.nextStatus = { status: 503, headers: { 'retry-after': '5' } }
  const error = await expectFailure(collect(runTurn(rig, baseOptions())), 'SERVER')
  assert.equal(error.failure.providerRetryAfterMs, 5_000)
  const failed = state.requests.at(-1).headers['idempotency-key']
  await collect(runTurn(rig, baseOptions()))
  assert.equal(state.requests.at(-1).headers['idempotency-key'], failed, 'the retry must present the same identity')
})

await test('identity is content-addressed and the stream control is excluded', async () => {
  const connection = connectionOf()
  const { body } = serializeRequest({ options: baseOptions(), connection, images: new Map() })
  const plain = logicalRequestHash(body)
  assert.equal(plain, logicalRequestHash({ ...body, stream: true }))
  assert.notEqual(plain, logicalRequestHash({ ...body, model: 'gemini-3.8-flash-high' }))
})

await test('the identity fits the documented alphabet and length bound', async () => {
  await collect(runTurn(deps(connectionOf()), baseOptions()))
  assert.match(state.requests.at(-1).headers['idempotency-key'], /^[A-Za-z0-9._:-]{1,128}$/)
})

await test('two sessions sending identical bytes never share one identity', async () => {
  const body = { model: 'gemini-3.8-flash-low', messages: [user('hi')] }
  const a = logicalRequestHash(body, 'session-a')
  assert.notEqual(a, logicalRequestHash(body, 'session-b'), 'a session id must separate identical requests')
  // Stability is what makes a retry a replay instead of a second generation.
  assert.equal(a, logicalRequestHash(body, 'session-a'))
  // An unset session id still mints a usable identity, distinct from a scoped one.
  assert.notEqual(a, logicalRequestHash(body))
  assert.notEqual(logicalRequestHash(body), logicalRequestHash({ ...body, model: 'gemini-3.8-flash-high' }))
})

await test('a session id separates the wire identity of two identical requests', async () => {
  await collect(runTurn(deps(connectionOf()), baseOptions({ sessionId: 'session-a' })))
  const first = state.requests.at(-1).headers['idempotency-key']
  await collect(runTurn(deps(connectionOf()), baseOptions({ sessionId: 'session-b' })))
  const second = state.requests.at(-1).headers['idempotency-key']
  assert.notEqual(first, second)
})

await test('the session id is carried as meridian_session_key', async () => {
  await collect(runTurn(deps(connectionOf()), baseOptions({ sessionId: 'session-abc' })))
  assert.equal(state.requests.at(-1).body.meridian_session_key, 'session-abc')
  await collect(runTurn(deps(connectionOf()), baseOptions()))
  assert.equal(state.requests.at(-1).body.meridian_session_key, undefined)
})

await test('every request carries harness attribution', async () => {
  await collect(runTurn(deps(connectionOf()), baseOptions()))
  assert.match(state.lastHeaders['user-agent'], /^deepseek-harness\//)
})

console.log('\nerror policy')
for (const [status, code, message] of [
  [400, 'INVALID_REQUEST', 'status 400'],
  [401, 'AUTH', 'status 401'],
  [409, 'MERIDIAN_UNCERTAIN_OUTCOME', 'This request was interrupted by a service restart without a saved response.'],
  [422, 'MERIDIAN_STOP_IN_STRUCTURED_OUTPUT', 'status 422'],
  [429, 'RATE_LIMIT', 'status 429'],
  [502, 'SERVER', 'status 502'],
  [503, 'SERVER', 'status 503'],
  [504, 'TIMEOUT', 'status 504'],
]) {
  await test(`${status} maps to ${code}`, async () => {
    state.nextStatus = { status, body: { type: 'error', error: { type: 'x', message } } }
    await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), code)
  })
}

// Meridian returns 409 for unrelated conditions, so the provider message has to
// decide. A blanket mapping reports an uncertain tool outcome when the real
// problem is a transcript the harness rewrote mid-continuation.
await test('a changed tool continuation is a deterministic conflict, not an uncertain outcome', async () => {
  state.nextStatus = { status: 409, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Pending Antigravity tool continuation changed its delivered history or tool batch' } } }
  const error = await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'MERIDIAN_CONTINUATION_CONFLICT')
  assert.doesNotMatch(error.message, /reports an uncertain outcome/iu, 'must not use the uncertain-outcome banner')
  assert.doesNotMatch(error.message, /do not retry under a new identity/iu, 'must not send the user hunting for a new identity')
  assert.match(error.message, /deterministic transcript conflict/iu)
})

await test('a reclaimed pending process is reported as replayable', async () => {
  state.nextStatus = { status: 409, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Idle tool process reclaimed; completed history can be replayed' } } }
  await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'MERIDIAN_PENDING_REPLAYABLE')
})

await test('an expired tool deadline is reported as replayable', async () => {
  state.nextStatus = { status: 409, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Client tool result deadline expired; completed history can be replayed' } } }
  await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'MERIDIAN_PENDING_REPLAYABLE')
})

await test('a 409 with no readable provider message stays the conservative uncertain outcome', async () => {
  state.script = (req, res) => { res.writeHead(409, { 'content-type': 'text/plain' }); res.end('conflict') }
  await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'MERIDIAN_UNCERTAIN_OUTCOME')
})

await test('the default policy never retries a transcript or identity failure', async () => {
  const codes = connectionOf().retryPolicy.retryableCodes
  for (const forbidden of ['INVALID_REQUEST', 'AUTH', 'MERIDIAN_CONTINUATION_CONFLICT', 'MERIDIAN_UNCERTAIN_OUTCOME', 'MERIDIAN_NO_SNAPSHOT', 'MERIDIAN_UNSUPPORTED_SERVICE', 'UNKNOWN_MODEL', 'QUOTA']) {
    assert.ok(!codes.includes(forbidden), `${forbidden} must not be retryable`)
  }
  for (const allowed of ['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE', 'MERIDIAN_PENDING_REPLAYABLE']) {
    assert.ok(codes.includes(allowed), `${allowed} should be retryable`)
  }
})

await test('an in-stream quota error is QUOTA, not a retryable transport fault', async () => {
  // A quota failure arrives as an error event inside an otherwise successful
  // stream. Classified TRANSPORT it was retried twice before failing with text
  // that read like a network fault; no retry can succeed until the window resets.
  state.script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_quota', model: 'claude-sonnet-5-5-medium', content: [], usage: {} } }))
    res.write(sse('error', {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h43m43s.',
      },
    }))
    res.end()
  }
  const failure = await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'QUOTA')
  assert.equal(failure.failure.providerRetryAfterMs, 9_823_000, 'the reset window must reach the harness')
  assert.ok(
    !connectionOf().retryPolicy.retryableCodes.includes('QUOTA'),
    'a quota failure must not be retried',
  )
})

await test('an in-stream fault that is not about quota stays a retryable transport error', async () => {
  state.script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_other', model: 'm', content: [], usage: {} } }))
    res.write(sse('error', { type: 'error', error: { type: 'api_error', message: 'Internal error, please retry.' } }))
    res.end()
  }
  await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'TRANSPORT')
})

await test('a non-JSON gateway body still classifies by HTTP status', async () => {
  state.script = (req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('upstream unavailable') }
  await expectFailure(collect(runTurn(deps(connectionOf()), baseOptions())), 'SERVER')
})

console.log('\ninjected notice filtering')

await test('a model-switch notice after the player message never reaches the provider', async () => {
  const messages = [user('hello'), notice('model-selection', '[model changed: earlier turns came from another model]')]
  await collect(runTurn(deps(connectionOf()), baseOptions({ messages })))
  const sent = state.requests.at(-1).body
  assert.equal(sent.messages.length, 1)
  assert.equal(sent.messages[0].role, 'user')
  assert.match(sent.messages[0].content[0].text, /hello/)
  assert.doesNotMatch(JSON.stringify(sent), /model changed/)
})

await test('an approval-policy notice after the player message is dropped', async () => {
  const messages = [user('hello'), notice('user-approval', 'The approval policy changed from "ask" to "never".')]
  await collect(runTurn(deps(connectionOf()), baseOptions({ messages })))
  assert.doesNotMatch(JSON.stringify(state.requests.at(-1).body), /approval policy changed/)
})

await test('a notice that is the whole turn is kept so the request still ends on a user turn', async () => {
  const messages = [assistantTurn('earlier reply'), notice('user-approval', 'The approval policy changed from "ask" to "never".')]
  await collect(runTurn(deps(connectionOf()), baseOptions({ messages })))
  const sent = state.requests.at(-1).body
  assert.equal(sent.messages.at(-1).role, 'user')
  assert.match(JSON.stringify(sent.messages.at(-1)), /approval policy changed/)
})

await test('only the newest runtime-context snapshot is sent', async () => {
  const messages = [
    user('hello'),
    notice('runtime-context', 'Current runtime context. This snapshot supersedes earlier ones. policy ONE'),
    notice('runtime-context', 'Current runtime context. This snapshot supersedes earlier ones. policy TWO'),
  ]
  await collect(runTurn(deps(connectionOf()), baseOptions({ messages })))
  const sent = JSON.stringify(state.requests.at(-1).body)
  assert.ok(sent.includes('policy TWO'), 'the current snapshot must survive')
  assert.ok(!sent.includes('policy ONE'), 'a superseded snapshot must be dropped')
})

await test('notices that carry something to act on are kept', async () => {
  const messages = [
    user('hello'),
    notice('skill-catalog', 'SKILL CATALOG'),
    notice('agent-instructions', 'AGENT INSTRUCTIONS'),
    notice('tool-jobs', 'background job finished; read its output with job_output'),
    notice('subagent-settled', 'Background subagent finished'),
    notice('goal', '<goal_round> objective'),
    notice('compact-checkpoint', 'CHECKPOINT SUMMARY'),
  ]
  await collect(runTurn(deps(connectionOf()), baseOptions({ messages })))
  const sent = JSON.stringify(state.requests.at(-1).body)
  for (const kept of [
    'SKILL CATALOG', 'AGENT INSTRUCTIONS', 'background job finished',
    'Background subagent finished', '<goal_round>', 'CHECKPOINT SUMMARY',
  ]) {
    assert.ok(sent.includes(kept), `${kept} must survive the filter`)
  }
})

await test('the drop policy can be disabled entirely', async () => {
  const messages = [
    user('hello'),
    notice('model-selection', 'MODEL SWITCH NOTICE'),
    notice('runtime-context', 'policy ONE'),
    notice('runtime-context', 'policy TWO'),
  ]
  const connection = connectionOf({ ignoredNoticeKinds: [], keepLatestRuntimeContext: false })
  await collect(runTurn(deps(connection), baseOptions({ messages })))
  const sent = JSON.stringify(state.requests.at(-1).body)
  assert.ok(sent.includes('MODEL SWITCH NOTICE'))
  assert.ok(sent.includes('policy ONE'))
  assert.ok(sent.includes('policy TWO'))
})

await test('the filter removes only the configured kinds and keeps the rest in order', async () => {
  const messages = [user('a'), notice('model-selection', 'n'), assistantTurn('b'), user('c')]
  const policy = { ignoredKinds: ['model-selection'], keepLatestRuntimeContext: true }
  const first = filterNoticeMessages(messages, policy)
  const second = filterNoticeMessages(messages, policy)
  assert.deepEqual(first.messages.map(m => m.content[0].text), ['a', 'b', 'c'])
  assert.deepEqual(first.messages.map(m => m.content[0].text), second.messages.map(m => m.content[0].text))
  assert.equal(first.dropped.length, 1)
  assert.equal(first.dropped[0].content[0].text, 'n')
})

console.log('\nbase URL handling and manifest')
await test('normalizes a pasted /v1 suffix and rejects credentials in the URL', async () => {
  assert.equal(normalizeBaseURL('http://host:3457/'), 'http://host:3457')
  assert.equal(normalizeBaseURL('http://host:3457/v1'), 'http://host:3457')
  assert.equal(normalizeBaseURL('https://host/antigravity/'), 'https://host/antigravity')
  assert.throws(() => normalizeBaseURL('http://user:pw@host:3457'))
  assert.throws(() => normalizeBaseURL('ftp://host'))
})

await test('exports the plugin surface the loader expects', async () => {
  assert.equal(plugin.name, 'meridian-antigravity')
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'Config must be exported for the settings and Config machinery')
})

// ----------------------------------------------------------------- teardown
console.log(`\n${passed} passed, ${failures.length} failed`)
server.close()
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
