/**
 * `context-freeze` tests — one runtime-context snapshot per turn.
 *
 * The property these guard is the whole point of the module: a context whose
 * inputs change **mid-turn** must not produce new text until the turn is
 * captured. The harness appends a fresh user message whenever the joined context
 * text changes, and a mid-turn change lands between a tool call and its result —
 * the window Meridian's continuation contract watches — while every superseded
 * snapshot stays in history and is re-sent forever.
 *
 * Measured on session `4ba1929e` before this existed: 3 snapshots, 28 KB, in a
 * 2-turn session, two of them mid-batch. The two snapshots rendered the same
 * `State as of turn 143` header and differed only in the `Micro-state` line that
 * `update_scene` had just written — exactly what a turn-stable key suppresses.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { campaignTurnKey, createTurnFrozenContext } from '../context-freeze.js'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** One campaign workspace. `state` is written as `state.json` when given. */
function workspace({ id = 'test_campaign', state, registry = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-freeze-'))
  roots.push(root)
  mkdirSync(join(root, 'campaign', id), { recursive: true })
  if (registry) {
    writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
      `# Campaign Registry\n\n## Active Campaign\n- **Identifier:** \`${id}\`\n`)
  }
  if (state !== undefined) {
    writeFileSync(join(root, 'campaign', id, 'state.json'), JSON.stringify(state, null, 2))
  }
  return root
}

/** The assembly context the modules read their campaign from. */
const at = (root, session = { header: { cwd: root } }) => ({ agent: { session } })

/** A counter renderer, so "was it rendered again?" is observable. */
function counting(text) {
  let calls = 0
  return { render: () => { calls += 1; return typeof text === 'function' ? text() : text }, calls: () => calls }
}

// ---- campaignTurnKey -----------------------------------------------------

test('the key is the campaign and the last captured turn', () => {
  const root = workspace({ state: { last_turn: { number: 143 } } })
  assert.equal(campaignTurnKey(at(root)), 'test_campaign:143')
})

test('a campaign with no captured turn yet keys on 0 rather than nothing', () => {
  // The first turn still needs freezing: that block is what the DM is reading.
  const root = workspace({ state: { scene: { title: 'Opening' } } })
  assert.equal(campaignTurnKey(at(root)), 'test_campaign:0')
})

test('no active campaign means no key', () => {
  assert.equal(campaignTurnKey(at(workspace({ registry: false, state: {} }))), null)
  assert.equal(campaignTurnKey({}), null)
})

test('a malformed state.json yields no key instead of throwing', () => {
  // This runs during prompt assembly; a throw here kills the session.
  const root = workspace({ state: { last_turn: { number: 1 } } })
  writeFileSync(join(root, 'campaign', 'test_campaign', 'state.json'), '{ not json')
  assert.equal(campaignTurnKey(at(root)), null)
})

test('switching campaigns cannot alias the previous campaign\'s text', () => {
  const root = workspace({ state: { last_turn: { number: 5 } } })
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    '# Campaign Registry\n\n## Active Campaign\n- **Identifier:** `other_campaign`\n')
  mkdirSync(join(root, 'campaign', 'other_campaign'), { recursive: true })
  writeFileSync(join(root, 'campaign', 'other_campaign', 'state.json'), JSON.stringify({ last_turn: { number: 5 } }))
  assert.equal(campaignTurnKey(at(root)), 'other_campaign:5')
})

// ---- createTurnFrozenContext ---------------------------------------------

test('a missing keyOf or render is a wiring error, not a silent no-op', () => {
  assert.throws(() => createTurnFrozenContext({ render: () => '' }), TypeError)
  assert.throws(() => createTurnFrozenContext({ keyOf: () => 'k' }), TypeError)
})

test('text is rendered once and reused while the turn does not move', () => {
  const { render, calls } = counting('state A')
  const context = createTurnFrozenContext({ keyOf: () => 'c:1', render })
  const assemble = at('/tmp')
  assert.equal(context(assemble), 'state A')
  assert.equal(context(assemble), 'state A')
  assert.equal(context(assemble), 'state A')
  assert.equal(calls(), 1, 'the renderer must not run again inside the turn')
})

test('a mid-turn change is suppressed, and the next turn picks it up', () => {
  // The bug this replaces: `update_scene` rewrote state.json mid-turn and the
  // next step appended a new ~9 KB snapshot between a tool call and its result.
  let turn = 143
  let microState = 'Maude cuddles with Thiago'
  const context = createTurnFrozenContext({
    keyOf: () => `c:${turn}`,
    render: () => `State as of turn ${turn}: ${microState}`,
  })
  const assemble = at('/tmp')
  assert.equal(context(assemble), 'State as of turn 143: Maude cuddles with Thiago')

  microState = 'Maude chats with Thiago about the villagers' // update_scene runs
  assert.equal(context(assemble), 'State as of turn 143: Maude cuddles with Thiago',
    'the mid-turn mutation must not change the frozen text')

  turn = 144 // the turn is captured
  assert.equal(context(assemble), 'State as of turn 144: Maude chats with Thiago about the villagers',
    'the next turn sees the updated state')
})

test('two sessions never share a frozen snapshot', () => {
  let value = 'session one'
  const context = createTurnFrozenContext({
    keyOf: () => 'c:1',
    render: () => value,
  })
  const one = at('/tmp', { header: { cwd: '/tmp' } })
  const two = at('/tmp', { header: { cwd: '/tmp' } })
  assert.equal(context(one), 'session one')
  value = 'session two'
  assert.equal(context(two), 'session two', 'the second session renders its own text')
  assert.equal(context(one), 'session one', 'and the first keeps its own')
})

test('an assembly with no session renders every time rather than caching globally', () => {
  const { render, calls } = counting('x')
  const context = createTurnFrozenContext({ keyOf: () => 'c:1', render })
  context({})
  context({})
  assert.equal(calls(), 2)
})

test('a null key renders every time, degrading to the previous behaviour', () => {
  const { render, calls } = counting('x')
  const context = createTurnFrozenContext({ keyOf: () => null, render })
  const assemble = at('/tmp')
  context(assemble)
  context(assemble)
  assert.equal(calls(), 2)
})

test('an empty contribution is cached too, so a campaign with no state stays quiet', () => {
  const { render, calls } = counting('')
  const context = createTurnFrozenContext({ keyOf: () => 'c:1', render })
  const assemble = at('/tmp')
  assert.equal(context(assemble), '')
  context(assemble)
  assert.equal(calls(), 1)
})
