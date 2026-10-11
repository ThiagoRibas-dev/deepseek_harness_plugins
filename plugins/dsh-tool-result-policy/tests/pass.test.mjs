/**
 * Tool-result retention tests — the host-plane strip pass.
 *
 * The pass is the piece that makes a settings toggle govern the preset it names:
 * it runs on `agent/pre-step` for every session instead of living in one preset's
 * isolated pruner realm. Two properties matter more than the rest, and both
 * destroy context if they regress:
 *
 *  - **A different preset's toggle never affects this session.** Resolution is
 *    `presets[agentPreset]` → `defaults` → the bundle default, so a preset absent
 *    from the table is untouched.
 *  - **A turn that is still running is never rewritten.** `read`/`roll_dice`
 *    results are the numbers the next step is about to narrate; eliding them
 *    mid-turn breaks the turn that asked for them.
 *
 * `pass.js` imports only pure code, so the session and the pairing cuts are
 * doubles and no harness rig is needed. Run with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PASS_NOOP, createPrunePass } from '../pass.js'
import { elisionMarker } from '../policy.js'

/**
 * A minimal Session double: surface nodes, event lookup, and an append log.
 *
 * Shaped like the real Session — tool names come from `tool-call` blocks on an
 * `assistant/message` surface node, and there is no `events` property and no
 * `tokenMeter`. See `prune-core.test.mjs` and `lessons-learned.md` §6.8 for why
 * inventing those two properties hid the strip and the shadow price respectively.
 */
function makeSession({ preset = 'dd35', calls = [], results = [] } = {}) {
  const bySeq = new Map()
  const surface = { nodes: [] }
  let seq = 90
  /** Append an assistant message carrying one tool-call block. */
  const pushCall = (callId, name) => {
    const at = seq++
    bySeq.set(at, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool-call', id: callId, name }] } },
    })
    surface.nodes.push(at)
    return at
  }
  for (const [callId, name] of calls) pushCall(callId, name)
  seq = 500
  for (const [callId, text] of results) {
    const at = seq++
    bySeq.set(at, { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text }] } } })
    surface.nodes.push(at)
  }
  const appended = []
  const session = {
    header: { agentPreset: preset },
    surface,
    eventAt: (n) => bySeq.get(n),
    append: (type, data, opts) => {
      const record = { seq: seq++, type, data, opts }
      appended.push(record)
      if (type === 'tool/result') {
        bySeq.set(record.seq, { type, data })
        // The replacement re-points its node, exactly as a surface op does.
        if (opts?.surfaceOp?.op === 'replace') {
          bySeq.delete(opts.surfaceOp.startSeq)
          const at = surface.nodes.indexOf(opts.surfaceOp.startSeq)
          if (at !== -1) surface.nodes[at] = record.seq
        }
      }
      return record
    },
    /** Append a call+result pair, as the next step of play would. */
    pushResult: (callId, name, text) => {
      pushCall(callId, name)
      const at = seq++
      bySeq.set(at, { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text }] } } })
      surface.nodes.push(at)
      return at
    },
    appended,
  }
  return session
}

/** Pairing cuts for a surface whose tail is a completed assistant turn. */
const turnOver = { balancedBefore: () => true, balancedAfter: () => true }
/** Pairing cuts for a surface whose tail is a tool result awaiting a continuation. */
const midTurn = { balancedBefore: () => false, balancedAfter: () => true }

/** A normalised policy carrying `presets` and one `defaults` answer. */
function policyReader({ presets = {}, defaults = false, problem = null } = {}) {
  return () => ({ policy: { version: 1, presets, defaults: { stripTransientResults: defaults } }, problem })
}

const passFor = (options = {}) => createPrunePass({
  readPolicy: policyReader(),
  policyPath: '/tmp/policy.json',
  pairing: turnOver,
  estimateTokens: () => 42,
  ...options,
})

const on = { dd35: { stripTransientResults: true } }
const off = { dd35: { stripTransientResults: false } }

// ---- wiring --------------------------------------------------------------

test('a pass without a policy reader is a wiring error, not a silent no-op', () => {
  assert.throws(() => createPrunePass({ pairing: turnOver }), TypeError)
})

test('a pass without the harness pairing cuts is a wiring error', () => {
  assert.throws(() => createPrunePass({ readPolicy: policyReader() }), TypeError)
})

test('no session is a no-op rather than a crash', () => {
  assert.deepEqual(passFor()(undefined), PASS_NOOP)
})

// ---- policy resolution ---------------------------------------------------

test('the toggle for this session\'s preset governs it', () => {
  const session = makeSession({ preset: 'dd35', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(result.ran, true)
  assert.equal(result.source, 'preset')
  assert.equal(result.agentPreset, 'dd35')
  assert.equal(result.pruned.length, 1)
})

test('another preset\'s toggle never touches this session', () => {
  // The whole point of the pass: a toggle is per preset, not global.
  const session = makeSession({ preset: 'standard', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(result.ran, false)
  assert.equal(result.reason, 'policy-off')
  assert.equal(result.source, 'defaults')
  assert.deepEqual(session.appended, [], 'nothing is rewritten')
})

test('a preset absent from the table follows defaults, not the preset beside it', () => {
  const session = makeSession({ preset: 'cordis', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: on, defaults: true }) })(session)
  assert.equal(result.ran, true)
  assert.equal(result.source, 'defaults')
})

test('an explicit off beats an on default for that preset', () => {
  const session = makeSession({ preset: 'dd35', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: off, defaults: true }) })(session)
  assert.equal(result.ran, false)
  assert.equal(result.source, 'preset')
})

