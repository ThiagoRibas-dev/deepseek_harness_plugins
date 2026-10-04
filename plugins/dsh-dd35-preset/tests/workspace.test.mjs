/**
 * Regression tests for workspace resolution.
 *
 * The preset used to resolve `campaign/` against the folder the bundle lived
 * in. It moved out of `D&D35/campaign/`, so every campaign path must now follow
 * the *session's* workspace (`session.header.cwd`) instead.
 *
 * These import `state-store.js` directly: it depends only on `node:fs` and
 * `node:path`, so no harness rig is needed. Run from the bundle folder with:
 *
 *   node --test
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  bindWorkspaceFromSession, bounded, campaignRoot, configure, registryPath,
  statePath, transcriptsDir, workspace,
} from '../state-store.js'

const CWD = '/games/TTRPG/D&D35'

test('an unbound workspace fails loudly instead of guessing a folder', () => {
  assert.throws(() => workspace(), /no workspace bound/)
})

test('campaign paths follow the session workspace, not the bundle', () => {
  bindWorkspaceFromSession({ header: { cwd: CWD } })
  assert.equal(workspace(), CWD)
  assert.equal(campaignRoot(), join(CWD, 'campaign'))
  assert.equal(registryPath(), join(CWD, 'campaign', 'campaign_registry.md'))
  assert.equal(statePath('seventh_moon'), join(CWD, 'campaign', 'seventh_moon', 'state.json'))
  assert.equal(transcriptsDir('seventh_moon'), join(CWD, 'campaign', 'seventh_moon', 'events', 'transcripts'))
  assert.ok(!campaignRoot().includes('plugins'), 'the bundle folder must never be the campaign root')
})

test('a wrapped tool binds from the execution agent before its body runs', () => {
  const seen = []
  const tool = bounded((args) => {
    seen.push(workspace())
    return args
  })
  assert.deepEqual(tool({ n: 1 }, { agent: { session: { header: { cwd: '/other/session' } } } }), { n: 1 })
  assert.deepEqual(seen, ['/other/session'])
})

test('an execution without an agent keeps the previous binding', () => {
  bindWorkspaceFromSession({ header: { cwd: CWD } })
  bounded(() => workspace())({}, {})
  assert.equal(workspace(), CWD)
})

test('a session without a cwd never clears a binding', () => {
  bindWorkspaceFromSession({ header: { cwd: CWD } })
  bindWorkspaceFromSession({ header: {} })
  bindWorkspaceFromSession(undefined)
  assert.equal(workspace(), CWD)
})

test('an explicit workspace config pins the root for standalone use', () => {
  configure({ workspace: '/pinned/root' })
  assert.equal(workspace(), '/pinned/root')
  // A later session binding still wins: the pin is the starting point, not a lock.
  bindWorkspaceFromSession({ header: { cwd: CWD } })
  assert.equal(workspace(), CWD)
})
