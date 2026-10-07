/**
 * Does the guarded pruner actually defer?
 *
 * The unit tests beside this one cover `shouldDeferPrune`, a pure predicate that
 * is easy to get right and that nothing in the live path is obliged to call. What
 * they cannot show is whether `GuardedToolResultPruner.pruneSession` — the method
 * `BasicCompactionEngine` actually invokes through `ctx.get('toolResultPruner')`
 * (`compaction-basic/src/index.ts:292`) — reaches that predicate at all, and
 * whether the harness's real pairing cuts agree with the assumption the predicate
 * rests on: that a surface ending on a tool result is mid-turn.
 *
 * So every case here builds a real `Session`, runs the real shipped pruner as a
 * control, and then runs the guarded one on the same shape.
 *
 * Needs the module-resolution rig: `./tests/run.sh`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

import { GuardedCompactionEngine } from '../engine.js'
import { GuardedToolResultPruner } from '../pruner.js'

/** Over-budget for the fixture's 200-character result, so the control really prunes. */
const BUDGET = { thresholdChars: 50, headChars: 4, tailChars: 3 }

/** The guard's fields on top of the parent's budget. */
const GUARD = { ...BUDGET, deferWhenBatchPending: true, contractProviders: ['meridian-antigravity'] }

/** A context whose services self-register, enough for a pruner to be constructed. */
function context() {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

/**
 * One completed tool step, optionally followed by the assistant's reply.
 *
 * @param options - `answered` appends an assistant text message after the result,
 *   which is the only shape the guard is allowed to rewrite; `provider` is what
 *   the session's last request header routed to.
 * @returns a session whose surface tail is the tool result, or the reply.
 */
function sessionWithToolStep({ answered = false, provider = 'meridian-antigravity' } = {}) {
  const suffix = `${provider}-${answered ? 'answered' : 'open'}`
  const session = Session.create(SessionId(`guard-${suffix}`))
  const callId = ToolCallId('c1')
  const source = { kind: 'model', provider, model: `${provider}-model` }

  session.append('request/header', {
    header: { config: { provider, model: `${provider}-model` } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source,
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  if (answered) {
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source,
      }),
    }, { surfaceOp: 'append' })
  } else {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return session
}

/** The pruner the engine reaches through the service, as the loader would mount it. */
function guarded(config = GUARD) {
  const ctx = context()
  const pruner = new GuardedToolResultPruner(ctx, config)
  return { ctx, pruner }
}

test('the shipped pruner prunes this fixture, so the control is real', () => {
  const result = new ToolResultPruner(context(), BUDGET).pruneSession(sessionWithToolStep())
  assert.equal(result.pruned.length, 1, 'the 200-character result must be over the 50-character budget')
})

test('the guarded pruner is the service the engine resolves', () => {
  // `compaction-basic` reads `ctx.get('toolResultPruner')` and calls the method on
  // what it finds, so the check has to go through that resolution rather than
  // through the instance this test constructed.
  const { ctx } = guarded()
  const resolved = ctx.get('toolResultPruner')
  assert.ok(resolved instanceof GuardedToolResultPruner, 'the guarded class must provide that service')
  assert.equal(typeof resolved.pruneSession, 'function')
  assert.deepEqual(
    resolved.pruneSession(sessionWithToolStep()).pruned,
    [],
    'the service the engine resolves must be the one that defers',
  )
})

test('a surface ending on an unanswered tool result is deferred', () => {
  const session = sessionWithToolStep()
  const before = session.snapshotEvents().length
  const { pruner } = guarded()
  const result = pruner.pruneSession(session)

  assert.deepEqual(result.pruned, [], 'the guard must not rewrite a delivered prefix')
  assert.equal(result.charsRemoved, 0)
  assert.equal(session.snapshotEvents().length, before, 'a deferred pass may append nothing')
})

test('the deferral is the guard, not an inert pruner', () => {
  // Same session shape and same budget as the deferred case, differing only in
  // the answer: a guard that had simply stopped working would show up here.
  const session = sessionWithToolStep({ answered: true })
  const { pruner } = guarded()
  const result = pruner.pruneSession(session)
  assert.equal(result.pruned.length, 1, 'a completed assistant turn is safe to rewrite')
})

test('a route outside contractProviders is pruned as before', () => {
  const session = sessionWithToolStep({ provider: 'deepseek-official' })
  const result = guarded().pruner.pruneSession(session)
  assert.equal(result.pruned.length, 1)
})

test('the deferral switch turns it off', () => {
  const session = sessionWithToolStep()
  const result = guarded({ ...BUDGET, deferWhenBatchPending: false }).pruner.pruneSession(session)
  assert.equal(result.pruned.length, 1)
})

test('an unmatched tool result is deferred rather than throwing', () => {
  // `toolPairingBalancedBefore` throws on a corrupt surface; "cannot tell" must
  // read as mid-turn, because a throw here would abort the compaction pass.
  const session = sessionWithToolStep({ answered: true })
  session.append('tool/result', {
    turn: 1,
    step: 3,
    message: createToolResultMessage({
      callId: ToolCallId('c-missing'),
      content: [{ type: 'text', text: 'y'.repeat(200) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  const result = guarded().pruner.pruneSession(session)
  assert.deepEqual(result.pruned, [])
})

test('guard state survives the service shadow, which is why it is not #private', () => {
  // Cordis calls a service method with a shadow receiver, so a `#private` field
  // read inside it throws. Both guards keep their state in public fields for that
  // reason; this pins the read path the engine depends on.
  const { ctx } = guarded()
  const resolved = ctx.get('toolResultPruner')
  assert.equal(typeof resolved.guard, 'object')
  assert.deepEqual(resolved.guard.contractProviders, ['meridian-antigravity'])
  assert.equal(
    Object.getOwnPropertyNames(resolved).includes('guard'),
    true,
    'a shadow must still reach the instance field',
  )
})

test('the engine guard state is reachable through its service too', () => {
  const ctx = context()
  new GuardedCompactionEngine(ctx, {})
  const resolved = ctx.get('compaction')
  assert.equal(typeof resolved.guard, 'object')
  assert.equal(typeof resolved.summarize, 'function')
})
