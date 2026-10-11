/**
 * Per-session campaign binding.
 *
 * The bug this pins: the D&D profile resolved its campaign from the single
 * global `campaign/campaign_registry.md`, so **every** new chat in the D&D35
 * folder was already inside `seventh_moon` — the state block, the notes and the
 * campaign persona were injected before the player typed anything, and
 * `route_turn` answered `fresh_session` for a campaign nobody chose.
 *
 * Two properties matter and are asserted directly:
 *
 *  - **A session created since this shipped starts with no campaign**, even when
 *    the registry names one, and contributes nothing to the prompt.
 *  - **A session that predates it keeps playing.** That is the whole migration:
 *    live sessions resolve through the registry exactly as before.
 *
 * `state-store.js` imports only `node:fs`/`node:path`, and `scene-state.js` adds
 * no harness dependency, so the resolver and the prompt path are driven directly.
 * The tools need `@deepseek-ai/dsh-tools`, so they run against a throwaway rig —
 * the same shape `oracles.test.mjs` uses.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- rig: the tools need a `defineTool` stub -----------------------------

let rig
before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-binding-rig-'))
  writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const file of ['state-store.js', 'state.js']) cpSync(join(BUNDLE, file), join(rig, file))
  const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
  }))
  writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')
})

const roots = []
after(() => {
  rmSync(rig, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const store = await import(pathToFileURL(join(BUNDLE, 'state-store.js')).href)
const sceneState = await import(pathToFileURL(join(BUNDLE, 'scene-state.js')).href)
const prompt = await import(pathToFileURL(join(BUNDLE, 'prompt.js')).href)
const stateTools = await import(pathToFileURL(join(rig, 'state.js')).href)

const { SESSION_BINDING_SINCE } = store

// ---- fixtures ------------------------------------------------------------

/**
 * One workspace with a registry naming `active`, and one campaign directory per
 * id in `campaigns`. Every id is a real directory unless listed in `missing`.
 */
function workspace({ campaigns = ['seventh_moon'], active = 'seventh_moon', registry = true, bindings } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-binding-'))
  roots.push(root)
  for (const id of campaigns) {
    mkdirSync(join(root, 'campaign', id, 'player'), { recursive: true })
    mkdirSync(join(root, 'campaign', id, 'actors'), { recursive: true })
    writeFileSync(join(root, 'campaign', id, 'state.json'), JSON.stringify({
      campaign: id, mode: 'exploration', clock: { date: 'Day 9', time: 'Dusk' },
      initiative: { round: 0, order: [], index: 0 },
      scene: { title: 'A Crossroads', location: 'Hurstwood', entities: [], micro_state: 'Maude waits.' },
      last_turn: { number: 143 },
    }, null, 2))
    writeFileSync(join(root, 'campaign', id, 'dm_persona.md'), `# ${id} persona\n`)
  }
  if (registry) {
    writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
      '# Campaign Registry\n\n## Active Campaign\n'
      + `- **Name:** ${active}\n- **Identifier:** \`${active}\`\n`)
  }
  if (bindings !== undefined) {
    writeFileSync(join(root, 'campaign', 'session_campaigns.json'), bindings)
  }
  return root
}

/** A session created after the binding feature shipped — the new-chat case. */
const newSession = (id, extra = {}) => ({
  header: { id, createdAt: SESSION_BINDING_SINCE + 60_000, ...extra },
})

/** A session created before it — the keep-playing case. */
const legacySession = (id, extra = {}) => ({
  header: { id, createdAt: SESSION_BINDING_SINCE - 60_000, ...extra },
})

const attached = (root, session) => store.resolveSessionCampaignIn(root, session)
const bind = (root, sessionId, campaign) => store.writeSessionBindingIn(root, sessionId, campaign)

// ---- the resolver --------------------------------------------------------

test('a session created since this shipped has no campaign, even when the registry names one', () => {
  const root = workspace({ active: 'seventh_moon' })
  assert.deepEqual(attached(root, newSession('s-new')), { id: null, source: 'none' })
})

test('an explicit binding wins over the registry', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  bind(root, 's-new', 'frostmarch')
  assert.deepEqual(attached(root, newSession('s-new')), { id: 'frostmarch', source: 'bound' })
})

test('two sessions in one folder hold different campaigns at the same time', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  bind(root, 's-a', 'seventh_moon')
  bind(root, 's-b', 'frostmarch')
  assert.equal(attached(root, newSession('s-a')).id, 'seventh_moon')
  assert.equal(attached(root, newSession('s-b')).id, 'frostmarch')
  // A third session is still untouched by either.
  assert.equal(attached(root, newSession('s-c')).id, null)
})

