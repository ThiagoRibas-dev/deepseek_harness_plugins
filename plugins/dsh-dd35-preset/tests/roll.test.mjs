/**
 * Roll-engine and roll-tool tests.
 *
 * `mechanics.js` and `tools.js` import `@deepseek-ai/dsh-tools`, which does not
 * resolve from the bundle folder, so this file builds a throwaway copy of the
 * modules next to a one-export stub of that package and imports the copies —
 * the same rig shape `dsh-meridian-antigravity` uses.
 *
 * `Math.random` is pinned for determinism: `randInt(1, n)` with a constant `r`
 * yields `floor(r * n) + 1`, so r = 0.5 is 4 on a d6 and 11 on a d20.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = ['dice.js', 'state-store.js', 'memory-store.js', 'mechanics.js', 'tools.js', 'tables.json']

const dice = await import(pathToFileURL(join(BUNDLE, 'dice.js')).href)

let rig
const workspaces = []

before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-rig-'))
  writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const file of MODULES) cpSync(join(BUNDLE, file), join(rig, file))
  const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
  }))
  // `defineTool` is identity here; the tools under test need nothing else from it.
  writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')
})

after(() => {
  rmSync(rig, { recursive: true, force: true })
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
})

/** Load one module from the rig and return its registered tools, keyed by name. */
async function toolsOf(file, config = {}) {
  const mod = await import(pathToFileURL(join(rig, file)).href)
  const tools = new Map()
  const ctx = { tools: { register: (tool) => { tools.set(tool.name, tool) } } }
  mod.apply(ctx, config)
  return tools
}

/** A workspace with one active campaign, so the state-backed tools resolve. */
function campaignWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dd35-campaign-'))
  workspaces.push(root)
  mkdirSync(join(root, 'campaign', 'test_campaign'), { recursive: true })
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    '# Campaign Registry\n\n## Active Campaign\n- **Identifier:** `test_campaign`\n')
  return root
}

/** Run `fn` with `Math.random` pinned to `values`, repeating the last value. */
function withRandom(values, fn) {
  const original = Math.random
  let i = 0
  Math.random = () => values[Math.min(i++, values.length - 1)]
  try { return fn() } finally { Math.random = original }
}

// ---- the engine ----------------------------------------------------------

test('randInt is inclusive at both ends', () => {
  assert.equal(withRandom([0], () => dice.randInt(1, 6)), 1)
  assert.equal(withRandom([0.999999], () => dice.randInt(1, 6)), 6)
})

test('rollPool reports raw rolls in the order they came up', () => {
  const pool = withRandom([0.1, 0.9, 0.5], () => dice.rollPool(3, 10))
  assert.deepEqual(pool.raw_rolls, [2, 10, 6])
  assert.deepEqual(pool.kept_rolls, [2, 10, 6])
  assert.equal(pool.total, 18)
  assert.equal(pool.notation, '3d10')
})

test('rollPool drops then keeps', () => {
  const pool = withRandom([0.5], () => dice.rollPool(4, 6, { dropLowest: 1, keepHighest: 2 }))
  assert.deepEqual(pool.raw_rolls, [4, 4, 4, 4])
  assert.deepEqual(pool.kept_rolls, [4, 4])
  assert.equal(pool.total, 8)
})

test('rollPool rejects a non-positive pool', () => {
  assert.deepEqual(dice.rollPool(0, 6), { error: 'X and Y must be positive integers.' })
  assert.deepEqual(dice.rollPool(1, -1), { error: 'X and Y must be positive integers.' })
})

test('rollExpression parses dice, bonuses and flat numbers', () => {
  const r = (expr) => withRandom([0.5], () => dice.rollExpression(expr))
  const d8 = r('1d8+5')
  assert.deepEqual(d8.rolls, [5])
  assert.equal(d8.total, 10)
  assert.equal(r('2d6').total, 8)
  assert.equal(r('1d10-1').total, 5)
  assert.equal(r('7').total, 7)
  assert.throws(() => dice.rollExpression('fireball'), /Unsupported damage expression/)
})

test('againstDc reports success and margin', () => {
  assert.deepEqual(dice.againstDc(17, 15), { dc: 15, success: true, margin: 2 })
  assert.deepEqual(dice.againstDc(16, 20), { dc: 20, success: false, margin: -4 })
})

