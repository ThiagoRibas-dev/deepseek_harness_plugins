/**
 * Contextual record tests (spec §12).
 *
 * `context-index.js` imports `@deepseek-ai/dsh-tools`, which does not resolve
 * from the bundle folder, so this file builds a throwaway copy of the modules
 * beside a one-export stub — the rig shape `roll.test.mjs` uses.
 *
 * These cover the pure half. The property that matters most is provenance: the
 * record must say whether presence came from the DM's own `- Entities:` line or
 * was inferred from prose, because only one of those is a fact.
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
const MODULES = ['state-store.js', 'memory-store.js', 'context-index.js']

let rig
before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-ctx-rig-'))
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

const ci = await import(pathToFileURL(join(rig, 'context-index.js')).href)

/** A parsed-transcript-shaped turn. */
const turn = (number, { entities = [], microState = null, pendingAction = null, location = null, date = null, dm = '', player = '' } = {}) =>
  ({ number, entities, microState, pendingAction, location, date, dm, player })

const matchers = [
  { id: 'thiago', re: /\b(?:thiago)\b/i, pc: true },
  { id: 'vance', re: /\b(?:vance)\b/i, pc: false },
  { id: 'kenna', re: /\b(?:kenna)\b/i, pc: false },
]

/** A built record, for the trigger tests. */
const rec = (number, actors, extra = {}) => ({
  turn: number, date: null, where: null, actors, label: null, unresolved: null,
  actor_source: 'prose', label_source: null, ...extra,
})

// ---- records -------------------------------------------------------------

test('presence from the header is marked as scene-sourced', () => {
  const [record] = ci.buildContextRecords([turn(1, { entities: ['thiago', 'vance'] })], matchers)
  assert.deepEqual(record.actors, ['thiago', 'vance'])
  assert.equal(record.actor_source, 'scene')
})

test('presence inferred from prose is marked as such', () => {
  const [record] = ci.buildContextRecords([turn(2, { dm: 'Vance eyes the treeline.' })], matchers)
  assert.deepEqual(record.actors, ['vance'])
  assert.equal(record.actor_source, 'prose', 'an inferred mention is not a recorded presence')
})

test('an entity named twice is recorded once per turn', () => {
  // The live campaign has `thiago` in both player/ and actors/; a matcher per id
  // keeps co-occurrence counts honest.
  const [record] = ci.buildContextRecords([turn(3, { dm: 'Thiago and Thiago again.' })], matchers)
  assert.deepEqual(record.actors, ['thiago'])
})

test('the recorded micro-state is the label, marked scene-sourced', () => {
  const [record] = ci.buildContextRecords([turn(4, { microState: 'Maude pours cider.' })], matchers)
  assert.equal(record.label, 'Maude pours cider.')
  assert.equal(record.label_source, 'scene')
})

test('a turn with no micro-state falls back to the narration opening', () => {
  const [record] = ci.buildContextRecords(
    [turn(5, { dm: 'The door creaks open. Maude looks up sharply and says nothing at all.' })], matchers)
  assert.equal(record.label, 'The door creaks open.')
  assert.equal(record.label_source, 'narration')
})

test('a turn with neither is left unlabelled rather than invented', () => {
  const [record] = ci.buildContextRecords([turn(6, {})], matchers)
  assert.equal(record.label, null)
  assert.equal(record.label_source, null)
})

test('an over-long opening is clipped, not truncated mid-word without a mark', () => {
  const [record] = ci.buildContextRecords([turn(7, { dm: `${'x'.repeat(400)}.` })], matchers, { labelMaxChars: 40 })
  assert.ok(record.label.length <= 41)
  assert.ok(record.label.endsWith('…'))
})

test('a pending action is carried as unresolved business', () => {
  const [record] = ci.buildContextRecords([turn(8, { pendingAction: 'Maude answers.' })], matchers)
  assert.equal(record.unresolved, 'Maude answers.')
})

test('records preserve turn order and tolerate an empty corpus', () => {
  const records = ci.buildContextRecords([turn(1, {}), turn(2, {}), turn(3, {})], matchers)
  assert.deepEqual(records.map((r) => r.turn), [1, 2, 3])
  assert.deepEqual(ci.buildContextRecords([], matchers), [])
  assert.deepEqual(ci.buildContextRecords(undefined), [])
})

// ---- trigger -------------------------------------------------------------

test('an actor absent past the gap is reported as returning, with the gap', () => {
  const records = [rec(10, ['vance']), rec(20, ['kenna'])]
  const returning = ci.returningActors(records, ['vance'], 100, { actorGap: 8 })
  assert.deepEqual(returning, [{ id: 'vance', lastTurn: 10, gap: 90 }])
})

test('an actor seen recently is not returning', () => {
  const records = [rec(95, ['vance'])]
  assert.deepEqual(ci.returningActors(records, ['vance'], 100, { actorGap: 8 }), [],
    'a 5-turn absence is below the gap')
})

