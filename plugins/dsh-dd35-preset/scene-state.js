/**
 * D&D 3.5e DM — passive scene and cast state.
 *
 * Spec: docs/dd35-memory-model-improvement.md §4.1 / §4.4.
 *
 * Why this exists
 * ---------------
 * Measured over 88 real sessions and 4,072 inference steps, **half of all tool
 * traffic was filesystem work** — `read` alone was called 1,113 times, more than
 * any preset tool, and its targets were the campaign's own history
 * (`player/backstory.md` 99, early transcripts 76/59/50). Previous sessions re-read
 * earlier campaign transcripts and player backstory via filesystem calls because
 * that state was not automatically present in prompt context. This module injects
 * active scene and cast state automatically.
 *
 * Core architectural constraints
 * ------------------------------
 * 1. **Identity, not a second source of truth.** Entity rows are rendered by
 *    `briefEntity` from `state-store.js` — the same function `get_state` uses —
 *    so the injected block and the tool result cannot disagree about what an
 *    entity is (spec §4.1.2).
 * 2. **A freshness line is mandatory.** The channel wraps every snapshot in the
 *    fixed text "This snapshot supersedes earlier runtime-context snapshots."
 *    Every superseded snapshot is *retained in session history* and one provider
 *    delivers all of them, so a line reading `as of turn N` is the only way the
 *    model can tell which snapshot is current (spec §4.1.3).
 * 3. **It must stay small.** `joinContextSections` renders *every* context into
 *    one message, so a change to any of them re-emits the whole block. Volatile
 *    records are positioned at the end so byte-limit truncation discards them
 *    before static campaign data.
 * 4. **It never throws.** This runs on the request's error path during prompt
 *    assembly; an absent campaign, a missing `state.json`, or an unreadable file
 *    must contribute `''`. An unhandled exception aborts prompt assembly.
 * 5. **It does not restate the recent turns.** The session already carries them
 *    verbatim. Re-injecting them would duplicate data and alter the prompt prefix
 *    every turn without adding information.
 */
import { join } from 'node:path'
import { campaignTurnKey, createTurnFrozenContext } from './context-freeze.js'
import {
  briefEntity, campaignFilePath, listEntityIdsIn, loadEntityIn, resolveSessionCampaignIn,
  readJson, readText,
} from './state-store.js'
import { lastSeenByActor, loadTranscriptsIn } from './memory-store.js'
import { consultOracle } from './oracle-core.js'

export const name = 'dd35-scene-state'

/** The prompt context registry this module contributes to. */
export const inject = ['systemPrompt']

export const HEADING = '## Active Game State'

const DEFAULTS = {
  /** Total byte budget for the runtime snapshot contribution, notices included. */
  sceneStateMaxBytes: 6144,
  /**
   * Byte budget for the player character prose prompt section.
   *
   * Measured on the live campaign, the three player files total 23.3 KB
   * (`backstory.md` 4.5 KB, `character.md` 9.9 KB, `companions.md` 8.9 KB) — approximately
   * 6,700 tokens. Positioning these files in an immutable system-prompt section allows
   * KV-caching providers to compute attention tensors once and reuse them across turns,
   * avoiding both repetitive filesystem reads (99 reads of `backstory.md` historically)
   * and resending the content on each turn. The budget accommodates complete files to
   * prevent partial truncation without clear indicators.
   */
  playerFilesMaxBytes: 24576,
  /** Per-file budget inside that section. */
  playerFileMaxBytes: 12288,
  /** After the DM persona (100) and the campaign persona (110), before policy. */
  playerSectionOrder: 120,
  /**
   * Render after `dd35:dm-notes` (200) so volatile scene state is positioned at
   * the end of the joined snapshot and truncated before notes when over budget.
   */
  sceneStateOrder: 300,
  /** Files from `player/` to include, in order. `.md` only; sheets render elsewhere. */
  playerFiles: ['backstory.md', 'character.md', 'companions.md'],
  /**
   * An off-stage actor counts as "active cast" while it was seen within this many
   * turns of the newest one, and renders a full line. Everyone else collapses to
   * name + id under *Also on file* (see `knownCastBlock`).
   */
  castRecentTurns: 30,
  /** Cap on the collapsed *Also on file* names, so a huge cast cannot grow unbounded. */
  castDormantLimit: 40,
  /**
   * Roll an inspiration consultation when a new scene opens (FI-20).
   *
   * The trigger is a **scene title change against the previous turn's transcript
   * header**, not a pending action. A pending action is whatever the DM last
   * recorded and can be stale for many turns; the title tracks the scene that was
   * actually played. Measured on the live corpus it fires 6 times in 41 turns —
   * one per ~7 turns, at real transitions, never mid-scene.
   */
  oracleOnSceneChange: true,
  /** Its own budget, so a large scene state cannot squeeze the vectors out. */
  oracleMaxBytes: 640,
}

