/**
 * Name generator tests — `generate_character_name` and `generate_place_name`.
 *
 * `names.js` imports `@deepseek-ai/dsh-tools`, which does not resolve from the
 * bundle folder, so this file builds a throwaway copy beside a one-export stub —
 * the rig shape `roll.test.mjs` and `oracles.test.mjs` use.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = ['names-data.json', 'names-core.js', 'names.js']

const rig = mkdtempSync(join(tmpdir(), 'dd35-names-rig-'))
writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
for (const file of MODULES) cpSync(join(BUNDLE, file), join(rig, file))
const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
mkdirSync(stub, { recursive: true })
writeFileSync(join(stub, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
}))
writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')

after(() => rmSync(rig, { recursive: true, force: true }))

const namesMod = await import(pathToFileURL(join(rig, 'names.js')).href)
const namesCore = await import(pathToFileURL(join(rig, 'names-core.js')).href)

/** The registered tools, keyed by name. */
function mount() {
  const tools = new Map()
  namesMod.apply({ tools: { register: (tool) => tools.set(tool.name, tool) } })
  return tools
}
const TOOLS = mount()
const charTool = (args = {}) => TOOLS.get('generate_character_name').execute(args)
const placeTool = (args = {}) => TOOLS.get('generate_place_name').execute(args)

// ---- Registration & Metadata ------------------------------------------------

test('both name tools register on ctx.tools', () => {
  assert.deepEqual([...TOOLS.keys()].sort(), ['generate_character_name', 'generate_place_name'])
  assert.equal(namesMod.name, 'dd35-names')
  assert.deepEqual(namesMod.inject, ['tools'])
})

// ---- Character Name Generation ----------------------------------------------

test('generate_character_name defaults to human_fantasy with count 1', () => {
  const res = charTool()
  assert.equal(res.culture, 'human_fantasy')
  assert.equal(res.count, 1)
  assert.equal(Array.isArray(res.names), true)
  assert.equal(res.names.length, 1)
  assert.equal(typeof res.names[0], 'string')
  assert.ok(res.names[0].length > 0)
})

test('every supported character culture generates valid names', () => {
  for (const culture of namesCore.CHARACTER_CULTURES) {
    const res = charTool({ culture, count: 2, seed: 12345 })
    assert.equal(res.culture, culture === 'fantasy' ? 'human_fantasy' : culture)
    assert.equal(res.count, 2)
    assert.equal(res.names.length, 2)
    for (const n of res.names) {
      assert.equal(typeof n, 'string', `Culture ${culture} should generate string names`)
      assert.ok(n.length > 0, `Culture ${culture} name should not be empty`)
      assert.ok(!n.includes('undefined'), `Culture ${culture} name must not contain undefined: ${n}`)
    }
  }
})

test('surname: false omits surnames for cultures that support them', () => {
  const withSurname = charTool({ culture: 'dwarf', surname: true, seed: 777 })
  const withoutSurname = charTool({ culture: 'dwarf', surname: false, seed: 777 })
  assert.equal(withSurname.names.length, 1)
  assert.equal(withoutSurname.names.length, 1)
  assert.ok(withSurname.names[0].includes(' '), 'Dwarf with surname contains space')
  assert.ok(!withoutSurname.names[0].includes(' '), 'Dwarf without surname contains no space')
})

test('gender options produce valid names across female and male', () => {
  const female = charTool({ culture: 'celtic', gender: 'female', seed: 101 })
  const male = charTool({ culture: 'celtic', gender: 'male', seed: 101 })
  assert.ok(female.names[0].length > 0)
  assert.ok(male.names[0].length > 0)
  assert.notEqual(female.names[0], male.names[0])
})

