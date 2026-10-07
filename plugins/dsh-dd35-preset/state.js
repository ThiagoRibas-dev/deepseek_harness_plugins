/**
 * D&D 3.5e DM — state, session, and campaign lifecycle tools.
 *
 * These replace the hand-maintained `campaign_log.md` / transcript prose
 * instructions with deterministic tools: the model calls them, and the exact
 * file formats, transcript numbering, and state bookkeeping happen in code.
 *
 * Division of truth: state.json holds session facts (mode, clock, initiative,
 * scene); each entity sheet holds per-entity facts (hp, ac, conditions, ...).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  actorsDir, bounded, campaignDir, campaignRoot, configure, defaultEntity,
  defaultState, ensureDir, listCampaignIds, loadAnyEntity, loadEntities,
  loadSceneEntities, loadState, patchEntity, playerDir, readActiveCampaign,
  readText, registryPath, requireCampaign, requireState, saveEntity, saveState,
  statePath, transcriptsDir, writeRegistry,
} from './state-store.js'

/** Register a tool whose campaign paths bind to the calling session's workspace. */
const define = (tool) => defineTool({ ...tool, execute: bounded(tool.execute) })

export const name = 'dd35-state'
export const inject = ['tools']

const MODE_CONSTRAINTS = {
  encounter:
    'ENCOUNTER MODE: strict 6-second rounds. Resolve actions in initiative order and keep it visible. '
    + 'Enforce action types (standard / move / swift / immediate / full-round / free), 5-ft steps, and attacks of opportunity. '
    + 'Never skip an NPC turn. At the end of the round, roll monster behaviour with roll_monster_behavior(phase="reaction").',
  exploration:
    'EXPLORATION MODE: time passes in ~10-minute increments (hours overland). Track marching order, light and vision, '
    + 'and use Perception/Search/Disable Device/Survival checks. Ask what the party does for the next stretch.',
  downtime:
    'DOWNTIME MODE: time passes in days to weeks. Resolve rest recovery, crafting, Gather Information, profession income, '
    + 'spell research/item creation costs, and living expenses.',
}

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const briefEntity = (entity) => ({
  id: entity.id,
  name: entity.name,
  kind: entity.kind,
  hp: entity.hp,
  max_hp: entity.max_hp,
  temp_hp: entity.temp_hp ?? 0,
  ac: entity.ac,
  ...(entity.position ? { position: entity.position } : {}),
  conditions: (entity.conditions ?? []).map((cond) => (typeof cond === 'string' ? cond : cond.name)),
})

/** Compact, model-facing projection of session state plus its entities. */
function compact(id, state) {
  const present = loadSceneEntities(id, state)
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
    party: loadEntities(id, 'pc').map(briefEntity),
    present: present.filter((entity) => entity.kind !== 'pc').map(briefEntity),
  }
}

