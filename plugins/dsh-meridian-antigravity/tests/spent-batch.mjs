/**
 * Spent-batch durability: a blocked generation must not kill the conversation.
 *
 * A live failure motivated these tests. Antigravity's content filter blocked the
 * model's output on a tool-continuation turn, after Meridian had already consumed
 * the tool result. The connector classified that as the retryable `TRANSPORT`, the
 * harness retried, and Meridian answered 409 "tool result was already consumed".
 * The transcript was then left ending on a tool result that nothing could answer,
 * so every later turn was refused identically: a permanently dead session.
 *
 * Three behaviours are asserted here:
 *
 *   a blocked generation is `CONTENT_FILTERED`, not a retryable transport fault,
 *   on the in-stream path and on the HTTP 502 path the ledger records;
 *   a failure on a continuation Meridian answered is `MERIDIAN_BATCH_SPENT`,
 *   while one that never reached Meridian stays retryable `TRANSPORT`;
 *   and the connector can stand in for the reply that will never exist, which is
 *   the only thing that makes the next request an ordinary call again.
 *
 * Runs against a scriptable fake Meridian over loopback. Like the conformance
 * suite, this needs the module-resolution rig: `./tests/run.sh`.
 */

import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'

const { resolveOptions } = await import('../lib/config.js')
const { MeridianContract } = await import('../lib/contract.js')
const { TurnLedger } = await import('../lib/idempotency.js')
const { TurnGate } = await import('../lib/limiter.js')
const { runTurn } = await import('../lib/transport.js')

/** Verbatim from the live failure, and from the `exchanges` row it produced. */
const FILTER_DETAIL = 'Your previous response was blocked by content safety filters: The model output'
  + ' could not be generated. This output contains sensitive words that violate Google\'s'
  + ' [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy).'
  + ' If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).\n'
  + 'Please provide a response that complies with content policies, or briefly explain to the user why you'
  + ' cannot help with this request\nRetries remaining: 3'

/**
 * Verbatim from the 22 `exchanges` rows with status 502 that are not the filter:
 * Meridian's subscriber to the agent falling behind and dropping the connection.
 */
const AGENT_INTERRUPTED_DETAIL = 'the connection to the agent was interrupted before the response finished:'
  + ' subscriber fell behind updates, stalled for 6s'

/** Verbatim from the live 409 that followed it. */
const SPENT_DETAIL = 'Antigravity tool result was already consumed; append the subsequent assistant'
  + ' response before continuing'

/**
 * Verbatim from the live blocked turn in `session-45365d66`: the model streamed a
 * complete refusal and the filter failed the turn at the finish.
 */
const LIVE_REPLY = 'I apologize, but I am unable to directly edit the campaign log for you.'
  + ' The text within the log contains explicit content that triggers my safety filters.'

/** The other 409: the delivered history genuinely moved, so no reply can repair it. */
const REWRITE_DETAIL = 'Antigravity tool continuation changed its delivered history or tool batch'

const state = {
  health: undefined,
  mode: 'cut',
  sawReplayOnly: false,
  nextStatus: undefined,
  onMessages: undefined,
}

