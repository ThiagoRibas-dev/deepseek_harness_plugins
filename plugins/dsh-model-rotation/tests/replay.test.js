import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareMessagesForMember } from '../lib/replay.js'

const ROUTE = 'model-rotation'

function envelope(api, provider = 'mr.fast.a', model = 'model-a') {
  return {
    response: {
      kind: 'pi-ai',
      version: 2,
      api,
      provider,
      model,
      stopReason: 'stop',
    },
    blocks: [{ type: 'text' }],
  }
}

function assistant(replayState, overrides = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    source: {
      kind: 'model',
      provider: ROUTE,
      model: 'fast',
      ...replayState === undefined ? {} : { replayState },
    },
    ...overrides,
  }
}

const OPENAI = { key: 'mr.fast.a', api: 'openai-completions' }
const ANTHROPIC = { key: 'mr.fast.b', api: 'anthropic-messages' }

test('auto preserves replay when the target speaks the same protocol', () => {
  const state = envelope('openai-completions')
  const result = prepareMessagesForMember([assistant(state)], { route: ROUTE, member: OPENAI, mode: 'auto' })
  assert.equal(result.rewritten, 1)
  assert.equal(result.neutralized, 0)
  const message = result.messages[0]
  assert.equal(message.source.provider, 'mr.fast.a')
  assert.equal(message.source.model, 'model-a')
  assert.equal(message.source.replayState, state)
})

test('auto drops replay when the producer and target protocols differ', () => {
  const state = envelope('anthropic-messages')
  const result = prepareMessagesForMember([assistant(state)], { route: ROUTE, member: OPENAI, mode: 'auto' })
  assert.equal(result.rewritten, 0)
  assert.equal(result.neutralized, 1)
  const message = result.messages[0]
  assert.equal(message.source.provider, ROUTE)
  assert.equal(message.source.model, 'fast')
  assert.equal(message.source.replayState, undefined)
})

test('neutral always drops replay even for a matching protocol', () => {
  const state = envelope('openai-completions')
  const result = prepareMessagesForMember([assistant(state)], { route: ROUTE, member: OPENAI, mode: 'neutral' })
  assert.equal(result.neutralized, 1)
  assert.equal(result.messages[0].source.replayState, undefined)
})

test('preserve keeps replay across protocols', () => {
  const state = envelope('anthropic-messages')
  const result = prepareMessagesForMember([assistant(state)], { route: ROUTE, member: OPENAI, mode: 'preserve' })
  assert.equal(result.rewritten, 1)
  assert.equal(result.messages[0].source.provider, 'mr.fast.a')
  assert.equal(result.messages[0].source.replayState, state)
})

test('a state from another provider is left for pi-ai to degrade', () => {
  const state = envelope('openai-completions', 'deepseek-official', 'deepseek-flash')
  const result = prepareMessagesForMember([assistant(state)], { route: ROUTE, member: OPENAI, mode: 'auto' })
  assert.equal(result.rewritten, 0)
  assert.equal(result.neutralized, 0)
  assert.equal(result.messages[0].source.replayState, state)
})

test('messages from another route are untouched', () => {
  const state = envelope('openai-completions')
  const message = assistant(state, { source: { kind: 'model', provider: 'other', model: 'x', replayState: state } })
  const result = prepareMessagesForMember([message], { route: ROUTE, member: OPENAI, mode: 'neutral' })
  assert.equal(result.neutralized, 0)
  assert.equal(result.messages[0], message)
})

test('non-assistant messages are returned as-is', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const result = prepareMessagesForMember([user], { route: ROUTE, member: OPENAI, mode: 'neutral' })
  assert.equal(result.messages[0], user)
  assert.equal(result.rewritten + result.neutralized, 0)
})

test('a malformed envelope is ignored rather than trusted', () => {
  const broken = { response: { kind: 'pi-ai', version: 1, api: 'openai-completions' }, blocks: [] }
  const result = prepareMessagesForMember([assistant(broken)], { route: ROUTE, member: OPENAI, mode: 'neutral' })
  assert.equal(result.neutralized, 0)
  assert.equal(result.messages[0].source.replayState, broken)
})

test('a frozen input array and message are not mutated', () => {
  const state = envelope('openai-completions')
  const message = Object.freeze(assistant(state))
  const messages = Object.freeze([message])
  const result = prepareMessagesForMember(messages, { route: ROUTE, member: OPENAI, mode: 'auto' })
  assert.equal(message.source.provider, ROUTE)
  assert.notEqual(result.messages[0], message)
  assert.equal(result.messages[0].source.provider, 'mr.fast.a')
})
