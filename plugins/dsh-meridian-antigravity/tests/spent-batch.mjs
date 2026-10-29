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
 * Four behaviours are asserted here:
 *
 *   a blocked generation is `CONTENT_FILTERED`, not a retryable transport fault,
 *   on the in-stream path and on the HTTP 502 path the ledger records;
 *   a failure on a continuation Meridian answered is `MERIDIAN_BATCH_SPENT`,
 *   while one that never reached Meridian stays retryable `TRANSPORT`;
 *   a continuation refused as a transcript conflict is retried **once** with the
 *   assistant turn Meridian's own error asks for appended, and the retried
 *   request is an ordinary call rather than a continuation;
 *   and when the retry is refused too, the connector can stand in for the reply
 *   that will never exist, which is the only thing that makes the next request an
 *   ordinary call again.
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
const { measurePrompt, resolvePromptBudget } = await import('../lib/budget.js')

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

/** The other 409: the delivered history moved, which the recovery retry answers. */
const REWRITE_DETAIL = 'Antigravity tool continuation changed its delivered history or tool batch'

const state = {
  health: undefined,
  mode: 'cut',
  sawReplayOnly: false,
  nextStatus: undefined,
  onMessages: undefined,
  /** One action per request, consumed in order: `'refuse'` or `'answer'`. */
  script: [],
  /** Every parsed `/v1/messages` body received, in dispatch order. */
  bodies: [],
}

const HEALTH = {
  status: 'healthy',
  version: '1.81.0',
  backend: 'antigravity',
  support: { tier: 'preview', cliVersion: '1.3.4', verifiedCliVersion: '1.3.4' },
  capabilities: { nativeReasoning: false, thinkingBudgets: false },
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** Meridian's 409 for a continuation it will not accept. */
function refuseContinuation(res, detail) {
  res.writeHead(409, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: detail } }))
}