const HEALTH = {
  status: 'healthy',
  version: '1.76.1',
  backend: 'antigravity',
  support: { tier: 'preview', cliVersion: '1.2.7', verifiedCliVersion: '1.2.7' },
  capabilities: { nativeReasoning: false, thinkingBudgets: false },
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  for await (const _ of req) { /* drain */ }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(HEALTH))
    return
  }
  if (url.pathname !== '/v1/messages') {
    res.writeHead(404)
    res.end('{}')
    return
  }
  // A scripted non-2xx, for the failures Meridian's ledger records as HTTP 502:
  // the content filter and the dropped agent connection. Both arrive with the
  // real cause only in the body.
  if (state.nextStatus !== undefined) {
    const { status, body, text } = state.nextStatus
    state.nextStatus = undefined
    if (text !== undefined) {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(text)
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  // Recovery re-asks the saved answer; this fake never saved one.
  if (req.headers['x-meridian-replay-only'] === 'true') {
    state.sawReplayOnly = true
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no saved response' } }))
    return
  }
  if (state.mode === 'refuse') {
    const detail = state.refuseDetail ?? SPENT_DETAIL
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: detail } }))
    return
  }
  if (state.mode === 'unreachable') {
    res.destroy()
    return
  }
  if (state.mode === 'hang') {
    // Hold the request open with no headers, so the client is genuinely mid-fetch
    // when its signal aborts. The timer only exists so a failed abort cannot
    // wedge the runner.
    state.onMessages?.()
    const timer = setTimeout(() => { if (!res.writableEnded) res.end() }, 5_000)
    timer.unref()
    res.on('close', () => clearTimeout(timer))
    return
  }
  if (state.mode === 'stall') {
    // Headers and one frame, then silence: the request reached Meridian and is
    // mid-stream when the idle deadline fires.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', model: 'gemini-3.8-flash-low', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
    }))
    const timer = setTimeout(() => { if (!res.writableEnded) res.end() }, 5_000)
    timer.unref()
    res.on('close', () => clearTimeout(timer))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', model: 'gemini-3.8-flash-low', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
  }))
  if (state.mode === 'filter') {
    res.write(sse('error', { type: 'error', error: { type: 'overloaded_error', message: FILTER_DETAIL } }))
    res.end()
    return
  }
  if (state.mode === 'filterLate') {
    // The shape the live failure actually took: the model thinks, streams a whole
    // answer, and only then does the filter fail the turn at the finish.
    res.write(sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }))
    res.write(sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: LIVE_REPLY },
    }))
    res.write(sse('error', { type: 'error', error: { type: 'overloaded_error', message: FILTER_DETAIL } }))
    res.end()
    return
  }
  // A cut stream: the connection closes with no `message_stop`.
  res.end()
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

const silentLogger = { debug() {}, info() {}, warn() {} }

function deps(overrides = {}) {
  const connection = resolveOptions({
    baseURL: BASE,
    apiKeyEnv: 'TEST_KEY',
    healthTtlMs: 0,
    ...overrides,
  })
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
  }
}

const user = text => ({ role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** One completed tool call, so the request is a continuation Meridian issued. */
const continuation = () => [
  user('go'),
  {
    role: 'assistant',
    id: 'a1',
    source: { kind: 'model', provider: 'meridian-antigravity', model: 'gemini-3.8-flash-low' },
    content: [{ type: 'tool-call', id: 'toolu_agy_aaaaaaaaaaaaaaaa', name: 'update_scene', arguments: '{}' }],
  },
  {
    role: 'tool',
    id: 't1',
    toolCallId: 'toolu_agy_aaaaaaaaaaaaaaaa',
    source: { kind: 'tool', callId: 'toolu_agy_aaaaaaaaaaaaaaaa' },
    content: [{ type: 'text', text: '{}' }],
  },
]

const options = (messages, extra) => ({
  provider: 'meridian-antigravity',
  model: 'gemini-3.8-flash-low',
  sessionId: 'session-test',
  messages,
  signal: new AbortController().signal,
  ...extra,
})

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

const textOf = chunks => chunks
  .flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
  .join('')

let passed = 0
const failures = []
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log('spent-batch durability')

await check('a blocked generation is CONTENT_FILTERED, not a retryable transport fault', async () => {
  state.mode = 'filter'
  const error = await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'CONTENT_FILTERED')
  assert.match(error.message, /content filter/)
  assert.match(error.message, /blocked by content safety filters/)
})

await check('a cut stream on an answered continuation is MERIDIAN_BATCH_SPENT', async () => {
  state.mode = 'cut'
  state.sawReplayOnly = false
  const messages = continuation()
  await expectFailure(collect(runTurn(deps(), options(messages))), 'MERIDIAN_BATCH_SPENT')
  assert.equal(state.sawReplayOnly, true, 'the saved-answer recovery must still be attempted first')
})

await check('a cut stream that never reached Meridian stays a retryable TRANSPORT', async () => {
  state.mode = 'unreachable'
  await expectFailure(collect(runTurn(deps(), options(continuation()))), 'TRANSPORT')
})

await check('an ordinary turn keeps its retryable TRANSPORT classification', async () => {
  state.mode = 'cut'
  await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'TRANSPORT')
})

