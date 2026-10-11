/**
 * Tool-result retention tests — how the bundle is found by the two scanners.
 *
 * The web half of this bundle is not declared anywhere explicit. It is inferred:
 * `packages/client/modules/src/index.ts` walks every Loader row, resolves the
 * row's module to its owning `package.json`, and — only if that manifest carries
 * `dsh.client` — serves `exports["./client"]` and adds it to `__DSH_BOOT__`.
 *
 * That inference has two hard gates, and this bundle failed the first one for its
 * entire life, which is why `settings.plugins.tab` showed only `all` and
 * `dsh-market` while the settings route answered 200:
 *
 *  1. **The row name must be an exact package specifier.** `resolveMeta` calls
 *     `exactPackageSpecifier(row.name)` and returns early when it is undefined.
 *     For a scoped name that helper requires exactly two segments, so
 *     `@local/dsh-tool-result-policy` resolves but `…/plugin` does not — the row
 *     is dropped before `dsh.client` is read, silently.
 *  2. **The loaded bundle must register the package name.** The module system
 *     throws `loaded without registering "<id>"` when `__ModuleLoader__.load`
 *     uses any other id.
 *
 * Both are cheap to assert and expensive to rediscover, so they are pinned here.
 * The tests read only files in the package and need no harness rig.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')

/**
 * The row name the bundle patch inserts.
 *
 * Read by regex rather than a YAML parse so the test carries no dependency; the
 * patch is ours and holds one inserted row.
 */
function insertedRowName(text) {
  const match = text.match(/- id:[^\n]*\n(?:[^\n]*\n)*?\s*name:\s*'([^']+)'/)
  assert.ok(match, 'the bundle patch must insert a row with a quoted name')
  return match[1]
}

/** The same gate the client-module scan applies before it will look at a package. */
function isExactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean)
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':')
}

test('the bundle row is named so the client scan can resolve it', () => {
  const row = insertedRowName(patch)
  assert.equal(row, pkg.name, 'the row must name the package itself, not a subpath')
  assert.ok(
    isExactPackageSpecifier(row),
    `a scoped subpath such as "${row}" is dropped by exactPackageSpecifier and never becomes a client row`,
  )
})

test('the bare package specifier loads the host entry, not a Service class', () => {
  const entry = pkg.exports['.']
  assert.equal(entry, './plugin.js')
  const source = readFileSync(join(packageRoot, entry), 'utf8')
  // The apply form. A default-exported Service class here would claim
  // `toolResultPruner` at the Host plane and collide with the preset realms.
  assert.match(source, /export function apply\b/)
  assert.doesNotMatch(source, /export default class/)
  // The host entry mounts the strip pass; it is not a route-only plugin.
  assert.match(source, /createPrunePass/)
  assert.ok(existsSync(join(packageRoot, 'pass.js')))
})

test('the web half is declared and its file exists', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(existsSync(join(packageRoot, pkg.exports['./client'])))
})

test('the bundle registers the package name, which is what the loader keys it by', () => {
  const registered = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(registered, 'client.js must register through window.__ModuleLoader__.load')
  assert.equal(registered[1], pkg.name)
})