test('the bundle default only answers when the table has no opinion', () => {
  const session = makeSession({ preset: 'ptc', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const policy = () => ({ policy: { version: 1, presets: {}, defaults: undefined }, problem: null })
  const result = passFor({ readPolicy: policy, fallback: true })(session)
  assert.equal(result.source, 'config')
  assert.equal(result.ran, true)
})

test('a malformed policy file is reported and treated as off, never thrown', () => {
  const seen = []
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({
    readPolicy: policyReader({ problem: 'unreadable policy file: boom' }),
    logger: { debug: (message) => seen.push(message) },
  })(session)
  assert.equal(result.ran, false)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /unreadable policy file/)
})

// ---- the turn boundary ---------------------------------------------------

test('a completed turn is rewritten', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(result.reason, 'pruned')
  assert.ok(result.charsRemoved > 400)
})

test('a running turn is deferred even with the policy on', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: on }), pairing: midTurn })(session)
  assert.equal(result.ran, false)
  assert.equal(result.reason, 'mid-turn')
  assert.deepEqual(session.appended, [])
})

test('the boundary rule does not depend on the provider', () => {
  // `shouldDeferPrune` only guards contract providers. This pass guards every
  // provider, because eliding a live turn's inputs is wrong on all of them.
  const session = makeSession({ preset: 'standard', calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const result = passFor({ readPolicy: policyReader({ presets: { standard: { stripTransientResults: true } } }), pairing: midTurn })(session)
  assert.equal(result.reason, 'mid-turn')
})

test('an empty surface is a completed turn with nothing to do', () => {
  const session = makeSession({ calls: [], results: [] })
  const result = passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(result.ran, true)
  assert.deepEqual(result.pruned, [])
})

// ---- the rewrite itself --------------------------------------------------

test('the strip marker lands and the call pairing survives', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.deepEqual(session.appended.map((a) => a.type), ['compaction/prune', 'tool/result'])
  assert.equal(session.appended[1].data.message.source.callId, 'c1')
  assert.match(session.appended[1].data.message.content[0].text, /^\[tool result elided: read/)
})

test('a second pass over the same session changes nothing more', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const pass = passFor({ readPolicy: policyReader({ presets: on }) })
  pass(session)
  const after = session.appended.length
  const again = pass(session)
  assert.deepEqual(again.pruned, [])
  assert.equal(session.appended.length, after, 'an already-elided result is not rewritten twice')
})

// ---- the high-water mark -------------------------------------------------

test('an unchanged surface is not walked again', () => {
  // `agent/pre-step` fires every step; a full walk of a 4,479-result history
  // measured ~13 ms even after stripping.
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const pass = passFor({ readPolicy: policyReader({ presets: on }) })
  assert.equal(pass(session).ran, true)
  const second = pass(session)
  assert.equal(second.ran, false)
  assert.equal(second.reason, 'unchanged')
  assert.equal(session.appended.length, 2, 'no extra rewrite')
})

test('a new result re-arms the pass', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const pass = passFor({ readPolicy: policyReader({ presets: on }) })
  pass(session)
  session.pushResult('c2', 'bash', 'y'.repeat(500))
  const again = pass(session)
  assert.equal(again.ran, true)
  assert.equal(again.pruned.length, 1)
  assert.equal(again.pruned[0].callId, 'c2')
})

test('a mid-turn deferral does not disarm the next boundary', () => {
  let mid = true
  const pairing = { balancedBefore: () => !mid, balancedAfter: () => true }
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  const pass = passFor({ readPolicy: policyReader({ presets: on }), pairing })
  assert.equal(pass(session).reason, 'mid-turn')
  mid = false
  assert.equal(pass(session).ran, true, 'the same tail is still pruned once the turn closes')
})

test('a policy-off pass records nothing, so switching the toggle on prunes at once', () => {
  const session = makeSession({ calls: [['c1', 'read']], results: [['c1', 'x'.repeat(500)]] })
  let presets = {}
  const pass = passFor({
    readPolicy: () => ({ policy: { version: 1, presets, defaults: { stripTransientResults: false } }, problem: null }),
  })
  assert.equal(pass(session).reason, 'policy-off')
  presets = on
  assert.equal(pass(session).ran, true)
})

test('an unclassified tool keeps the shipped truncation behaviour', () => {
  const session = makeSession({ calls: [['c1', 'future_plugin_tool']], results: [['c1', 'x'.repeat(20000)]] })
  passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(session.appended.length, 2, 'truncated, not deleted')
  assert.match(session.appended[1].data.message.content[0].text, /trimmed/)
})

test('the elision marker is what the policy module says it is', () => {
  const session = makeSession({ calls: [['c1', 'roll_dice']], results: [['c1', 'x'.repeat(300)]] })
  passFor({ readPolicy: policyReader({ presets: on }) })(session)
  assert.equal(session.appended[1].data.message.content[0].text, elisionMarker('roll_dice', 300))
})

test('the pass prices each prune with the meter it was given', () => {
  // `compaction/prune` records what the meter charged the node, and consumers
  // subtract it. A pass with no meter wrote `0` for every prune, leaving the
  // meter over-counting; the estimator must reach `commitPlan`.
  const seen = []
  const session = makeSession({
    calls: [['c1', 'read'], ['c2', 'list_memories']],
    results: [['c1', 'x'.repeat(500)], ['c2', 'y'.repeat(400)]],
  })
  passFor({
    readPolicy: policyReader({ presets: on }),
    estimateTokens: (message) => { seen.push(message); return 77 },
  })(session)
  const prices = session.appended.filter((a) => a.type === 'compaction/prune').map((a) => a.data.shadowedTokenCount)
  assert.deepEqual(prices, [77, 77])
  assert.equal(seen.length, 2)
})
