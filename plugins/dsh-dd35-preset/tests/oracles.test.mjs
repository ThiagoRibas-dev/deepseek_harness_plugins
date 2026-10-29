/**
 * Oracle tests — `ask_oracle` and `consult_oracle` (FI-18, FI-19).
 *
 * `oracles.js` imports `@deepseek-ai/dsh-tools`, which does not resolve from the
 * bundle folder, so this file builds a throwaway copy beside a one-export stub —
 * the rig shape `roll.test.mjs` uses.
 *
 * The load-bearing assertions here are the two that encode measured facts about
 * this corpus:
 *
 *  - **Every preset resolves, always.** The printed range columns of
 *    `monster_reactions` (21/100), `boon_table` (58/100) and `bane_table` (55/100)
 *    do not cover their dice, so range lookup fails most of the time on them. The
 *    shipped `roll_monster_behavior` returned null on 79 of 100 mid-combat rolls.
 *  - **A coherent-row table is refused by `consult_oracle`.** Drawing twice from
 *    one is the incoherence bug the shipped generators had.
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
const MODULES = ['dice.js', 'tables.js', 'tables.json', 'oracle-core.js', 'oracles.js']

let rig
before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-oracle-rig-'))
  writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const file of MODULES) cpSync(join(BUNDLE, file), join(rig, file))
  const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
  }))
  writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')
})
after(() => rmSync(rig, { recursive: true, force: true }))

const oracles = await import(pathToFileURL(join(rig, 'oracles.js')).href)
const tables = await import(pathToFileURL(join(rig, 'tables.js')).href)
const dice = await import(pathToFileURL(join(rig, 'dice.js')).href)
const core = await import(pathToFileURL(join(rig, 'oracle-core.js')).href)

/** The registered tools, keyed by name. */
function mount() {
  const tools = new Map()
  oracles.apply({ tools: { register: (tool) => tools.set(tool.name, tool) } })
  return tools
}
const TOOLS = mount()
const ask = (args) => TOOLS.get('ask_oracle').execute(args)
const consult = (args = {}) => TOOLS.get('consult_oracle').execute(args)

/** Run `fn` with `Math.random` pinned to `values`, repeating the last. */
function withRandom(values, fn) {
  const original = Math.random
  let i = 0
  Math.random = () => values[Math.min(i++, values.length - 1)]
  try { return fn() } finally { Math.random = original }
}

// ---- registration --------------------------------------------------------

test('both oracle tools register', () => {
  assert.deepEqual([...TOOLS.keys()].sort(), ['ask_oracle', 'consult_oracle'])
})

// ---- ask_oracle: DM-supplied options -------------------------------------

test('options are chosen from the list and reported with the odds', () => {
  const options = ['helps', 'refuses', 'calls for backup']
  const result = ask({ question: 'Does the guard help?', options })
  assert.ok(options.includes(result.answer), `answer off-list: ${result.answer}`)
  assert.ok(Number.isInteger(result.roll) && result.roll >= 1 && result.roll <= options.length)
  assert.equal(result.odds, '1 in 3')
  assert.equal(result.question, 'Does the guard help?')
})

test('every option is reachable', () => {
  const options = ['a', 'b', 'c', 'd']
  const seen = new Set()
  for (const r of [0, 0.3, 0.55, 0.99]) seen.add(withRandom([r], () => ask({ options })).answer)
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd'])
})

test('the last option is reachable at the top of the range', () => {
  assert.equal(withRandom([0.999999], () => ask({ options: ['a', 'b', 'c'] })).answer, 'c')
})

test('a question is optional for options', () => {
  const result = ask({ options: ['yes', 'no'] })
  assert.ok(!('question' in result))
  assert.ok(['yes', 'no'].includes(result.answer))
})

test('neither options nor preset is an error naming the presets', () => {
  const result = ask({})
  assert.match(result.error, /needs either `options`/)
  assert.ok(result.known_presets.includes('solo'))
})

