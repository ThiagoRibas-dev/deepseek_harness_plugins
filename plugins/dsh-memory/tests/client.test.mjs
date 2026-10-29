/**
 * Client bundle contract tests.
 *
 * The browser half is a plain script, so it can be evaluated offline with a
 * `window.__ModuleLoader__` shim. That is worth doing: every failure mode here is
 * silent. A body registered under a key that does not match its tab type's `id`
 * renders nothing; a missing service in `inject` throws at activation; a tab type
 * with no guide entry is unreachable by a person.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Minimal React, good enough to build elements without a DOM. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

/** Evaluate the bundle and hand back what its factory returned. */
function loadBundle() {
  let module = null;
  const slots = [];
  const tabTypes = [];
  const registrations = [];
  const context = {
    slots: {
      inject: (name, fn) => { slots.push(name); fn(); return () => {}; },
      register: (options) => { registrations.push(options); return () => {}; },
    },
    sidebarRight: { openTab: () => {} },
    sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); return () => {}; } },
    effect: (fn) => { fn(); return () => {}; },
  };
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        module = { id, ...factory((name) => (name === 'react' ? React : {})) };
      },
    },
  };
  // eslint-disable-next-line no-new-func -- the bundle is a script by contract
  new Function('window', source)(window);
  return { module, slots, tabTypes, registrations, context };
}

test('the bundle self-registers under its package name', () => {
  const { module } = loadBundle();
  assert.equal(module.id, '@local/dsh-memory', 'the loader keys every bundle by the id it declares');
  assert.equal(typeof module.apply, 'function');
});

test('the client declares every service it reads', () => {
  const { module } = loadBundle();
  assert.deepEqual([...module.inject].sort(), ['sidebarRight', 'sidebarRightTabs', 'slots']);
});

test('both surfaces are registered: settings and the right pane', () => {
  const { module, context, slots, registrations } = loadBundle();
  module.apply(context);
  assert.ok(slots.includes('settings.plugins.tab'), 'the configuration surface');
  assert.ok(slots.includes('sidebar.right.pane.tab'), 'the working surface body');
  assert.ok(slots.includes('sidebar.right.pane.tab.title'), 'the tab chip');
  assert.equal(registrations.find((r) => r.name === 'settings.plugins.tab')?.id, 'memory-core');
});

test('the tab body and title are keyed by the type id, or they render nothing', () => {
  const { module, context, tabTypes, registrations } = loadBundle();
  module.apply(context);
  assert.equal(tabTypes.length, 1);
  const type = tabTypes[0];
  const body = registrations.find((r) => r.name === 'sidebar.right.pane.tab');
  const title = registrations.find((r) => r.name === 'sidebar.right.pane.tab.title');
  assert.equal(body.key, type.id, 'the body seat is dispatched by the type id');
  assert.equal(title.key, type.id, 'the title seat uses the same key');
});

test('the tab type can be opened by a person', () => {
  const { module, context, tabTypes } = loadBundle();
  module.apply(context);
  const type = tabTypes[0];
  assert.equal(typeof type.title, 'function');
  assert.equal(type.title(), 'Memory');
  assert.equal(typeof type.kind, 'string');
  assert.ok(type.kind.length > 0);
  assert.ok(Array.isArray(type.guide) && type.guide.length >= 1, 'a page type needs a guide entry to be reachable');
  const entry = type.guide[0];
  assert.equal(typeof entry.title, 'function');
  assert.equal(typeof entry.order, 'number');
  assert.equal(typeof entry.id, 'string');
});

test('the tab type claims no resource addresses', () => {
  const { module, context, tabTypes } = loadBundle();
  module.apply(context);
  // A page type is opened by kind. Declaring a pattern would make it contend for
  // files the browser type already claims.
  assert.equal(tabTypes[0].patterns, undefined);
});

test('the factory exports its components for the offline suite', () => {
  const { module } = loadBundle();
  assert.ok(module.__components, 'components must be reachable without a browser');
  for (const name of ['MemoryTab', 'MemoryTabTitle', 'CoreMemoriesPanel', 'PrepareEmbedderCard', 'VectorHealthCard', 'DocumentUploadCard']) {
    assert.equal(typeof module.__components[name], 'function', `${name} should be exported`);
  }
});

test('the memory tab renders without a session', () => {
  const { module } = loadBundle();
  const element = module.__components.MemoryTab({ sessionId: undefined });
  assert.ok(element, 'the body must render before a session is known');
});

test('every exported component renders, and none leaks undefined', () => {
  const { module } = loadBundle();
  const { MemoryTab, MemoryTabTitle, HitRow, Panel, PrepareEmbedderCard, VectorHealthCard, DocumentUploadCard, CoreMemoriesPanel } = module.__components;
  const tree = [
    MemoryTab({ sessionId: 's1' }),
    MemoryTabTitle(),
    HitRow({ hit: { source_path: 'docs/a.md', content: 'excerpt text' }, first: true }),
    HitRow({ hit: { id: 'x', content: 'y'.repeat(400) }, first: false }),
    Panel({ title: 'T', count: 3, children: null }),
    PrepareEmbedderCard(),
    DocumentUploadCard(),
    CoreMemoriesPanel(),
  ];
  for (const element of tree) assert.ok(element, 'a component returned nothing');
  // The vector card stays out of that list on purpose: it renders nothing until
  // its first status read lands, so an empty panel is not drawn over the form.
  assert.equal(VectorHealthCard(), null, 'the vector card withholds itself before it has data');
  // A missing prop that renders as the literal string is the classic symptom of a
  // typo in a field name, and it is invisible until someone reads the pane.
  const serialized = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? undefined : value));
  assert.equal(serialized.includes('undefined'), false, 'a field rendered as undefined');
});

test('the client reads the injected identity rather than a literal token', () => {
  assert.match(source, /window\.__DSH_MEMORY__/, 'the token arrives with the document; a literal would be a second credential');
  assert.equal(/token:\s*'[A-Za-z0-9_-]{8,}'/.test(source), false, 'no token may be embedded in the bundle');
});
