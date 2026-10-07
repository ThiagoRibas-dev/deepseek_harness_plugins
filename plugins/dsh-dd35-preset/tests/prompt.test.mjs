/**
 * Campaign prompt-file tests.
 *
 * `prompt.js` imports only `node:fs`, `node:path` and `state-store.js`, so the
 * section and context providers can be exercised against a temporary campaign
 * tree with no harness rig. Run from the bundle folder with:
 *
 *   node --test
 *
 * A fake `systemPrompt` captures the two registrations and hands the providers
 * back, which is enough to assert what each request would contribute.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../prompt.js'

const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** One campaign workspace. Omitted files are simply not created. */
function workspace({ campaign, persona, notes } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-prompt-'))
  roots.push(root)
  if (campaign !== undefined) {
    writeRegistry(root, campaign)
    const dir = join(root, 'campaign', campaign)
    mkdirSync(dir, { recursive: true })
    if (persona !== undefined) writeFileSync(join(dir, 'dm_persona.md'), persona)
    if (notes !== undefined) writeFileSync(join(dir, 'dm_notes.md'), notes)
  }
  return root
}

function writeRegistry(root, campaign) {
  mkdirSync(join(root, 'campaign'), { recursive: true })
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    `# Campaign Registry\n\n## Active Campaign\n- **Name:** Test\n- **Identifier:** \`${campaign}\`\n`)
}

/** Mount the plugin against a fake registry and return the captured registrations. */
function mount(config) {
  const registered = {}
  const ctx = {
    systemPrompt: {
      section: (section) => { registered.section = section; return () => {} },
      context: (context) => { registered.context = context; return () => {} },
    },
    // Cordis runs the effect body at registration and keeps its disposer.
    effect: (body) => {
      const disposer = body()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  apply(ctx, config)
  return registered
}

const assembleAt = (cwd) => ({ agent: { session: { header: { cwd } } } })

test('dm_persona.md becomes a system-prompt section that never interpolates', () => {
  const root = workspace({ campaign: 'seventh_moon', persona: 'Speak in a low, dry voice.' })
  const { section } = mount()
  assert.equal(section.name, 'dd35:dm-persona')
  assert.equal(section.interpolate, false)
  const text = section.text(assembleAt(root))
  assert.match(text, /Speak in a low, dry voice\./)
  assert.match(text, /campaign\/seventh_moon\/dm_persona\.md/)
})

test('campaign prose containing {{braces}} survives verbatim', () => {
  const root = workspace({ campaign: 'c', persona: 'Address the player as {{hero}}, always.' })
  const { section } = mount()
  // The registration must be interpolate:false, or an unregistered {{hero}}
  // would throw while rendering the prompt.
  assert.match(section.text(assembleAt(root)), /\{\{hero\}\}/)
})

test('the notes block names the path and appends the file contents', () => {
  const root = workspace({ campaign: 'c', notes: 'Kenna owes the party a favour.' })
  const { context } = mount()
  const text = context.text(assembleAt(root))
  assert.equal(context.name, 'dd35:dm-notes')
  assert.match(text, /campaign\/c\/dm_notes\.md/)
  assert.match(text, /Kenna owes the party a favour\./)
  assert.match(text, /`edit` to append/)
})

test('the persona section defers campaign facts to the notes file', () => {
  const root = workspace({ campaign: 'c', persona: 'Grim and unhurried.' })
  assert.match(mount().section.text(assembleAt(root)),
    /campaign facts and house rules belong in your notes file/)
})

test('notes are named as the home for anything the DM must be reminded of', () => {
  const root = workspace({ campaign: 'c' })
  const text = mount().context.text(assembleAt(root))
  assert.match(text, /anything you may need to be reminded of/)
  assert.match(text, /House rules are the primary use/)
  assert.match(text, /active quests/)
  assert.match(text, /intent behind a plot arc/)
  assert.match(text, /bring up several sessions from now/)
})

test('campaign truth is kept out of workspace-global files', () => {
  const root = workspace({ campaign: 'c' })
  const text = mount().context.text(assembleAt(root))
  assert.match(text, /campaign-specific truth/)
  assert.match(text, /AGENTS\.md/)
})

test('the notes block forbids anything that changes turn to turn', () => {
  // Notes are re-injected on every request as authoritative, so a scene
  // description copied into them is not merely redundant with `get_state` — it
  // goes stale within a turn and is then read back as though still true.
  const root = workspace({ campaign: 'c' })
  const text = mount().context.text(assembleAt(root))
  assert.match(text, /Do not record anything that changes from turn to turn/)
  assert.match(text, /current scene, party location, turn order, hit points, and conditions/)
  assert.match(text, /retrieved fresh from get_state/)
  assert.match(text, /remain true across multiple turns and sessions/)
})

test('the notes block still explains the file when it does not exist', () => {
  const root = workspace({ campaign: 'c' })
  const text = mount().context.text(assembleAt(root))
  assert.match(text, /campaign\/c\/dm_notes\.md/)
  assert.match(text, /does not exist/)
  assert.doesNotMatch(text, /### Current notes/)
})

test('an edited notes file is re-read rather than served from cache', () => {
  const root = workspace({ campaign: 'c', notes: 'short' })
  const { context } = mount()
  assert.match(context.text(assembleAt(root)), /short/)
  writeFileSync(join(root, 'campaign', 'c', 'dm_notes.md'), 'a considerably longer note')
  assert.match(context.text(assembleAt(root)), /a considerably longer note/)
})

test('the active campaign registry decides which files load', () => {
  const root = workspace({ campaign: 'first', persona: 'Persona one.' })
  const { section } = mount()
  assert.match(section.text(assembleAt(root)), /Persona one\./)

  writeRegistry(root, 'second')
  mkdirSync(join(root, 'campaign', 'second'), { recursive: true })
  writeFileSync(join(root, 'campaign', 'second', 'dm_persona.md'), 'Persona two.')
  assert.match(section.text(assembleAt(root)), /Persona two\./)
})

test('no active campaign and no agent both contribute nothing', () => {
  const bare = workspace()
  const { section, context } = mount()
  assert.equal(section.text(assembleAt(bare)), '')
  assert.equal(context.text(assembleAt(bare)), '')
  assert.equal(section.text({}), '')
  assert.equal(context.text({}), '')
  assert.equal(section.text(undefined), '')
})

test('an oversized file is truncated with a visible notice', () => {
  const root = workspace({ campaign: 'c', persona: 'x'.repeat(500) })
  const { section } = mount({ personaMaxBytes: 64 })
  const text = section.text(assembleAt(root))
  assert.match(text, /dm_persona\.md truncated at 64 bytes/)
  assert.ok(Buffer.byteLength(text, 'utf8') < 400, 'truncated body stays small')
})

test('the persona section sits just after the persona prefix; notes come after policy context', () => {
  const { section, context } = mount()
  assert.equal(section.order, 100)
  assert.equal(context.order, 200)
})

test('an empty persona file contributes nothing', () => {
  const root = workspace({ campaign: 'c', persona: '   \n\n' })
  assert.equal(mount().section.text(assembleAt(root)), '')
})