// ---- ask_oracle: presets resolve, always ---------------------------------

test('every preset resolves on every roll', () => {
  // The regression this encodes: monster_reactions covers 21/100 of its die and
  // boon/bane 58/100 and 55/100, so a range lookup fails most of the time. Every
  // preset must return an outcome regardless of what the die says.
  for (const preset of Object.keys(oracles.PRESETS)) {
    for (let i = 0; i < 200; i += 1) {
      const result = ask({ preset, level: 'mid' })
      assert.ok(!result.error, `${preset} failed on draw ${i}: ${result.error}`)
    }
  }
})

test('a preset reaches its whole table, not just the rows inside a printed range', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i += 1) seen.add(ask({ preset: 'monster_reaction' }).result)
  assert.equal(seen.size, 6, 'a six-row table must yield six outcomes')
})

test('solo returns the four nuanced answers', () => {
  const seen = new Set()
  for (let i = 0; i < 400; i += 1) seen.add(ask({ preset: 'solo' }).answer)
  assert.deepEqual([...seen].sort(), ['No, and...', 'No, but...', 'Yes, and...', 'Yes, but...'])
})

test('an unknown preset is an error listing the known ones', () => {
  const result = ask({ preset: 'nope' })
  assert.match(result.error, /unknown preset/)
  assert.ok(result.known_presets.includes('random_dc'))
})

// ---- the odds cannot be steered ------------------------------------------

test('the likelihood modifier is clamped to ±2', () => {
  assert.equal(ask({ preset: 'solo', likelihood_modifier: 20 }).likelihood_modifier, 2)
  assert.equal(ask({ preset: 'solo', likelihood_modifier: -9 }).likelihood_modifier, -2)
  assert.equal(ask({ preset: 'solo', likelihood_modifier: 1 }).likelihood_modifier, 1)
})

test('an interrupt is read from the raw roll, before the modifier', () => {
  // A natural 1 or 20 must interrupt regardless of how the odds were shifted,
  // or "likely" would silently suppress a natural 1.
  const natural20 = withRandom([0.999999], () => ask({ preset: 'solo', likelihood_modifier: -2 }))
  assert.equal(natural20.raw_roll, 20)
  assert.equal(natural20.is_interrupt, true)
  assert.equal(natural20.interrupt_type, 'Random Event/Positive Interrupt')

  const natural1 = withRandom([0], () => ask({ preset: 'solo', likelihood_modifier: 2 }))
  assert.equal(natural1.raw_roll, 1)
  assert.equal(natural1.is_interrupt, true)
  assert.equal(natural1.interrupt_type, 'Combat/Negative Interrupt')
})

test('a shifted solo roll is clamped back into the table', () => {
  const result = withRandom([0.999999], () => ask({ preset: 'solo', likelihood_modifier: 2 }))
  assert.equal(result.modified_roll, 20, 'a natural 20 cannot roll off the end of the table')
  assert.ok(!result.error)
})

test('the modifier is reported, so a shifted roll is visible', () => {
  const result = ask({ preset: 'solo', likelihood_modifier: 2 })
  assert.equal(result.likelihood_modifier, 2)
  assert.ok(Number.isInteger(result.raw_roll))
  assert.ok(Number.isInteger(result.modified_roll))
})

// ---- random_dc -----------------------------------------------------------

test('random_dc honours the level category', () => {
  for (const level of ['low', 'mid', 'high']) {
    const result = ask({ preset: 'random_dc', level })
    assert.equal(result.level, level)
    assert.match(result.dc, /^DC \d+$/)
  }
})

test('random_dc defaults to the middle column', () => {
  assert.equal(ask({ preset: 'random_dc' }).level, 'mid')
})

// ---- consult_oracle ------------------------------------------------------

