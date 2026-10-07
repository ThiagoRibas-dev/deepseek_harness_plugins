/**
 * Structural check on this bundle's `preset-standard` override.
 *
 * The override restates a shipped preset declaration verbatim with two rows
 * swapped, because a patch replaces `config` wholesale and a preset's child
 * plugins are not Loader rows that `disabled` can reach. Restating the list
 * copies the shipped file, so it can silently drift away from it, and the
 * plugin names inside a declaration are never anchored by the loader: a
 * relative path there resolves against the root entry list's base, fails to
 * import, and activates the preset as broken.
 *
 * This test pins the copy to the installed preset and pins the two names to
 * files that exist.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const patchFile = join(here, '..', 'cordis.patch.yml')
const profileAnchor = join(
  process.env.DSH_PROFILE_DIR ?? join(process.env.HOME ?? '/root', '.dsh', 'profiles', 'web'),
  'package.json',
)

/** Locate the installed preset this override copies. */
function locateShipped() {
  const require = createRequire(profileAnchor)
  const manifest = require.resolve('@deepseek-ai/dsh-web-app/package.json')
  return join(dirname(manifest), 'presets', 'standard.patch.yml')
}

let shippedFile
let missing
try {
  shippedFile = locateShipped()
  if (!existsSync(shippedFile)) missing = `no shipped preset at ${shippedFile}`
} catch (error) {
  missing = `cannot resolve @deepseek-ai/dsh-web-app from ${profileAnchor}: ${error.code ?? error.message}`
}

/** `!!js` scalars stay literal strings; only structure is under test. */
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }

/** Parse a loader patch list with the same tag the loader accepts. */
function readPatches(file) {
  const YAML = createRequire(profileAnchor)('yaml')
  return YAML.parse(readFileSync(file, 'utf8'), { customTags: [jsTag] })
}

/** Rows of a declaration, flattened depth-first with group nesting. */
function rows(plugins) {
  const out = []
  for (const [index, row] of plugins.entries()) {
    out.push({ index, row })
    if (row.group === true && Array.isArray(row.config)) {
      for (const [childIndex, child] of row.config.entries()) out.push({ index: `${index}.${childIndex}`, row: child })
    }
  }
  return out
}

/** Every leaf path where two values differ, treating a missing key as a value. */
function diffPaths(left, right, path = '') {
  if (Object.is(left, right)) return []
  const both = left !== null && right !== null && typeof left === 'object' && typeof right === 'object'
  if (!both) return [{ path, left, right }]
  const list = Array.isArray(left) || Array.isArray(right)
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].flatMap((key) => {
    const step = list ? `[${key}]` : path === '' ? key : `.${key}`
    return diffPaths(left[key], right[key], `${path}${step}`)
  })
}

test('the override copies the shipped standard declaration except for compaction', { skip: missing }, () => {
  const shipped = readPatches(shippedFile)
  const ours = readPatches(patchFile)

  const shippedRow = shipped
    .flatMap(patch => patch.insert ?? [])
    .find(row => row.id === 'preset-standard')
  assert.ok(shippedRow, 'the shipped file must insert preset-standard')

  const oursRow = ours.find(patch => patch.id === 'preset-standard' && patch.insert === undefined)
  assert.ok(oursRow, 'this patch must override preset-standard with a non-insert row')

  // The override carries the entire declaration, not an id-targeted field.
  assert.equal(oursRow.name, '@deepseek-ai/dsh-agent-preset')
  for (const field of ['id', 'name', 'description', 'order']) {
    assert.deepEqual(oursRow.config[field], shippedRow.config[field], `config.${field} must be restated as shipped`)
  }

  // Same rows, in the same order, with the same identities.
  assert.deepEqual(
    rows(oursRow.config.plugins).map(({ row }) => row.id),
    rows(shippedRow.config.plugins).map(({ row }) => row.id),
    'the plugin list must restate the shipped ids in the shipped order',
  )

  const group = oursRow.config.plugins.findIndex(row => row.id === 'compaction')
  assert.notEqual(group, -1, 'the compaction group must exist')
  assert.deepEqual(
    oursRow.config.plugins[group].isolate,
    shippedRow.config.plugins[group].isolate,
    'the guard only works if the compaction realm is isolated exactly as shipped',
  )

  // Exactly the swapped rows differ, and nothing else.
  const expected = [
    `config.plugins[${group}].config[0].name`,
    `config.plugins[${group}].config[0].config`,
    `config.plugins[${group}].config[2].name`,
    `config.plugins[${group}].config[2].config.deferWhenBatchPending`,
    `config.plugins[${group}].config[2].config.contractProviders`,
  ].sort()
  assert.deepEqual(
    diffPaths(shippedRow, oursRow).map(({ path }) => path).sort(),
    expected,
    'the override may differ from the shipped declaration only in the two swapped rows',
  )
})

test('every name in the override resolves without the patch-file anchor', { skip: missing }, () => {
  const ours = readPatches(patchFile)

  const declaration = ours.find(patch => patch.id === 'preset-standard' && patch.insert === undefined)
  const names = rows(declaration.config.plugins).map(({ row }) => row.name)

  for (const name of names) {
    assert.ok(typeof name === 'string' && name !== '', 'every row needs a name')
    if (name.startsWith('cordis:')) continue
    assert.ok(
      !name.startsWith('.') && !name.startsWith('/'),
      `${name} is neither an absolute file URL nor a package specifier: the loader anchors relative names only inside insert lists`,
    )
  }

  const swapped = names.filter(name => name.startsWith('file:///'))
  for (const name of swapped) {
    assert.ok(existsSync(fileURLToPath(name)), `${name} does not exist`)
  }
  assert.equal(swapped.length, 2, 'exactly the two swapped rows are named by URL')
})
