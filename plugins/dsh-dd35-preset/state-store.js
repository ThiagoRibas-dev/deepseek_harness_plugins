/**
 * Shared filesystem helpers for the D&D 3.5e DM tools.
 *
 * Layout under the workspace's `campaign/` tree:
 *   campaign/campaign_registry.md            active-campaign registry (markdown)
 *   campaign/<id>/state.json                 session/scene state (mode, clock, initiative, scene)
 *   campaign/<id>/events/campaign_log.md     human-readable timeline (appended)
 *   campaign/<id>/events/transcripts/NNNN_turn.md
 *   campaign/<id>/player/<entity>.json       character sheets (per-entity truth: HP, AC, conditions, resources)
 *   campaign/<id>/actors/<entity>.json       NPC/actor sheets
 *
 * Division of truth (no field lives in two places):
 *   state.json   -> session facts: mode, clock, initiative order/index, scene, present entities
 *   entity sheet -> per-entity facts: hp, temp_hp, ac, conditions, resources, position, stats
 *
 * Every campaign path resolves against the *session's* workspace — the folder
 * the user opened, taken from `session.header.cwd` — and never against the
 * folder this bundle happens to live in. The root is bound per tool call and per
 * memory hook. An explicit `workspace` config pins it instead, for standalone
 * use and tests.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let workspaceRoot = null

/** Pin the workspace root explicitly. An empty value leaves the per-session binding in charge. */
export function configure(config = {}) {
  if (typeof config.workspace === 'string' && config.workspace.length > 0) {
    workspaceRoot = config.workspace
  }
}

/** Bind the root from one session, when it carries a cwd. */
export function bindWorkspaceFromSession(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) workspaceRoot = cwd
}

/** Bind the root from a tool execution's agent, when the loop supplied one. */
export function bindWorkspaceFromExec(exec) {
  bindWorkspaceFromSession(exec?.agent?.session)
}

/**
 * Wrap one tool's execute so every campaign path it touches resolves against the
 * calling session. Tool bodies in this preset are synchronous, so a binding
 * cannot be displaced before the body finishes.
 */
export function bounded(execute) {
  return (args, exec) => {
    bindWorkspaceFromExec(exec)
    return execute(args, exec)
  }
}

export function workspace() {
  if (workspaceRoot === null) {
    throw new Error('dd35: no workspace bound; this needs a session cwd or an explicit workspace config')
  }
  return workspaceRoot
}
export function campaignRoot() { return join(workspaceRoot, 'campaign') }
export function registryPath() { return join(campaignRoot(), 'campaign_registry.md') }

export function campaignDir(id) { return join(campaignRoot(), id) }
export function statePath(id) { return join(campaignDir(id), 'state.json') }
export function eventsDir(id) { return join(campaignDir(id), 'events') }
export function transcriptsDir(id) { return join(eventsDir(id), 'transcripts') }
export function logPath(id) { return join(eventsDir(id), 'campaign_log.md') }
export function playerDir(id) { return join(campaignDir(id), 'player') }
export function actorsDir(id) { return join(campaignDir(id), 'actors') }

export function ensureDir(path) { mkdirSync(path, { recursive: true }) }
export function readText(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null }

/** Atomic JSON write (tmp + rename) so a crash never leaves a half-written state file. */
export function writeJson(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
  return path
}

export function readJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---- registry ------------------------------------------------------------