test('a fork inherits its parent campaign', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-parent', 'seventh_moon')
  const fork = newSession('s-fork', { parentSession: 's-parent' })
  assert.deepEqual(attached(root, fork), { id: 'seventh_moon', source: 'inherited' })
})

// ---- forks of forks ------------------------------------------------------
//
// `fork()` records only `parentSession`, so generation two has nothing of its
// own to match. Two mechanisms cover it, and both are exercised here: the
// `sessions` lookup walks the chain, and `route_turn` pins what it resolved so
// the chain survives a link that is never run.

/** Stands in for `ctx.sessions.get`, which a plugin reaches through the service. */
function withHeaders(headers) {
  store.setSessionLookup((id) => (id in headers ? { header: headers[id] } : undefined))
}

test('a fork of a fork inherits through the chain when the store can be read', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-root', 'seventh_moon')
  withHeaders({
    's-root': { id: 's-root', createdAt: 1, cwd: root },
    // The middle link was forked but never run, so it has no binding of its own.
    's-mid': { id: 's-mid', createdAt: 2, parentSession: 's-root', cwd: root },
  })
  const grandchild = newSession('s-leaf', { parentSession: 's-mid' })
  assert.deepEqual(attached(root, grandchild), { id: 'seventh_moon', source: 'inherited' })
  store.setSessionLookup(null)
})

test('without the store, only the immediate parent is followed', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-root', 'seventh_moon')
  store.setSessionLookup(null)
  const grandchild = newSession('s-leaf', { parentSession: 's-mid' })
  assert.deepEqual(attached(root, grandchild), { id: null, source: 'none' })
})

test('a chain terminates on a cycle instead of spinning', () => {
  const root = workspace({ active: 'seventh_moon' })
  withHeaders({
    a: { id: 'a', createdAt: 1, parentSession: 'b', cwd: root },
    b: { id: 'b', createdAt: 1, parentSession: 'a', cwd: root },
  })
  const session = { header: { id: 'c', createdAt: Date.now(), parentSession: 'a', cwd: root } }
  assert.deepEqual(attached(root, session), { id: null, source: 'none' })
  store.setSessionLookup(null)
})

test('the nearest ancestor wins', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  bind(root, 's-root', 'seventh_moon')
  bind(root, 's-mid', 'frostmarch')
  const leaf = newSession('s-leaf', { parentSession: 's-mid' })
  assert.deepEqual(attached(root, leaf), { id: 'frostmarch', source: 'inherited' })
})

test('route_turn pins a fork, so a later generation resolves without the store', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-root', 'seventh_moon')
  store.setSessionLookup(null)
  const fork = newSession('s-mid', { parentSession: 's-root', cwd: root })
  assert.deepEqual(attached(root, fork), { id: 'seventh_moon', source: 'inherited' })
  // Running the fork makes the inheritance explicit on disk...
  run('route_turn', { first_message: true }, fork)
  assert.deepEqual(attached(root, fork), { id: 'seventh_moon', source: 'bound' })
  // ...which is what lets its own fork resolve with no lookup at all.
  const grandchild = newSession('s-leaf', { parentSession: 's-mid' })
  assert.deepEqual(attached(root, grandchild), { id: 'seventh_moon', source: 'inherited' })
})

test('a rename does not disturb the binding', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-new', 'seventh_moon')
  // A rename appends `session/title`; it changes neither the header id nor the
  // directory, which is named `session-<id>`. The binding keys on the id.
  const renamed = newSession('s-new', { title: 'The Frostmarch Job' })
  assert.deepEqual(attached(root, renamed), { id: 'seventh_moon', source: 'bound' })
})

test('a fork of an unbound session stays unbound rather than picking up the registry', () => {
  const root = workspace({ active: 'seventh_moon' })
  const fork = newSession('s-fork', { parentSession: 's-unbound-parent' })
  assert.deepEqual(attached(root, fork), { id: null, source: 'none' })
})

test('its own binding beats the one it would inherit', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  bind(root, 's-parent', 'seventh_moon')
  bind(root, 's-fork', 'frostmarch')
  const fork = newSession('s-fork', { parentSession: 's-parent' })
  assert.deepEqual(attached(root, fork), { id: 'frostmarch', source: 'bound' })
})

