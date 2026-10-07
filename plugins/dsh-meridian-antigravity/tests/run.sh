#!/usr/bin/env bash
# Run the connector's offline conformance tests.
#
# A profile-installed plugin resolves `@deepseek-ai/*` through the harness
# loader's installed-host base, which plain Node does not provide. This script
# therefore builds a throwaway rig beside the plugin: a copy of the package plus
# a `node_modules` whose `@deepseek-ai` entries point at the installed harness
# packages, so the same module graph the loader builds can be exercised offline.
#
# Nothing here touches a live Meridian service or spends subscription quota.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
ROOT="${DSH_INSTALL_ROOT:-/usr/lib/node_modules/@deepseek-ai/dsh-root}"

if [ ! -d "$ROOT/packages/llm/llm" ]; then
  echo "harness installation not found at $ROOT; set DSH_INSTALL_ROOT" >&2
  exit 2
fi

RIG="${TMPDIR:-/tmp}/ma-conformance-$$"
mkdir -p "$RIG/node_modules/@deepseek-ai"
trap 'rm -rf "$RIG"' EXIT

cp -r "$PKG" "$RIG/plugin"
rm -rf "$RIG/plugin/node_modules"

for spec in "packages/llm/llm:dsh-llm" "vendor/schemastery:schemastery" "vendor/cosmokit:cosmokit" "vendor/cordis:cordis"; do
  src="$ROOT/${spec%%:*}"
  name="${spec##*:}"
  ln -sfn "$src" "$RIG/node_modules/@deepseek-ai/$name"
done

cd "$RIG"
node plugin/tests/client.mjs "$@"
echo
node plugin/tests/serialize-compaction.mjs "$@"
echo
node plugin/tests/serialize-notices.mjs "$@"
echo
node plugin/tests/spent-batch.mjs "$@"
echo
exec node plugin/tests/conformance.mjs "$@"
