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
  actorsDir, bindSessionCampaign, bounded, briefEntity, campaignDir, campaignRoot, configure,
  defaultEntity, defaultState, ensureDir, listCampaignIds, loadAnyEntity, loadEntities,
  loadSceneEntities, loadState, patchEntity, playerDir, resolveSessionCampaign,
  readText, registryPath, requireCampaign, requireState, saveEntity, saveState,
  setSessionLookup, statePath, transcriptsDir, unbindSessionCampaign, writeRegistry,
} from './state-store.js'

/** Register a tool whose campaign paths bind to the calling session's workspace. */
const define = (tool) => defineTool({ ...tool, execute: bounded(tool.execute) })

export const name = 'dd35-state'
/**
 * `sessions` is here for one reason: a fork records only its immediate parent, so
 * following a chain of forks needs `sessions.get` to reach the ancestors' own
 * `parentSession`. `dsh-compaction-guard`'s engine already injects the same
 * service inside this preset, so it is present in this scope.
 */
export const inject = ['tools', 'sessions']

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
    party: loadEntities(id, 'pc').map((entity) => briefEntity(entity)),
    present: present.filter((entity) => entity.kind !== 'pc').map((entity) => briefEntity(entity)),
  }
}

export function apply(ctx, config = {}) {
  configure(config)

  // Lets the resolver walk a chain of forks. Shared module instance, so wiring it
  // here also covers dd35-prompt and dd35-scene-state, which mount later.
  setSessionLookup((id) => ctx.sessions.get(id))

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
      const hint = `Entered ${mode} mode. Follow ${mode} procedures and action economy as defined in`
        + ` the \`dd35-${mode}-mode\` skill.`
      return { campaign: id, mode, constraints: MODE_CONSTRAINTS[mode], hint }
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
      'Determine the opening phase for the current turn. Evaluates session and campaign state to return one of '
      + 'five operational phases: "setup" (campaign attached but no turns played yet; establish the starting '
      + 'framework before opening a scene), "session_zero" (no campaign exists in this workspace yet), '
      + '"choose_campaign" (campaigns exist but none attached to this session; prompt the player to select or '
      + 'create one), "fresh_session" (first message of a session with existing history; recap prior events '
      + 'first), or "gameplay" (active turn loop in the current mode). Call this on the first message of every '
      + 'session.',
    parameters: {
      first_message: { type: 'boolean', description: 'True when this is the first message of a new session.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ first_message = false }) {
      const resolved = resolveSessionCampaign()
      if (resolved.id === null) {
        const campaigns = (() => { try { return listCampaignIds() } catch { return [] } })()
        if (campaigns.length === 0) {
          return {
            phase: 'session_zero',
            campaign: null,
            campaigns: [],
            reason: 'no campaign exists in this workspace yet',
            hint: 'Build a campaign with the player: agree the setting and the party, then create it. The '
              + '`dd35-session-zero` skill carries the interview and the build.',
          }
        }
        return {
          phase: 'choose_campaign',
          campaign: null,
          campaigns,
          reason: 'this session has no campaign attached',
          hint: 'Greet the player, then ask whether to start a new campaign or continue one of these. A new '
            + 'one is `create_campaign`; continuing an existing one is `set_active_campaign`. The '
            + '`dd35-campaign-choice` skill carries the full procedure.',
        }
      }

      // Pin anything that was not an explicit choice, so the resolution stops
      // depending on something outside this session.
      //
      //   `legacy`    — a later change to the registry must not move a live session.
      //   `inherited` — a fork of a fork has no entry of its own, and pinning the
      //                 middle link is what lets the chain resolve past it even
      //                 once an ancestor is gone.
      if (resolved.source !== 'bound') {
        try { bindSessionCampaign(resolved.id) } catch { /* pinning is best-effort */ }
      }

      const state = loadState(resolved.id)
      // A campaign that has never captured a turn is built but not yet played:
      // no opening scene exists for the player to resume, and nothing in the log
      // can be recapped. An `active` scene means the framing was already agreed,
      // so it keeps the normal phases even if the first turn has not landed yet.
      // `last_turn` is tested for absence, not against `null`: `loadState` is a
      // raw JSON read, so a hand-authored `state.json` may omit the key.
      const unplayed = !state?.last_turn
      const framed = state?.scene?.status === 'active'
      const phase = unplayed && !framed ? 'setup' : (first_message ? 'fresh_session' : 'gameplay')
      const hints = {
        setup: 'No turns have been played in this campaign yet. Settle the starting framework with the player '
          + 'first (character level, campaign premise, starting location, and party or cohort roster). Do not '
          + 'narrate the opening scene until the player confirms the setup. Once confirmed, initialize the '
          + 'environment with update_scene and set_mode. The `dd35-session-zero` skill covers the interview, '
          + 'the build, and the sheet fill-in.',
        fresh_session: 'Recap prior events and unresolved threads from memory logs (list_memories, then '
          + 'fetch_memories for the turns you need) before prompting for new action. The `dd35-fresh-session` '
          + 'skill carries the full procedure.',
        gameplay: 'Continue the active scene under the current play mode. The `dd35-gameplay-loop` skill '
          + 'carries the loop; get_state resyncs you first.',
      }
      return {
        phase,
        campaign: resolved.id,
        campaign_source: resolved.source,
        mode: state?.mode ?? 'exploration',
        scene: state?.scene ?? null,
        hint: hints[phase],
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
      // A campaign created in a session belongs to that session. Best-effort: a
      // standalone call with no session still creates the campaign.
      const attached = (() => { try { return bindSessionCampaign(id) } catch { return false } })()
      return { campaign: id, attached, state: statePath(id), registry: registryPath(), party: party.map((member) => member.id) }
    },
  }))

  ctx.tools.register(define({
    name: 'create_entity',
    description:
      'Create a structured entity sheet (character or NPC). Use for new PCs, NPCs, cohorts, familiars, and monsters '
      + 'that need tracked HP/AC/conditions. For a walk-on extra, `update_scene` with create_provisional is lighter.',
    parameters: {
      entity_id: { type: 'string', required: true, description: 'Entity id, e.g. thiago or goblin_1.' },
      kind: { type: 'string', enum: ['pc', 'npc'], description: 'pc (player/) or npc (actors/). Defaults to npc.' },
      name: { type: 'string', description: 'Display name.' },
      hp: { type: 'integer', description: 'Current/max hit points.' },
      ac: { type: 'integer', description: 'Armor class.' },
      initiative_bonus: { type: 'integer', description: 'Initiative modifier.' },
      npc_tier: { type: 'string', enum: ['main', 'supporting'], description: 'Set "main" for an NPC whose presence or history matters across the campaign; they stay fully listed in the live state block even after a long absence.' },
      sheet: { type: 'json', description: 'Extra sheet fields to merge (stats, skills, saves, resources, ...).' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ entity_id, kind = 'npc', name, hp, ac, initiative_bonus, npc_tier, sheet = {}, campaign }) {
      const id = requireCampaign(campaign)
      const created = {
        ...defaultEntity(entity_id, { kind, ...(name === undefined ? {} : { name }), ...(hp === undefined ? {} : { hp, max_hp: hp }), ...(ac === undefined ? {} : { ac }), ...(initiative_bonus === undefined ? {} : { initiative_bonus }), ...(npc_tier === undefined ? {} : { npc_tier }) }),
        ...sheet,
      }
      saveEntity(id, entity_id, kind, created)
      return { campaign: id, entity_id, kind, sheet: created }
    },
  }))

  ctx.tools.register(define({
    name: 'list_campaigns',
    description:
      'List campaign identifiers under campaign/, and report which one is attached to this session. '
      + 'Use it when the player has to choose between starting a new campaign and continuing an existing one.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      const resolved = resolveSessionCampaign()
      return {
        attached: resolved.id,
        attached_source: resolved.source,
        campaigns: listCampaignIds(),
        root: campaignRoot(),
      }
    },
  }))

  ctx.tools.register(define({
    name: 'set_active_campaign',
    description:
      'Attach a campaign to this session, and record it as the workspace\'s most recently used one. '
      + 'Call it when the player chooses to continue an existing campaign.',
    parameters: {
      identifier: { type: 'string', required: true, description: 'Campaign identifier to activate.' },
      name: { type: 'string', description: 'Human-readable name (defaults to the campaign name).' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ identifier, name }) {
      if (!existsSync(campaignDir(identifier))) throw new Error(`No such campaign: ${identifier}`)
      const state = loadState(identifier)
      writeRegistry({ active: identifier, title: name ?? state?.name ?? identifier, setting: state?.setting ?? null })
      const attached = (() => { try { return bindSessionCampaign(identifier) } catch { return false } })()
      return { attached_to_session: attached, campaign: identifier }
    },
  }))

  ctx.tools.register(define({
    name: 'detach_campaign',
    description:
      'Detach the campaign from this session, returning it to the choose-a-campaign state. Other sessions '
      + 'keep theirs. Use it when the player wants to start over or the wrong campaign was attached.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      const was = resolveSessionCampaign()
      const detached = (() => { try { return unbindSessionCampaign() } catch { return false } })()
      return { detached, previous: was.id, previous_source: was.source }
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
      + 'Creates the sheet on first use. This is the authoritative record for per-entity state. '
      + 'Set patch.npc_tier to "main" on an NPC whose presence or history matters across the whole campaign: '
      + 'the live state block lists main NPCs in full even after a long absence, whereas everyone else is '
      + 'demoted to a short name-only line once they have not appeared for a while.',
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