test('the default consultation is 3 keywords plus focus plus a muse word', () => {
  const { vectors } = consult()
  const bySource = vectors.reduce((acc, v) => ({ ...acc, [v.source]: (acc[v.source] ?? 0) + 1 }), {})
  assert.equal(bySource.keywords, 3)
  assert.equal(bySource.action, 1)
  assert.equal(bySource.detail, 1)
  assert.equal(bySource.topic, 1)
  assert.equal((bySource.muse_upright ?? 0) + (bySource.muse_inverted ?? 0), 1)
})

test('vectors changes how many keywords are drawn', () => {
  const { vectors } = consult({ vectors: 6 })
  assert.equal(vectors.filter((v) => v.source === 'keywords').length, 6)
})

test('every vector carries a value and its source', () => {
  for (const vector of consult().vectors) {
    assert.ok(typeof vector.value === 'string' && vector.value.length > 0, JSON.stringify(vector))
    assert.ok(typeof vector.source === 'string' && vector.source.length > 0)
  }
})

test('upright_only never draws from the inverted table', () => {
  for (let i = 0; i < 50; i += 1) {
    const { vectors } = consult({ upright_only: true })
    assert.ok(!vectors.some((v) => v.source === 'muse_inverted'))
  }
})

test('a coherent-row table is refused, with the reason', () => {
  // Drawing twice from one coherent-row table is the incoherence bug: the room's
  // location, encounter, object and exits stop relating to each other.
  for (const bad of ['dungeon_crawler.csv', 'plot_hook_generator.csv', 'hex_crawler.csv']) {
    const result = consult({ tables: ['keywords', bad] })
    assert.match(result.error, /not a vector table/)
    assert.match(result.why, /drawn once and read whole/)
  }
})

test('a restricted table set is honoured', () => {
  const { vectors } = consult({ tables: ['keywords', 'action'] })
  assert.deepEqual([...new Set(vectors.map((v) => v.source))].sort(), ['action', 'keywords'])
})

// ---- consult_oracle: coherent rows ---------------------------------------

test('a coherent draw returns every content column of ONE row', () => {
  // The regression: the shipped generate_plot_hook drew Objective, Adversaries
  // and Rewards from three different rows, so they were unrelated. A coherent
  // draw must return fields that belong to the same row.
  const result = consult({ coherent: 'plot_hook' })
  assert.equal(result.coherent, 'plot_hook')
  assert.ok(result.fields.Objective && result.fields.Adversaries && result.fields.Rewards)
  const rows = tables.table('plot_hook_generator.csv')
  const matching = rows.filter((row) =>
    row.Objective === result.fields.Objective
    && row.Adversaries === result.fields.Adversaries
    && row.Rewards === result.fields.Rewards)
  assert.equal(matching.length, 1, 'the three fields must come from exactly one real row')
})

test('every coherent table draws whole rows', () => {
  for (const key of Object.keys(oracles.COHERENT_TABLES)) {
    const result = consult({ coherent: key })
    assert.ok(!result.error, `${key}: ${result.error}`)
    assert.ok(Object.keys(result.fields).length > 1, `${key} returned a single field`)
    const columns = tables.contentColumns(result.table)
    assert.deepEqual(Object.keys(result.fields).sort(), columns.sort(), `${key} dropped a column`)
  }
})

test('a coherent table does not leak its roll column into the fields', () => {
  for (const key of Object.keys(oracles.COHERENT_TABLES)) {
    const { fields } = consult({ coherent: key })
    for (const column of Object.keys(fields)) {
      assert.ok(!/^(Roll|d20|d6|d12|Card_Value|D6_Roll)$/.test(column), `${key} leaked ${column}`)
    }
  }
})

test('an unknown coherent table is refused with the known ones', () => {
  const result = consult({ coherent: 'weather' })
  assert.match(result.error, /not a coherent-row table/)
  assert.deepEqual(result.coherent_tables.sort(), ['dungeon_room', 'hex', 'npc', 'plot_hook'])
})

