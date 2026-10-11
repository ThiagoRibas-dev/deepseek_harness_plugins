/**
 * Tool-result retention tests — the prune pass.
 *
 * `prune-core.js` imports only `policy.js`, so the session can be a recording
 * double and the whole pass is testable without a harness. The session protocol
 * being mirrored is documented on the module; what these tests pin is the
 * behaviour this policy adds on top of it.
 *
 * Run with `node --test` from the bundle folder.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  TRUNCATION_MARKER, commitPlan, planPrune, textOf, toolNamesByCallId, truncateContent,
} from '../prune-core.js'
import { elisionMarker } from '../policy.js'

/**
 * A minimal stand-in for a Session: surface nodes, event lookup, and an append log.
 *
 * Deliberately shaped like the **real** Session — tool names live on `tool-call`
 * blocks of an `assistant/message` surface node, and there is no `events`
 * property and no `tokenMeter`. A double that invented those two properties let
 * two production bugs through: `toolNamesByCallId` read `session.events` (absent),
 * so nothing was ever classified and the strip never fired; `commitPlan` read
 * `session.tokenMeter` (absent), so every `compaction/prune` recorded a price of
 * zero. See `lessons-learned.md` §6.8.
 */
function makeSession({ calls = [], results = [] } = {}) {
  const bySeq = new Map()
  const nodes = []
  if (calls.length > 0) {
    bySeq.set(90, {
      type: 'assistant/message',
      data: { message: { content: calls.map(([callId, name]) => ({ type: 'tool-call', id: callId, name })) } },
    })
    nodes.push(90)
  }
  let seq = 100
  for (const [callId, text] of results) {
    const at = seq++
    bySeq.set(at, { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text }] } } })
    nodes.push(at)
  }
  const appended = []
  return {
    surface: { nodes },
    eventAt: (n) => bySeq.get(n),
    append: (type, data, opts) => {
      const record = { seq: seq++, type, data, opts }
      appended.push(record)
      if (type === 'tool/result') {
        bySeq.set(record.seq, { type, data })
        if (opts?.surfaceOp?.op === 'replace') {
          bySeq.delete(opts.surfaceOp.startSeq)
          const at = nodes.indexOf(opts.surfaceOp.startSeq)
          if (at !== -1) nodes[at] = record.seq
        }
      }
      return record
    },
    appended,
  }
}

const bigText = (n) => 'x'.repeat(n)

// ---- name resolution -----------------------------------------------------

test('a result is classified by the name of the call that produced it', () => {
  const session = makeSession({ calls: [['c1', 'read'], ['c2', 'something_new']], results: [['c1', bigText(50)], ['c2', bigText(50)]] })
  const names = toolNamesByCallId(session)
  assert.equal(names.get('c1'), 'read')
  assert.equal(names.get('c2'), 'something_new')
})

test('a result whose call is unrecorded is kept, not guessed at', () => {
  const session = makeSession({ calls: [], results: [['orphan', bigText(50)]] })
  const plan = planPrune(session, { strip: true })
  assert.equal(plan[0].action, 'keep')
  assert.equal(plan[0].toolName, null)
})

// ---- stripping -----------------------------------------------------------

test('with the policy on, a transient read is replaced by the marker', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  const plan = planPrune(session, { strip: true })
  assert.equal(plan[0].action, 'strip')
  assert.equal(textOf(plan[0].content), elisionMarker('read', 500))
  assert.ok(plan[0].charsAfter < plan[0].charsBefore)
})

test('with the policy off nothing is stripped, but truncation still applies', () => {
  // Byte-identical to the shipped behaviour when the toggle is off.
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(20000)]] })
  const plan = planPrune(session, { strip: false, thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  assert.equal(plan[0].action, 'truncate')
  assert.ok(textOf(plan[0].content).includes(TRUNCATION_MARKER))
})

test('with the policy off, a small read is left completely alone', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  assert.deepEqual(planPrune(session, { strip: false }).map((e) => e.action), ['keep'])
})

test('an unclassified tool over the budget is truncated, not deleted', () => {
  const session = makeSession({ calls: [['c1', 'future_plugin_tool']], results: [['c1', bigText(20000)]] })
  const plan = planPrune(session, { strip: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  assert.equal(plan[0].action, 'truncate', 'the safety net for a tool the policy has never seen')
})

test('an unclassified tool under the budget is untouched', () => {
  const session = makeSession({ calls: [['c1', 'future_plugin_tool']], results: [['c1', bigText(100)]] })
  assert.equal(planPrune(session, { strip: true })[0].action, 'keep')
})

test('an already-elided result is not elided twice', () => {
  const marker = elisionMarker('read', 500)
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', marker]] })
  const plan = planPrune(session, { strip: true })
  assert.equal(plan[0].action, 'keep')
  assert.equal(plan[0].reason, 'already-elided')
})

test('a non-tool result node is ignored', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(50)]] })
  session.surface.nodes.push(999) // no event at this seq
  assert.equal(planPrune(session, { strip: true }).length, 1)
})

// ---- truncation ----------------------------------------------------------

test('truncation keeps a head and a tail around the marker', () => {
  const content = [{ type: 'text', text: `${'H'.repeat(50)}${'M'.repeat(200)}${'T'.repeat(50)}` }]
  const next = truncateContent(content, { headChars: 20, tailChars: 10 })
  const text = textOf(next)
  assert.ok(text.startsWith('H'.repeat(20)))
  assert.ok(text.endsWith('T'.repeat(10)))
  assert.ok(text.includes(TRUNCATION_MARKER))
})