// ---- the unified tool surface --------------------------------------------

test('roll_dice rolls a pool with keep and drop applied', async () => {
  const tools = await toolsOf('tools.js')
  const result = withRandom([0.5], () => tools.get('roll_dice').execute({ x: 4, y: 6, drop_lowest: 1 }))
  assert.equal(result.notation, '4d6')
  assert.deepEqual(result.raw_rolls, [4, 4, 4, 4])
  assert.deepEqual(result.kept_rolls, [4, 4, 4])
  assert.equal(result.total, 12)
})

test('roll_dice adds a modifier and resolves a DC', async () => {
  const tools = await toolsOf('tools.js')
  const result = withRandom([0.5], () => tools.get('roll_dice').execute({ x: 1, y: 20, modifier: 5, dc: 20 }))
  assert.equal(result.total, 16)
  assert.equal(result.success, false)
  assert.equal(result.margin, -4)
})

test('roll_dice calls a natural 20 only on a single d20', async () => {
  const tools = await toolsOf('tools.js')
  const roll = tools.get('roll_dice')
  const single = withRandom([0.999], () => roll.execute({ x: 1, y: 20 }))
  assert.equal(single.kept_rolls[0], 20)
  assert.equal(single.critical, 'success')
  const pool = withRandom([0.999], () => roll.execute({ x: 2, y: 20 }))
  assert.equal(pool.critical, undefined)
})

test('roll_dice passes a bad pool straight through', async () => {
  const tools = await toolsOf('tools.js')
  assert.deepEqual(tools.get('roll_dice').execute({ x: 0, y: 6 }),
    { error: 'X and Y must be positive integers.' })
})

test('roll_check resolves a check against a DC', async () => {
  const tools = await toolsOf('mechanics.js')
  const result = withRandom([0.45], () =>
    tools.get('roll_check').execute({ kind: 'Reflex save', modifier: 7, dc: 15 }))
  assert.equal(result.roll, 10)
  assert.equal(result.total, 17)
  assert.equal(result.success, true)
  assert.equal(result.margin, 2)
})

test('roll_check resolves an opposed contest', async () => {
  const tools = await toolsOf('mechanics.js')
  const result = withRandom([0.0, 0.9], () =>
    tools.get('roll_check').execute({ kind: 'Move Silently', opponent: 'guard', opponent_modifier: 0 }))
  assert.equal(result.opposed, true)
  assert.equal(result.a.total, 1)
  assert.equal(result.b.total, 19)
  assert.equal(result.winner, 'guard')
})

test('roll_check re-rolls a tied opposed contest', async () => {
  const tools = await toolsOf('mechanics.js')
  const result = withRandom([0.5, 0.5, 0.0, 0.9], () =>
    tools.get('roll_check').execute({ kind: 'Grapple', opponent: 'ogre' }))
  assert.equal(result.a.total, 1)
  assert.equal(result.b.total, 19)
  assert.equal(result.winner, 'ogre')
})

test('roll_attack hits, confirms no crit, and rolls damage', async () => {
  const tools = await toolsOf('mechanics.js')
  const cwd = campaignWorkspace()
  const result = withRandom([0.5], () => tools.get('roll_attack').execute(
    { bonus: 10, target_ac: 15, damage: '1d8+3' },
    { agent: { session: { header: { cwd } } } }))
  assert.equal(result.roll, 11)
  assert.equal(result.total, 21)
  assert.equal(result.hit, true)
  assert.equal(result.critical, false)
  assert.equal(result.damage.total, 8)
})

test('the retired tool names are gone and the merged ones are present', async () => {
  const mechanics = await toolsOf('mechanics.js')
  for (const gone of ['roll_d20', 'roll_save', 'roll_skill', 'roll_opposed']) {
    assert.equal(mechanics.has(gone), false, `${gone} should no longer be registered`)
  }
  assert.equal(mechanics.has('roll_check'), true)
  assert.equal(mechanics.has('roll_attack'), true)

  const oracle = await toolsOf('tools.js')
  assert.equal(oracle.has('get_monster_ai'), false)
  assert.equal(oracle.has('roll_monster_behavior'), true)
  assert.equal(oracle.has('roll_dice'), true)
})
