/**
 * D&D 3.5e DM — the contextual record.
 *
 * Spec: docs/dd35-memory-model-improvement.md §12.
 *
 * One record per turn: **who was there, where, when, what happened, what is
 * unresolved.** Retrieval over these answers "these people, this place, that
 * business" — exactly, and with no model call anywhere.
 *
 * This is deliberately not semantic search. Everything here is counting and
 * exact matching over files that already exist, so it costs nothing per turn and
 * every result can be traced back to the turn it came from. The semantic layer
 * stays deferred (§12.7): both providers configured in this profile are
 * external, so per-turn inference would be a recurring bill.
 *
 * Layering: `context-index.js` is pure — it reads parsed transcripts and the
 * entity roster and returns plain data. `scene-state.js` does the same kind of
 * assembly for the prompt; neither writes.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  bounded, listEntityIdsIn, loadEntityIn, loadState, requireCampaign, workspace,
} from './state-store.js'
import { loadTranscriptsIn } from './memory-store.js'

export const name = 'dd35-context-index'
export const inject = ['tools']

const DEFAULTS = {
  /** An entity absent this many turns counts as "returning" when it reappears. */
  actorGap: 8,
  /** Most candidates to return. */
  maxCandidates: 6,
  /** Turns this recent are assumed to be in context already, so never surfaced. */
  recentWindow: 12,
  /** Opening-sentence budget when a turn has no recorded micro-state. */
  labelMaxChars: 140,
}

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Reusable matchers for the campaign's entity roster.
 *
 * A sheet's id is almost never the string the prose uses — searching for
 * `dire_wolf_1` finds nothing while "Dire Wolf (Alpha Pair, male)" appears in
 * five turns — so each entity is matched on its id *and* its display name with
 * any parenthetical qualifier stripped.
 */
function rosterMatchers(root, id) {
  const out = []
  const pcs = new Set()
  for (const kind of ['pc', 'npc']) {
    for (const entityId of listEntityIdsIn(root, id, kind)) {
      const sheet = loadEntityIn(root, id, entityId, kind)
      if (sheet === null) continue
      if (kind === 'pc') pcs.add(entityId)
      const needles = [entityId, String(sheet.name ?? '').split(' (')[0].trim()]
        .filter((needle) => typeof needle === 'string' && needle.length > 2)
      if (needles.length === 0) continue
      // One matcher per id: an id can exist in both player/ and actors/ (the
      // duplicate trap `dd35_doctor` reports), and counting it twice would
      // double every co-occurrence it takes part in.
      if (out.some((entry) => entry.id === entityId)) continue
      out.push({ id: entityId, re: new RegExp(`\\b(?:${needles.map(escapeRe).join('|')})\\b`, 'i'), pc: kind === 'pc' })
    }
  }
  return { matchers: out, pcs }
}

/** First sentence of the narration, for turns that recorded no micro-state. */
function openingSentence(dm, maxChars) {
  const flat = String(dm ?? '').replace(/\s+/gu, ' ').trim()
  if (flat === '') return null
  const stop = flat.search(/[.!?](\s|$)/u)
  const first = stop === -1 ? flat : flat.slice(0, stop + 1)
  return first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first
}

/**
 * Build one contextual record per parsed turn.
 *
 * Pure: no writes, no model, no module state. `turns` comes from
 * `loadTranscriptsIn`, which is cached on directory stamp, so this is one pass
 * over in-memory text.
 *
 * @param turns - parsed transcripts (`parseTranscript` shape).
 * @param matchers - roster matchers from {@link rosterMatchers}, or `[]`.
 * @param options - `{ labelMaxChars }`.
 */
export function buildContextRecords(turns, matchers = [], options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const list = Array.isArray(turns) ? turns : []
  return list.map((turn) => {
    const prose = `${turn.player ?? ''}\n${turn.dm ?? ''}`

    // The header's `- Entities:` is the DM's own record of who was present, so it
    // wins when present. Otherwise presence is inferred from the prose, which is
    // a candidate signal rather than a fact and is labelled as such.
    const headerActors = Array.isArray(turn.entities) ? turn.entities.filter(Boolean) : []
    const proseActors = matchers.filter((matcher) => matcher.re.test(prose)).map((matcher) => matcher.id)
    const actors = headerActors.length > 0 ? [...new Set(headerActors)] : [...new Set(proseActors)]

    const label = turn.microState ?? openingSentence(turn.dm, opts.labelMaxChars)
    return {
      turn: turn.number,
      date: turn.date ?? null,
      where: turn.location ?? null,
      actors,
      label: label ?? null,
      unresolved: turn.pendingAction ?? null,
      actor_source: headerActors.length > 0 ? 'scene' : 'prose',
      label_source: turn.microState ? 'scene' : (label ? 'narration' : null),
    }
  })
}