test('martin Westeros culture generates distinct female and male names from parsed author dataset', () => {
  const female = charTool({ culture: 'martin', gender: 'female', count: 5, seed: 42 })
  const male = charTool({ culture: 'martin', gender: 'male', count: 5, seed: 42 })
  assert.equal(female.names.length, 5)
  assert.equal(male.names.length, 5)
  assert.notDeepEqual(female.names, male.names)
  for (const n of female.names) {
    assert.ok(n.length > 0)
    assert.ok(!n.includes('undefined'))
  }
})

test('howard subcultures generate authentic Hyborian names', () => {
  for (const sub of namesCore.HOWARD_SUBCULTURES) {
    const res = charTool({ culture: 'howard', subculture: sub, seed: 999 })
    assert.equal(res.names.length, 1)
    assert.ok(res.names[0].length > 0)
    assert.ok(!res.names[0].includes('undefined'), `Subculture ${sub} must not include undefined`)
  }
})

test('character generator deterministic PRNG with seed', () => {
  const run1 = charTool({ culture: 'elf', count: 3, seed: 42 })
  const run2 = charTool({ culture: 'elf', count: 3, seed: 42 })
  const run3 = charTool({ culture: 'elf', count: 3, seed: 99 })

  assert.deepEqual(run1.names, run2.names, 'Identical seed must yield identical names')
  assert.notDeepEqual(run1.names, run3.names, 'Different seeds should yield different names')
  assert.equal(run1.seed, 42)
})

test('character count clamping strictly bounds to [1, 10]', () => {
  assert.equal(charTool({ count: 0 }).count, 1)
  assert.equal(charTool({ count: -5 }).count, 1)
  assert.equal(charTool({ count: 15 }).count, 10)
  assert.equal(charTool({ count: 'not-a-number' }).count, 1)
  assert.equal(charTool({ count: 5 }).count, 5)
  assert.equal(charTool({ count: 5 }).names.length, 5)
})

// ---- Place Name Generation --------------------------------------------------

test('generate_place_name defaults to settlement with count 1', () => {
  const res = placeTool()
  assert.equal(res.category, 'settlement')
  assert.equal(res.count, 1)
  assert.equal(res.names.length, 1)
  assert.equal(typeof res.names[0], 'string')
  assert.ok(res.names[0].length > 0)
})

test('every place category generates valid names', () => {
  for (const category of namesCore.PLACE_CATEGORIES) {
    const res = placeTool({ category, count: 2, seed: 555 })
    assert.equal(res.category, category)
    assert.equal(res.count, 2)
    assert.equal(res.names.length, 2)
    for (const n of res.names) {
      assert.equal(typeof n, 'string', `Category ${category} should generate string names`)
      assert.ok(n.length > 0, `Category ${category} name should not be empty`)
      assert.ok(!n.includes('undefined'), `Category ${category} name must not contain undefined: ${n}`)
    }
  }
})

test('settlement category with terrain generates valid names', () => {
  const res = placeTool({ category: 'settlement', terrain: 'coast', seed: 123 })
  assert.equal(res.category, 'settlement')
  assert.ok(res.names[0].length > 0)
})

test('realm category supports realm_type flavors', () => {
  for (const rt of namesCore.REALM_TYPES) {
    const res = placeTool({ category: 'realm', realm_type: rt, seed: 789 })
    assert.equal(res.category, 'realm')
    assert.equal(res.realm_type, rt)
    assert.ok(res.names[0].length > 0)
    assert.ok(!res.names[0].includes('undefined'))
  }
})

test('ancestral category supports all ancestral cultures', () => {
  for (const ac of namesCore.ANCESTRAL_CULTURES) {
    const res = placeTool({ category: 'ancestral', ancestral_culture: ac, seed: 321 })
    assert.equal(res.category, 'ancestral')
    assert.equal(res.ancestral_culture, ac)
    assert.ok(res.names[0].length > 0)
    assert.ok(!res.names[0].includes('undefined'))
  }
})