export function readActiveCampaign() {
  const text = readText(registryPath())
  if (text === null) return null
  const match = text.match(/\*\*Identifier:\*\*\s*`([^`]+)`/)
  return match ? match[1] : null
}

/** Directories under campaign/ that are not campaigns. */
const RESERVED_CAMPAIGN_DIRS = new Set(['setting'])

export function listCampaignIds() {
  const root = campaignRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !RESERVED_CAMPAIGN_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Rewrite the registry markdown for one active campaign, listing every campaign directory. */
export function writeRegistry({ active, title, setting }) {
  ensureDir(campaignRoot())
  const lines = []
  lines.push('# Campaign Registry', '')
  lines.push('## Active Campaign')
  lines.push(`- **Name:** ${title}`)
  lines.push(`- **Identifier:** \`${active}\``)
  if (setting) lines.push(`- **Setting:** \`${setting}\``)
  lines.push('- **Status:** Active')
  lines.push(`- **Date Created:** ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('## All Campaigns')
  for (const id of listCampaignIds()) lines.push(`- [${id}](campaign/${id}/)`)
  lines.push('')
  writeFileSync(registryPath(), lines.join('\n'))
  return registryPath()
}

// ---- session state -------------------------------------------------------

export function loadState(id) { return readJson(statePath(id)) }
export function saveState(id, state) { return writeJson(statePath(id), state) }

export function defaultState(id, { name = id, setting = null } = {}) {
  return {
    campaign: id,
    name,
    setting,
    mode: 'exploration',
    clock: { date: 'Day 1', time: 'Morning', elapsed: '0' },
    initiative: { round: 0, order: [], index: 0, delayed: [], readied: [] },
    scene: { title: '', status: 'inactive', location: '', entities: [], micro_state: '', pending_action: '' },
    party: { light: '', marching_order: [] },
    houserules: [],
    last_turn: null,
  }
}

// ---- entity sheets -------------------------------------------------------

export function defaultEntity(id, { name = id, kind = 'pc', hp = 1, max_hp, ac = 10, initiative_bonus = 0 } = {}) {
  return {
    id, kind, name,
    hp, max_hp: max_hp ?? hp, temp_hp: 0,
    ac, touch_ac: null, flat_footed_ac: null,
    initiative_bonus,
    conditions: [], resources: {}, position: '', notes: '',
  }
}

export function entityPath(id, entityId, kind = 'pc') {
  return join(kind === 'npc' ? actorsDir(id) : playerDir(id), `${entityId}.json`)
}

export function loadEntity(id, entityId, kind = 'pc') {
  return readJson(entityPath(id, entityId, kind))
}

/** Load an entity without knowing whether it is a PC or an NPC. */
export function loadAnyEntity(id, entityId) {
  return loadEntity(id, entityId, 'pc') ?? loadEntity(id, entityId, 'npc')
}

export function saveEntity(id, entityId, kind, sheet) {
  return writeJson(entityPath(id, entityId, kind), sheet)
}

/** Shallow-merge a patch into an entity sheet, creating it when absent. */
export function patchEntity(id, entityId, kind, patch) {
  const sheet = loadEntity(id, entityId, kind) ?? defaultEntity(entityId, { kind })
  const next = { ...sheet, ...patch }
  saveEntity(id, entityId, kind, next)
  return next
}

/** Every entity referenced by the current scene, in scene order. */
export function loadSceneEntities(id, state) {
  return (state.scene?.entities ?? []).map((entityId) => loadAnyEntity(id, entityId)).filter(Boolean)
}

/** Entity ids with a JSON sheet in player/ (pc) or actors/ (npc). */
export function listEntityIds(id, kind = 'pc') {
  const dir = kind === 'npc' ? actorsDir(id) : playerDir(id)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort()
}

/** All entity sheets of one kind. */
export function loadEntities(id, kind = 'pc') {
  return listEntityIds(id, kind).map((entityId) => loadEntity(id, entityId, kind)).filter(Boolean)
}

// ---- campaign log --------------------------------------------------------

/** Append one turn to `events/campaign_log.md`, seeding the header when absent. */
export function appendLogTurn(id, { sceneTitle, dateTime, location, entities, microState, pendingAction, playerInput, dmOutput }) {
  const path = logPath(id)
  ensureDir(dirname(path))
  const existed = existsSync(path)
  const blocks = []
  if (!existed) blocks.push(`# Campaign Log: ${id}`, '', '## Campaign Events', '')
  blocks.push(`### ${sceneTitle}`)
  blocks.push(`- **Date/Time:** ${dateTime}`)
  if (location) blocks.push(`- **Current Location:** ${location}`)
  if (entities && entities.length > 0) blocks.push(`- **Entities:** ${entities.join(', ')}`)
  if (microState) blocks.push(`- **Micro-State:** ${microState}`)
  if (pendingAction) blocks.push(`- **Pending Action:** ${pendingAction}`)
  if (playerInput) blocks.push('', `**Player:** ${playerInput}`)
  if (dmOutput) blocks.push('', `**DM:** ${dmOutput}`)
  blocks.push('')
  writeFileSync(path, `${existed ? '\n' : ''}${blocks.join('\n')}`, { flag: 'a' })
  return path
}

/** Render the "Active State" section of the campaign log from session state + sheets. */
export function renderActiveState(id, state) {
  const entities = loadSceneEntities(id, state)
  const party = entities.filter((entity) => entity.kind === 'pc')
  const buffs = party.flatMap((entity) =>
    (entity.conditions ?? []).map((cond) => `${entity.name}: ${typeof cond === 'string' ? cond : cond.name}`))
  return [
    '## Active State',
    `- **Current Date:** ${state.clock?.date ?? 'unknown'}`,
    `- **Time of Day:** ${state.clock?.time ?? 'unknown'}`,
    `- **Current Location:** ${state.scene?.location ?? 'unknown'}`,
    `- **Active Party:** ${party.map((entity) => `${entity.name} (${entity.hp}/${entity.max_hp} hp)`).join(', ') || 'none'}`,
    `- **Active Buffs:** ${buffs.join(', ') || 'none'}`,
  ].join('\n')
}

// ---- shared campaign accessors -------------------------------------------

/** Resolve an explicit campaign id or fall back to the registry's active one. */
export function requireCampaign(explicit) {
  const id = explicit ?? readActiveCampaign()
  if (!id) throw new Error('No active campaign. Call create_campaign first, or set_active_campaign.')
  return id
}

/**
 * Load a campaign's state, self-healing an existing campaign directory whose
 * state.json is missing (so tools work before any explicit migration).
 */
export function requireState(id) {
  const existing = loadState(id)
  if (existing) return existing
  if (!existsSync(campaignDir(id))) throw new Error(`No such campaign: ${id}`)
  const created = defaultState(id, { name: id })
  saveState(id, created)
  return created
}
