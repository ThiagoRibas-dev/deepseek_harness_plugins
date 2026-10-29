/**
 * Shared filesystem helpers for the D&D 3.5e DM tools.
 *
 * Layout under the workspace's `campaign/` tree:
 *   campaign/campaign_registry.md            active-campaign registry (markdown)
 *   campaign/<id>/state.json                 session/scene state (mode, clock, initiative, scene)
 *   campaign/<id>/events/transcripts/NNNN_turn.md   the turn record (exchange + scene snapshot)
 *   campaign/<id>/events/memory_index.json          derived scene index
 *   campaign/<id>/player/<entity>.json       character sheets (per-entity truth: HP, AC, conditions, resources)
 *   campaign/<id>/actors/<entity>.json       NPC/actor sheets
 *
 * Data partitioning schema (non-overlapping fields):
 *   state.json   -> session-level state: mode, clock, initiative order/index, scene, present entities
 *   entity sheet -> entity-level state: hp, temp_hp, ac, conditions, resources, position, stats
 *
 * Campaign file paths resolve against the active session's workspace root (from
 * `session.header.cwd`) rather than the plugin installation directory.
 * The root is bound per tool invocation and memory hook, or specified explicitly via configuration for testing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let workspaceRoot = null

/** Pin the workspace root explicitly. An empty value leaves the per-session binding in charge. */
export function configure(config = {}) {
  if (typeof config.workspace === 'string' && config.workspace.length > 0) {
    workspaceRoot = config.workspace
  }
}

/**
 * The session the current binding belongs to.
 *
 * Tools resolve their campaign through this rather than through the registry, so
 * two sessions in the same folder can run different campaigns. Bound together
 * with {@link workspaceRoot} — a root without its session, or the reverse, would
 * resolve one session's campaign against another's workspace.
 */
let boundSession = null

/** Bind the root and the session together, when the session carries a cwd. */
export function bindWorkspaceFromSession(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return
  workspaceRoot = cwd
  boundSession = session
}

/** Bind the root from a tool execution's agent, when the loop supplied one. */
export function bindWorkspaceFromExec(exec) {
  bindWorkspaceFromSession(exec?.agent?.session)
}

/**
 * Wraps tool execution to bind the active campaign and workspace root to the invoking session.
 * Because preset tool handlers execute synchronously, execution bindings remain isolated per invocation.
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

/**
 * Read the active campaign id from a registry under an explicit root.
 *
 * Prompt assembly calls this before any tool has run, when the module-level
 * binding may still be unset, so an unusable root yields `null` instead of the
 * `path.join` throw a bare {@link registryPath} would raise.
 * @param root - absolute workspace root, or any non-string to signal "unbound".
 * @returns the active campaign id, or `null` when there is no usable registry.
 */
