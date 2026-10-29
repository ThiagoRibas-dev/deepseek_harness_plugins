/**
 * Phase 0 analysis for docs/dd35-memory-model-improvement.md §6.0 / §8.
 *
 * Read-only. Answers, against a real campaign:
 *   Q2  how often would a rendered scene-state snapshot actually change?
 *   Q3  how big is the block `get_state` returns (the thing the snapshot replaces)?
 *   Q1  (partial) does DM narration agree with the files the dice tools wrote?
 *
 * Usage: node dd35-phase0-analysis.mjs <campaignDir> [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: node dd35-phase0-analysis.mjs <campaignDir>')
const asJson = process.argv.includes('--json')

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const dirJson = (d) => {
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => f.endsWith('.json')).sort()
    .map((f) => readJson(join(d, f))).filter(Boolean)
}

// ---- the payload: mirrors state.js `compact()` + `briefEntity()` ----------
// briefEntity keeps ONLY: id, name, kind, hp, max_hp, temp_hp, ac,
// optional position, and conditions flattened to NAMES. `effect`,
// `resources` and `notes` are dropped. (Verified against state.js:43-72.)

const brief = (e) => ({
  id: e.id, name: e.name, kind: e.kind,
  hp: e.hp, max_hp: e.max_hp, temp_hp: e.temp_hp ?? 0, ac: e.ac,
  ...(e.position ? { position: e.position } : {}),
  conditions: (e.conditions ?? []).map((c) => (typeof c === 'string' ? c : c.name)),
})

function compact(state, { pcs, actors }) {
  const present = (state.scene?.entities ?? [])
    .map((id) => pcs.find((e) => e.id === id) ?? actors.find((e) => e.id === id))
    .filter(Boolean)
  return {
    campaign: state.campaign,
    mode: state.mode,
    clock: state.clock,
    initiative: {
      round: state.initiative?.round ?? 0,
      order: state.initiative?.order ?? [],
      current_turn: state.initiative?.order?.[state.initiative?.index ?? 0] ?? null,
      delayed: state.initiative?.delayed ?? [],
    },
    scene: state.scene,
    party: pcs.map(brief),
    present: present.filter((e) => e.kind !== 'pc').map(brief),
  }
}

// ---- transcripts ---------------------------------------------------------

function parseTranscript(text, number) {
  const grab = (re) => {
    const m = text.match(re)
    return m ? m[1].trim() : null
  }
  const dmAt = text.indexOf('\n## DM\n')
  return {
    number,
    title: grab(/^#\s*Turn\s+\d+\s*[—–-]\s*(.+)$/m),
    date: grab(/^-\s*Date:\s*(.+)$/m),
    location: grab(/^-\s*Location:\s*(.+)$/m),
    entities: (grab(/^-\s*Entities:\s*(.+)$/m) ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    microState: grab(/^-\s*Micro-State:\s*(.+)$/m),
    pendingAction: grab(/^-\s*Pending Action:\s*(.+)$/m),
    dm: dmAt === -1 ? '' : text.slice(dmAt + 7).trim(),
  }
}

const tdir = join(root, 'events', 'transcripts')
const turns = existsSync(tdir)
  ? readdirSync(tdir).filter((f) => /^\d+.*\.md$/.test(f)).sort()
    .map((f) => parseTranscript(read(join(tdir, f)), Number.parseInt(f, 10)))
  : []

const state = readJson(join(root, 'state.json'))
const pcs = dirJson(join(root, 'player'))
const actors = dirJson(join(root, 'actors'))
if (!state) throw new Error(`no state.json under ${root}`)

// ---- Q3: payload size ----------------------------------------------------

const payload = compact(state, { pcs, actors })
const payloadJson = JSON.stringify(payload, null, 2)
const bytes = Buffer.byteLength(payloadJson, 'utf8')
const estTokens = Math.round(bytes / 3.5)

// What the given scene's roster implies, and what hydration would drop.
const sceneIds = state.scene?.entities ?? []
const resolvable = sceneIds.filter((id) => pcs.some((e) => e.id === id) || actors.some((e) => e.id === id))
const unresolvable = sceneIds.filter((id) => !resolvable.includes(id))

const briefBytes = Buffer.byteLength(JSON.stringify(pcs.map(brief), null, 2), 'utf8')
const fullBytes = Buffer.byteLength(JSON.stringify(pcs, null, 2), 'utf8')

// ---- Q2: snapshot deltas -------------------------------------------------
// The snapshot text changes when ANY rendered field changes. state.json keeps
// only current values, so the transcript headers are the historical record of
// the fields the block renders (location, entities, micro-state, pending
// action, date). Clock time is not in the header, so this is a LOWER bound.

const fingerprint = (t) => JSON.stringify([t.date, t.location, t.entities, t.microState, t.pendingAction])
let changes = 0
const fieldChangeCounts = { date: 0, location: 0, entities: 0, microState: 0, pendingAction: 0 }
for (let i = 1; i < turns.length; i += 1) {
  const a = turns[i - 1]
  const b = turns[i]
  if (fingerprint(a) !== fingerprint(b)) changes += 1
  for (const k of Object.keys(fieldChangeCounts)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fieldChangeCounts[k] += 1
  }
}
const transitions = Math.max(0, turns.length - 1)

// ---- Q1 (partial): narration vs dice-written files ----------------------
// HP arithmetic stated in narration, e.g. "24 damage", "down to 12 hit points".

const DMG = /\b(\d{1,3})\s*(?:points of\s*)?damage\b/gi
const HP_TO = /\b(?:down to|at|to)\s+(\d{1,3})\s*(?:hp|hit points)\b/gi
const numbered = turns.filter((t) => t.dm)
const hpMentions = numbered.filter((t) => DMG.test(t.dm) || HP_TO.test(t.dm))

// Cross-check: does every id the scene names have a sheet at all?
const allActorIds = actors.map((a) => a.id)
const allPcIds = pcs.map((p) => p.id)

const report = {
  campaign: root,
  corpus: {
    transcripts: turns.length,
    turnRange: turns.length ? [turns[0].number, turns.at(-1).number] : null,
    gaps: (() => {
      const missing = []
      for (let i = 1; i < turns.length; i += 1) {
        if (turns[i].number !== turns[i - 1].number + 1) missing.push([turns[i - 1].number + 1, turns[i].number - 1])
      }
      return missing
    })(),
    pcs: allPcIds,
    actors: allActorIds,
  },
  Q3_payload: {
    bytes,
    estTokens,
    partyEntries: pcs.length,
    presentNpcEntries: payload.present.length,
    note: 'briefEntity drops conditions[].effect, resources and notes',
    pcFullBytes: fullBytes,
    pcBriefBytes: briefBytes,
    droppedByHydrationPct: Math.round((1 - briefBytes / fullBytes) * 100),
  },
  hydrationCoverage: {
    sceneEntities: sceneIds,
    resolvable,
    unresolvable,
    unresolvablePct: sceneIds.length ? Math.round((unresolvable.length / sceneIds.length) * 100) : 0,
  },
  Q2_snapshots: {
    turns: turns.length,
    transitions,
    snapshotsIfPerTurn: turns.length,
    snapshotsIfChanged: changes,
    reductionPct: transitions ? Math.round((1 - changes / transitions) * 100) : 0,
    fieldChangeCounts,
    note: 'lower bound: clock time is not in the transcript header',
  },
  Q1_drift: {
    turnsWithNarration: numbered.length,
    turnsStatingHpArithmetic: hpMentions.length,
    pct: numbered.length ? Math.round((hpMentions.length / numbered.length) * 100) : 0,
    note: 'proxy only; the sheets hold no per-turn history, so stated arithmetic cannot be recomputed',
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const p = (k, v) => console.log(`${String(k).padEnd(34)} ${v}`)
  console.log(`\n=== ${root} ===\n`)
  console.log('-- corpus --')
  p('transcripts', report.corpus.transcripts)
  p('turn range', report.corpus.turnRange?.join('..'))
  p('gaps', report.corpus.gaps.length ? JSON.stringify(report.corpus.gaps) : 'none')
  p('pc sheets', allPcIds.join(', ') || '(none)')
  p('actor sheets', allActorIds.join(', ') || '(none)')
  console.log('\n-- Q3: get_state payload --')
  p('bytes', report.Q3_payload.bytes)
  p('estimated tokens (bytes/3.5)', report.Q3_payload.estTokens)
  p('party entries', report.Q3_payload.partyEntries)
  p('present-NPC entries', report.Q3_payload.presentNpcEntries)
  p('brief vs full pc json', `${briefBytes}B vs ${fullBytes}B (-${report.Q3_payload.droppedByHydrationPct}%)`)
  console.log('\n-- hydration coverage --')
  p('scene.entities', JSON.stringify(sceneIds))
  p('resolvable', JSON.stringify(resolvable))
  p('UNRESOLVABLE', JSON.stringify(unresolvable))
  p('unresolvable %', `${report.hydrationCoverage.unresolvablePct}%`)
  console.log('\n-- Q2: snapshot deltas --')
  p('transitions', transitions)
  p('snapshots if per-turn', report.Q2_snapshots.snapshotsIfPerTurn)
  p('snapshots if changed-only', report.Q2_snapshots.snapshotsIfChanged)
  p('reduction', `${report.Q2_snapshots.reductionPct}%`)
  p('per-field changes', JSON.stringify(fieldChangeCounts))
  console.log('\n-- Q1: drift proxy --')
  p('turns with narration', report.Q1_drift.turnsWithNarration)
  p('turns stating hp arithmetic', `${report.Q1_drift.turnsStatingHpArithmetic} (${report.Q1_drift.pct}%)`)
  console.log('')
}