/**
 * Trim to a UTF-8 byte budget, ending with a visible notice rather than a silent cut.
 *
 * A budget at or below the notice's own size still returns the notice: returning
 * `''` here would make an over-tight cap delete the block silently, which is the
 * failure this whole module is written to avoid.
 */
function cap(text, maxBytes, label) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const notice = `\n\n[${label} truncated at ${maxBytes} bytes]`
  const budget = maxBytes - Buffer.byteLength(notice, 'utf8')
  if (budget <= 0) return notice.trimStart()
  let slice = text.slice(0, budget)
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > budget) slice = slice.slice(0, -1)
  return `${slice}${notice}`
}

const list = (values) => (values.length > 0 ? values.join(', ') : 'none')

/**
 * One rendered entity line, built from the shared projection rather than from
 * the raw sheet — so the block and `get_state` cannot report different hp, ac,
 * or condition names for the same entity.
 */
function row(brief, { withConditions = true } = {}) {
  const temp = brief.temp_hp > 0 ? ` (+${brief.temp_hp} temp)` : ''
  const hp = brief.max_hp === undefined ? `HP ${brief.hp}` : `HP ${brief.hp}/${brief.max_hp}${temp}`
  const ac = brief.ac === undefined ? '' : ` · AC ${brief.ac}`
  const pos = brief.position ? ` · ${brief.position}` : ''
  const cond = withConditions ? ` · conditions: ${list(brief.conditions)}` : ''
  return `- **${brief.name ?? brief.id}** (${brief.id}) — ${hp}${ac}${pos}${cond}`
}

/** The mechanical detail §4.4 restored: buff effects and the sheet's own notes. */
function detailLines(brief) {
  const out = []
  if ((brief.condition_effects ?? []).length > 0) out.push(`  - effects: ${brief.condition_effects.join(' · ')}`)
  const resources = brief.resources ?? {}
  const keys = Object.keys(resources).filter((key) => String(resources[key] ?? '').trim() !== '')
  if (keys.length > 0) out.push(`  - resources: ${keys.map((key) => `${key} = ${resources[key]}`).join(' · ')}`)
  if (String(brief.notes ?? '').trim() !== '') out.push(`  - notes: ${String(brief.notes).trim()}`)
  return out
}

/** The party: full mechanical detail, because this is what the DM narrates from. */
function partyBlock(root, id) {
  const party = listEntityIdsIn(root, id, 'pc')
    .map((entityId) => loadEntityIn(root, id, entityId, 'pc'))
    .filter(Boolean)
    .map((sheet) => briefEntity(sheet))
  if (party.length === 0) return []
  const lines = ['### Party']
  for (const brief of party) {
    lines.push(row(brief))
    lines.push(...detailLines(brief))
  }
  return lines
}

/** Everyone else on stage right now. */
function presentBlock(root, id, state) {
  const rows = []
  for (const entityId of state.scene?.entities ?? []) {
    const sheet = loadEntityIn(root, id, entityId, 'pc') ?? loadEntityIn(root, id, entityId, 'npc')
    if (sheet === null) {
      // Spec §6.1: name the gap, never drop it silently. `maude` in the live
      // campaign is exactly this case, and a silently-omitted NPC is the failure
      // the whole adjudication design exists to prevent.
      rows.push(`- **${entityId}** — no sheet on file`)
      continue
    }
    if (sheet.kind === 'pc') continue // already rendered in the party block
    rows.push(row(briefEntity(sheet, { includeDetail: false })))
  }
  if (rows.length === 0) return []
  return ['### Present (non-party)', ...rows]
}