export function readActiveCampaignIn(root) {
  if (typeof root !== 'string' || root.length === 0) return null
  const text = readText(join(root, 'campaign', 'campaign_registry.md'))
  if (text === null) return null
  const match = text.match(/\*\*Identifier:\*\*\s*`([^`]+)`/)
  return match ? match[1] : null
}

export function readActiveCampaign() {
  return readActiveCampaignIn(workspaceRoot)
}

/** One named file at the root of a campaign directory under an explicit root. */
export function campaignFilePath(root, id, file) {
  return join(root, 'campaign', id, file)
}

/**
 * Entity ids with a JSON sheet, resolved against an **explicit root**.
 *
 * Prompt assembly runs before any tool call, so the module-level workspace
 * binding may still be unset. Anything on that path must take its root as an
 * argument rather than relying on {@link workspace} — the same reason
 * {@link readActiveCampaignIn} and {@link campaignFilePath} exist.
 */
export function listEntityIdsIn(root, id, kind = 'pc') {
  if (typeof root !== 'string' || root.length === 0) return []
  const dir = join(root, 'campaign', id, kind === 'npc' ? 'actors' : 'player')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort()
}

/** One entity sheet under an explicit root, or null when absent or unreadable. */
export function loadEntityIn(root, id, entityId, kind = 'pc') {
  if (typeof root !== 'string' || root.length === 0) return null
  const path = join(root, 'campaign', id, kind === 'npc' ? 'actors' : 'player', `${entityId}.json`)
  try {
    return readJson(path)
  } catch {
    // A corrupt sheet is a finding for `dd35_doctor`, not a reason to fail the
    // request that is assembling a prompt.
    return null
  }
}

/**
 * Campaign identifiers: the directories under `campaign/` that hold a state file.
 *
 * Valid campaigns are identified by the presence of a `state.json` file within their
 * directory. Subdirectories lacking a state file (such as `player/` or `setting/`) are
 * excluded from campaign listings.
 */
export function listCampaignIds() {
  const root = campaignRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isCampaignDirIn(root, entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Whether one directory under `campaign/` is a campaign: it holds a state file. */
function isCampaignDirIn(root, name) {
  try {
    return statSync(join(root, name, 'state.json')).isFile()
  } catch {
    // Absent, or unreadable. Either way there is no state to load.
    return false
  }
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

// ---- session → campaign binding ------------------------------------------

/**
 * Sessions created prior to this timestamp resolve via the active campaign registry
 * for backward compatibility. Sessions created after this timestamp initialize without
 * a bound campaign and require explicit selection or inheritance from a parent session.
 *
 * This timestamp constant enables deterministic session binding without modifying filesystem metadata.
 */
export const SESSION_BINDING_SINCE = Date.parse('2026-10-09T18:59:35Z')

export function bindingsPath(root) { return join(root, 'campaign', 'session_campaigns.json') }

function readBindingsFile(root) {
  if (typeof root !== 'string' || root.length === 0) return null
  try {
    return readJson(bindingsPath(root))
  } catch {
    // Prompt assembly reads this: a corrupt file must mean "unbound", not a throw.
    return null
  }
}

/** The parsed binding file, normalised. Never throws. */
export function readBindingsIn(root) {
  const raw = readBindingsFile(root)
  const sessions = raw !== null && typeof raw === 'object' && raw.sessions !== null && typeof raw.sessions === 'object'
    ? raw.sessions
    : {}
  return { version: 1, sessions }
}

/** The campaign id bound to one session, or `undefined` when it has no entry. */
export function readSessionBindingIn(root, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const entry = readBindingsIn(root).sessions[sessionId]
  if (entry === undefined || entry === null) return undefined
  const id = typeof entry === 'string' ? entry : entry.campaign
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Optional access to the session store, so the resolver can read an *ancestor's*
 * header.
 *
 * A fork records only its immediate parent. Following a chain of forks therefore
 * needs the parent session's own `parentSession`, and `sessions.get` is the only
 * place that exists — no workspace file holds it, because the harness creates the
 * fork, not this plugin.
 *
 * Optional on purpose. With no lookup the resolver still follows one level, and
 * `route_turn` pins whatever it resolved, so a second generation resolves through
 * its parent's own entry. The lookup covers the case where the middle link was
 * created but never run.
 */
let sessionLookup = null

/** Wire in `ctx.sessions.get`. Passing a non-function disables ancestor walking. */
export function setSessionLookup(fn) {
  sessionLookup = typeof fn === 'function' ? fn : null
}

/** The `parentSession` recorded on a header, or null. */
function parentOf(session) {
  const parent = session?.header?.parentSession
  return typeof parent === 'string' && parent.length > 0 ? parent : null
}

/** How far up a fork chain to look before giving up. Guards a hand-edited chain. */
const MAX_ANCESTORS = 32

/**
 * Bind one session to a campaign, or unbind it when `campaignId` is null.
 *
 * Unbinding removes the entry rather than storing a null. A session created
 * after {@link SESSION_BINDING_SINCE} is unbound by default, so there is nothing
 * for a null to record; for an older session, removing the entry restores the
 * registry fallback, which is what "no choice made yet" meant for it.
 */
export function writeSessionBindingIn(root, sessionId, campaignId) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('dd35: no workspace bound')
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('dd35: no session to bind')
  const existing = readBindingsIn(root).sessions
  const sessions = { ...existing }
  if (campaignId === null) delete sessions[sessionId]
  else sessions[sessionId] = { campaign: campaignId, boundAt: new Date().toISOString() }
  writeJson(bindingsPath(root), { version: 1, sessions })
  return sessions
}

/**
 * Which campaign one session is playing, and why.
 *
 * Precedence hierarchy for session-to-campaign resolution:
 *
 *   `bound`     — explicit session binding or pinned legacy resolution.
 *   `inherited` — fork session inheriting binding from an ancestor session.
 *   `legacy`    — session predating {@link SESSION_BINDING_SINCE}, resolving via active registry.
 *   `none`      — unconfigured session created after {@link SESSION_BINDING_SINCE}.
 *
 * This function handles missing or malformed records without throwing exceptions,
 * ensuring prompt assembly completes during session initialization.
 *
 * @returns `{ id, source }`; `id` is null when the session has no campaign.
 */
export function resolveSessionCampaignIn(root, session) {
  try {
    const sessionId = session?.header?.id
    const bound = readSessionBindingIn(root, sessionId)
    if (bound !== undefined) {
      // If the bound campaign directory does not exist on disk, resolve as unbound
      // to prevent downstream file read failures; reported as a diagnostic finding by dd35_doctor.
      const real = typeof root === 'string' && root.length > 0 && existsSync(campaignDirIn(root, bound))
      return real ? { id: bound, source: 'bound' } : { id: null, source: 'none' }
    }

    // Follow the fork chain, not just the immediate parent. `fork()` records only
    // `parentSession`, so a fork of a fork has nothing of its own to match until
    // one of them runs; stopping at the first parent drops the campaign at
    // generation two. `sessionLookup` supplies the ancestors' own parents.
    const seen = new Set()
    if (typeof sessionId === 'string' && sessionId.length > 0) seen.add(sessionId)
    let ancestor = parentOf(session)
    for (let depth = 0; depth < MAX_ANCESTORS && ancestor !== null; depth += 1) {
      // Cycle detected in session ancestry chain; terminate traversal.
      if (seen.has(ancestor)) break
      seen.add(ancestor)
      const inherited = readSessionBindingIn(root, ancestor)
      if (inherited !== undefined) {
        const real = typeof root === 'string' && root.length > 0 && existsSync(campaignDirIn(root, inherited))
        return real ? { id: inherited, source: 'inherited' } : { id: null, source: 'none' }
      }
      ancestor = parentOf(sessionLookup?.(ancestor))
    }

    const created = session?.header?.createdAt
    const identifiable = typeof sessionId === 'string' && sessionId.length > 0

    // Two callers legitimately have no binding of their own: a session created
    // before this feature existed, and any caller with no session identity at all
    // (standalone use, and the fixtures that drive these modules directly). Both
    // keep the registry's answer. A session that *can* be identified and was
    // created since must be bound by a choice, so it resolves to nothing.
    if (!identifiable || (typeof created === 'number' && created < SESSION_BINDING_SINCE)) {
      const legacy = readActiveCampaignIn(root)
      return legacy === null ? { id: null, source: 'none' } : { id: legacy, source: 'legacy' }
    }

    return { id: null, source: 'none' }
  } catch {
    return { id: null, source: 'none' }
  }
}

/** One campaign directory under an explicit root. */
export function campaignDirIn(root, id) { return join(root, 'campaign', id) }

/** {@link resolveSessionCampaignIn} for the session bound by the current tool call. */
export function resolveSessionCampaign() {
  return resolveSessionCampaignIn(workspaceRoot, boundSession)
}

/** The id of the session bound by the current tool call, or null. */
export function boundSessionId() {
  const id = boundSession?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Bind the campaign to the session that made the current tool call.
 *
 * Returns false rather than throwing when there is no session to bind, so a tool
 * like `create_campaign` can still succeed in standalone or test use where the
 * campaign exists but no session owns it.
 */
export function bindSessionCampaign(campaignId) {
  const id = boundSessionId()
  if (id === null) return false
  writeSessionBindingIn(workspaceRoot, id, campaignId)
  return true
}

/** Unbind the current session, returning it to the choose-a-campaign state. */
export function unbindSessionCampaign() {
  return bindSessionCampaign(null)
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

/**
 * Compact, model-facing projection of one entity sheet.
 *
 * Defined in the data access layer so prompt assembly and `get_state` tool formatting
 * execute the identical projection function (spec §4.1.2 consistency requirement).
 * Including expanded entity statistics in this projection eliminates secondary entity
 * read operations during turn resolution (spec §4.4).
 *
 * Layering: `conditions` stays names-only and always renders; the bundled
 * `condition_effects` follows it, so a byte cap truncates the prose before the
 * numbers. `includeDetail: false` is the one-line form used by the known-cast
 * roster.
 */
export function briefEntity(entity, { includeDetail = true } = {}) {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    hp: entity.hp,
    max_hp: entity.max_hp,
    temp_hp: entity.temp_hp ?? 0,
    ac: entity.ac,
    ...(entity.position ? { position: entity.position } : {}),
    conditions: (entity.conditions ?? []).map((cond) => (typeof cond === 'string' ? cond : cond.name)),
    ...(includeDetail ? {
      condition_effects: (entity.conditions ?? [])
        .filter((cond) => typeof cond === 'object' && cond !== null && cond.effect)
        .map((cond) => `${cond.name}: ${cond.effect}`),
      resources: entity.resources ?? {},
      notes: entity.notes ?? '',
    } : {}),
  }
}

// ---- campaign log --------------------------------------------------------


// ---- shared campaign accessors -------------------------------------------

/**
 * The campaign a tool call operates on.
 *
 * An explicit id wins. Otherwise the campaign attached to the calling session.
 * Sessions without an assigned campaign throw an explicit error rather than defaulting
 * to the registry, ensuring uninitialized sessions prompt for campaign selection.
 */
export function requireCampaign(explicit) {
  const id = explicit ?? resolveSessionCampaign().id
  if (!id) {
    throw new Error(
      'No campaign is attached to this session. Start one with create_campaign, '
      + 'or attach an existing one with set_active_campaign.',
    )
  }
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