test('a session predating the feature keeps resolving through the registry', () => {
  const root = workspace({ active: 'seventh_moon' })
  assert.deepEqual(attached(root, legacySession('s-old')), { id: 'seventh_moon', source: 'legacy' })
})

test('pinning a legacy session makes it immune to a later registry change', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  bind(root, 's-old', attached(root, legacySession('s-old')).id)
  // The player starts a new campaign, which rewrites the registry's active entry.
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    '# Campaign Registry\n\n## Active Campaign\n- **Identifier:** `frostmarch`\n')
  assert.deepEqual(attached(root, legacySession('s-old')), { id: 'seventh_moon', source: 'bound' })
})

test('a caller with no session identity keeps the registry behaviour', () => {
  const root = workspace({ active: 'seventh_moon' })
  assert.equal(attached(root, undefined).id, 'seventh_moon')
  assert.equal(attached(root, { header: {} }).id, 'seventh_moon')
})

test('a binding to a campaign that no longer exists resolves to nothing', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-new', 'deleted_campaign')
  assert.deepEqual(attached(root, newSession('s-new')), { id: null, source: 'none' })
})

test('a corrupt bindings file is unbound, not a thrown request', () => {
  const root = workspace({ active: 'seventh_moon', bindings: '{ not json' })
  assert.deepEqual(attached(root, newSession('s-new')), { id: null, source: 'none' })
  // A legacy session still resolves, because it never reads the binding.
  assert.equal(attached(root, legacySession('s-old')).id, 'seventh_moon')
})

test('unbinding removes the entry and restores the session to unbound', () => {
  const root = workspace({ active: 'seventh_moon' })
  bind(root, 's-new', 'seventh_moon')
  assert.equal(attached(root, newSession('s-new')).id, 'seventh_moon')
  store.writeSessionBindingIn(root, 's-new', null)
  assert.equal(attached(root, newSession('s-new')).id, null)
})

// ---- what counts as a campaign -------------------------------------------

test('a campaign is a directory holding a state file, not a reserved name', () => {
  // `create_campaign` writes `player/` and `setting/` beside the campaigns, and a
  // name-based filter has to be told about each new one. Membership by file means
  // those are excluded for not having a `state.json`, and a campaign this code has
  // never heard of still appears.
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  // `listCampaignIds()` resolves against the bound workspace, not an argument.
  store.bindWorkspaceFromSession({ header: { cwd: root } })
  for (const bystander of ['player', 'setting', 'events', 'notes']) {
    mkdirSync(join(root, 'campaign', bystander), { recursive: true })
  }
  mkdirSync(join(root, 'campaign', 'half_created', 'player'), { recursive: true })
  assert.deepEqual(store.listCampaignIds(), ['frostmarch', 'seventh_moon'])
  // A directory whose state file is a directory, not a file, is still not a campaign.
  mkdirSync(join(root, 'campaign', 'not_a_file', 'state.json'), { recursive: true })
  assert.deepEqual(store.listCampaignIds(), ['frostmarch', 'seventh_moon'])
})

// ---- the prompt path: what the model actually sees ------------------------

test('an unbound session contributes no state, persona or notes', () => {
  const root = workspace({ active: 'seventh_moon' })
  writeFileSync(join(root, 'campaign', 'seventh_moon', 'dm_notes.md'), 'A secret the DM keeps.')
  const assemble = { agent: { session: newSession('s-new', { cwd: root }) } }
  assert.equal(sceneState.sceneStateContext(assemble), '')
  assert.equal(sceneState.playerFilesText(assemble), '')
  assert.equal(prompt.personaSectionText(assemble), '')
  assert.equal(prompt.notesContextText(assemble), '')
})

test('the same session sees them the moment it is bound', () => {
  const root = workspace({ active: 'seventh_moon' })
  writeFileSync(join(root, 'campaign', 'seventh_moon', 'dm_notes.md'), 'A secret the DM keeps.')
  const session = newSession('s-new', { cwd: root })
  const assemble = { agent: { session } }
  bind(root, 's-new', 'seventh_moon')
  assert.match(sceneState.sceneStateContext(assemble), /Hurstwood/)
  assert.match(prompt.notesContextText(assemble), /A secret the DM keeps/)
  assert.match(prompt.personaSectionText(assemble), /seventh_moon persona/)
})

