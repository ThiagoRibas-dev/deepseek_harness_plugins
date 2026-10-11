/**
 * Tool-result retention tests — the policy table and the strip rule.
 *
 * Spec: `docs/dsh-tool-result-policy.md`.
 *
 * The two properties worth guarding above all others:
 *
 *  - **An unknown tool is kept.** A policy written today cannot know what a plugin
 *    installed tomorrow returns, and the policy file is edited by hand as well as
 *    by the settings page, so a typo must not be able to destroy context.
 *  - **An absent or malformed policy file yields the defaults, never an error.**
 *    This runs on the request path; a broken preference must not stop a session.
 *
 * `policy.js` imports only `node:fs`, so no harness rig is needed.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  DEFAULT_POLICY, POLICY_VERSION, STRIPPED_TOOLS, createPolicyCache, elisionMarker,
  isElided, normalisePolicy, readPolicyFile, resolvePolicy, shouldStrip,
} from '../policy.js'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A temp file holding `text`. */
function policyFile(text) {
  const root = mkdtempSync(join(tmpdir(), 'dd35-policy-'))
  roots.push(root)
  const path = join(root, 'tool-result-policy.json')
  if (text !== undefined) writeFileSync(path, text)
  return path
}

// ---- classification ------------------------------------------------------

test('the three stripped classes cover the tools that cost real context', () => {
  // Each of these is in the measured top-ten by retained bytes, except the
  // entropy tools, which are stripped by design intent rather than by size.
  for (const tool of ['read', 'bash', 'grep', 'get_state', 'update_scene', 'list_memories']) {
    assert.equal(shouldStrip(tool), true, `${tool} should be stripped`)
  }
  for (const tool of ['roll_dice', 'ask_oracle', 'consult_oracle']) {
    assert.equal(shouldStrip(tool), true, `${tool} is spent entropy`)
  }
  for (const tool of ['apply_damage', 'update_entity']) {
    assert.equal(shouldStrip(tool), true, `${tool} echoes state that is already on the sheet`)
  }
})

test('an unknown tool is kept, never stripped', () => {
  // The asymmetry is deliberate and is the safety property of the whole policy.
  assert.equal(shouldStrip('some_plugin_tool'), false)
  assert.equal(shouldStrip(''), false)
  assert.equal(shouldStrip(undefined), false)
  assert.equal(shouldStrip(null), false)
  assert.equal(shouldStrip(123), false)
})

test('the stripped list has no duplicates', () => {
  assert.equal(new Set(STRIPPED_TOOLS).size, STRIPPED_TOOLS.length)
})

test('the marker names the tool and the size, and is recognisable', () => {
  const marker = elisionMarker('read', 5478)
  assert.match(marker, /tool result elided: read/)
  assert.match(marker, /5478 B/)
  assert.match(marker, /Re-run the tool/)
  assert.equal(isElided(marker), true)
})

test('a marker survives a missing size', () => {
  assert.match(elisionMarker('read', undefined), /size unknown/)
})

test('isElided only recognises the marker, not ordinary text', () => {
  assert.equal(isElided('[tool result elided: read — 1 B. x]'), true)
  assert.equal(isElided('some ordinary output'), false)
  assert.equal(isElided(undefined), false)
})

// ---- policy file ---------------------------------------------------------

test('an absent file yields the defaults with no problem reported', () => {
  const { policy, problem } = readPolicyFile(policyFile())
  assert.equal(problem, null)
  assert.deepEqual(policy, DEFAULT_POLICY)
})

test('a malformed file yields the defaults and reports the problem', () => {
  // It must not throw: this runs while building a request.
  const { policy, problem } = readPolicyFile(policyFile('{ not json'))
  assert.deepEqual(policy, DEFAULT_POLICY)
  assert.match(problem, /unreadable policy file/)
})

test('a well-formed file is read', () => {
  const { policy, problem } = readPolicyFile(policyFile(JSON.stringify({
    version: POLICY_VERSION,
    presets: { dd35: { stripTransientResults: true } },
    defaults: { stripTransientResults: false },
  })))
  assert.equal(problem, null)
  assert.equal(policy.presets.dd35.stripTransientResults, true)
  assert.equal(policy.defaults.stripTransientResults, false)
})

test('a partial file is normalised rather than rejected', () => {
  const policy = normalisePolicy({ presets: { dd35: {} } })
  assert.equal(policy.presets.dd35.stripTransientResults, false, 'a missing flag means off')
  assert.equal(policy.version, POLICY_VERSION)
})

test('junk shapes normalise to the defaults', () => {
  for (const junk of [null, undefined, 42, 'text', [], { presets: 7 }]) {
    const policy = normalisePolicy(junk)
    assert.equal(policy.defaults.stripTransientResults, false)
    assert.deepEqual(policy.presets, {})
  }
})

// ---- resolution ----------------------------------------------------------

test('a preset entry wins over the defaults', () => {
  const policy = normalisePolicy({ presets: { dd35: { stripTransientResults: true } } })
  assert.deepEqual(resolvePolicy(policy, 'dd35'), { stripTransientResults: true, source: 'preset' })
})

test('a preset absent from the table falls through to the defaults', () => {
  // This is what makes a new preset opt-in rather than silently affected.
  const policy = normalisePolicy({ presets: { dd35: { stripTransientResults: true } } })
  assert.deepEqual(resolvePolicy(policy, 'cordis'), { stripTransientResults: false, source: 'defaults' })
})

test('a session with no preset name falls through to the defaults', () => {
  const policy = normalisePolicy({ presets: { dd35: { stripTransientResults: true } } })
  for (const preset of [undefined, null, '', 7]) {
    assert.equal(resolvePolicy(policy, preset).source, 'defaults')
  }
})

test('the configured fallback is used only when there is no policy at all', () => {
  assert.deepEqual(resolvePolicy(undefined, 'dd35', true), { stripTransientResults: true, source: 'config' })
  assert.deepEqual(resolvePolicy(undefined, 'dd35', false), { stripTransientResults: false, source: 'config' })
})

// ---- the cache -----------------------------------------------------------

test('the cache re-reads only when the file changes', () => {
  const path = policyFile(JSON.stringify({ presets: { dd35: { stripTransientResults: true } } }))
  const cache = createPolicyCache()
  assert.equal(cache.read(path).policy.presets.dd35.stripTransientResults, true)

  // A settings-page write: the next read must see it without a restart.
  writeFileSync(path, JSON.stringify({ presets: { dd35: { stripTransientResults: false } } }), { flag: 'w' })
  assert.equal(cache.read(path).policy.presets.dd35.stripTransientResults, false,
    'a live toggle has to be observed on the next pass')
})

test('the cache does not memoise an absent file', () => {
  // So that creating the file takes effect immediately rather than being missed.
  const path = policyFile()
  const cache = createPolicyCache()
  assert.equal(cache.read(path).policy.defaults.stripTransientResults, false)
  writeFileSync(path, JSON.stringify({ defaults: { stripTransientResults: true } }))
  assert.equal(cache.read(path).policy.defaults.stripTransientResults, true)
})

test('the cache tolerates a path that does not exist', () => {
  const cache = createPolicyCache()
  const { policy, problem } = cache.read(join(tmpdir(), 'definitely-not-here-9f8a.json'))
  assert.deepEqual(policy, DEFAULT_POLICY)
  assert.equal(problem, null)
})