/** A complete, ordinary answer: what a retried request gets when Meridian accepts it. */
function serveAnswer(res, text = 'resumed') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', model: 'gemini-3.8-flash-low', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
  }))
  res.write(sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }))
  res.write(sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 5, output_tokens: 2 },
  }))
  res.write(sse('message_stop', { type: 'message_stop' }))
  res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')

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
  state.bodies.push(raw.length === 0 ? undefined : JSON.parse(raw))

  // A scripted action is consumed before the mode: it is how a test drives a
  // refusal and then an accepted answer on the same turn, which is the retry
  // path. An empty script falls through to `state.mode`.
  const action = state.script.shift()
  if (action === 'refuse') {
    refuseContinuation(res, state.refuseDetail ?? SPENT_DETAIL)
    return
  }
  if (action === 'answer') {
    serveAnswer(res)
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
    refuseContinuation(res, state.refuseDetail ?? SPENT_DETAIL)
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
  if (state.mode === 'cutFirst') {
    // The live shape from `session-dc7217e4` turn 2: a long tool loop, then the
    // turn dies with no reply and the batch is spent. Only the first dispatch is
    // cut; the replay-only re-ask above answers 404 for want of a saved response,
    // so the next ordinary request is the recovery retry and it succeeds.
    if (state.cutOnce === true) {
      serveAnswer(res)
      return
    }
    state.cutOnce = true
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', model: 'gemini-3.8-flash-low', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
    }))
    res.end()
    return
  }
  if (state.mode === 'stallFirst') {
    // Meridian's own turn deadline expiring while the stream is open: the batch is
    // already consumed, so this is the second route to a spent verdict. Only the
    // first dispatch stalls; the recovery retry is answered.
    if (state.stallOnce === true) {
      serveAnswer(res)
      return
    }
    state.stallOnce = true
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

/**
 * The live shape from `session-dc7217e4` turn 3: a spent batch left a tool result
 * at the tail, then the player sent a new message. The result is still a
 * continuation (`analyzeContinuation` counts tool messages after the last
 * assistant), and the serializer merges the player's turn into that tool result,
 * which is what makes the appended instruction matter.
 */
const continuationThenRequest = request => [...continuation(), user(request)]

/** A user message the harness recorded, which is not a player request. */
const injected = (kind, text = 'steady') => ({
  role: 'user',
  id: `i-${kind}`,
  source: { kind },
  content: [{ type: 'text', text }],
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
  // The repair is off so the classification is observable: with it on, a spent
  // batch is retried instead of reported (`a spent batch is retried once as an
  // ordinary call` pins that half).
  state.mode = 'cut'
  state.sawReplayOnly = false
  const messages = continuation()
  await expectFailure(
    collect(runTurn(deps({ repairSpentBatch: false }), options(messages))),
    'MERIDIAN_BATCH_SPENT',
  )
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
  // Repair off: with it on this turn is retried, so the code never surfaces.
  state.nextStatus = {
    status: 502,
    body: { type: 'error', error: { type: 'api_error', message: AGENT_INTERRUPTED_DETAIL } },
  }
  await expectFailure(
    collect(runTurn(deps({ repairSpentBatch: false }), options(continuation()))),
    'MERIDIAN_BATCH_SPENT',
  )
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

await check('a batch Meridian already consumed is stood in for after the retry', async () => {
  // Meridian consumed the tool results, so the transcript ends on them and every
  // later request re-presents a batch it will not accept. The connector first
  // retries once with the missing assistant turn appended -- the remedy
  // Meridian's own error asks for -- and when that is refused too it commits a
  // notice in place of the reply so the conversation can continue.
  //
  // The notice no longer names the batch size: on the retry the request is an
  // ordinary call, so the connector no longer sees a continuation to count. The
  // count is asserted for the notice builder itself in `failure.test.js`.
  state.mode = 'refuse'
  state.refuseDetail = SPENT_DETAIL
  state.bodies = []
  state.script = ['refuse', 'refuse']
  const chunks = await collect(runTurn(deps(), options(continuation())))
  const text = textOf(chunks)
  assert.equal(state.bodies.length, 2, 'the refusal is retried once before the notice')
  assert.match(text, /\[Meridian Antigravity\]/)
  assert.match(text, /This turn's tool batch was consumed/)
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

await check('a spent batch is retried once as an ordinary call', async () => {
  // The shape that actually happened live: Meridian accepted the tool results,
  // then the turn died with no reply (`Antigravity turn timed out`). It arrives
  // as `MERIDIAN_BATCH_SPENT`, whose text never says "already consumed", so the
  // text match misses it and this path used to skip the repair entirely -- the
  // turn errored and the transcript stayed on the tool results.
  //
  // The remedy is the one the refusal path already uses: append the assistant
  // turn Meridian's error asks for plus a user instruction, which leaves the
  // request ending on a user turn. That retry is an ordinary call, so the batch
  // Meridian consumed is no longer being re-presented as a continuation.
  state.mode = 'cutFirst'
  state.cutOnce = false
  state.script = []
  state.bodies = []
  const chunks = await collect(runTurn(deps(), options(continuation())))
  // Dispatch, the replay-only re-ask that finds no saved answer, then the retry.
  assert.equal(state.bodies.length, 3, 'exactly one recovery retry, not a loop')
  const retried = state.bodies.at(-1).messages
  assert.deepEqual(
    retried.at(-2),
    { role: 'assistant', content: [{ type: 'text', text: 'Recovering from transcript conflict.' }] },
  )
  assert.equal(retried.at(-1).role, 'user')
  assert.match(retried.at(-1).content[0].text, /previous tool batch was interrupted by a transcript rewrite/)
  assert.match(retried.at(-1).content[0].text, /continue your work using the tool results above/)
  // The retry carries the consumed results in history but not as a trailing
  // continuation: that is what makes it acceptable rather than refused again.
  assert.equal(retried.at(-1).content.some(block => block.type === 'tool_result'), false)
  assert.equal(textOf(chunks), 'resumed')
  assert.doesNotMatch(textOf(chunks), /\[Meridian Antigravity\]/)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

await check('a spent batch is not retried when repairSpentBatch is false', async () => {
  // The flag stays the single switch for the whole repair, retry included.
  state.mode = 'cut'
  state.script = []
  state.bodies = []
  await expectFailure(
    collect(runTurn(deps({ repairSpentBatch: false }), options(continuation()))),
    'MERIDIAN_BATCH_SPENT',
  )
  assert.equal(state.bodies.length, 2, 'the initial dispatch and the replay re-ask only')
})

await check('a spent batch whose retry also dies is reported, not retried twice', async () => {
  // The retry is one second attempt, not a repair loop. It is an ordinary call,
  // so a second stream cut is a retryable transport fault rather than another
  // spent batch -- the harness's own policy may re-send it, safely, because no
  // consumed continuation is being re-presented.
  state.mode = 'cut'
  state.script = []
  state.bodies = []
  await expectFailure(collect(runTurn(deps(), options(continuation()))), 'TRANSPORT')
  assert.equal(state.bodies.length, 4, 'dispatch, replay, retry, replay -- then stop')
})

await check('a refused continuation is retried once with the recovery turn appended', async () => {
  // Meridian pins a continuation to the history it already delivered, so a 409
  // means the prefix moved. The connector's answer is one retry that appends the
  // assistant turn Meridian's own error asks for. Appending it also leaves the
  // retried request ending on a user message, so it is no longer a tool-result
  // continuation and Meridian's prefix constraint no longer applies.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.bodies = []
  state.script = ['refuse', 'answer']
  const chunks = await collect(runTurn(deps(), options(continuation())))
  assert.equal(state.bodies.length, 2, 'exactly one retry, not a loop')
  const retried = state.bodies[1].messages
  assert.deepEqual(
    retried.at(-2),
    { role: 'assistant', content: [{ type: 'text', text: 'Recovering from transcript conflict.' }] },
  )
  assert.equal(retried.at(-1).role, 'user')
  assert.match(retried.at(-1).content[0].text, /previous tool batch was interrupted by a transcript rewrite/)
  assert.match(retried.at(-1).content[0].text, /continue your work using the tool results above/)
  // The retry was accepted, so the turn ends on the model's reply with no notice.
  assert.equal(textOf(chunks), 'resumed')
  assert.doesNotMatch(textOf(chunks), /\[Meridian Antigravity\]/)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

await check('a retried turn re-issues the player\'s newest message', async () => {
  // Turn 3 of `session-dc7217e4`: the player's message arrived while a spent batch
  // was still at the tail, Meridian refused the continuation, and the recovery turn
  // said "continue your work using the tool results above". The model answered the
  // previous request, because that is what the instruction told it to do. The
  // player's words must be the operative instruction instead.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.script = ['refuse', 'answer']
  state.bodies = []
  const request = 'I mean we hit the same error in this very session.'
  const chunks = await collect(runTurn(deps(), options(continuationThenRequest(request))))
  assert.equal(state.bodies.length, 2, 'exactly one retry')
  const instruction = state.bodies[1].messages.at(-1)
  assert.equal(instruction.role, 'user')
  const text = instruction.content[0].text
  assert.match(text, /previous tool batch was interrupted by a transcript rewrite/)
  assert.match(text, /The user's newest message is the instruction/)
  assert.ok(text.includes(request), 'the request is repeated verbatim')
  assert.doesNotMatch(text, /continue your work using the tool results above/)
  assert.equal(textOf(chunks), 'resumed')
})

await check('an injected user message is never mistaken for the request', async () => {
  // Runtime context, workspace instructions and the skill catalog are all user-role
  // messages. None of them may become the instruction the retry answers, so with no
  // player turn at the tail the original wording stays.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.script = ['refuse', 'answer']
  state.bodies = []
  const messages = [...continuation(), injected('runtime-context'), injected('agent-instructions')]
  await collect(runTurn(deps(), options(messages)))
  const text = state.bodies[1].messages.at(-1).content[0].text
  assert.match(text, /continue your work using the tool results above/)
  assert.doesNotMatch(text, /The user's newest message is the instruction/)
})

await check('a long request is repeated only up to the cap', async () => {
  // A pasted error is already in the request once; repeating it in full would double
  // the prefill of the one call that is already the expensive one.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.script = ['refuse', 'answer']
  state.bodies = []
  await collect(runTurn(deps(), options(continuationThenRequest('x'.repeat(9_000)))))
  const text = state.bodies[1].messages.at(-1).content[0].text
  assert.match(text, /\[request truncated for the retry\]/)
  assert.ok(text.length < 5_000, `instruction was ${text.length} chars`)
})

await check('a pinned conversation sends one key for every dispatch', async () => {
  // The default: one live CLI conversation per harness session, so Meridian can
  // reuse its process and its prefix cache.
  state.mode = null
  state.script = ['answer', 'answer']
  state.bodies = []
  const opts = options(continuation(), { sessionId: 'session-pinned' })
  const depsPinned = deps()
  await collect(runTurn(depsPinned, opts))
  await collect(runTurn(depsPinned, opts))
  assert.equal(state.bodies.length, 2)
  assert.equal(state.bodies[0].meridian_session_key, 'session-pinned')
  assert.equal(state.bodies[1].meridian_session_key, 'session-pinned')
})

await check('a repaired turn keeps its conversation until the turn ends', async () => {
  // The retry cannot win in the conversation that just refused it, so it rotates.
  // But the model issues NEW tool calls there, and Meridian resolves a continuation
  // by tool-id ownership, so every later step of that turn must stay in the same
  // conversation. Measured on `session-10c2aff1`: ten repairs in one turn, one per
  // step, because each continuation went back to the pinned key.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.script = ['refuse', 'answer']
  state.bodies = []
  const opts = options(continuation(), { sessionId: 'session-sticky' })
  await collect(runTurn(deps(), opts))
  assert.equal(state.bodies.length, 2, 'the refusal is retried once')
  const [refused, retried] = state.bodies.map(body => body.meridian_session_key)
  assert.equal(refused, 'session-sticky')
  assert.match(retried, /^session-sticky#r\d+$/, 'the retry is a new conversation')

  // A continuation after the repair continues the conversation that issued its calls.
  state.mode = null
  state.script = ['answer']
  await collect(runTurn(deps(), opts))
  assert.equal(state.bodies.at(-1).meridian_session_key, retried, 'the rest of the turn stays there')

  // A turn opener is the one request that can safely seed a conversation again.
  state.script = ['answer']
  await collect(runTurn(deps(), options([user('next question')], { sessionId: 'session-sticky' })))
  assert.equal(state.bodies.at(-1).meridian_session_key, 'session-sticky', 'the next turn is pinned again')
})

await check('a continuation still refused after the retry is reported as an error', async () => {
  // The retry is a single second attempt, not a repair loop. If Meridian refuses
  // the appended recovery turn as well, the transcript cannot continue and the
  // connector reports the provider's verdict instead of inventing a reply.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  state.bodies = []
  state.script = ['refuse', 'refuse']
  await expectFailure(
    collect(runTurn(deps(), options(continuation()))),
    'MERIDIAN_CONTINUATION_CONFLICT',
  )
  assert.equal(state.bodies.length, 2)
})

await check('a conflict with no continuation is still reported as an error', async () => {
  // Nothing is stranded when the turn carried no tool results, so the connector
  // reports Meridian's verdict instead of inventing a reply.
  state.mode = 'refuse'
  state.refuseDetail = REWRITE_DETAIL
  await expectFailure(
    collect(runTurn(deps(), options([user('hi')]))),
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

await check('a spent batch found by the idle deadline is retried too', async () => {
  // The second route to the same verdict. This one throws from inside the catch,
  // before the repair block, so unless the retry is taken where the failure is
  // created it cannot be taken at all.
  state.mode = 'stallFirst'
  state.stallOnce = false
  state.script = []
  state.bodies = []
  const chunks = await collect(
    runTurn(deps({ streamIdleTimeoutMs: 80 }), options(continuation())),
  )
  assert.equal(state.bodies.length, 2, 'the dispatch and the recovery retry, no replay probe')
  assert.equal(state.bodies.at(-1).messages.at(-1).role, 'user')
  assert.match(state.bodies.at(-1).messages.at(-1).content[0].text, /continue your work using the tool results above/)
  assert.equal(textOf(chunks), 'resumed')
})

await check('an idle stream stall on a continuation is MERIDIAN_BATCH_SPENT', async () => {
  // The stall happens after Meridian has the request, so the batch may already be
  // spent. A retryable TIMEOUT here is the same trap as a retryable cut stream.
  // Repair off for the same reason as the cut above.
  state.mode = 'stall'
  state.onMessages = undefined
  await expectFailure(
    collect(runTurn(deps({ streamIdleTimeoutMs: 80, repairSpentBatch: false }), options(continuation()))),
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

await check('capture is off by default and writes the dispatched body when on', async () => {
  const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { resolveOptions } = await import('../lib/config.js')

  const dir = mkdtempSync(join(tmpdir(), 'ma-capture-'))
  try {
    // Off by default: a fresh image must not leave transcripts on disk.
    assert.equal(deps().connection.captureRequestBodies, false)
    // On without a directory is an operator error, not a silent no-op.
    assert.throws(
      () => resolveOptions({ baseURL: BASE, captureRequestBodies: true }),
      /captureRequestBodies needs captureDir/,
    )

    // A refusal is exactly the case the capture exists for, and it proves the
    // body is written before dispatch rather than after a good answer. The
    // repair is off here so the refusal surfaces as the error it is.
    state.mode = 'refuse'
    state.refuseDetail = REWRITE_DETAIL
    await expectFailure(
      collect(runTurn(
        deps({ captureRequestBodies: true, captureDir: dir, repairSpentBatch: false }),
        options(continuation()),
      )),
      'MERIDIAN_CONTINUATION_CONFLICT',
    )
    state.mode = 'cut'
    const files = readdirSync(dir)
    assert.equal(files.length, 1, 'one dispatch writes one capture')
    const captured = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
    assert.equal(captured.session, 'session-test')
    assert.equal(captured.model, 'gemini-3.8-flash-low')
    assert.equal(captured.continuation.results, 1)
    assert.equal(captured.body.stream, true, 'the capture is what went on the wire')
    assert.equal(captured.body.messages.some(message => message.role === 'user'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    assert.equal(existsSync(dir), false)
  }
})

await check('the prompt budget measures in the unit it is configured with', async () => {
  // Every number is configuration: the same body can be judged in bytes, chars or
  // tokens, and the conversion from body to prompt is a ratio rather than code.
  const body = 300_000
  const bytes = measurePrompt({ bodyBytes: body, budget: resolvePromptBudget({ limit: 190_000, margin: 0 }) })
  assert.equal(bytes.value, 194_100, '300000 * 0.647')
  assert.equal(bytes.exceeded, true, 'over the 190000-byte limit')

  const generous = measurePrompt({ bodyBytes: body, budget: resolvePromptBudget({ limit: 200_000, margin: 0 }) })
  assert.equal(generous.exceeded, false, 'the same body fits a larger limit')

  const tokens = measurePrompt({
    bodyBytes: body,
    budget: resolvePromptBudget({ limit: 40_000, unit: 'tokens', charsPerToken: 4, margin: 0 }),
  })
  assert.equal(tokens.value, 48_525, '194100 / 4')
  assert.equal(tokens.exceeded, true, 'over a 40000-token limit')

  const chars = measurePrompt({ bodyBytes: body, budget: resolvePromptBudget({ limit: 190_000, unit: 'chars', margin: 0 }) })
  assert.equal(chars.unit, 'chars')
  assert.equal(chars.value, bytes.value, 'chars and bytes share a number')
})

await check('the margin holds headroom below the limit', async () => {
  const tight = measurePrompt({ bodyBytes: 270_000, budget: resolvePromptBudget({ limit: 190_000, margin: 0 }) })
  assert.equal(tight.value, 174_690)
  assert.equal(tight.exceeded, false)
  const withMargin = measurePrompt({ bodyBytes: 270_000, budget: resolvePromptBudget({ limit: 180_000, margin: 0.05 }) })
  assert.equal(withMargin.effectiveLimit, 171_000, '5% of 180000 is held back')
  assert.equal(withMargin.exceeded, true, 'a body that fits the limit can fail the effective one')
})

await check('body measuring skips the ratio, and a disabled budget never fires', async () => {
  const direct = measurePrompt({ bodyBytes: 300_000, budget: resolvePromptBudget({ measure: 'body', limit: 250_000, margin: 0 }) })
  assert.equal(direct.value, 300_000, 'no conversion applied')
  assert.equal(direct.exceeded, true)

  const off = measurePrompt({ bodyBytes: 10_000_000, budget: resolvePromptBudget({ enabled: false }) })
  assert.equal(off.exceeded, false, 'a disabled budget cannot refuse a dispatch')
})

await check('an over-budget request is refused before dispatch', async () => {
  // The code matters: compaction-basic reacts to CONTEXT_WINDOW_EXCEEDED by
  // compacting and retrying, so the refusal has to carry exactly that.
  state.mode = null
  state.script = ['answer']
  state.bodies = []
  const small = deps({ promptBudget: { limit: 10, margin: 0 } })
  let error
  try {
    await collect(runTurn(small, options(continuation(), { sessionId: 'session-budget' })))
  } catch (thrown) {
    error = thrown
  }
  assert.ok(error, 'the turn must fail rather than dispatch an oversized prompt')
  assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED', 'the harness compacts on this code')
  assert.match(error.message, /estimated prompt .* against an effective limit/)
  assert.equal(state.bodies.length, 0, 'nothing reached the provider')
})

server.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