test('a coherent draw is random across calls', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) seen.add(consult({ coherent: 'dungeon_room' }).fields.Location)
  assert.ok(seen.size > 1, 'a six-row table should not return the same room every time')
})

// ---- determinism ---------------------------------------------------------

test('a seeded draw is reproducible from its seed', () => {
  const first = oracles.consult({ random: tables.seededRandom(142) })
  const second = oracles.consult({ random: tables.seededRandom(142) })
  assert.deepEqual(first, second, 'the same turn must yield the same vectors across steps')
})

test('different seeds produce different draws', () => {
  const a = oracles.consult({ random: tables.seededRandom(1) })
  const b = oracles.consult({ random: tables.seededRandom(999) })
  assert.notDeepEqual(a.vectors.map((v) => v.value), b.vectors.map((v) => v.value))
})

test('seededRandom stays inside [0, 1)', () => {
  const random = tables.seededRandom(7)
  for (let i = 0; i < 500; i += 1) {
    const value = random()
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

// ---- table layer ---------------------------------------------------------

test('every vector source resolves to a real table, and names real columns', () => {
  // A source is one of two deliberate shapes:
  //   - **column-named** — one column of a table that holds several
  //     (`focus_tables` keeps action/detail/topic side by side);
  //   - **column-random** — a table whose every content column is equally valid
  //     (`muse_upright` holds four interchangeable inspiration words).
  // What must never happen is a source that names a column the table lacks, or a
  // column-random source pointing at a table that mixes roll columns with content.
  const columnRandom = new Set(['muse_upright', 'muse_inverted'])
  for (const [key, source] of Object.entries(tables.VECTOR_TABLES)) {
    const columns = tables.contentColumns(source.table)
    assert.ok(columns.length > 0, `${key}: ${source.table} has no content columns`)
    if (source.column === null) {
      assert.ok(columnRandom.has(key),
        `${key} names no column, which is only valid for a wholly interchangeable table`)
    } else {
      assert.ok(columns.includes(source.column), `${key}: ${source.table} has no column ${source.column}`)
    }
  }
})

test('a column-random source draws from every one of its columns', () => {
  const seen = new Set()
  for (let i = 0; i < 400; i += 1) {
    const vector = tables.drawVector('muse_upright')
    assert.equal(vector.source, 'muse_upright')
    if (vector.column !== undefined) seen.add(vector.column)
  }
  assert.equal(seen.size, 4, 'all four muse columns should be reachable')
})

test('the oracle table is read through its separate min/max columns', () => {
  const { row, matched } = tables.rowByRange('oracle_table.csv', 'MinRoll', 17, 'MaxRoll')
  assert.equal(matched, true)
  assert.equal(row.Answer, 'Yes')
})

test('an uncovered roll reports itself unmatched rather than guessing', () => {
  // monster_reactions covers 1-4, 9-12, 29-32, 72, 77-80 and 97-100; 5 falls in a
  // gap. The caller must handle a miss — which is why the presets draw uniformly
  // instead of by range.
  const { matched } = tables.rowByRange('monster_reactions.csv', 'Range', 5)
  assert.equal(matched, false, '5 is outside the printed ranges — the caller must handle it')
})

test('rowAt always returns a row from a non-empty table', () => {
  for (const name of tables.tableNames()) {
    if (tables.table(name).length === 0) continue
    assert.ok(tables.rowAt(name) !== null, name)
  }
})

test('dice.js still supplies real randomness for play', () => {
  // The seeded stream is for reproducible injection only; live rolls stay random.
  assert.notEqual(dice.rollD20, undefined)
  const rolls = new Set()
  for (let i = 0; i < 200; i += 1) rolls.add(dice.rollD20())
  assert.ok(rolls.size > 5, 'a live d20 should not repeat a handful of values')
})

// ---- the tension tick (REC-1) -------------------------------------------
//
// The tick is the reason three tables were added to `tables.json`: `ambient`,
// `tactical` and `world` each draw a whole row when their tier fires. These
// cases pin the arithmetic, because a decay bug is invisible in play for dozens
// of turns and only shows up as "the ambushes never stop".

const tierNames = () => Object.keys(core.TENSION_TIERS)

test('every tension tier draws from a populated vocabulary', () => {
  for (const [tier, spec] of Object.entries(core.TENSION_TIERS)) {
    assert.equal(tables.table(spec.table).length, 10, `${tier} -> ${spec.table}`)
  }
})

test('a first tick compares against each tier start DC without decaying it', () => {
  const { tiers } = core.evaluateTensionTick({ last_turn: { number: 1 } }, 1)
  for (const [tier, spec] of Object.entries(core.TENSION_TIERS)) {
    assert.equal(tiers[tier].dc_at_roll, spec.dc, tier)
    assert.equal(tiers[tier].die, spec.die, tier)
  }
})

test('a quiet tier decays by its printed amount; a fired tier resets to its start', () => {
  const carried = { tiers: { ambient: { dc: 60 }, tactical: { dc: 60 }, world: { dc: 60 } } }
  const { tiers, event } = core.evaluateTensionTick({ tension: carried, last_turn: { number: 9 } }, 9)
  for (const [tier, spec] of Object.entries(core.TENSION_TIERS)) {
    const entry = tiers[tier]
    assert.equal(entry.dc_at_roll, Math.max(core.TENSION_FLOOR, 60 - spec.decay), tier)
    assert.equal(entry.triggered, entry.roll >= entry.dc_at_roll, tier)
    assert.equal(entry.dc, entry.triggered ? spec.dc : entry.dc_at_roll, tier)
  }
  assert.equal(event === null, tierNames().every((tier) => !tiers[tier].triggered))
})

test('the DC stops at the floor instead of decaying to nothing', () => {
  const carried = { tiers: { ambient: { dc: 6 }, tactical: { dc: 6 }, world: { dc: 6 } } }
  const { tiers } = core.evaluateTensionTick({ tension: carried }, 4)
  for (const tier of tierNames()) assert.equal(tiers[tier].dc_at_roll, core.TENSION_FLOOR, tier)
})

test('the same state and seed produce the same tick', () => {
  const state = { tension: { tiers: { ambient: { dc: 77 } } }, last_turn: { number: 12 } }
  assert.deepEqual(core.evaluateTensionTick(state, 12), core.evaluateTensionTick(state, 12))
})

test('the larger tier is the one delivered when several fire together', () => {
  // At the floor every die has ~96% to fire, so a seed that fires two is easy to
  // find and the assertion never rests on one lucky roll.
  const carried = { tiers: { ambient: { dc: 5 }, tactical: { dc: 5 }, world: { dc: 5 } } }
  for (let seed = 1; seed <= 200; seed += 1) {
    const { tiers, event } = core.evaluateTensionTick({ tension: carried }, seed)
    const fired = core.TENSION_PRIORITY.filter((tier) => tiers[tier].triggered)
    if (fired.length < 2) continue
    assert.equal(event.tier, fired[0], 'priority is world > tactical > ambient')
    return
  }
  assert.fail('no seed in 1..200 fired two tiers at the floor')
})

test('a delivered event carries its tier tag and a usable line', () => {
  const carried = { tiers: { ambient: { dc: 5 }, tactical: { dc: 5 }, world: { dc: 5 } } }
  const { event } = core.evaluateTensionTick({ tension: carried }, 7)
  assert.ok(event !== null, 'three tiers at the floor should fire')
  assert.equal(event.tag, core.TENSION_TIERS[event.tier].tag)
  assert.ok(event.text.length > 0)
  assert.ok(event.line.startsWith(event.tag), event.line)
  assert.ok(event.line.length <= 420, `line is ${event.line.length} chars`)
})
