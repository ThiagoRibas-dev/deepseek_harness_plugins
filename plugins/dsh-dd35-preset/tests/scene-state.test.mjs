/**
 * `dd35-scene-state` tests.
 *
 * This module is the passive half of the recall fix (spec §4.1, §4.4). Two
 * properties matter more than the exact prose and are asserted explicitly:
 *
 *  - **It carries a freshness line.** Every superseded snapshot is retained in
 *    session history and one provider delivers all of them, so `as of turn N` is
 *    the only thing that lets the model tell which snapshot is current.
 *  - **It never throws.** It runs during prompt assembly, on the request's error
 *    path; a throw there kills the session.
 *
 * `scene-state.js` imports only `node:fs`/`node:path` and `state-store.js`, so no
 * harness rig is needed. Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply, playerFilesText, sceneStateContext, HEADING } from '../scene-state.js'
import { campaignTurnKey, createTurnFrozenContext } from '../context-freeze.js'

const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const ID = 'test_campaign'

/** One campaign workspace. Omitted files are simply not created. */
function workspace({ campaign = ID, state, pc = {}, npc = {}, playerFiles = {}, registry = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-scene-'))
  roots.push(root)
  const dir = join(root, 'campaign', campaign)
  mkdirSync(join(dir, 'player'), { recursive: true })
  mkdirSync(join(dir, 'actors'), { recursive: true })
  if (registry) {
    writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
      `# Campaign Registry\n\n## Active Campaign\n- **Identifier:** \`${campaign}\`\n`)
  }
  if (state !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2))
  for (const [id, sheet] of Object.entries(pc)) {
    writeFileSync(join(dir, 'player', `${id}.json`), JSON.stringify({ id, ...sheet }, null, 2))
  }
  for (const [id, sheet] of Object.entries(npc)) {
    writeFileSync(join(dir, 'actors', `${id}.json`), JSON.stringify({ id, ...sheet }, null, 2))
  }
  for (const [name, text] of Object.entries(playerFiles)) {
    writeFileSync(join(dir, 'player', name), text)
  }
  return root
}

/** The assembly context the module reads its campaign from. */
const at = (root) => ({ agent: { session: { header: { cwd: root } } } })

/** Write one transcript in the current on-disk shape, for the recency map to read. */
function writeTranscript(root, turn, dm, player = 'The player acts.', title = 'A Scene') {
  const dir = join(root, 'campaign', ID, 'events', 'transcripts')
  mkdirSync(dir, { recursive: true })
  const body = [
    `# Turn ${String(turn).padStart(4, '0')} — ${title}`,
    '- Date: Day 1 Morning',
    '- Location: Here',
    '',
    '## Player',
    player,
    '',
    '## DM',
    dm,
    '',
  ].join('\n')
  writeFileSync(join(dir, `${String(turn).padStart(4, '0')}_turn.md`), body)
}

const BASE_STATE = {
  campaign: ID, mode: 'exploration',
  clock: { date: '3 Years Ago', time: 'Night' },
  initiative: { round: 0, order: [], index: 0 },
  scene: { title: 'Bedroom', location: "The Boar's Rest", micro_state: 'Maude explains.', pending_action: 'Thiago answers.' },
  last_turn: { number: 142, at: '2026-10-06T18:46:07.313Z' },
}

// ---- the freshness line and the basics -----------------------------------

test('the block carries a freshness line naming the turn', () => {
  const root = workspace({ state: BASE_STATE })
  const text = sceneStateContext(at(root))
  assert.match(text, /as of turn 142/i, 'the model must be able to identify the current snapshot')
  assert.ok(text.startsWith(HEADING))
})

