/**
 * D&D 3.5e DM — campaign diagnostic (`dd35_doctor`).
 *
 * Spec: docs/dd35-memory-model-improvement.md §9.3.
 *
 * Reports the campaign's *authoring debt*: places where the files disagree with
 * themselves or with what the table established. Every check here was chosen
 * because it is currently failing somewhere in a real campaign — the point is
 * to make silent gaps loud, not to enforce a schema.
 *
 * Two rules govern this module, and both are load-bearing:
 *
 *  1. **Read-only.** It never writes, ever. In particular it uses `loadState`,
 *     never `requireState`, because the latter *self-heals by creating*
 *     `state.json` — a write on what is supposed to be a read path.
 *  2. **It never throws.** A missing campaign, an unreadable directory, corrupt
 *     JSON: each is a *finding*, not an exception. A diagnostic that can crash
 *     the turn it was meant to help is worse than no diagnostic.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  actorsDir, bounded, campaignDir, configure, defaultEntity, listCampaignIds,
  loadState, playerDir, readActiveCampaign, readText, resolveSessionCampaign,
  transcriptsDir, workspace,
} from './state-store.js'
import { memoryIndexPath, parseTranscript, UNTITLED } from './memory-store.js'

export const name = 'dd35-doctor'
export const inject = ['tools']

/** A provisional stub older than this many turns is authoring debt worth naming. */
const PROVISIONAL_AGE_TURNS = 10

// ---- reporting primitives ------------------------------------------------

const finding = (check, detail, remedy, severity = 'warning') => ({ check, severity, detail, remedy })

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Read a directory's `.json` files, tolerating an absent directory entirely. */
function jsonFiles(dir) {
  if (!existsSync(dir)) return []
  let names
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((f) => f.endsWith('.json')).sort()
}

/** Parse one JSON file, reporting a corrupt one instead of throwing. */
function parseFile(path, findings, check, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    findings.push(finding(check, `${label} is not valid JSON: ${error.message}`,
      'Re-create or repair the file; nothing can read it until it parses.', 'error'))
    return null
  }
}

/** Entity sheets in one campaign, both directories, tagged with their home. */
function loadSheets(id, findings) {
  const sheets = []
  for (const [dir, kind] of [[playerDir(id), 'pc'], [actorsDir(id), 'npc']]) {
    for (const file of jsonFiles(dir)) {
      const sheet = parseFile(join(dir, file), findings, 'corrupt-sheet', `${kind}/${file}`)
      if (sheet) sheets.push({ ...sheet, __home: kind, __file: file })
    }
  }
  return sheets
}

