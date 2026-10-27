import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureGeminiResponse, isGeminiBaseURL, recordGeminiChunk,
  replayGeminiSignatures, resetGeminiSignatures,
} from '../lib/gemini-signatures.js'

const chunk = (id, signature) => ({
  choices: [{
    delta: {
      tool_calls: [{
        index: 0,
        id,
        type: 'function',
        function: { name: 'route_turn', arguments: '{}' },
        ...signature === undefined ? {} : { extra_content: { google: { thought_signature: signature } } },
      }],
    },
    finish_reason: 'tool_calls',
  }],
})

function bodyWith(calls) {
  return {
    model: 'gemini-3.6-flash',
    messages: [{ role: 'assistant', content: null, tool_calls: calls }],
  }
}

test('only the Google OpenAI-compatible baseURL is recognised', () => {
  assert.equal(isGeminiBaseURL('https://generativelanguage.googleapis.com/v1beta/openai/'), true)
  assert.equal(isGeminiBaseURL('https://openrouter.ai/api/v1'), false)
  assert.equal(isGeminiBaseURL(undefined), false)
})

test('a streamed tool call signature is replayed on the same call id', () => {
  resetGeminiSignatures()
  recordGeminiChunk(chunk('call_1', 'sig-abc'), 'mr.Gemini.primary')
  const body = bodyWith([{ id: 'call_1', type: 'function', function: { name: 'route_turn', arguments: '{}' } }])
  replayGeminiSignatures(body, 'mr.Gemini.primary')
  assert.deepEqual(body.messages[0].tool_calls[0].extra_content, { google: { thought_signature: 'sig-abc' } })
})

test('calls without a recorded signature use the documented dummy', () => {
  resetGeminiSignatures()
  const body = bodyWith([{ id: 'call_2', type: 'function', function: { name: 'x', arguments: '{}' } }])
  replayGeminiSignatures(body, 'mr.Gemini.primary')
  assert.equal(
    body.messages[0].tool_calls[0].extra_content.google.thought_signature,
    'skip_thought_signature_validator',
  )
})

test('an existing extra_content is not overwritten', () => {
  resetGeminiSignatures()
  recordGeminiChunk(chunk('call_3', 'sig-new'), 'mr.Gemini.primary')
  const body = bodyWith([{
    id: 'call_3',
    type: 'function',
    function: { name: 'x', arguments: '{}' },
    extra_content: { google: { thought_signature: 'sig-existing' } },
  }])
  replayGeminiSignatures(body, 'mr.Gemini.primary')
  assert.equal(body.messages[0].tool_calls[0].extra_content.google.thought_signature, 'sig-existing')
})

test('the SSE capture records signatures split across chunks', async () => {
  resetGeminiSignatures()
  const payload = JSON.stringify(chunk('call_sse', 'sig-sse'))
  const sse = `data: ${payload}\n\ndata: [DONE]\n\n`
  const bytes = new TextEncoder().encode(sse)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 40))
      controller.enqueue(bytes.slice(40))
      controller.close()
    },
  })
  await captureGeminiResponse(stream, 'mr.Gemini.primary')
  const body = bodyWith([{ id: 'call_sse', type: 'function', function: { name: 'x', arguments: '{}' } }])
  replayGeminiSignatures(body, 'mr.Gemini.primary')
  assert.equal(body.messages[0].tool_calls[0].extra_content.google.thought_signature, 'sig-sse')
})

test('a signature is never replayed to a different member', () => {
  resetGeminiSignatures()
  recordGeminiChunk(chunk('call_x', 'sig-x'), 'mr.Gemini.primary')
  const body = bodyWith([{ id: 'call_x', type: 'function', function: { name: 'x', arguments: '{}' } }])
  replayGeminiSignatures(body, 'mr.Gemini.member-2')
  assert.equal(
    body.messages[0].tool_calls[0].extra_content.google.thought_signature,
    'skip_thought_signature_validator',
  )
})