export function apply(ctx, config = {}) {
  configure(config)

  ctx.tools.register(define({
    name: 'get_state',
    description:
      'Read the active campaign\'s current state: mode, in-game clock, initiative order and whose turn it is, '
      + 'the current scene (location, entities, micro-state, pending action), and the live HP/AC/conditions of every '
      + 'entity in the scene. Call this at the start of a turn to resync before narrating or resolving anything.',
    parameters: {
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      full: { type: 'boolean', description: 'Include the raw session state alongside the summary.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign, full = false }) {
      const id = requireCampaign(campaign)
      const state = requireState(id)
      const summary = compact(id, state)
      return full ? { ...summary, raw: state } : summary
    },
  }))

  ctx.tools.register(define({
    name: 'set_mode',
    description:
      'Set the play mode (encounter | exploration | downtime) and return that mode\'s deterministic constraints. '
      + 'Call it the moment the mode changes — when combat starts or ends, when travel begins, or when the party rests.',
    parameters: {
      mode: { type: 'string', required: true, enum: ['encounter', 'exploration', 'downtime'], description: 'The mode to enter.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ mode, campaign }) {
      const id = requireCampaign(campaign)
      const state = requireState(id)
      state.mode = mode
      saveState(id, state)
      return { campaign: id, mode, constraints: MODE_CONSTRAINTS[mode] }
    },
  }))

  ctx.tools.register(define({
    name: 'update_scene',
    description:
      'Update the active scene: title, status, location, entities present, the granular end-of-turn micro-state, '
      + 'and the pending action the player must answer. Also sets the in-game clock (date/time).',
    parameters: {
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      title: { type: 'string', description: 'Scene/event title.' },
      status: { type: 'string', enum: ['active', 'completed', 'on_hold'], description: 'Scene status.' },
      location: { type: 'string', description: 'Micro location.' },
      entities: { type: 'json', description: 'JSON array of entity ids present in the scene.' },
      micro_state: { type: 'string', description: 'Granular end-of-turn state: environment, NPC dispositions, hooks.' },
      pending_action: { type: 'string', description: 'The exact question the player must answer next.' },
      date: { type: 'string', description: 'In-game date.' },
      time: { type: 'string', description: 'In-game time of day.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign, date, time, ...scene }) {
      const id = requireCampaign(campaign)
      const state = requireState(id)
      if (date !== undefined) state.clock.date = date
      if (time !== undefined) state.clock.time = time
      for (const [key, value] of Object.entries(scene)) {
        if (value !== undefined) state.scene[key] = value
      }
      saveState(id, state)
      return { campaign: id, scene: state.scene, clock: state.clock }
    },
  }))

  ctx.tools.register(define({
    name: 'route_turn',
    description:
      'Decide how to open this turn. Returns the phase to run: "session_zero" (no campaign exists yet), '
      + '"fresh_session" (first message of a session — recap prior events from the log first), or "gameplay" '
      + '(the normal loop in the returned mode). Call this on the first message of a session.',
    parameters: {
      first_message: { type: 'boolean', description: 'True when this is the first message of a new session.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ first_message = false }) {
      const active = readActiveCampaign()
      if (!active) return { phase: 'session_zero', campaign: null, reason: 'no active campaign in the registry' }
      const state = loadState(active)
      const phase = first_message ? 'fresh_session' : 'gameplay'
      return {
        phase,
        campaign: active,
        mode: state?.mode ?? 'exploration',
        scene: state?.scene ?? null,
        hint: phase === 'fresh_session'
          ? 'Recap prior events with list_memories, then fetch_memories for the turns you need.'
          : 'Resync with get_state, then run the gameplay loop.',
      }
    },
  }))

  ctx.tools.register(define({
    name: 'create_campaign',
    description:
      'Initialize a new campaign: creates campaign/<id>/{player,actors,events/transcripts}, writes a fresh '
      + 'state.json and a sheet per starting party member, and makes it the active campaign.',
    parameters: {
      identifier: { type: 'string', required: true, description: 'Short lowercase underscore identifier, e.g. chronicles_of_isaldar.' },
      name: { type: 'string', required: true, description: 'Human-readable campaign name.' },
      setting: { type: 'string', description: 'Setting folder path, e.g. campaign/setting/<name>.' },
      party: { type: 'json', description: 'JSON array of party members: [{ id, name, hp, max_hp, ac, initiative_bonus }].' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ identifier, name, setting, party = [] }) {
      if (!/^[a-z0-9_]+$/.test(identifier)) throw new Error('identifier must be lowercase letters, digits and underscores')
      const id = identifier
      ensureDir(campaignDir(id))
      ensureDir(playerDir(id))
      ensureDir(actorsDir(id))
      ensureDir(transcriptsDir(id))
      saveState(id, defaultState(id, { name, setting: setting ?? null }))
      for (const member of party) {
        saveEntity(id, member.id, 'pc', defaultEntity(member.id, { ...member, kind: 'pc' }))
      }
      writeRegistry({ active: id, title: name, setting: setting ?? null })
      return { campaign: id, state: statePath(id), registry: registryPath(), party: party.map((member) => member.id) }
    },
  }))

  ctx.tools.register(define({
    name: 'create_entity',
    description:
      'Create a structured entity sheet (character or NPC). Use for new PCs, NPCs, cohorts, familiars, and monsters '
      + 'that need tracked HP/AC/conditions.',
    parameters: {
      entity_id: { type: 'string', required: true, description: 'Entity id, e.g. thiago or goblin_1.' },
      kind: { type: 'string', enum: ['pc', 'npc'], description: 'pc (player/) or npc (actors/). Defaults to npc.' },
      name: { type: 'string', description: 'Display name.' },
      hp: { type: 'integer', description: 'Current/max hit points.' },
      ac: { type: 'integer', description: 'Armor class.' },
      initiative_bonus: { type: 'integer', description: 'Initiative modifier.' },
      sheet: { type: 'json', description: 'Extra sheet fields to merge (stats, skills, saves, resources, ...).' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ entity_id, kind = 'npc', name, hp, ac, initiative_bonus, sheet = {}, campaign }) {
      const id = requireCampaign(campaign)
      const created = {
        ...defaultEntity(entity_id, { kind, ...(name === undefined ? {} : { name }), ...(hp === undefined ? {} : { hp, max_hp: hp }), ...(ac === undefined ? {} : { ac }), ...(initiative_bonus === undefined ? {} : { initiative_bonus }) }),
        ...sheet,
      }
      saveEntity(id, entity_id, kind, created)
      return { campaign: id, entity_id, kind, sheet: created }
    },
  }))

  ctx.tools.register(define({
    name: 'list_campaigns',
    description: 'List campaign identifiers under campaign/ and show which is active.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return { active: readActiveCampaign(), campaigns: listCampaignIds(), root: campaignRoot() }
    },
  }))

  ctx.tools.register(define({
    name: 'set_active_campaign',
    description: 'Switch the active campaign in campaign_registry.md.',
    parameters: {
      identifier: { type: 'string', required: true, description: 'Campaign identifier to activate.' },
      name: { type: 'string', description: 'Human-readable name (defaults to the campaign name).' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ identifier, name }) {
      if (!existsSync(campaignDir(identifier))) throw new Error(`No such campaign: ${identifier}`)
      const state = loadState(identifier)
      writeRegistry({ active: identifier, title: name ?? state?.name ?? identifier, setting: state?.setting ?? null })
      return { active: identifier }
    },
  }))

  ctx.tools.register(define({
    name: 'get_entity',
    description:
      'Read a structured entity sheet (character or NPC) from player/<id>.json or actors/<id>.json. '
      + 'Falls back to the human-readable markdown sheet when no JSON exists yet.',
    parameters: {
      entity_id: { type: 'string', required: true, description: 'Entity id, e.g. thiago.' },
      kind: { type: 'string', enum: ['pc', 'npc'], description: 'pc (player/) or npc (actors/). Defaults to pc.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ entity_id, kind = 'pc', campaign }) {
      const id = requireCampaign(campaign)
      const sheet = loadAnyEntity(id, entity_id)
      if (sheet) return { campaign: id, entity_id, kind: sheet.kind ?? kind, sheet }
      const dir = kind === 'npc' ? actorsDir(id) : playerDir(id)
      return { campaign: id, entity_id, kind, sheet: null, markdown: readText(join(dir, `${entity_id}.md`)) }
    },
  }))

  ctx.tools.register(define({
    name: 'update_entity',
    description:
      'Patch an entity sheet (shallow merge). Use for hp, ac, conditions, resources, position, and other sheet fields. '
      + 'Creates the sheet on first use. This is the authoritative record for per-entity state.',
    parameters: {
      entity_id: { type: 'string', required: true, description: 'Entity id.' },
      kind: { type: 'string', enum: ['pc', 'npc'], description: 'pc (player/) or npc (actors/). Defaults to pc.' },
      patch: { type: 'json', required: true, description: 'JSON object of fields to merge into the sheet.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ entity_id, kind = 'pc', patch, campaign }) {
      const id = requireCampaign(campaign)
      return { campaign: id, entity_id, kind, sheet: patchEntity(id, entity_id, kind, patch) }
    },
  }))
}