/** Turn numbers, in order, from the transcript file names. */
function turnNumbers(id) {
  const dir = transcriptsDir(id)
  if (!existsSync(dir)) return []
  let names
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .filter((f) => /^\d+.*\.md$/.test(f))
    .map((f) => Number.parseInt(f, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

/**
 * True when a sheet still carries exactly the values `defaultEntity` invents.
 *
 * This is the fingerprint of a fabrication: `init_combat` / `add_combatant` call
 * `defaultEntity` on a lookup miss, so an unknown id drafted into combat acquires
 * `hp 1, max_hp 1, ac 10` and becomes indistinguishable from an authored sheet
 * afterwards. An authored 1-HP rat matches too — the check reports, it does not
 * accuse (spec §7).
 */
function looksFabricated(sheet) {
  const base = defaultEntity(sheet.id ?? '', { kind: sheet.kind })
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  return sheet.hp === base.hp
    && sheet.max_hp === base.max_hp
    && sheet.ac === base.ac
    && same(sheet.conditions ?? [], base.conditions)
    && same(sheet.resources ?? {}, base.resources)
    && !String(sheet.notes ?? '').trim()
    && !String(sheet.position ?? '').trim()
}

// ---- the checks ----------------------------------------------------------

/**
 * Run every check against one campaign.
 * @param id - campaign identifier.
 * @returns `{ campaign, findings, counts }` — never throws.
 */
export function diagnoseCampaign(id) {
  const findings = []
  const counts = { sheets: 0, transcripts: 0, sceneEntities: 0 }

  const state = loadState(id)
  if (!state) {
    findings.push(finding('missing-state', `campaign/${id}/state.json is missing or unreadable.`,
      'Create the campaign again, or restore state.json from a backup.', 'error'))
    return { campaign: id, findings, counts }
  }

  const sheets = loadSheets(id, findings)
  counts.sheets = sheets.length
  const byId = new Map()
  for (const sheet of sheets) {
    if (!sheet.id) continue
    if (!byId.has(sheet.id)) byId.set(sheet.id, [])
    byId.get(sheet.id).push(sheet)
  }

  const sceneEntities = Array.isArray(state.scene?.entities) ? state.scene.entities : []
  counts.sceneEntities = sceneEntities.length
  const lastTurn = Number.isFinite(state.last_turn?.number) ? state.last_turn.number : 0

  // 1 — scene ids with no sheet. The Maude case: on stage, no sheet anywhere.
  for (const entityId of sceneEntities) {
    if (typeof entityId !== 'string') {
      findings.push(finding('unresolvable-scene-id', `scene.entities contains a non-string entry: ${JSON.stringify(entityId)}`,
        'Replace it with an entity id string.', 'error'))
      continue
    }
    if (!byId.has(entityId)) {
      findings.push(finding('unresolvable-scene-id',
        `"${entityId}" is in state.scene.entities but has no sheet in player/ or actors/.`,
        `Create it with create_entity, or re-call update_scene with create_provisional to record it as a walk-on.`,
        'error'))
    }
  }

  // 2 — provisional stubs that were never resolved.
  for (const [entityId, copies] of byId) {
    for (const sheet of copies) {
      if (sheet.kind !== 'provisional') continue
      const since = Number.isFinite(sheet.provisional_since_turn) ? sheet.provisional_since_turn : null
      const age = since === null ? null : Math.max(0, lastTurn - since)
      if (age === null || age >= PROVISIONAL_AGE_TURNS) {
        const aged = age === null ? 'with no recorded turn' : `${age} turns ago (turn ${since})`
        findings.push(finding('provisional-entity',
          `"${entityId}" is still a provisional stub, created ${aged}.`,
          'Give it a real sheet with create_entity, or delete it if the walk-on never mattered.'))
      }
    }
  }

  // 3 — the same id in both player/ and actors/, which is a silent precedence trap.
  for (const [entityId, copies] of byId) {
    if (copies.length < 2) continue
    const homes = copies.map((c) => c.__home).sort()
    if (new Set(homes).size < 2) continue
    const [a, b] = copies
    const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => !k.startsWith('__') && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .sort()
    findings.push(finding('duplicate-entity',
      `"${entityId}" exists in both player/ and actors/ and they differ in: ${differing.join(', ') || '(nothing)'}. `
      + `loadAnyEntity checks player/ first, so the actors/ copy is invisible.`,
      'Decide which copy is canonical and delete the other; a divergence here is never intentional.',
      differing.length > 0 ? 'error' : 'warning'))
  }

  // 4 — fabricated sheets (defaultEntity's hp 1, max_hp 1, ac 10 and nothing else).
  for (const sheet of sheets) {
    if (sheet.kind === 'provisional') continue
    if (looksFabricated(sheet)) {
      findings.push(finding('fabricated-sheet',
        `"${sheet.id}" (${sheet.__home}) carries exactly defaultEntity's defaults (hp 1, max_hp 1, ac 10, no conditions/resources/notes/position).`,
        'Either author the sheet, or — if this was an unknown id drafted into combat — the numbers were invented by the runtime, not chosen by anyone.'))
    }
  }

  // 5 — transcripts the parser cannot read (old header shapes).
  //
  // The test is *structural*, not "did a title come out": a modern transcript
  // always has a `- Date:` line, and turn 7's title is genuinely `Untitled Scene`
  // rather than a parse failure. Conflating the two would report a healthy
  // transcript as broken, which is exactly the kind of false positive that makes
  // a diagnostic get ignored.
  const numbers = turnNumbers(id)
  counts.transcripts = numbers.length
  const unparsed = []
  const files = existsSync(transcriptsDir(id)) ? readdirSync(transcriptsDir(id)) : []
  for (const n of numbers) {
    const file = files.filter((f) => Number.parseInt(f, 10) === n && f.endsWith('.md'))[0]
    if (!file) continue
    const raw = readText(join(transcriptsDir(id), file))
    if (raw === null) continue
    const parsed = parseTranscript(raw, n)
    const hasTurnHeader = /^#\s*Turn\s+\d+\s*[—–-]/m.test(raw)
    const hasDateLine = /^-\s*Date:\s*/m.test(raw)
    if (!hasTurnHeader || !hasDateLine) {
      unparsed.push({ turn: n, file, title: parsed.title, missing: [!hasTurnHeader && 'turn header', !hasDateLine && 'date line'].filter(Boolean).join(' + ') })
    }
  }
  if (unparsed.length > 0) {
    const turns = unparsed.map((u) => u.turn).join(', ')
    findings.push(finding('unparsed-transcript',
      `${unparsed.length} transcript(s) lack the parser's header shape (${unparsed[0].missing}): ${turns}. `
      + `The index records them as "${UNTITLED}" with null dates, so they are effectively unfindable by date or scene.`,
      'Normalise the headers to "# Turn NNNN — Title" with "- Date:" lines, or extend parseTranscript to accept the old shapes.'))
  }

  // 6 — index/transcript divergence.
  const indexPath = memoryIndexPath(id)
  if (existsSync(indexPath)) {
    const index = parseFile(indexPath, findings, 'corrupt-index', 'events/memory_index.json')
    if (index) {
      const covered = Number.isFinite(index.total_turns) ? index.total_turns : 0
      const newest = numbers.length > 0 ? numbers[numbers.length - 1] : 0
      if (covered !== newest) {
        findings.push(finding('index-divergence',
          `events/memory_index.json says total_turns=${covered} but the newest transcript file is turn ${newest}. `
          + 'A gap forces a full rebuild on the next commit, which silently discards anything non-derivable.',
          'Harmless if the index is rebuilt on the next turn; investigate if it persists.'))
      }
      // Gaps in the surviving transcript sequence. Pruning turns is a normal
      // authoring decision, so this is reported as information rather than a
      // defect — but a *surprising* gap means transcripts were lost, and only
      // the DM knows which it is.
      const gaps = []
      for (let i = 1; i < numbers.length; i += 1) {
        if (numbers[i] !== numbers[i - 1] + 1) gaps.push([numbers[i - 1] + 1, numbers[i] - 1])
      }
      if (gaps.length > 0) {
        findings.push(finding('transcript-gaps',
          `${numbers.length} transcript(s) on disk cover turns ${numbers[0]}-${newest}; ${newest - numbers.length} turn(s) are absent `
          + `(${gaps.length} gap(s): ${gaps.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}).`,
          'Expected when turns were pruned deliberately. If you did not prune them, the transcripts were lost — check the recycle bin.',
          'info'))
      }
    }
  }

  // 7 — a scene that was never updated while play continued.
  if (sceneEntities.length > 0 && lastTurn > 0 && numbers.length > 0) {
    const newest = numbers[numbers.length - 1]
    if (newest - lastTurn > 1) {
      findings.push(finding('stale-scene',
        `state.json's last_turn is ${lastTurn} but the newest transcript is turn ${newest} — ${newest - lastTurn} turn(s) of play the scene never recorded.`,
        'The scene block the DM reads is behind the story; re-run update_scene for the current scene.'))
    }
  }

  // 8 — timed conditions with no combat running to expire them.
  const inCombat = Number.isFinite(state.initiative?.round) && state.initiative.round > 0
  if (!inCombat) {
    for (const sheet of sheets) {
      const timed = (sheet.conditions ?? []).filter((c) => typeof c === 'object' && c !== null && c.expires_round !== null && c.expires_round !== undefined)
      if (timed.length > 0) {
        findings.push(finding('unexpired-conditions',
          `"${sheet.id}" carries ${timed.length} condition(s) with an expires_round (${timed.map((c) => c.name).join(', ')}) but no combat is running.`,
          'Nothing will tick these down outside combat; clear them or convert them to untimed.'))
      }
    }
  }

  return { campaign: id, findings, counts }
}

/**
 * Diagnose every campaign under the bound workspace.
 * @returns `{ workspace, campaigns, findings, counts }` — never throws.
 */
export function diagnoseAll({ campaign } = {}) {
  let root = null
  try { root = workspace() } catch (error) {
    return {
      workspace: null,
      campaigns: [],
      findings: [finding('no-workspace', error.message, 'Open a workspace that contains campaign/.', 'error')],
      counts: { campaigns: 0, findings: 1, errors: 1 },
    }
  }

  let ids
  try { ids = campaign ? [campaign] : listCampaignIds() } catch (error) {
    return {
      workspace: root,
      campaigns: [],
      findings: [finding('unreadable-campaign-root', `${root}/campaign could not be listed: ${error.message}`,
        'Check that campaign/ exists and is readable.', 'error')],
      counts: { campaigns: 0, findings: 1, errors: 1 },
    }
  }

  if (campaign && !existsSync(campaignDir(campaign))) {
    return {
      workspace: root,
      campaigns: [],
      findings: [finding('no-such-campaign', `campaign/${campaign}/ does not exist.`, 'Check the identifier.', 'error')],
      counts: { campaigns: 0, findings: 1, errors: 1 },
    }
  }

  const findings = []
  const campaigns = []
  for (const id of ids) {
    const result = diagnoseCampaign(id)
    campaigns.push({ campaign: id, counts: result.counts, findings: result.findings.length })
    for (const item of result.findings) findings.push({ campaign: id, ...item })
  }

  // Both are worth reporting: `registry_active` is what a session predating
  // per-session binding still resolves to, and `attached_campaign` is what this
  // session is actually playing. They are allowed to differ.
  const registryActive = (() => { try { return readActiveCampaign() } catch { return null } })()
  const attached = (() => { try { return resolveSessionCampaign() } catch { return { id: null, source: 'none' } } })()
  return {
    workspace: root,
    attached_campaign: attached.id,
    attached_source: attached.source,
    registry_active: registryActive,
    campaigns,
    findings,
    counts: {
      campaigns: campaigns.length,
      findings: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
  }
}

function render(report) {
  if (report.counts.findings === 0) {
    return `doctor: ${report.counts.campaigns} campaign(s), no findings.\n`
  }
  const parts = []
  if (report.counts.errors > 0) parts.push(`${report.counts.errors} error(s)`)
  if (report.counts.warnings > 0) parts.push(`${report.counts.warnings} warning(s)`)
  if (report.counts.info > 0) parts.push(`${report.counts.info} note(s)`)
  const lines = [`doctor: ${report.counts.findings} finding(s) across ${report.counts.campaigns} campaign(s)`
    + `${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`, '']
  // Errors first: a diagnostic nobody reads to the bottom is a diagnostic that
  // did not run.
  const rank = { error: 0, warning: 1, info: 2 }
  for (const f of [...report.findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))) {
    lines.push(`[${f.severity}] ${f.campaign} · ${f.check}`)
    lines.push(`  ${f.detail}`)
    lines.push(`  → ${f.remedy}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  configure(config)

  // `bounded` rebinds the workspace from the calling session before the body runs
  // (state-store.js:50-55), which is why this tool resolves campaign paths against
  // the user's workspace rather than the bundle's folder.
  ctx.tools.register(defineTool({
    name: 'dd35_doctor',
    description:
      'Diagnose a campaign\'s files. Read-only: reports scene entities with no sheet, provisional stubs left unresolved, '
      + 'an id duplicated in player/ and actors/, sheets left at default hp/ac, transcripts the parser cannot read, '
      + 'index/transcript divergence, a scene that stopped being updated, and timed conditions with no combat running. '
      + 'Run it when the DM seems to be missing context, or at the start of a session.',
    parameters: {
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign, and to every campaign when there is none.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute: bounded(({ campaign } = {}) => diagnoseAll({ campaign })),
  }))
}

export { render }