/** Turns in which one entity appears. */
export function turnsWith(records, entityId) {
  return records.filter((record) => record.actors.includes(entityId)).map((record) => record.turn)
}

/**
 * Entity ids in the current scene whose previous appearance was long ago.
 *
 * This is the trigger the section exists for: someone walks back on stage after
 * an absence, and the campaign's history with them becomes relevant again.
 */
export function returningActors(records, sceneActors, currentTurn, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  // A player character is present by definition; their absence from the record
  // means the DM stopped listing them, not that they left. Only NPCs return.
  const skip = new Set(opts.playerCharacters ?? [])
  const before = records.filter((record) => record.turn < currentTurn)
  const returning = []
  for (const entityId of sceneActors) {
    if (skip.has(entityId)) continue
    const seen = turnsWith(before, entityId)
    if (seen.length === 0) continue
    const last = seen[seen.length - 1]
    const gap = currentTurn - last
    if (gap >= opts.actorGap) returning.push({ id: entityId, lastTurn: last, gap })
  }
  return returning.sort((a, b) => b.gap - a.gap)
}

/**
 * Score and rank candidate turns for the current scene.
 *
 * Every candidate carries the reasons it was retrieved, so the DM can judge
 * whether it is relevant instead of trusting a number. Turns inside the recent
 * window are dropped: surfacing what the DM can already read is noise.
 *
 * @returns `{ trigger, candidates }` — `trigger` is null when nothing fired.
 */
export function findContextCandidates(records, scene, currentTurn, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const list = Array.isArray(records) ? records : []
  if (list.length === 0) return { trigger: null, candidates: [] }

  const sceneActors = [...new Set(Array.isArray(scene?.actors) ? scene.actors : [])]
  const where = scene?.where ?? null
  const returning = returningActors(list, sceneActors, currentTurn, opts)

  const previous = [...list].filter((record) => record.turn < currentTurn).at(-1) ?? null
  // A location change needs two comparable records: with no prior known place
  // there is nothing to have changed from, so this does not fire on the
  // campaign's first located turn.
  const locationChanged = where !== null && previous?.where != null && previous.where !== where

  if (returning.length === 0 && !locationChanged) return { trigger: null, candidates: [] }

  const since = returning.map((entry) => entry.id)
  const cutoff = currentTurn - opts.recentWindow
  const scored = []
  for (const record of list) {
    if (record.turn >= cutoff) continue // already in context
    const shared = record.actors.filter((actor) => sceneActors.includes(actor))
    const back = record.actors.filter((actor) => since.includes(actor))
    const reasons = []
    let score = 0
    if (shared.length >= 2) { score += 3; reasons.push(`shares ${shared.length} actors (${shared.join(', ')})`) }
    else if (shared.length === 1) { score += 1; reasons.push(`shares ${shared[0]}`) }
    if (where !== null && record.where === where) { score += 2; reasons.push('same place') }
    if (back.length > 0) { score += 1; reasons.push(`involves returning ${back.join(', ')}`) }
    if (record.unresolved) { score += 1; reasons.push('left business unfinished') }
    if (score === 0) continue
    // Nearer turns rank higher among otherwise equal candidates.
    score += Math.max(0, 3 - Math.floor((currentTurn - record.turn) / 25))
    scored.push({ ...record, score, reasons })
  }

  scored.sort((a, b) => b.score - a.score || b.turn - a.turn)
  return {
    trigger: {
      returning,
      location_changed: locationChanged,
      from: previous?.where ?? null,
      to: where,
    },
    candidates: scored.slice(0, opts.maxCandidates),
  }
}

