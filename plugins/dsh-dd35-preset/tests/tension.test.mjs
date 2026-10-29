/**
 * Tension tick tests — persistence and delivery (REC-1).
 *
 * The arithmetic lives in `oracles.test.mjs`; this file covers the two things
 * the arithmetic cannot prove on its own:
 *
 *   1. **The roll is written where the next turn can see it.** The tick runs at
 *      `agent/turn-stopping`, before the turn is committed, so it reads the state
 *      as the turn ended and writes the event back for the turn after.
 *   2. **The event is delivered for exactly one turn.** An event that lingered
 *      would re-inject the same scene every turn; one delivered a turn late would
 *      describe a moment the table has already left.
 *
 * `tension.js` imports nothing from the harness, so no stub rig is needed — the
 * same shape `context-freeze.test.mjs` uses.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')

const store = await import(pathToFileURL(join(BUNDLE, 'state-store.js')).href)
const core = await import(pathToFileURL(join(BUNDLE, 'oracle-core.js')).href)
const tension = await import(pathToFileURL(join(BUNDLE, 'tension.js')).href)

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const CAMPAIGN = 'seventh_moon'

/**
 * One workspace with a bound campaign whose `state.json` holds `state`.
 *
 * The session is created after `SESSION_BINDING_SINCE` and carries an explicit
 * binding, so resolution never falls through to the registry.
 */
function workspace(state) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-tension-'))
  roots.push(root)
  for (const dir of ['player', 'actors']) mkdirSync(join(root, 'campaign', CAMPAIGN, dir), { recursive: true })
  writeState(root, state)
  writeFileSync(join(root, 'campaign', 'session_campaigns.json'), JSON.stringify({
    version: 1,
    sessions: { 's-new': { campaign: CAMPAIGN, boundAt: '2026-10-20T00:00:00.000Z' } },
  }))
  return root
}

const stateFile = (root) => join(root, 'campaign', CAMPAIGN, 'state.json')
const writeState = (root, state) => writeFileSync(stateFile(root), JSON.stringify(state, null, 2))
const readState = (root) => JSON.parse(readFileSync(stateFile(root), 'utf8'))

const session = (root) => ({ header: { id: 's-new', cwd: root, createdAt: store.SESSION_BINDING_SINCE + 60_000 } })
const assemble = (root) => ({ agent: { session: session(root) } })

/** A ctx just wide enough for `rollTick` and `apply`. */
function fakeCtx() {
  const hooks = new Map()
  const contexts = []
  const warnings = []
  return {
    hooks,
    contexts,
    warnings,
    logger: { debug() {}, info() {}, warn: (message) => warnings.push(message) },
    on: (event, handler) => hooks.set(event, handler),
    effect: (factory) => factory(),
    systemPrompt: { context: (entry) => contexts.push(entry) },
  }
}

// ---- the roll ------------------------------------------------------------

test('the tick writes every tier and no event on a quiet turn', () => {
  const root = workspace({ campaign: CAMPAIGN, mode: 'exploration', last_turn: { number: 9 } })
  // A DC of 400 for every tier cannot be met by d100, d200 or d500.
  writeState(root, { ...readState(root), tension: { tiers: { ambient: { dc: 400 }, tactical: { dc: 400 }, world: { dc: 400 } } } })
  const ctx = fakeCtx()
  const event = tension.rollTick(ctx, session(root))
  assert.equal(event, null)
  const state = readState(root)
  assert.deepEqual(Object.keys(state.tension.tiers).sort(), ['ambient', 'tactical', 'world'])
  assert.equal(state.tension.pending, null)
  assert.equal(state.tension.tiers.ambient.dc, 397, 'ambient decays by 3')
})

test('a scheduled event records the turn it follows, so it can expire', () => {
  const root = workspace({ campaign: CAMPAIGN, last_turn: { number: 1 } })
  const ctx = fakeCtx()
  // Each turn re-seeds from its own number. Walking forward until the dice
  // intrude is the honest way to reach a firing tick: it is the same path play
  // takes, and by turn 30 the ambient DC is at the floor.
  for (let number = 1; number <= 50; number += 1) {
    writeState(root, { ...readState(root), last_turn: { number } })
    const event = tension.rollTick(ctx, session(root))
    const state = readState(root)
    if (event === null) {
      assert.equal(state.tension.pending, null, `turn ${number}: no event means no pending`)
      continue
    }
    assert.equal(state.tension.pending.after_turn, number)
    assert.equal(state.tension.pending.line, event.line)
    assert.equal(state.tension.pending.tag, event.tag)
    return
  }
  assert.fail('50 turns produced no tension event')
})

