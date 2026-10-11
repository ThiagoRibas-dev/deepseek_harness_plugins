/**
 * Offline tests for the quota token.
 *
 * The bug being pinned: the token was minted with `randomUUID()` on every plugin
 * apply. This connector sits in the profile's `hmr` watch root, so any edit
 * reloads it — the route came back with a new token while the page kept polling
 * with the old one, and every request answered 403. The strip showed "Quota route
 * refused: forbidden" and never recovered without a manual refresh.
 *
 * The module under test imports only node builtins, so this runs with plain
 * `node --test`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { quotaTokenPath, resolveQuotaToken } from '../lib/quota-token.js'

let dir
before(() => { dir = mkdtempSync(join(tmpdir(), 'meridian-token-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })

const at = name => join(dir, name)

test('a configured token is used verbatim', () => {
  const file = at('configured')
  assert.equal(resolveQuotaToken({ configured: 'from-config', file }), 'from-config')
  // Nothing is minted, so nothing is written.
  assert.throws(() => readFileSync(file, 'utf8'))
})

test('a minted token survives the next apply', () => {
  // The whole point: a reload must resolve to the same token, or the page holding
  // the old one is locked out until it refreshes.
  const file = at('stable')
  const first = resolveQuotaToken({ file })
  const second = resolveQuotaToken({ file })
  assert.equal(second, first)
  assert.match(first, /^[0-9a-f-]{36}$/u)
})

test('a minted token is kept readable only by its owner', () => {
  const file = at('mode')
  resolveQuotaToken({ file })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(file, 'utf8').trim(), resolveQuotaToken({ file }))
})

test('a configured token overrides one already minted', () => {
  const file = at('override')
  const minted = resolveQuotaToken({ file })
  assert.notEqual(minted, 'from-config')
  assert.equal(resolveQuotaToken({ configured: 'from-config', file }), 'from-config')
})

test('an unwritable location still yields a usable token, and says so', () => {
  // Without persistence the token rotates per reload, which is the original bug.
  // Failing silently is how it went unnoticed, so the warning is the contract.
  const warnings = []
  const token = resolveQuotaToken({
    file: join(dir, 'mode', 'a-file-is-in-the-way'),
    logger: { warn: message => warnings.push(message) },
  })
  assert.match(token, /^[0-9a-f-]{36}$/u)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot persist the quota token/)
  assert.match(warnings[0], /will need a refresh/)
})

test('an empty entry in the file is not a token', () => {
  const file = at('empty')
  writeFileSync(file, '\n  \n')
  const token = resolveQuotaToken({ file })
  assert.match(token, /^[0-9a-f-]{36}$/u)
  assert.equal(readFileSync(file, 'utf8').trim(), token)
})

test('the token path follows DSH_HOME and falls back to the home directory', () => {
  assert.equal(quotaTokenPath({ DSH_HOME: '/tmp/custom-home' }, '/home/x'), '/tmp/custom-home/meridian-quota-token')
  assert.equal(quotaTokenPath({}, '/home/x'), '/home/x/.dsh/meridian-quota-token')
  // An empty DSH_HOME is not a location.
  assert.equal(quotaTokenPath({ DSH_HOME: '' }, '/home/x'), '/home/x/.dsh/meridian-quota-token')
})

test('the config default is an empty token, so the persisted fallback runs', () => {
  // Guards the wiring: if the schema ever defaulted this to something non-empty,
  // every install would share one token and the fallback would never be exercised.
  const source = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
  assert.match(source, /quotaToken: z\.string\(\)\.default\(''\)/u)
  assert.match(source, /quotaToken: typeof plain\.quotaToken === 'string'/u)
})

test('a file that is not a path is ignored rather than read', () => {
  // The call site once passed `(ctx, dependencies)` to a function taking one
  // options object, so `file` became whatever `ctx.file` happened to be. A default
  // parameter does not catch that -- it applies only to `undefined` -- so reading a
  // non-string as a path either threw or, far worse, returned the contents of some
  // unrelated file as the token.
  const scope = mkdtempSync(join(tmpdir(), 'meridian-token-guard-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = scope
  try {
    for (const bogus of [undefined, null, 42, {}, () => {}, '']) {
      assert.match(
        resolveQuotaToken({ file: bogus }),
        /^[0-9a-f-]{36}$/u,
        `file=${String(bogus)} should have fallen back to the default path`,
      )
    }
    // Every fallback landed on the configured home, not on the bogus value.
    assert.equal(readFileSync(join(scope, 'meridian-quota-token'), 'utf8').trim(), resolveQuotaToken({}))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(scope, { recursive: true, force: true })
  }
})

test('a configured token wins even when the file argument is bogus', () => {
  assert.equal(resolveQuotaToken({ configured: 'from-config', file: () => {} }), 'from-config')
})
