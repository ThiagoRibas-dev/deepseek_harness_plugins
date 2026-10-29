/**
 * Plugin-load contract tests.
 *
 * These do not exercise behaviour; they catch the two mistakes that make a row
 * fail to activate, both of which cost a full restart to discover:
 *
 *   1. reading a service that is not declared in `inject` — the property read
 *      throws, and optional chaining does not soften it;
 *   2. declaring a service that may not exist yet, which makes the row itself fail.
 *
 * The source is inspected rather than the runtime, because the runtime failure
 * only appears in the harness's own launcher log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');

/**
 * Source with comments removed.
 *
 * The prose in this file names `ctx.memory` when describing the service, and a
 * naive scan cannot tell that from a real read. Comments carry no runtime
 * meaning, so dropping them first is both simpler and more accurate than
 * special-casing the one word.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

/** Services the plugin declares as required. */
function declaredInject() {
  const match = /export const inject = \[([^\]]*)\]/.exec(source);
  assert.ok(match, 'plugin.js must export an inject array');
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * Services read as `ctx.<name>`, excluding things that are not services.
 *
 * `ctx.get('name')` is deliberately not a service read: it is the documented way
 * to look up something optional, and it returns undefined instead of throwing.
 */
function servicesReadDirectly() {
  const found = new Set();
  const pattern = /\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    found.add(match[1]);
  }
  // Context API, not services.
  for (const api of ['get', 'inject', 'effect', 'on', 'provide', 'logger', 'emit', 'waterfall', 'serial', 'parallel', 'bail', 'start', 'stop']) {
    found.delete(api);
  }
  return [...found].sort();
}

test('every service read directly on ctx is declared in inject', () => {
  const declared = new Set(declaredInject());
  const read = servicesReadDirectly();
  const missing = read.filter((name) => !declared.has(name));
  assert.deepEqual(
    missing,
    [],
    `these services are read as ctx.<name> but absent from inject: ${missing.join(', ')} — the property read throws at activation`,
  );
});

test('the required services are the ones the plugin actually needs', () => {
  const declared = declaredInject();
  assert.deepEqual([...declared].sort(), ['systemPrompt', 'tools']);
});

test('webServer is never declared, because it may arrive after this row applies', () => {
  assert.ok(!declaredInject().includes('webServer'), 'webServer must be awaited through ctx.inject, not required');
  assert.match(source, /ctx\.inject\(\['webServer'\]/, 'the route must be mounted from a deferred ctx.inject callback');
});

test('the route is never read as a bare service property', () => {
  // `ctx.webServer` would throw; the optional lookup and the deferred form are
  // the only two allowed spellings.
  assert.equal(/\bctx\.webServer\b/.test(source), false, 'use ctx.get(\'webServer\') or ctx.inject([\'webServer\'])');
});

test('optional services are reached through ctx.get, not a property', () => {
  const optionalReads = source.match(/ctx\.get\??\.\('([a-zA-Z]+)'/g) ?? [];
  assert.ok(optionalReads.some((entry) => entry.includes('webServer')), 'webServer is looked up optionally as the guard expects');
});