test('a legacy session still sees the registry campaign', () => {
  const root = workspace({ active: 'seventh_moon' })
  const assemble = { agent: { session: legacySession('s-old', { cwd: root }) } }
  assert.match(sceneState.sceneStateContext(assemble), /Hurstwood/)
})

// ---- the tools -----------------------------------------------------------

function mountTools() {
  const tools = new Map()
  stateTools.apply({ tools: { register: (tool) => tools.set(tool.name, tool) } })
  return tools
}
const TOOLS = mountTools()
const run = (name, args, session) => TOOLS.get(name).execute(args, { agent: { session } })

test('route_turn offers the choice when a session has no campaign', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  const result = run('route_turn', { first_message: true }, newSession('s-new', { cwd: root }))
  assert.equal(result.phase, 'choose_campaign')
  assert.equal(result.campaign, null)
  assert.deepEqual(result.campaigns, ['frostmarch', 'seventh_moon'])
  assert.match(result.hint, /new campaign or continue/)
})

test('route_turn reports session_zero only when no campaign exists at all', () => {
  const root = workspace({ campaigns: [], active: 'seventh_moon', registry: false })
  const result = run('route_turn', { first_message: true }, newSession('s-new', { cwd: root }))
  assert.equal(result.phase, 'session_zero')
  assert.deepEqual(result.campaigns, [])
})

test('route_turn routes a bound session to the recap, and later turns to gameplay', () => {
  const root = workspace({ active: 'seventh_moon' })
  const session = newSession('s-new', { cwd: root })
  run('set_active_campaign', { identifier: 'seventh_moon' }, session)
  const first = run('route_turn', { first_message: true }, session)
  assert.equal(first.phase, 'fresh_session')
  assert.equal(first.campaign, 'seventh_moon')
  assert.equal(first.mode, 'exploration')
  assert.equal(run('route_turn', {}, session).phase, 'gameplay')
})

test('route_turn pins a legacy session so the registry cannot move it', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  const session = legacySession('s-old', { cwd: root })
  assert.equal(run('route_turn', {}, session).campaign, 'seventh_moon')
  // The pin is on disk now: rewriting the registry does not move the session.
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    '# Campaign Registry\n\n## Active Campaign\n- **Identifier:** `frostmarch`\n')
  assert.equal(run('route_turn', {}, session).campaign, 'seventh_moon')
})

test('set_active_campaign attaches to the calling session only', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  const a = newSession('s-a', { cwd: root })
  const b = newSession('s-b', { cwd: root })
  const result = run('set_active_campaign', { identifier: 'frostmarch' }, a)
  assert.equal(result.attached_to_session, true)
  assert.equal(attached(root, a).id, 'frostmarch')
  assert.equal(attached(root, b).id, null)
})

test('detach_campaign returns a session to the choice', () => {
  const root = workspace({ active: 'seventh_moon' })
  const session = newSession('s-new', { cwd: root })
  run('set_active_campaign', { identifier: 'seventh_moon' }, session)
  const detached = run('detach_campaign', {}, session)
  assert.equal(detached.detached, true)
  assert.equal(detached.previous, 'seventh_moon')
  assert.equal(run('route_turn', { first_message: true }, session).phase, 'choose_campaign')
})

test('list_campaigns reports the attachment, not a global active', () => {
  const root = workspace({ campaigns: ['seventh_moon', 'frostmarch'], active: 'seventh_moon' })
  const session = newSession('s-new', { cwd: root })
  assert.deepEqual(run('list_campaigns', {}, session), {
    attached: null, attached_source: 'none', campaigns: ['frostmarch', 'seventh_moon'], root: join(root, 'campaign'),
  })
  run('set_active_campaign', { identifier: 'seventh_moon' }, session)
  assert.equal(run('list_campaigns', {}, session).attached, 'seventh_moon')
})

test('a tool refuses an unbound session instead of guessing the registry campaign', () => {
  const root = workspace({ active: 'seventh_moon' })
  assert.throws(
    () => run('get_state', {}, newSession('s-new', { cwd: root })),
    /No campaign is attached to this session/,
  )
})

test('create_campaign attaches the campaign to the creating session', () => {
  const root = workspace({ campaigns: [], active: 'seventh_moon', registry: false })
  const session = newSession('s-new', { cwd: root })
  const created = run('create_campaign', { identifier: 'frostmarch', name: 'Frostmarch' }, session)
  assert.equal(created.attached, true)
  assert.equal(attached(root, session).id, 'frostmarch')
  assert.equal(run('route_turn', { first_message: true }, session).phase, 'fresh_session')
})