/**
 * The rest of the cast, graded by how much attention each one earns.
 *
 * An ungraded roster grows without bound: a 300-actor campaign would inject 300
 * lines every step, for characters most of which are three story-arcs stale. The
 * grade comes from two signals, cheapest first:
 *
 *  - **Recency**, derived from the transcripts (`lastSeenByActor`). Needs no
 *    authoring and is right by default: whoever the story has been about lately
 *    is who the DM is most likely to need.
 *  - **`npc_tier`**, an optional field on the sheet. This is the only signal that
 *    can answer *"who have I forgotten?"* — a character absent for 60 turns is
 *    invisible to recency by definition, which is exactly the failure §8's second
 *    open question describes. `main` promotes them back into the detailed list
 *    regardless of how long they have been away.
 *
 * Active cast render a full line; everyone else collapses to name + id, so the
 * roster stays a *findable index* rather than growing into a second party block.
 */
function knownCastBlock(root, id, state, opts) {
  const onStage = new Set(state.scene?.entities ?? [])
  const sheets = listEntityIdsIn(root, id, 'npc')
    .map((entityId) => loadEntityIn(root, id, entityId, 'npc'))
    .filter((sheet) => sheet !== null && !onStage.has(sheet.id))

  const seen = lastSeenByActor(root, id, sheets)
  const lastTurn = Number.isFinite(state.last_turn?.number) ? state.last_turn.number : 0

  const active = []
  const dormant = []
  for (const sheet of sheets) {
    const record = seen.get(sheet.id) ?? { lastTurn: null, turns: 0 }
    const away = record.lastTurn === null ? null : Math.max(0, lastTurn - record.lastTurn)
    const isMain = sheet.npc_tier === 'main'
    const isRecent = away !== null && away <= opts.castRecentTurns
    if (isMain || isRecent) {
      active.push({ sheet, record, away, isMain })
    } else {
      dormant.push({ sheet, record, away })
    }
  }

  const lines = []
  if (active.length > 0) {
    active.sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.away ?? 1e9) - (b.away ?? 1e9))
    lines.push('### Known cast, not present')
    for (const { sheet, away, isMain } of active) {
      const where = sheet.position ? ` · ${sheet.position}` : ''
      const when = away === null ? 'never on stage' : away === 0 ? 'this turn' : `${away} turn(s) ago`
      lines.push(`- ${sheet.name ?? sheet.id} (${sheet.id}) — HP ${sheet.hp}${sheet.ac === undefined ? '' : ` · AC ${sheet.ac}`}${where} · seen ${when}${isMain ? ' · **main**' : ''}`)
    }
  }

  if (dormant.length > 0) {
    // Kept as names, never dropped: this was the original point of the roster —
    // knowing who exists without having to remember them first. Only the *detail*
    // is withdrawn, and the size is bounded by a cap with an explicit count.
    dormant.sort((a, b) => (b.record.lastTurn ?? 0) - (a.record.lastTurn ?? 0))
    const shown = dormant.slice(0, opts.castDormantLimit)
    const names = shown.map(({ sheet, away }) =>
      `${sheet.name ?? sheet.id} (${sheet.id}${away === null ? ', never on stage' : `, ${away} turn(s) ago`})`)
    const hidden = dormant.length - shown.length
    lines.push('### Also on file', names.join(' · ') + (hidden > 0 ? ` · …and ${hidden} more` : ''))
  }

  return lines
}

/**
 * The player's authored character prose, contributed as an immutable
 * **system-prompt section** rather than part of the runtime snapshot.
 *
 * Incorporating player backstory files into a static system-prompt section
 * prevents repetitive disk reads (which accounted for 99 reads in benchmarked campaigns).
 * Because this content changes infrequently across a campaign, placing it in an
 * immutable system-prompt section allows LLM providers with KV prefix caching to
 * compute attention states once on turn 1 and reuse the cache across subsequent turns.
 * In contrast, placing these files in the runtime snapshot would resend the full byte
 * payload on every step. The byte limit is set high enough to preserve whole files,
 * as partial truncation causes missing character details without explicit indicators.
 */
