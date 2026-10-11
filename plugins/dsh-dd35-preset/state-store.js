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
 * Membership is decided by the file, not by a list of reserved names. A campaign
 * *is* a directory with a `state.json` — that is what every loader here requires —
 * so `player/`, `setting/` and anything else the setup writes beside them are
 * excluded for not having one, and a campaign that this file has never heard of
 * still appears.
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
 * Sessions created before this instant keep resolving through the registry, so
 * shipping this feature does not detach a campaign from a session already in
 * play. Every session created after it starts with **no campaign** and must be
 * bound by a choice the player made.
 *
 * A constant rather than a file field: nothing has to be written to establish
 * it, so the first request of a new chat is already correct. Forks created after
 * it inherit through {@link resolveSessionCampaignIn}'s parent rule.
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
 * The order matters and each rule earns its place:
 *
 *   `bound`     — the player chose, or `route_turn` pinned a legacy resolution.
 *   `inherited` — a fork with no entry of its own follows its parent.
 *   `legacy`    — created before {@link SESSION_BINDING_SINCE}, so the registry's
 *                 active campaign still governs it. This is the whole migration.
 *   `none`      — a session created since, unbound. A brand-new chat.
 *
 * Never throws: this runs on the prompt-assembly path, where a throw kills the
 * session before its first token.
 *
 * @returns `{ id, source }`; `id` is null when the session has no campaign.
 */
export function resolveSessionCampaignIn(root, session) {
  try {
    const sessionId = session?.header?.id
    const bound = readSessionBindingIn(root, sessionId)
    if (bound !== undefined) {
      // A binding to a campaign directory that no longer exists is a finding for
      // `dd35_doctor`, not a campaign: resolve it as unbound rather than handing
      // every tool a path that cannot load.
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
      // A cycle is not resolvable: stop rather than spin.
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
 * Lives here, in the data layer, so the prompt builder and the `get_state` tool
 * render entities through the *same* function — the spec's §4.1.2 requirement
 * that the injected block and the tool result cannot disagree about what an
 * entity is. Widening this is the single change that removes the DM's need for a
 * second read of the sheet (spec §4.4).
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
 * A session that has no campaign attached gets an error rather than a guess —
 * that is what makes a brand-new chat start empty.
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