test('a campaign with no captured turn is not rolled', () => {
  const root = workspace({ campaign: CAMPAIGN, mode: 'exploration', last_turn: null })
  const ctx = fakeCtx()
  assert.equal(tension.rollTick(ctx, session(root)), null)
  assert.equal(readState(root).tension, undefined, 'setup-phase campaigns stay untouched')
})

test('an unbound session records nothing rather than filing under another campaign', () => {
  const root = workspace({ campaign: CAMPAIGN, last_turn: { number: 4 } })
  const stranger = { header: { id: 's-stranger', cwd: root, createdAt: store.SESSION_BINDING_SINCE + 60_000 } }
  assert.equal(tension.rollTick(fakeCtx(), stranger), null)
  assert.equal(readState(root).tension, undefined)
})

// ---- the snapshot --------------------------------------------------------

/**
 * The state as it looks during the turn that should show the event.
 *
 * `rolledAfter` is the last committed turn when the tick ran, which is why the
 * fixture's `last_turn` is one past it: the event belongs to the turn that
 * follows the one it was rolled while finishing.
 */
const pendingState = (rolledAfter, line = '[SURPRISE EVENT] A door that moved; empty and cold.') => ({
  campaign: CAMPAIGN,
  last_turn: { number: rolledAfter + 1 },
  tension: {
    tiers: {},
    pending: { tier: 'ambient', tag: '[SURPRISE EVENT]', line, after_turn: rolledAfter },
  },
})

test('the event renders on the turn right after it was rolled', () => {
  const root = workspace(pendingState(7))
  const text = tension.tensionContext(assemble(root), { maxBytes: 1024 })
  assert.equal(text, `${tension.PENDING_HEADING}\n[SURPRISE EVENT] A door that moved; empty and cold.`)
})

test('the event is gone on the following turn', () => {
  const root = workspace(pendingState(7))
  writeState(root, { ...readState(root), last_turn: { number: 9 } })
  assert.equal(tension.tensionContext(assemble(root), { maxBytes: 1024 }), '')
})

test('a pending block from before the last captured turn never renders', () => {
  // `after_turn` older than last_turn - 1 is a stale block; replaying it would
  // describe a scene the table has already played past.
  const root = workspace(pendingState(3))
  writeState(root, { ...readState(root), last_turn: { number: 9 } })
  assert.equal(tension.tensionContext(assemble(root), { maxBytes: 1024 }), '')
})

test('a quiet turn renders nothing at all', () => {
  const root = workspace({ campaign: CAMPAIGN, last_turn: { number: 7 }, tension: { tiers: {}, pending: null } })
  assert.equal(tension.tensionContext(assemble(root), { maxBytes: 1024 }), '')
})

test('a malformed state file contributes nothing instead of throwing', () => {
  const root = workspace(pendingState(7))
  writeFileSync(stateFile(root), '{ not json')
  assert.equal(tension.tensionContext(assemble(root), { maxBytes: 1024 }), '')
})

test('an unbound session renders nothing', () => {
  const root = workspace(pendingState(7))
  const stranger = { header: { id: 's-stranger', cwd: root, createdAt: store.SESSION_BINDING_SINCE + 60_000 } }
  assert.equal(tension.tensionContext({ agent: { session: stranger } }, { maxBytes: 1024 }), '')
})

test('a long line is capped with a visible notice', () => {
  const root = workspace(pendingState(7, `[SURPRISE EVENT] ${'x'.repeat(2000)}`))
  const text = tension.tensionContext(assemble(root), { maxBytes: 256 })
  assert.ok(Buffer.byteLength(text, 'utf8') <= 256 + 64, `rendered ${Buffer.byteLength(text, 'utf8')} bytes`)
  assert.match(text, /truncated at 256 bytes/)
})

// ---- wiring --------------------------------------------------------------

test('apply registers the turn-stopping tick and one frozen context', () => {
  const ctx = fakeCtx()
  tension.apply(ctx, { maxBytes: 1024 })
  assert.ok(ctx.hooks.has('agent/turn-stopping'), 'the tick must run at the turn boundary')
  assert.equal(ctx.contexts.length, 1)
  assert.equal(ctx.contexts[0].name, 'dd35:tension')
  assert.equal(ctx.contexts[0].order, 290, 'ahead of the scene snapshot at 300')
})

test('a failing roll is logged, not thrown into the turn', () => {
  const ctx = fakeCtx()
  tension.apply(ctx, {})
  // No workspace is bound, so the tick cannot resolve a campaign; the hook must
  // still return rather than raising into the harness' turn-stopping path.
  assert.doesNotThrow(() => ctx.hooks.get('agent/turn-stopping')({ agent: { session: undefined } }))
})

test('the tier tables the tick reads are the ones tables.json ships', () => {
  for (const [tier, spec] of Object.entries(core.TENSION_TIERS)) {
    assert.match(spec.table, /^(ambient_surprise|tactical_encounter|world_event)\.csv$/, tier)
  }
})