test('the scene, clock, and micro-state are rendered', () => {
  const root = workspace({ state: BASE_STATE })
  const text = sceneStateContext(at(root))
  assert.match(text, /The Boar's Rest/)
  assert.match(text, /3 Years Ago Night/)
  assert.match(text, /Maude explains\./)
  assert.match(text, /Thiago answers\./)
})

test('a mid-combat round is shown', () => {
  const root = workspace({
    state: { ...BASE_STATE, mode: 'encounter', initiative: { round: 3, order: ['thiago', 'goblin'], index: 0 } },
  })
  assert.match(sceneStateContext(at(root)), /round 3, thiago to act/)
})

// ---- the widening (§4.4) -------------------------------------------------

test('party members render condition effects, resources, and notes', () => {
  const root = workspace({
    state: BASE_STATE,
    pc: {
      thiago: {
        kind: 'pc', name: 'Thiago', hp: 140, max_hp: 140, temp_hp: 20, ac: 37,
        conditions: [{ name: 'Divine Power', effect: 'Str 23, BAB +15' }],
        resources: { spells_lost_today: 'Summon Monster IV' },
        notes: 'attack +23, damage 1d8+17',
      },
    },
  })
  const text = sceneStateContext(at(root))
  assert.match(text, /Divine Power: Str 23, BAB \+15/, 'the effect is the mechanical content §4.4 restores')
  assert.match(text, /spells_lost_today = Summon Monster IV/)
  assert.match(text, /attack \+23, damage 1d8\+17/)
  assert.match(text, /HP 140\/140 \(\+20 temp\) · AC 37/)
})

test('a scene entity with no sheet is named, never dropped (§6.1)', () => {
  const root = workspace({
    state: { ...BASE_STATE, scene: { ...BASE_STATE.scene, entities: ['thiago', 'maude'] } },
    pc: { thiago: { kind: 'pc', name: 'Thiago', hp: 1, ac: 10, notes: 'x' } },
  })
  const text = sceneStateContext(at(root))
  assert.match(text, /\*\*maude\*\* — no sheet on file/, 'the Maude case must be visible, not silent')
})

test('an actor never named in a transcript collapses to "Also on file"', () => {
  const root = workspace({
    state: BASE_STATE,
    npc: {
      kenna: { kind: 'npc', name: 'Kenna', hp: 14, ac: 15, position: 'Watch post' },
      thorn: { kind: 'npc', name: 'Thorn', hp: 100, ac: 16 },
    },
  })
  const text = sceneStateContext(at(root))
  assert.match(text, /Also on file/)
  assert.match(text, /Kenna \(kenna/)
  assert.match(text, /Thorn \(thorn/)
  assert.ok(!text.includes('Known cast, not present'),
    'no transcript history means no recency evidence, so nobody earns the detailed list')
})

test('an actor named in a recent transcript earns the detailed list, with its recency', () => {
  const root = workspace({
    state: { ...BASE_STATE, last_turn: { number: 10, at: '2026-10-06T18:46:07.313Z' } },
    npc: { kenna: { kind: 'npc', name: 'Kenna', hp: 14, ac: 15, position: 'Watch post' } },
  })
  writeTranscript(root, 9, 'Kenna eyes the treeline.')
  const text = sceneStateContext(at(root))
  assert.match(text, /Known cast, not present/)
  assert.match(text, /Kenna \(kenna\) — HP 14 · AC 15 · Watch post · seen 1 turn\(s\) ago/)
})

test('a stale actor marked npc_tier main is promoted back into the detailed list', () => {
  // This is the only signal that can answer "who have I forgotten?" — recency
  // buries anyone absent long enough, which is the failure mode the roster exists
  // to prevent (§8, open question 2).
  const root = workspace({
    state: { ...BASE_STATE, last_turn: { number: 200, at: '2026-10-06T18:46:07.313Z' } },
    npc: { wick: { kind: 'npc', name: 'Wick', hp: 30, ac: 16, npc_tier: 'main' } },
  })
  writeTranscript(root, 5, 'Wick was here long ago.')
  const text = sceneStateContext(at(root))
  assert.match(text, /Known cast, not present/)
  assert.match(text, /Wick \(wick\).*seen 195 turn\(s\) ago.*\*\*main\*\*/)
})

test('the collapsed list is capped and reports what it hid', () => {
  const npc = {}
  for (let i = 0; i < 12; i += 1) npc[`n${i}`] = { kind: 'npc', name: `Nobody ${i}`, hp: 5, ac: 10 }
  const root = workspace({ state: BASE_STATE, npc })
  const text = sceneStateContext(at(root), { castDormantLimit: 5 })
  assert.match(text, /…and 7 more/)
})

test('a present PC is not duplicated into the present block', () => {
  const root = workspace({
    state: { ...BASE_STATE, scene: { ...BASE_STATE.scene, entities: ['thiago'] } },
    pc: { thiago: { kind: 'pc', name: 'Thiago', hp: 1, ac: 10, notes: 'x' } },
  })
  const text = sceneStateContext(at(root))
  assert.ok(!text.includes('Present (non-party)'), 'the party block already rendered them')
  assert.equal(text.match(/Thiago Fitheaben|\(thiago\)/g).length, 1)
})

// ---- player files (a prompt section, not part of the snapshot) -----------

test('the player\'s own prose is rendered as a section', () => {
  const root = workspace({
    state: BASE_STATE,
    playerFiles: { 'backstory.md': '# Backstory\nHe ran with wolves.' },
  })
  const section = playerFilesText(at(root))
  assert.match(section, /He ran with wolves\./)
  assert.match(section, /## Player Character/)
})

test('the player prose is NOT in the runtime snapshot', () => {
  // It is structural, so it belongs in the cached system prefix. Duplicating it
  // into the snapshot would re-send the same bytes on every step.
  const root = workspace({
    state: BASE_STATE,
    playerFiles: { 'backstory.md': 'UNIQUE_MARKER_TEXT' },
  })
  assert.ok(!sceneStateContext(at(root)).includes('UNIQUE_MARKER_TEXT'))
})

test('a player file over its per-file budget is capped with a visible notice', () => {
  const root = workspace({
    state: BASE_STATE,
    playerFiles: { 'backstory.md': 'x'.repeat(20000) },
  })
  const section = playerFilesText(at(root), { playerFilesMaxBytes: 100000, playerFileMaxBytes: 4000 })
  assert.match(section, /truncated at 4000 bytes/, 'a silent cut is worse than a labelled one')
})

test('a missing player file yields an empty section', () => {
  const root = workspace({ state: BASE_STATE })
  assert.equal(playerFilesText(at(root)), '')
  assert.match(sceneStateContext(at(root)), /as of turn 142/, 'the snapshot still renders')
})

test('a zero player-file budget surfaces a notice rather than nothing', () => {
  const root = workspace({
    state: BASE_STATE,
    playerFiles: { 'backstory.md': 'x'.repeat(5000) },
  })
  assert.match(playerFilesText(at(root), { playerFilesMaxBytes: 0, playerFileMaxBytes: 0 }),
    /truncated at 0 bytes/, 'an over-tight cap must be visible, not silent')
})

// ---- the cap and the failure paths ---------------------------------------

test('the snapshot respects its byte budget and says so', () => {
  const root = workspace({
    state: BASE_STATE,
    pc: {
      thiago: {
        kind: 'pc', name: 'Thiago', hp: 1, ac: 10,
        conditions: Array.from({ length: 40 }, (_, i) => ({ name: `Buff ${i}`, effect: 'y'.repeat(60) })),
      },
    },
  })
  const text = sceneStateContext(at(root), { sceneStateMaxBytes: 900 })
  assert.ok(Buffer.byteLength(text, 'utf8') <= 900, 'the cap must hold')
  assert.match(text, /truncated at 900 bytes/)
})

test('the closing tool-refresh note survives the cap', () => {
  const root = workspace({
    state: BASE_STATE,
    pc: {
      thiago: {
        kind: 'pc', name: 'Thiago', hp: 1, ac: 10,
        conditions: Array.from({ length: 40 }, (_, i) => ({ name: `Buff ${i}`, effect: 'y'.repeat(60) })),
      },
    },
  })
  const text = sceneStateContext(at(root), { sceneStateMaxBytes: 4000 })
  assert.match(text, /Re-read with `get_state` after any tool that changes a sheet mid-turn/,
    'this is the rule that keeps the block from going stale mid-turn')
})

test('no campaign, no state, and corrupt state all yield an empty string', () => {
  const noCampaign = workspace({ state: BASE_STATE, registry: false })
  assert.equal(sceneStateContext(at(noCampaign)), '')

  const noState = workspace({})
  assert.equal(sceneStateContext(at(noState)), '')

  const corrupt = workspace({ state: BASE_STATE })
  writeFileSync(join(corrupt, 'campaign', ID, 'state.json'), '{ not json')
  assert.equal(sceneStateContext(at(corrupt)), '', 'a corrupt state file must not kill assembly')
})

test('a missing or malformed assembly context yields an empty string', () => {
  assert.equal(sceneStateContext(undefined), '')
  assert.equal(sceneStateContext({}), '')
  assert.equal(sceneStateContext({ agent: { session: { header: {} } } }), '')
})

// ---- the scene-change oracle (FI-20) -------------------------------------

/** A campaign whose current scene has a title, with prior turns at other titles. */
function sceneCampaign({ currentTitle, previousTitles = [] }) {
  const root = workspace({ state: { ...BASE_STATE, scene: { ...BASE_STATE.scene, title: currentTitle } } })
  previousTitles.forEach((title, i) => writeTranscript(root, i + 1, `Turn ${i + 1} narration.`, 'I act.', title))
  return root
}

test('no previous scene means no injection — A to B, never nothing to A', () => {
  const root = sceneCampaign({ currentTitle: 'The First Room', previousTitles: [] })
  assert.ok(!sceneStateContext(at(root)).includes('### Oracle'),
    'the first turn has nothing to have changed from')
})

test('a scene title change fires the oracle', () => {
  const root = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  const text = sceneStateContext(at(root))
  assert.match(text, /### Oracle — new scene \(was: The Inn\)/)
  assert.match(text, /not facts about the world until you narrate them/)
})

test('an unchanged scene title does not fire', () => {
  const root = sceneCampaign({ currentTitle: 'The Inn', previousTitles: ['The Inn'] })
  assert.ok(!sceneStateContext(at(root)).includes('### Oracle'))
})

test('the same turn yields the same vectors across steps', () => {
  // Context renders per step, so a Math.random() draw would hand the DM different
  // vectors on every step of the same scene.
  const root = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  const first = sceneStateContext(at(root))
  const second = sceneStateContext(at(root))
  assert.equal(first, second)
  const oracleLine = (text) => text.split('### Oracle')[1].split('\n')[1]
  assert.equal(oracleLine(first), oracleLine(second))
})

test('a different turn yields different vectors', () => {
  const a = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  const b = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  // Same turn number in both, so pin one to a different turn and compare.
  writeFileSync(join(b, 'campaign', ID, 'state.json'), JSON.stringify({
    ...BASE_STATE, scene: { ...BASE_STATE.scene, title: 'The Bath' }, last_turn: { number: 200, at: BASE_STATE.last_turn.at },
  }))
  const lineOf = (text) => text.split('### Oracle')[1].split('\n')[1]
  assert.notEqual(lineOf(sceneStateContext(at(a))), lineOf(sceneStateContext(at(b))))
})

test('the injection can be switched off', () => {
  const root = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  assert.ok(!sceneStateContext(at(root), { oracleOnSceneChange: false }).includes('### Oracle'))
})

test('the oracle has its own budget, separate from the state block', () => {
  const root = sceneCampaign({ currentTitle: 'The Bath', previousTitles: ['The Inn'] })
  const text = sceneStateContext(at(root), { oracleMaxBytes: 60 })
  assert.match(text, /\[oracle truncated at 60 bytes\]/, 'a tiny oracle budget must be visible')
  assert.match(text, /State as of turn/, 'and must not consume the state block')
})

test('a scene with no title falls back to its location', () => {
  const root = workspace({
    state: { ...BASE_STATE, scene: { ...BASE_STATE.scene, title: '', location: 'The Ridge' } },
  })
  writeTranscript(root, 1, 'Earlier.', 'I act.', 'The Ridge')
  assert.ok(!sceneStateContext(at(root)).includes('### Oracle'), 'same place, no change')
})

// ---- registration --------------------------------------------------------

test('apply registers one section and one context, in that order', () => {
  const sections = []
  const contexts = []
  const ctx = {
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      context: (c) => { contexts.push(c); return () => {} },
    },
    effect: (body) => { const d = body(); return typeof d === 'function' ? d : () => {} },
  }
  apply(ctx)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dd35:player-files')
  assert.equal(sections[0].interpolate, false, 'player prose must never be scanned for {{variables}}')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'dd35:scene-state')
  assert.equal(contexts[0].order, 300, 'after dm-notes (200) so the volatile tail truncates first')
  assert.equal(typeof contexts[0].text, 'function', 'rendered per assembly, not once at registration')
})

test('a partial options object does not silently blank the block', () => {
  // Regression: `apply()` resolves config, but a direct call with a partial
  // object left the other budgets `undefined`, `cap()` threw on a NaN slice, and
  // the catch — which exists to protect prompt assembly — swallowed it into ''.
  const root = workspace({ state: BASE_STATE })
  const text = sceneStateContext(at(root), { sceneStateMaxBytes: 100000 })
  assert.ok(text.length > 100, 'unspecified budgets must fall back to their defaults')
  assert.match(text, /as of turn 142/)
})

test('config overrides are honoured and negative values fall back', () => {
  const root = workspace({ state: BASE_STATE })
  const capped = sceneStateContext(at(root), { sceneStateMaxBytes: 50 })
  assert.ok(Buffer.byteLength(capped, 'utf8') <= 50)

  const registered = []
  const ctx = {
    systemPrompt: {
      section: () => () => {},
      context: (c) => { registered.push(c); return () => {} },
    },
    effect: (body) => { const d = body(); return typeof d === 'function' ? d : () => {} },
  }
  apply(ctx, { sceneStateMaxBytes: -5 })
  assert.ok(Buffer.byteLength(registered[0].text(at(root)), 'utf8') > 100,
    'a negative budget falls back to the default')
})

// ---- one snapshot per turn ------------------------------------------------

test('a mid-turn state change does not produce a second snapshot', () => {
  // The harness appends a fresh runtime-context message whenever the joined text
  // changes, so a mid-turn rewrite lands between a tool call and its result, and
  // every superseded copy is retained in history and re-sent. Observed live in
  // session `4ba1929e`: 3 snapshots / 28 KB in 2 turns, two of them mid-batch.
  const root = workspace({ state: BASE_STATE })
  const context = createTurnFrozenContext({
    keyOf: campaignTurnKey,
    render: (assemble) => sceneStateContext(assemble, {}),
  })
  const assemble = at(root)
  const first = context(assemble)
  assert.match(first, /Maude explains\./)

  const statePath = join(root, 'campaign', ID, 'state.json')
  const moved = {
    ...BASE_STATE,
    scene: { ...BASE_STATE.scene, micro_state: 'Maude discusses Kenna.', pending_action: 'Thiago replies.' },
  }

  // `update_scene` rewrites the scene mid-turn; `last_turn` is untouched, which
  // is exactly the case the freeze must suppress.
  writeFileSync(statePath, JSON.stringify(moved, null, 2))
  assert.equal(context(assemble), first, 'the mid-turn rewrite must not change the snapshot')

  // The turn is captured, so the next turn sees the updated state.
  writeFileSync(statePath, JSON.stringify({
    ...moved,
    last_turn: { number: 143, at: '2026-10-09T15:31:00.000Z' },
  }, null, 2))
  const next = context(assemble)
  assert.notEqual(next, first)
  assert.match(next, /Maude discusses Kenna\./)
})
