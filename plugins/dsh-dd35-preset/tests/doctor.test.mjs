/**
 * `dd35_doctor` tests.
 *
 * `doctor.js` imports `@deepseek-ai/dsh-tools`, which does not resolve from the
 * bundle folder, so this file builds a throwaway copy of the modules next to a
 * one-export stub of that package — the same rig shape `roll.test.mjs` uses.
 *
 * The load-bearing test here is the last one: the diagnostic must not write.
 * It reads through `loadState`, never `requireState`, because the latter
 * self-heals by *creating* `state.json`. A diagnostic that mutates the campaign
 * it is inspecting is worse than no diagnostic.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = ['state-store.js', 'memory-store.js', 'doctor.js']

let rig
const workspaces = []

before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-doctor-rig-'))
  writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const file of MODULES) cpSync(join(BUNDLE, file), join(rig, file))
  const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
  }))
  writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')
})

after(() => {
  rmSync(rig, { recursive: true, force: true })
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
})

const doctor = await import(pathToFileURL(join(rig, 'doctor.js')).href)
const store = await import(pathToFileURL(join(rig, 'state-store.js')).href)

const ID = 'test_campaign'

/**
 * Build a throwaway workspace containing one campaign.
 * @param options.state - `state.json` contents (defaults to a valid empty scene).
 * @param options.sheets - `{ pc: {id: sheet}, npc: {id: sheet} }`.
 * @param options.transcripts - `{ turnNumber: fileText }`.
 * @param options.index - `memory_index.json` contents.
 * @param options.registry - whether to write the registry markdown.
 * @param options.tamper - `{ path, text }` to write invalid JSON somewhere.
 */
function makeCampaign(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-doctor-ws-'))
  workspaces.push(root)
  const dir = join(root, 'campaign', ID)
  mkdirSync(join(dir, 'player'), { recursive: true })
  mkdirSync(join(dir, 'actors'), { recursive: true })
  mkdirSync(join(dir, 'events', 'transcripts'), { recursive: true })

  if (options.registry !== false) {
    writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
      `# Campaign Registry\n\n## Active Campaign\n- **Identifier:** \`${ID}\`\n`)
  }
  const state = options.state ?? {
    campaign: ID, name: ID, mode: 'exploration',
    clock: { date: 'Day 1', time: 'Morning', elapsed: '0' },
    initiative: { round: 0, order: [], index: 0, delayed: [], readied: [] },
    scene: { title: 'A Room', status: 'active', location: 'Here', entities: [], micro_state: '', pending_action: '' },
    last_turn: null,
  }
  if (state !== null) writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2))
  for (const [kind, sheets] of Object.entries(options.sheets ?? {})) {
    // Test callers say `pc`/`npc` (the sheet's `kind`); the directories are
    // `player/` and `actors/`.
    const sub = kind === 'pc' ? 'player' : 'actors'
    for (const [id, sheet] of Object.entries(sheets)) {
      writeFileSync(join(dir, sub, `${id}.json`), JSON.stringify({ id, ...sheet }, null, 2))
    }
  }
  for (const [turn, body] of Object.entries(options.transcripts ?? {})) {
    writeFileSync(join(dir, 'events', 'transcripts', `${String(turn).padStart(4, '0')}_turn.md`), body)
  }
  if (options.index) writeFileSync(join(dir, 'events', 'memory_index.json'), JSON.stringify(options.index, null, 2))
  if (options.tamper) writeFileSync(join(dir, options.tamper.path), options.tamper.text)
  return { root, dir }
}

/** Configure the workspace and run one campaign's diagnosis. */
function diagnose(workspace, id = ID, opts = {}) {
  store.configure({ workspace })
  return doctor.diagnoseAll({ campaign: id, ...opts })
}

const checksOf = (report) => report.findings.map((f) => f.check)
const has = (report, check) => checksOf(report).includes(check)
const detailFor = (report, check) => report.findings.find((f) => f.check === check)?.detail ?? ''

const validHeader = (n, title = 'A Scene') => `# Turn ${String(n).padStart(4, '0')} — ${title}\n- Date: Day 1 Morning\n- Location: Here\n\n## Player\nhi\n\n## DM\nhello\n`

// ---- checks --------------------------------------------------------------