/** One compact line per candidate — a pointer, not an injection. */
export function renderCandidates(result) {
  if (result.trigger === null) return 'No trigger: the scene has not changed shape.'
  const lines = []
  const bits = []
  for (const entry of result.trigger.returning) {
    bits.push(`${entry.id} returns after ${entry.gap} turns (last seen ${entry.lastTurn})`)
  }
  if (result.trigger.location_changed) bits.push(`location changed: ${result.trigger.from} → ${result.trigger.to}`)
  lines.push(`Trigger: ${bits.join('; ')}`, '')
  if (result.candidates.length === 0) {
    lines.push('No earlier turns scored as relevant.')
    return lines.join('\n')
  }
  lines.push('Possibly relevant earlier turns (fetch ids with fetch_memories):')
  for (const candidate of result.candidates) {
    const who = candidate.actors.length > 0 ? candidate.actors.join(', ') : 'nobody recorded'
    lines.push(`- turn ${candidate.turn}${candidate.date ? ` (${candidate.date})` : ''} — ${candidate.where ?? 'unplaced'}`)
    lines.push(`  who: ${who}`)
    if (candidate.label) lines.push(`  what: ${candidate.label}`)
    if (candidate.unresolved) lines.push(`  open: ${candidate.unresolved}`)
    lines.push(`  why: ${candidate.reasons.join('; ')} [${candidate.turn}:dm]`)
  }
  return lines.join('\n')
}

/** Resolve the bound workspace and campaign, then gather everything the tool needs. */
function gather(root, id, options) {
  const opts = { ...DEFAULTS, ...options }
  const { turns } = loadTranscriptsIn(root, id)
  const { matchers, pcs } = rosterMatchers(root, id)
  const records = buildContextRecords(turns, matchers, opts)
  const state = loadState(id)
  const scene = {
    actors: Array.isArray(state?.scene?.entities) ? state.scene.entities : [],
    where: state?.scene?.location ?? null,
    title: state?.scene?.title ?? null,
  }
  const currentTurn = state?.last_turn?.number ?? (records.at(-1)?.turn ?? 0)
  return { opts: { ...opts, playerCharacters: [...pcs] }, records, scene, currentTurn }
}

export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'dd35_context_index',
    description:
      'Look up the campaign\'s contextual records: who was present in each turn, where, when, and what happened. '
      + 'With no arguments it reports the triggered candidates for the current scene — use it when a character or '
      + 'place comes back after an absence and you want the history you already played. '
      + 'Pass `entity` to list every turn that entity appears in, with whom and where. '
      + 'Derived from the transcripts by exact matching; costs no model call and every line names its turn.',
    parameters: {
      entity: { type: 'string', description: 'List the turns one entity appears in, with co-actors and places.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      actorGap: { type: 'integer', description: 'Turns of absence before a returning actor triggers retrieval. Defaults to 8.' },
      maxCandidates: { type: 'integer', description: 'Maximum candidates to return. Defaults to 6.' },
      recentWindow: { type: 'integer', description: 'Turns this recent are assumed to be in context and never surfaced. Defaults to 12.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute: bounded(({ entity, campaign, actorGap, maxCandidates, recentWindow }) => {
      const id = requireCampaign(campaign)
      const opts = {
        ...(Number.isInteger(actorGap) && actorGap > 0 ? { actorGap } : {}),
        ...(Number.isInteger(maxCandidates) && maxCandidates > 0 ? { maxCandidates } : {}),
        ...(Number.isInteger(recentWindow) && recentWindow >= 0 ? { recentWindow } : {}),
      }
      const root = workspace()
      const gathered = gather(root, id, opts)

      if (typeof entity === 'string' && entity.length > 0) {
        const turns = gathered.records.filter((record) => record.actors.includes(entity))
        return {
          campaign: id,
          entity,
          turns: turns.map((record) => ({
            turn: record.turn,
            date: record.date,
            where: record.where,
            with: record.actors.filter((actor) => actor !== entity),
            label: record.label,
            unresolved: record.unresolved,
          })),
          note: turns.length === 0
            ? 'No turn mentions this id. It may be recorded under a different name, or never appeared.'
            : 'Co-actors are inferred from prose when the turn recorded no entity list.',
        }
      }

      return {
        campaign: id,
        current_turn: gathered.currentTurn,
        ...findContextCandidates(gathered.records, gathered.scene, gathered.currentTurn, opts),
      }
    }),
  }))
}