test('a player character is never reported as returning', () => {
  // The PC is present by definition; absence from the record means the DM
  // stopped listing them, not that they left.
  const records = [rec(1, ['thiago'])]
  assert.deepEqual(ci.returningActors(records, ['thiago'], 500, { actorGap: 8, playerCharacters: ['thiago'] }), [])
})

test('an entity with no history at all does not trigger on its own', () => {
  const result = ci.findContextCandidates([rec(1, ['vance'])], { actors: ['stranger'], where: null }, 100)
  assert.equal(result.trigger, null)
})

// ---- ranking -------------------------------------------------------------

test('candidates are ranked, and each carries why it was retrieved', () => {
  const records = [
    rec(10, ['thiago', 'vance'], { where: 'Hurstwood' }),
    rec(20, ['thiago', 'vance'], { where: 'Hurstwood', unresolved: 'Owes a map.' }),
    rec(60, ['thiago', 'thorn'], { where: 'The Ridge' }),
  ]
  const result = ci.findContextCandidates(records, { actors: ['thiago', 'vance'], where: 'Hurstwood' }, 100,
    { playerCharacters: ['thiago'] })
  assert.ok(result.candidates.length > 0)
  assert.equal(result.candidates[0].turn, 20, 'shared actors + place + unfinished business ranks first')
  assert.ok(result.candidates.every((c) => c.reasons.length > 0), 'every candidate explains itself')
  assert.ok(result.candidates[0].reasons.some((r) => r.includes('unfinished')))
})

test('a shared place alone is enough to be a candidate', () => {
  const records = [
    rec(40, ['thorn'], { where: 'Hurstwood' }),
    rec(50, ['thorn'], { where: 'The Ridge' }),
    rec(90, ['thorn'], { where: 'Hurstwood' }), // the party was here until now
  ]
  // The party moves to The Ridge; record 50 matches it, record 40 does not.
  const result = ci.findContextCandidates(records, { actors: [], where: 'The Ridge' }, 100)
  assert.equal(result.trigger?.location_changed, true)
  assert.equal(result.candidates[0]?.turn, 50)
  assert.ok(result.candidates[0].reasons.includes('same place'))
  assert.ok(!result.candidates.some((c) => c.turn === 40), 'no shared actors and no place match scores nothing')
  assert.ok(!result.candidates.some((c) => c.turn === 90), 'the turn just left is inside the recent window')
})

test('a first located turn has nothing to have changed from', () => {
  const records = [rec(50, ['thorn'], { where: 'Hurstwood' })]
  assert.equal(ci.findContextCandidates(records, { actors: [], where: 'Hurstwood' }, 100).trigger, null)
})

test('turns inside the recent window are never surfaced', () => {
  const records = [rec(95, ['vance'], { where: 'Hurstwood' }), rec(10, ['vance'], { where: 'Hurstwood' })]
  const result = ci.findContextCandidates(records, { actors: ['vance'], where: 'Hurstwood' }, 100,
    { recentWindow: 20 })
  assert.deepEqual(result.candidates.map((c) => c.turn), [10], 'turn 95 is already in context')
})

test('the candidate list is capped', () => {
  const records = Array.from({ length: 20 }, (_, i) => rec(i + 1, ['vance'], { where: 'Hurstwood' }))
  const result = ci.findContextCandidates(records, { actors: ['vance'], where: 'Hurstwood' }, 100,
    { maxCandidates: 3 })
  assert.equal(result.candidates.length, 3)
})

test('no trigger produces no candidates', () => {
  const records = [rec(99, ['vance'], { where: 'Hurstwood' })]
  const result = ci.findContextCandidates(records, { actors: ['vance'], where: 'Hurstwood' }, 100)
  assert.equal(result.trigger, null)
  assert.deepEqual(result.candidates, [])
})

// ---- rendering -----------------------------------------------------------

test('the render names the turn ids a fetch can use', () => {
  const records = [rec(20, ['thiago', 'vance'], { where: 'Hurstwood', label: 'Vance gives a map.', unresolved: 'Owes a map.' })]
  const result = ci.findContextCandidates(records, { actors: ['thiago', 'vance'], where: 'Hurstwood' }, 100,
    { playerCharacters: ['thiago'] })
  const rendered = ci.renderCandidates(result)
  assert.match(rendered, /Trigger:/)
  assert.match(rendered, /turn 20/)
  assert.match(rendered, /who: thiago, vance/)
  assert.match(rendered, /what: Vance gives a map\./)
  assert.match(rendered, /open: Owes a map\./)
  assert.match(rendered, /\[20:dm\]/, 'the fetch id must be available without the DM composing it')
})

test('no trigger renders an explanation rather than an empty list', () => {
  assert.match(ci.renderCandidates({ trigger: null, candidates: [] }), /No trigger/)
})

test('turnsWith lists the turns one entity appears in', () => {
  const records = [rec(1, ['vance']), rec(2, ['kenna']), rec(3, ['vance', 'kenna'])]
  assert.deepEqual(ci.turnsWith(records, 'vance'), [1, 3])
  assert.deepEqual(ci.turnsWith(records, 'nobody'), [])
})
