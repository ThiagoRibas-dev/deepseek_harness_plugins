#!/usr/bin/env bash
# Run the compaction guard's tests.
#
# The pure modules (`lib/summary-quality.js`, `lib/pending-batch.js`) import
# nothing, so their tests run anywhere with `node --test tests/<file>.test.js`.
# `tests/pruner-deferral.test.js` builds a real harness `Session` and drives the
# real pruner, which needs the `@deepseek-ai/*` packages the loader supplies and
# plain Node does not resolve from this directory.
#
# This script therefore builds a throwaway rig beside the plugin: a copy of the
# package plus a `node_modules` whose `@deepseek-ai` entries point at every
# workspace package the installation ships, so the same module graph the loader
# builds can be exercised offline. Nothing here touches a live session.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
ROOT="${DSH_INSTALL_ROOT:-/usr/lib/node_modules/@deepseek-ai/dsh-root}"

if [ ! -d "$ROOT/packages/compaction/compaction" ]; then
  echo "harness installation not found at $ROOT; set DSH_INSTALL_ROOT" >&2
  exit 2
fi

RIG="${TMPDIR:-/tmp}/cg-rig-$$"
mkdir -p "$RIG"
trap 'rm -rf "$RIG"' EXIT

cp -r "$PKG" "$RIG/plugin"
rm -rf "$RIG/plugin/node_modules"

# Link every workspace package by its manifest name, the way the loader supplies
# them. A per-package list would need editing every time this test touches a new
# harness service.
node - "$ROOT" "$RIG" <<'LINK'
const { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } = require('node:fs')
const { dirname, join } = require('node:path')

const [root, rig] = process.argv.slice(2)
const modules = join(rig, 'node_modules')

/** Every package.json under a base directory, without descending into node_modules. */
function* manifests(base, depth = 0) {
  if (depth > 3) return
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const dir = join(base, entry.name)
    const manifest = join(dir, 'package.json')
    if (statSync(manifest, { throwIfNoEntry: false })) yield manifest
    else yield* manifests(dir, depth + 1)
  }
}

let linked = 0
for (const manifest of [...manifests(join(root, 'packages')), ...manifests(join(root, 'vendor'))]) {
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
  const target = join(modules, name)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  symlinkSync(dirname(manifest), target, 'dir')
  linked += 1
}
console.log(`rig: linked ${linked} harness packages`)
LINK

cd "$RIG"
exec node --test plugin/tests/*.test.js "$@"