// The ledger records both blocks as HTTP 502 on the `tool-result` continuation.
// Classifying by status alone would make the content filter retryable `SERVER`
// again — the same deadlock the stream fix closed, reached through the other
// transport — and would keep the dropped agent connection invisible.

await check('a 502 carrying the policy text is CONTENT_FILTERED, not a retryable SERVER', async () => {
  state.mode = 'cut'
  state.nextStatus = {
    status: 502,
    body: { type: 'error', error: { type: 'api_error', message: FILTER_DETAIL } },
  }
  const error = await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'CONTENT_FILTERED')
  // The two paths must read the same, so the sentence is asserted, not just the code.
  assert.match(error.message, /blocked the model's output with its content filter/)
  assert.match(error.message, /blocked by content safety filters/)
})

await check('a non-JSON 502 body carrying the policy text is still CONTENT_FILTERED', async () => {
  // A gateway can pass the provider's wording through without an envelope. The
  // status alone would call that retryable `SERVER` and reopen the deadlock.
  state.nextStatus = { status: 502, text: `Bad Gateway\n${FILTER_DETAIL}` }
  await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'CONTENT_FILTERED')
})

await check('the policy text is found past the message-length cap', async () => {
  // Classification reads the whole body; only the displayed detail is capped, so
  // an error page that prefixes a long preamble is still recognised.
  state.nextStatus = { status: 502, text: `${'<p>gateway noise</p>'.repeat(40)}\n${FILTER_DETAIL}` }
  await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'CONTENT_FILTERED')
})

await check('a 502 on a continuation is MERIDIAN_BATCH_SPENT, not a retryable SERVER', async () => {
  state.nextStatus = {
    status: 502,
    body: { type: 'error', error: { type: 'api_error', message: AGENT_INTERRUPTED_DETAIL } },
  }
  await expectFailure(collect(runTurn(deps(), options(continuation()))), 'MERIDIAN_BATCH_SPENT')
})

await check('the same 502 on an ordinary turn keeps its retryable classification', async () => {
  state.nextStatus = { status: 502, body: { type: 'error', error: { type: 'api_error', message: 'status 502' } } }
  await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'SERVER')
})

await check('a dropped agent connection gets its own retryable code', async () => {
  state.nextStatus = {
    status: 502,
    body: { type: 'error', error: { type: 'api_error', message: AGENT_INTERRUPTED_DETAIL } },
  }
  const error = await expectFailure(
    collect(runTurn(deps(), options([user('hi')]))),
    'MERIDIAN_AGENT_INTERRUPTED',
  )
  assert.match(error.message, /connection to the agent was interrupted/)
  // A new name, not a new policy: it has to stay retryable exactly as `SERVER` was.
  assert.equal(
    deps().connection.retryPolicy.retryableCodes.includes('MERIDIAN_AGENT_INTERRUPTED'),
    true,
    'splitting the code out of SERVER must not quietly make it permanent',
  )
})

await check('the connector stands in for a reply Meridian consumed the batch for', async () => {
  state.mode = 'refuse'
  state.refuseDetail = SPENT_DETAIL
  const chunks = await collect(runTurn(deps(), options(continuation())))
  const text = textOf(chunks)
  assert.match(text, /\[Meridian Antigravity\]/)
  assert.match(text, /batch of 1 tool result /)
  assert.match(text, /consumed by a generation the backend blocked and never completed/)
  assert.match(text, /no reply exists for it/)
  assert.match(text, /Nothing was lost and no tool ran twice/)
  // A complete, ordinary assistant turn: one text block and a terminal stop.
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text'), true)
  // No model ran, so nothing may be reported as usage.
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
})

await check('the repair is off when repairSpentBatch is false', async () => {
  state.mode = 'refuse'
  state.refuseDetail = SPENT_DETAIL
  await expectFailure(
    collect(runTurn(deps({ repairSpentBatch: false }), options(continuation()))),
    'MERIDIAN_CONTINUATION_CONFLICT',
  )
})

await check('a genuinely rewritten transcript is never papered over', async () => {
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  await expectFailure(
    collect(runTurn(deps(), options(continuation()))),
    'MERIDIAN_CONTINUATION_CONFLICT',
  )
})