test('truncation declines when the content is already small', () => {
  assert.equal(truncateContent([{ type: 'text', text: 'short' }], { headChars: 4096, tailChars: 1024 }), null)
})

test('truncation counts code points, so a multi-byte character is never split', () => {
  const content = [{ type: 'text', text: '😀'.repeat(300) }]
  const next = truncateContent(content, { headChars: 10, tailChars: 5 })
  const text = textOf(next)
  assert.ok([...text].every((ch) => ch === '😀' || TRUNCATION_MARKER.includes(ch)), 'no broken surrogate pair')
})

// ---- committing ----------------------------------------------------------

test('committing writes a shadow-price event before each replacement', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  const result = commitPlan(session, planPrune(session, { strip: true }), { estimateTokens: () => 42 })
  assert.equal(result.pruned.length, 1)
  const types = session.appended.map((a) => a.type)
  assert.deepEqual(types, ['compaction/prune', 'tool/result'])
  assert.equal(session.appended[0].data.shadowedTokenCount, 42, 'priced through the injected meter')
  assert.deepEqual(session.appended[1].opts.surfaceOp, { op: 'replace', startSeq: 100, endSeq: 100 })
})

// ---- the real Session shape ----------------------------------------------

test('tool names are read from the assistant message, not a session.events property', () => {
  // The real Session has no `events`; an earlier version read it and silently
  // classified nothing, so the strip never fired while every test passed.
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(50)]] })
  assert.equal('events' in session, false, 'the double must not offer a property the Session lacks')
  assert.equal(toolNamesByCallId(session).get('c1'), 'read')
})

test('no assistant message means no classification, and the result is kept', () => {
  const session = makeSession({ calls: [], results: [['c1', bigText(500)]] })
  assert.equal(planPrune(session, { strip: true })[0].action, 'keep')
})

test('a missing meter still prices a prune, rather than writing zero tokens', () => {
  // A zero price makes every consumer believe nothing was removed.
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(400)]] })
  commitPlan(session, planPrune(session, { strip: true }))
  assert.ok(session.appended[0].data.shadowedTokenCount > 0)
})

test('a stripped replacement preserves the rest of the event data', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  session.eventAt(100).data.extra = 'kept'
  commitPlan(session, planPrune(session, { strip: true }))
  const replacement = session.appended[1].data
  assert.equal(replacement.extra, 'kept')
  assert.equal(replacement.message.source.callId, 'c1', 'the call pairing must survive')
})

test('committing reports the characters removed', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  const result = commitPlan(session, planPrune(session, { strip: true }))
  assert.ok(result.charsRemoved > 400)
  assert.equal(result.pruned[0].charsBefore, 500)
})

test('several results at once are committed in descending order', () => {
  // A replacement re-points its node, so a lower sequence committed first could
  // invalidate a higher one still to come.
  const session = makeSession({
    calls: [['c1', 'read'], ['c2', 'bash'], ['c3', 'grep']],
    results: [['c1', bigText(100)], ['c2', bigText(100)], ['c3', bigText(100)]],
  })
  const before = planPrune(session, { strip: true }).map((e) => e.seq)
  commitPlan(session, planPrune(session, { strip: true }))
  const replaced = session.appended
    .filter((a) => a.opts?.surfaceOp)
    .map((a) => a.opts.surfaceOp.startSeq)
  assert.deepEqual(replaced, [...before].sort((a, b) => b - a))
})

test('a result smaller than the marker is left alone', () => {
  // Replacing five characters with a ninety-character marker would grow the
  // history, which is the opposite of the point.
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'small']] })
  assert.equal(planPrune(session, { strip: true })[0].action, 'keep')
})

test('nothing actionable commits nothing', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'small']] })
  const result = commitPlan(session, planPrune(session, { strip: true }))
  assert.deepEqual(result, { pruned: [], charsRemoved: 0 })
  assert.deepEqual(session.appended, [])
})

test('every committed replacement is strictly smaller than what it replaced', () => {
  const session = makeSession({
    calls: [['c1', 'read'], ['c2', 'roll_dice'], ['c3', 'future_tool']],
    results: [['c1', bigText(500)], ['c2', bigText(120)], ['c3', bigText(4)]],
  })
  for (const entry of planPrune(session, { strip: true })) {
    if (entry.action === 'keep') continue
    assert.ok(entry.charsAfter < entry.charsBefore,
      `${entry.toolName}: ${entry.charsBefore} -> ${entry.charsAfter}`)
  }
})

test('a keep entry is never committed even when mixed with strips', () => {
  const session = makeSession({
    calls: [['c1', 'read'], ['c2', 'future_tool']],
    results: [['c1', bigText(100)], ['c2', bigText(100)]],
  })
  const plan = planPrune(session, { strip: true })
  assert.deepEqual(plan.map((e) => e.action), ['strip', 'keep'])
  const result = commitPlan(session, plan)
  assert.equal(result.pruned.length, 1)
  assert.equal(result.pruned[0].callId, 'c1')
})

test('a plan is a pure description: planning alone changes nothing', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', bigText(500)]] })
  planPrune(session, { strip: true })
  assert.deepEqual(session.appended, [])
  assert.equal(session.eventAt(100).data.message.content[0].text.length, 500)
})

test('strips newly added name generator tools', () => {
  const session = makeSession({
    calls: [['c1', 'generate_character_name'], ['c2', 'generate_place_name']],
    results: [['c1', bigText(200)], ['c2', bigText(200)]],
  })
  const plan = planPrune(session, { strip: true })
  assert.equal(plan.length, 2)
  assert.equal(plan[0].action, 'strip')
  assert.equal(plan[1].action, 'strip')
})