test('a scene id with no sheet is an error (the Maude case)', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['thiago', 'maude'] }, last_turn: { number: 5 }, initiative: { round: 0 } },
    sheets: { pc: { thiago: { kind: 'pc', hp: 140, ac: 37 } } },
  })
  const report = diagnose(root)
  assert.ok(has(report, 'unresolvable-scene-id'))
  assert.match(detailFor(report, 'unresolvable-scene-id'), /"maude"/)
  assert.ok(!detailFor(report, 'unresolvable-scene-id').includes('"thiago"'), 'a resolvable id must not be reported')
  assert.equal(report.counts.errors, 1)
})

test('a provisional stub past the age threshold is reported', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['maude'] }, last_turn: { number: 40 }, initiative: { round: 0 } },
    sheets: { npc: { maude: { kind: 'provisional', name: 'Maude', provisional_since_turn: 12, hp: 1, ac: 10 } } },
  })
  const report = diagnose(root)
  assert.ok(has(report, 'provisional-entity'), 'a 28-turn-old stub is authoring debt')
  assert.match(detailFor(report, 'provisional-entity'), /28 turns ago/)
})

test('a fresh provisional stub is not reported', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['maude'] }, last_turn: { number: 14 }, initiative: { round: 0 } },
    sheets: { npc: { maude: { kind: 'provisional', provisional_since_turn: 12, hp: 1, ac: 10 } } },
  })
  assert.ok(!has(diagnose(root), 'provisional-entity'), 'a 2-turn-old walk-on is not debt yet')
})

test('an id in both player/ and actors/ is reported with the differing fields', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['thiago'] }, last_turn: { number: 3 }, initiative: { round: 0 } },
    sheets: {
      pc: { thiago: { kind: 'pc', hp: 140, ac: 37, initiative_total: 22, notes: 'attack +23' } },
      npc: { thiago: { kind: 'pc', hp: 140, ac: 37, initiative_total: 14, notes: 'attack +18' } },
    },
  })
  const report = diagnose(root)
  assert.ok(has(report, 'duplicate-entity'))
  const detail = detailFor(report, 'duplicate-entity')
  assert.match(detail, /initiative_total/)
  assert.match(detail, /notes/)
  assert.match(detail, /player\/ first/)
})

test('identical copies in both directories are a warning, not an error', () => {
  const sheet = { kind: 'pc', hp: 10, ac: 12, initiative_total: 5 }
  const { root } = makeCampaign({
    state: { scene: { entities: ['dup'] }, last_turn: { number: 1 }, initiative: { round: 0 } },
    sheets: { pc: { dup: sheet }, npc: { dup: sheet } },
  })
  const report = diagnose(root)
  const found = report.findings.find((f) => f.check === 'duplicate-entity')
  assert.ok(found, 'a duplicated id is worth reporting even when identical')
  assert.equal(found.severity, 'warning')
})

test("a sheet left at defaultEntity's defaults is reported as fabricated", () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['goblin_1'] }, last_turn: { number: 2 }, initiative: { round: 0 } },
    sheets: { npc: { goblin_1: { kind: 'npc', name: 'goblin_1', hp: 1, max_hp: 1, ac: 10, conditions: [], resources: {} } } },
  })
  assert.ok(has(diagnose(root), 'fabricated-sheet'))
})

test('an authored 1-HP sheet with any other detail is not called fabricated', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['rat'] }, last_turn: { number: 2 }, initiative: { round: 0 } },
    sheets: { npc: { rat: { kind: 'npc', name: 'Rat', hp: 1, max_hp: 1, ac: 10, conditions: [], resources: {}, notes: 'diseased bite' } } },
  })
  assert.ok(!has(diagnose(root), 'fabricated-sheet'), 'an authored sheet that happens to be 1 HP must not be flagged')
})

test('a transcript missing the turn header is reported', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: [] }, last_turn: { number: 1 }, initiative: { round: 0 } },
    transcripts: { 1: '# Session 1: The Rising Shadow\n\n## User Prompt\nLet us play.\n' },
  })
  assert.ok(has(diagnose(root), 'unparsed-transcript'))
})

test('a transcript titled literally "Untitled Scene" is NOT reported (turn 7 regression)', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: [] }, last_turn: { number: 7 }, initiative: { round: 0 } },
    transcripts: { 7: validHeader(7, 'Untitled Scene') },
  })
  assert.ok(!has(diagnose(root), 'unparsed-transcript'),
    'a valid header whose title is genuinely Untitled is healthy, not a parse failure')
})

test('an index behind the newest transcript is reported', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: [] }, last_turn: { number: 5 }, initiative: { round: 0 } },
    transcripts: { 5: validHeader(5) },
    index: { campaign: ID, total_turns: 3, segments: [{ start: 1, end: 3, title: 'A Scene' }] },
  })
  assert.ok(has(diagnose(root), 'index-divergence'))
})