await check('an aborted continuation is healed by the repair on the next request', async () => {
  // 15 ledger rows are Meridian's 499 and five of them are `tool-result`
  // continuations. A cancelled turn commits nothing — the operator stopped it —
  // so the spent batch is what the *next* request meets, and the repair is what
  // answers it. That makes the repair load-bearing, not a nicety.
  state.mode = 'hang'
  let arrived
  const arrival = new Promise(resolve => { arrived = resolve })
  state.onMessages = arrived
  const controller = new AbortController()
  const pending = collect(runTurn(deps(), options(continuation(), { signal: controller.signal })))
  await arrival
  controller.abort()
  await expectFailure(pending, 'ABORTED')
  state.onMessages = undefined

  state.mode = 'refuse'
  state.refuseDetail = SPENT_DETAIL
  const chunks = await collect(runTurn(deps(), options(continuation())))
  assert.match(textOf(chunks), /\[Meridian Antigravity\]/)
})

await check('an idle stream stall on a continuation is MERIDIAN_BATCH_SPENT', async () => {
  // The stall happens after Meridian has the request, so the batch may already be
  // spent. A retryable TIMEOUT here is the same trap as a retryable cut stream.
  state.mode = 'stall'
  state.onMessages = undefined
  await expectFailure(
    collect(runTurn(deps({ streamIdleTimeoutMs: 80 }), options(continuation()))),
    'MERIDIAN_BATCH_SPENT',
  )
})

await check('a stall before Meridian answers keeps the retryable TIMEOUT', async () => {
  // Same deadline, but it fired while connecting: nothing was reached, so there
  // is no batch to have spent and the retry is safe.
  state.mode = 'hang'
  await expectFailure(
    collect(runTurn(deps({ streamIdleTimeoutMs: 80 }), options(continuation()))),
    'TIMEOUT',
  )
})

await check('a blocked continuation is repaired instead of stranding the batch', async () => {
  // A blocked generation is non-retryable, so nothing re-presents the batch and
  // Meridian's "already consumed" 409 never arrives. The repair has to recognise
  // the block itself or the one case it was written for is unreachable.
  state.mode = 'filter'
  const chunks = await collect(runTurn(deps(), options(continuation())))
  const text = textOf(chunks)
  assert.match(text, /^\[Meridian Antigravity\]/, 'the turn must be closed by the notice, not by an error')
  assert.match(text, /no reply exists for it/)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'the turn must complete so the transcript is continuable')
})

await check('a reply the filter cut late is kept, with the notice after it', async () => {
  // The live shape: the model already streamed most of an answer. Throwing that
  // away with the failed turn is what this salvage exists to prevent.
  state.mode = 'filterLate'
  const chunks = await collect(runTurn(deps(), options(continuation())))
  const text = textOf(chunks)
  assert.match(text, new RegExp(LIVE_REPLY.slice(0, 40)), 'the delivered reply must survive')
  assert.match(text, /content filter stopped the reply after it had\s+already begun/)
  assert.match(text, /the text above may be incomplete/)
  assert.equal((text.match(/\[Meridian Antigravity\]/g) ?? []).length, 1)
  // The model's text and the connector's notice are separate blocks, so a reply
  // cut mid-word cannot read as prose running into the notice.
  const ends = chunks.filter(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(ends.length, 2)
  assert.equal(ends.at(-1).block.text.startsWith('[Meridian Antigravity]'), true)
  // No usage: the only figure this stream carried was the partial one from
  // `message_start`, and the terminal totals never arrived.
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

await check('a blocked ordinary turn still reports CONTENT_FILTERED', async () => {
  // Nothing is stranded on a non-continuation: the transcript ends on the user's
  // own message, so the user can simply ask again and no notice is warranted.
  state.mode = 'filter'
  await expectFailure(collect(runTurn(deps(), options([user('hi')]))), 'CONTENT_FILTERED')
})

await check('a blocked continuation is not repaired when the repair is off', async () => {
  state.mode = 'filter'
  await expectFailure(
    collect(runTurn(deps({ repairSpentBatch: false }), options(continuation()))),
    'CONTENT_FILTERED',
  )
})

server.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