test('terrain category supports 13 terrains and themes', () => {
  for (const terr of namesCore.TERRAINS) {
    const res = placeTool({ category: 'terrain', terrain: terr, theme: 'haunted', seed: 654 })
    assert.equal(res.category, 'terrain')
    assert.equal(res.terrain, terr)
    assert.equal(res.theme, 'haunted')
    assert.ok(res.names[0].length > 0)
    assert.ok(!res.names[0].includes('undefined'))
  }
})

test('place generator deterministic PRNG with seed', () => {
  const run1 = placeTool({ category: 'settlement', count: 3, seed: 42 })
  const run2 = placeTool({ category: 'settlement', count: 3, seed: 42 })
  const run3 = placeTool({ category: 'settlement', count: 3, seed: 99 })

  assert.deepEqual(run1.names, run2.names, 'Identical seed must yield identical place names')
  assert.notDeepEqual(run1.names, run3.names, 'Different seeds should yield different place names')
  assert.equal(run1.seed, 42)
})

test('place count clamping strictly bounds to [1, 10]', () => {
  assert.equal(placeTool({ count: 0 }).count, 1)
  assert.equal(placeTool({ count: -3 }).count, 1)
  assert.equal(placeTool({ count: 20 }).count, 10)
  assert.equal(placeTool({ count: 4 }).count, 4)
  assert.equal(placeTool({ count: 4 }).names.length, 4)
})

// ---- PRNG Algorithm Tests ---------------------------------------------------

test('mulberry32 produces uniform numbers inside [0, 1)', () => {
  const rng = namesCore.mulberry32(12345)
  for (let i = 0; i < 1000; i++) {
    const val = rng()
    assert.ok(val >= 0 && val < 1, `Value ${val} outside [0, 1)`)
  }
})

// ---- Second-Pass Audit Regression Tests -------------------------------------

test('old_english character names generate proper title-case dithematic compounds', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const res = charTool({ culture: 'old_english', surname: false, seed })
    assert.equal(res.names.length, 1)
    const name = res.names[0]
    assert.match(name, /^[A-Z][a-z]+$/, `Old English compound name "${name}" must be title-cased with no internal capital letters`)
  }
})

test('names-data.json dataset integrity: Martin split, regions, and clean tokens', () => {
  const namesData = JSON.parse(readFileSync(join(BUNDLE, 'names-data.json'), 'utf8'))
  // Martin gender split verification
  assert.equal(namesData.characters.authors.martin.female.length, 57)
  assert.equal(namesData.characters.authors.martin.male.length, 301)

  // Terrain regions verification
  assert.deepEqual(namesData.places.terrains.ocean.regions, ['Ocean', 'Sea', 'Deep', 'Reach', 'Waters', 'Expanse'])
  assert.equal(namesData.places.terrains.plains.regions.length, 11)

  // Instruction & header artifact absence
  const raw = JSON.stringify(namesData)
  assert.ok(!raw.includes('Die roller'), 'Dataset must not contain die roller artifacts')
  assert.ok(!raw.includes('On the Coast: Roll 1d'), 'Dataset must not contain coastal roller instructions')
  assert.ok(!namesData.places.terrains.lake.regions.includes('Greater'), 'Lake regions must not contain Greater header')
  assert.ok(!namesData.places.terrains.lake.regions.includes('Smaller'), 'Lake regions must not contain Smaller header')
  assert.ok(!namesData.places.themes.oppressed.includes('s'), 'Oppressed theme must not contain single-letter artifact')
})

test('ocean and plains terrain places generate valid names using populated regions', () => {
  const ocean = placeTool({ category: 'terrain', terrain: 'ocean', count: 3, seed: 101 })
  const plains = placeTool({ category: 'terrain', terrain: 'plains', count: 3, seed: 202 })
  assert.equal(ocean.names.length, 3)
  assert.equal(plains.names.length, 3)
  for (const n of [...ocean.names, ...plains.names]) {
    assert.ok(n.length > 0)
    assert.ok(!n.includes('undefined'))
  }
})