test('a scene far behind the newest transcript is reported', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['thiago'] }, last_turn: { number: 2 }, initiative: { round: 0 } },
    sheets: { pc: { thiago: { kind: 'pc', hp: 10, ac: 12, notes: 'x' } } },
    transcripts: { 2: validHeader(2), 9: validHeader(9) },
  })
  assert.ok(has(diagnose(root), 'stale-scene'))
})

test('a timed condition outside combat is reported, and one inside combat is not', () => {
  const sheet = (kind = 'pc') => ({
    kind, hp: 10, ac: 12, notes: 'x',
    conditions: [{ name: 'Bless', effect: '+1 morale', expires_round: 4 }],
  })
  const idle = makeCampaign({
    state: { scene: { entities: ['a'] }, last_turn: { number: 1 }, initiative: { round: 0 } },
    sheets: { pc: { a: sheet() } },
  })
  assert.ok(has(diagnose(idle.root), 'unexpired-conditions'))

  const fighting = makeCampaign({
    state: { scene: { entities: ['a'] }, last_turn: { number: 1 }, initiative: { round: 2, order: ['a'], index: 0 } },
    sheets: { pc: { a: sheet() } },
  })
  assert.ok(!has(diagnose(fighting.root), 'unexpired-conditions'), 'in combat the round tick expires it')
})

test('a clean campaign reports nothing', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['thiago'] }, last_turn: { number: 1 }, initiative: { round: 0 } },
    sheets: { pc: { thiago: { kind: 'pc', hp: 140, ac: 37, notes: 'attack +23' } } },
    transcripts: { 1: validHeader(1) },
    index: { campaign: ID, total_turns: 1, segments: [{ start: 1, end: 1, title: 'A Scene' }] },
  })
  const report = diagnose(root)
  assert.deepEqual(checksOf(report), [], `expected no findings, got: ${JSON.stringify(report.findings, null, 2)}`)
  assert.match(doctor.render(report), /no findings/)
})

// ---- failure tolerance ---------------------------------------------------

test('a missing campaign is a finding, not a throw', () => {
  const { root } = makeCampaign({})
  const report = diagnose(root, 'no_such_campaign')
  assert.ok(has(report, 'no-such-campaign'))
  assert.equal(report.counts.errors, 1)
})

test('corrupt JSON is reported and the run continues', () => {
  const { root } = makeCampaign({
    state: { scene: { entities: ['thiago'] }, last_turn: { number: 1 }, initiative: { round: 0 } },
    sheets: { pc: { thiago: { kind: 'pc', hp: 10, ac: 12, notes: 'x' } } },
    transcripts: { 1: validHeader(1) },
    tamper: { path: 'actors/broken.json', text: '{ not json' },
  })
  const report = diagnose(root)
  assert.ok(has(report, 'corrupt-sheet'))
  assert.ok(has(report, 'unresolvable-scene-id') === false, 'thiago still resolves')
})

test('a workspace directory that does not exist is a finding, not a throw', () => {
  const report = diagnose('/definitely/not/a/workspace')
  assert.ok(Array.isArray(report.findings), 'must return a report rather than throwing')
  assert.equal(report.counts.campaigns, 0)
})

// ---- the guarantee -------------------------------------------------------

test('the diagnostic never writes: every campaign file is byte-identical afterwards', () => {
  const { root, dir } = makeCampaign({
    state: { scene: { entities: ['thiago', 'maude'] }, last_turn: { number: 3 }, initiative: { round: 0 } },
    sheets: { pc: { thiago: { kind: 'pc', hp: 1, max_hp: 1, ac: 10, conditions: [], resources: {} } } },
    transcripts: { 1: '# Session 1: broken header\n', 3: validHeader(3) },
    index: { campaign: ID, total_turns: 99, segments: [] },
    tamper: { path: 'events/memory_index.json', text: '{ "campaign": "x", "total_turns": 99 ' },
  })
  const snapshot = (d) => {
    const out = {}
    const walk = (base) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const p = join(base, entry.name)
        if (entry.isDirectory()) walk(p)
        else out[p] = readFileSync(p, 'utf8')
      }
    }
    walk(d)
    return out
  }
  const before = snapshot(dir)
  diagnose(root)
  const after = snapshot(dir)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'no file may be created or removed')
  for (const path of Object.keys(before)) {
    assert.equal(after[path], before[path], `${path} was modified`)
  }
})