function playerFilesSection(assemble, opts) {
  try {
    const session = assemble?.agent?.session
    const root = session?.header?.cwd
    const id = resolveSessionCampaignIn(root, session).id
    if (id === null) return ''
    const parts = []
    for (const file of opts.playerFiles) {
      const text = readText(campaignFilePath(root, id, join('player', file)))
      if (text === null || text.trim() === '') continue
      parts.push(`### ${file}`, cap(text.trim(), opts.playerFileMaxBytes, file))
    }
    if (parts.length === 0) return ''
    return [
      '## Player Character',
      `The player's own notes on their character, from \`campaign/${id}/player/\`. This is the player's material — build on it rather than overriding it — and it is distinct from your own campaign notes.`,
      '',
      cap(parts.join('\n'), opts.playerFilesMaxBytes, 'player files'),
    ].join('\n')
  } catch {
    return ''
  }
}

/** The player's own authored prose, as a system-prompt section. */
export function playerFilesText(assemble, options) {
  const opts = { ...DEFAULTS, ...options }
  return playerFilesSection(assemble, opts)
}

/**
 * The previous turn's scene title, from the transcript header.
 *
 * Returns null when there is no earlier turn, which is what keeps the trigger to
 * **A → B** rather than **nothing → A**: with no prior scene there is nothing to
 * have changed from, and firing on a campaign's first turn would put vectors in
 * front of the DM before any scene exists.
 */
function previousSceneTitle(root, id, currentTurn) {
  if (!Number.isFinite(currentTurn)) return null
  const { turns } = loadTranscriptsIn(root, id)
  const before = turns.filter((turn) => turn.number < currentTurn)
  const last = before.at(-1)
  return last ? { title: last.title ?? null, turn: last.number } : null
}

/**
 * A consultation, rolled once per scene.
 *
 * **Seeded from the turn number**, because this renders per *step*: an unseeded
 * random draw would generate different vectors on every step of the same scene,
 * creating snapshot churn across steps. Seeding from turn number ensures the roll
 * is deterministic and reproducible from `(turn)` alone without secondary storage.
 *
 * The DM can also invoke `consult_oracle` directly for an unseeded draw; this
 * automatic consultation provides thematic prompts at scene transitions.
 */
export function oracleBlock(root, id, state, opts) {
  if (opts.oracleOnSceneChange !== true) return []
  const turn = state.last_turn?.number
  const title = state.scene?.title || state.scene?.location || null
  if (title === null || !Number.isFinite(turn)) return []

  const previous = previousSceneTitle(root, id, turn)
  if (previous === null) return []
  if (previous.title === title) return []

  // Re-read the configured table set through the one implementation that owns
  // the vector rules.
  const consultation = consultOracle({ seed: turn })
  if (consultation.error !== undefined) return []
  const values = (consultation.vectors ?? []).map((vector) => vector.value).filter(Boolean)
  if (values.length === 0) return []

  const header = `### Oracle — new scene (was: ${previous.title || 'unnamed'})`
  const note = '_Independent draws for you to reconcile. They are not facts about the world until you narrate them._'
  return [header, values.join(' · '), note, '']
}

/**
 * Render the whole contribution for one assembly.
 *
 * @param assemble - the assembly context; the campaign resolves from its session cwd.
 * @param opts - resolved options (byte budgets, order, file list).
 * @returns the snapshot text, or `''` when there is no campaign or no state.
 */
export function sceneStateContext(assemble, options) {
  // Merge here rather than trusting the caller: `apply()` resolves config, but a
  // direct call with a partial object would otherwise leave a budget `undefined`,
  // and `cap()` would throw on the resulting NaN slice — silently, because the
  // catch below exists to protect prompt assembly.
  const opts = { ...DEFAULTS, ...options }
  try {
    const session = assemble?.agent?.session
    const root = session?.header?.cwd
    const id = resolveSessionCampaignIn(root, session).id
    if (id === null) return ''

    const state = readJson(campaignFilePath(root, id, 'state.json'))
    if (state === null || state === undefined) return ''

    const round = state.initiative?.round ?? 0
    const inCombat = Number.isFinite(round) && round > 0
    const turn = state.last_turn?.number
    const stamp = state.last_turn?.at ? `, ${String(state.last_turn.at).slice(0, 16).replace('T', ' ')}` : ''

    const lines = [
      HEADING,
      turn === undefined
        ? 'These are the live numbers for this moment. This snapshot supersedes earlier runtime-context snapshots.'
        : `**State as of turn ${turn}${stamp}.** This snapshot supersedes earlier runtime-context snapshots — if you can see more than one, only the highest turn number is current.`,
      '',
      `- **Mode:** ${state.mode ?? 'unknown'}${inCombat ? ` (round ${round}${state.initiative?.order?.length ? `, ${state.initiative.order[state.initiative.index ?? 0] ?? '?'} to act` : ''})` : ''}`,
      `- **Location:** ${state.scene?.location || state.scene?.title || '(unset)'}`,
      `- **Clock:** ${state.clock?.date ?? '?'} ${state.clock?.time ?? ''}`.trimEnd(),
      `- **Micro-state:** ${state.scene?.micro_state || '(none recorded)'}`,
      `- **Pending action:** ${state.scene?.pending_action || '(none recorded)'}`,
      '',
    ]

    // The oracle receives a dedicated byte budget applied before merging into the
    // body so that large scene state text cannot displace oracle vectors.
    const oracle = oracleBlock(root, id, state, opts)
    if (oracle.length > 0) lines.push(cap(oracle.join('\n'), opts.oracleMaxBytes, 'oracle'), '')

    const party = partyBlock(root, id)
    const present = presentBlock(root, id, state)
    const cast = knownCastBlock(root, id, state, opts)
    const closing = '_These numbers come from the campaign files and are current for this turn. '
      + 'Re-read with `get_state` after any tool that changes a sheet mid-turn — `apply_damage`, '
      + '`roll_attack(apply: true)`, `next_turn` — because this block is rebuilt per step, not per tool call._'

    // Volatile records are placed after party data so byte-limit truncation
    // drops transient cast details before core party state.
    // The closing note sits with the state it describes rather than at the very
    // end, so a capped block does not lose it. The player's prose is a separate
    // prompt *section* (see `playerFilesText`), not part of this snapshot.
    for (const block of [party, present, cast]) {
      if (block.length > 0) lines.push(...block, '')
    }
    lines.push(closing, '')

    const body = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()
    if (body === '') return ''
    return cap(body, opts.sceneStateMaxBytes, 'scene state')
  } catch {
    // Prompt assembly runs on the request's error path. An absent campaign,
    // corrupt JSON, or an unreadable directory contributes nothing; unhandled
    // exceptions must not abort the session.
    return ''
  }
}

/**
 * A non-negative integer config value, or the default.
 *
 * Zero is honoured deliberately: `playerFilesMaxBytes: 0` switches the player's
 * prose block off, which is a legitimate budget choice rather than a typo.
 */
function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Register the scene-state context for this preset's scope.
 * @param ctx - the preset's agent scope; an unscoped mount would shadow other sessions.
 * @param config - optional byte budgets, order, and player-file list.
 */
export function apply(ctx, config = {}) {
  const opts = {
    ...DEFAULTS,
    ...config,
    sceneStateMaxBytes: nonNegativeInt(config.sceneStateMaxBytes, DEFAULTS.sceneStateMaxBytes),
    playerFilesMaxBytes: nonNegativeInt(config.playerFilesMaxBytes, DEFAULTS.playerFilesMaxBytes),
    playerFileMaxBytes: nonNegativeInt(config.playerFileMaxBytes, DEFAULTS.playerFileMaxBytes),
    playerFiles: Array.isArray(config.playerFiles) && config.playerFiles.length > 0
      ? config.playerFiles
      : DEFAULTS.playerFiles,
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dd35:player-files',
    order: opts.playerSectionOrder,
    // The player's prose is arbitrary text: never scan it for {{variable}} groups.
    interpolate: false,
    text: (assemble) => playerFilesSection(assemble, opts),
  }), 'dd35-scene-state.playerFiles()')

  // Frozen for the duration of a turn. This section reads `state.json` on every
  // assembly, and `update_scene` rewrites it mid-turn, so without the freeze the
  // harness appended a fresh ~9 KB snapshot between a tool call and its result
  // and retained every superseded copy. See `context-freeze.js`.
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dd35:scene-state',
    order: opts.sceneStateOrder,
    text: createTurnFrozenContext({
      keyOf: campaignTurnKey,
      render: (assemble) => sceneStateContext(assemble, opts),
    }),
  }), 'dd35-scene-state.context()')
}
