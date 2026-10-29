/**
 * Tier 1 Core Memories: Unit tests for core.js
 *
 * Exercises:
 * - XML prompt formatting & deterministic sorting (priority DESC, key ASC)
 * - XML entity escaping for keys and directives
 * - Static prompt section descriptor (order 110, interpolate: false)
 * - CoreMemoryManager CRUD & namespace isolation
 * - manage_core_memory tool definition and execution
 * - Defensively bounded result sets (capping at 100)
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MemoryStorage } from '../storage.js';
import {
  CORE_PROMPT_SECTION_NAME,
  CORE_PROMPT_SECTION_ORDER,
  CoreMemoryManager,
  createCorePromptSectionDescriptor,
  createManageCoreMemoryTool,
  escapeXmlAttr,
  escapeXmlText,
  formatCorePromptSection,
  MAX_TOOL_LIST_RESULTS,
} from '../core.js';

test('Core Memories — XML Entity Escaping', () => {
  assert.equal(escapeXmlText('Hello & World <10> "yes"'), 'Hello &amp; World &lt;10&gt; "yes"');
  assert.equal(escapeXmlAttr('key & "name" <val>'), 'key &amp; &quot;name&quot; &lt;val&gt;');
  assert.equal(escapeXmlText(null), '');
  assert.equal(escapeXmlAttr(undefined), '');
});

test('Core Memories — Prompt Section XML Formatting & Sorting', () => {
  // Empty or non-array returns empty string
  assert.equal(formatCorePromptSection([]), '');
  assert.equal(formatCorePromptSection(null), '');
  assert.equal(formatCorePromptSection(undefined), '');

  // Deterministic sorting: priority DESC then key ASC
  const items = [
    { key: 'zebra', directive: 'Zebra rules', priority: 5 },
    { key: 'alpha', directive: 'Alpha rules', priority: 5 },
    { key: 'urgent', directive: 'High priority instruction', priority: 100 },
    { key: 'background', directive: 'Low priority note', priority: 0 },
    { key: 'beta', directive: 'Beta rules', priority: 5 },
  ];

  const xml = formatCorePromptSection(items);

  const expected = [
    '<core_memories>',
    '  <memory key="urgent" priority="100">High priority instruction</memory>',
    '  <memory key="alpha" priority="5">Alpha rules</memory>',
    '  <memory key="beta" priority="5">Beta rules</memory>',
    '  <memory key="zebra" priority="5">Zebra rules</memory>',
    '  <memory key="background" priority="0">Low priority note</memory>',
    '</core_memories>',
  ].join('\n');

  assert.equal(xml, expected);
});

test('Core Memories — XML Formatting with Multiline & Special Characters', () => {
  const items = [
    {
      key: 'code_style',
      directive: 'Always use:\n```javascript\nconst a = 1 < 2 && 3 > 2;\n```',
      priority: 10,
    },
  ];

  const xml = formatCorePromptSection(items);
  assert.match(xml, /key="code_style"/);
  assert.match(xml, /priority="10"/);
  assert.match(xml, /1 &lt; 2 &amp;&amp; 3 &gt; 2;/);
  assert.ok(xml.startsWith('<core_memories>\n'));
  assert.ok(xml.endsWith('\n</core_memories>'));
});

test('Core Memories — Prompt Section Descriptor (Prefix Cache Preservation)', () => {
  const storage = new MemoryStorage(':memory:');
  const manager = new CoreMemoryManager(storage, { defaultNamespace: 'test_desc' });

  const desc = createCorePromptSectionDescriptor(manager, { namespace: 'test_desc' });

  // Order must be 110 (following base instructions at 100)
  assert.equal(desc.order, CORE_PROMPT_SECTION_ORDER);
  assert.equal(desc.order, 110);
  assert.equal(desc.name, CORE_PROMPT_SECTION_NAME);
  assert.equal(desc.name, 'memory:core');

  // Critical for static prefix cache: interpolate must be false
  assert.equal(desc.interpolate, false);

  // Dynamic text returns empty string when 0 memories exist
  assert.equal(desc.text(), '');

  // Add memory containing mustache syntax that would crash mustache interpolation
  manager.set('user_template', 'When addressing {{user}}, say {{greeting}}', 10);

  const text = desc.text();
  assert.match(text, /<core_memories>/);
  assert.match(text, /When addressing {{user}}, say {{greeting}}/);

  storage.close();
});

test('Core Memories — Descriptor with Custom Target Shapes', () => {
  // Array target
  const descArray = createCorePromptSectionDescriptor([
    { key: 'role', directive: 'Assistant', priority: 1 },
  ]);
  assert.match(descArray.text(), /<core_memories>/);

  // Function target
  const descFn = createCorePromptSectionDescriptor((ns) => [
    { key: 'scope', directive: `Scoped to ${ns}`, priority: 5 },
  ], { namespace: 'custom_ns' });
  assert.match(descFn.text(), /Scoped to custom_ns/);

  // Storage target directly
  const storage = new MemoryStorage(':memory:');
  storage.setCoreMemory({ namespace: 'direct', key: 'k1', directive: 'd1', priority: 0 });
  const descStorage = createCorePromptSectionDescriptor(storage, { namespace: 'direct' });
  assert.match(descStorage.text(), /<memory key="k1"/);
  storage.close();
});

test('Core Memories — CoreMemoryManager CRUD Operations', () => {
  const storage = new MemoryStorage(':memory:');
  const manager = new CoreMemoryManager(storage, { defaultNamespace: 'global' });

  // Set
  const created = manager.set('persona', 'Be direct and concise', 50);
  assert.ok(created.id);
  assert.equal(created.key, 'persona');
  assert.equal(created.priority, 50);

  // Get
  const retrieved = manager.get('persona');
  assert.ok(retrieved);
  assert.equal(retrieved.directive, 'Be direct and concise');

  // Get by ID
  const retrievedById = manager.getById(created.id);
  assert.equal(retrievedById?.id, created.id);

  // Upsert
  manager.set('persona', 'Be exceptionally brief and precise', 75);
  const updated = manager.get('persona');
  assert.equal(updated.directive, 'Be exceptionally brief and precise');
  assert.equal(updated.priority, 75);

  // List
  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'persona');

  // Delete
  const deleted = manager.delete('persona');
  assert.equal(deleted, true);
  assert.equal(manager.get('persona'), null);

  // Delete non-existent
  assert.equal(manager.delete('non_existent'), false);

  storage.close();
});

test('Core Memories — CoreMemoryManager deleteById & Object Set Form', () => {
  const storage = new MemoryStorage(':memory:');
  const manager = new CoreMemoryManager(storage);

  const mem = manager.set({
    key: 'target',
    directive: 'Directive to delete by id',
    priority: 15,
    namespace: 'custom',
  });
  assert.ok(mem.id);
  assert.equal(manager.get('target', 'custom')?.directive, 'Directive to delete by id');

  const deleted = manager.deleteById(mem.id);
  assert.equal(deleted, true);
  assert.equal(manager.get('target', 'custom'), null);
  assert.equal(manager.deleteById(mem.id), false);

  storage.close();
});

test('Core Memories — Namespace Isolation', () => {
  const storage = new MemoryStorage(':memory:');
  const manager = new CoreMemoryManager(storage);

  manager.set('user_name', 'Global User', 10, 'global');
  manager.set('user_name', 'Session User', 20, 'session_123');

  const globalMem = manager.get('user_name', 'global');
  const sessionMem = manager.get('user_name', 'session_123');

  assert.equal(globalMem.directive, 'Global User');
  assert.equal(sessionMem.directive, 'Session User');

  const globalList = manager.list('global');
  const sessionList = manager.list('session_123');

  assert.equal(globalList.length, 1);
  assert.equal(sessionList.length, 1);
  assert.equal(globalList[0].directive, 'Global User');
  assert.equal(sessionList[0].directive, 'Session User');

  const allList = manager.listAll();
  assert.equal(allList.length, 2);

  storage.close();
});

test('Core Memories — Agent Tool: manage_core_memory Schema', () => {
  const storage = new MemoryStorage(':memory:');
  const tool = createManageCoreMemoryTool(storage);

  assert.equal(tool.name, 'manage_core_memory');
  assert.ok(typeof tool.description === 'string');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.properties.action.type, 'string');
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'get', 'set', 'delete']);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.properties.key.type, 'string');
  assert.equal(tool.parameters.properties.directive.type, 'string');
  assert.equal(tool.parameters.properties.priority.type, 'integer');

  storage.close();
});

test('Core Memories — Agent Tool: execute set, get, list, delete', async () => {
  const storage = new MemoryStorage(':memory:');
  const tool = createManageCoreMemoryTool(storage);

  // Set action
  const setRes = await tool.execute({
    action: 'set',
    key: 'response_mode',
    directive: 'Answer strictly with factual evidence',
    priority: 10,
  });
  assert.equal(setRes.success, true);
  assert.equal(setRes.action, 'set');
  assert.equal(setRes.memory.key, 'response_mode');
  assert.equal(setRes.memory.priority, 10);

  // Get action
  const getRes = await tool.execute({
    action: 'get',
    key: 'response_mode',
  });
  assert.equal(getRes.success, true);
  assert.equal(getRes.action, 'get');
  assert.equal(getRes.memory.directive, 'Answer strictly with factual evidence');

  // List action
  const listRes = await tool.execute({
    action: 'list',
  });
  assert.equal(listRes.success, true);
  assert.equal(listRes.action, 'list');
  assert.equal(listRes.count, 1);
  assert.equal(listRes.memories[0].key, 'response_mode');

  // Delete action
  const delRes = await tool.execute({
    action: 'delete',
    key: 'response_mode',
  });
  assert.equal(delRes.success, true);
  assert.equal(delRes.action, 'delete');
  assert.equal(delRes.key, 'response_mode');

  // Get after delete returns success: false
  const getAfterDel = await tool.execute({
    action: 'get',
    key: 'response_mode',
  });
  assert.equal(getAfterDel.success, false);
  assert.match(getAfterDel.error, /not found/i);

  storage.close();
});

test('Core Memories — Agent Tool: Namespace Handling in Execute', async () => {
  const storage = new MemoryStorage(':memory:');
  const tool = createManageCoreMemoryTool(storage);

  await tool.execute({
    action: 'set',
    namespace: 'tenant_a',
    key: 'theme',
    directive: 'dark',
  });

  await tool.execute({
    action: 'set',
    namespace: 'tenant_b',
    key: 'theme',
    directive: 'light',
  });

  const getA = await tool.execute({ action: 'get', namespace: 'tenant_a', key: 'theme' });
  const getB = await tool.execute({ action: 'get', namespace: 'tenant_b', key: 'theme' });

  assert.equal(getA.memory.directive, 'dark');
  assert.equal(getB.memory.directive, 'light');

  const listA = await tool.execute({ action: 'list', namespace: 'tenant_a' });
  assert.equal(listA.count, 1);
  assert.equal(listA.memories[0].directive, 'dark');

  storage.close();
});

test('Core Memories — Agent Tool: Error Handling and Validation', async () => {
  const storage = new MemoryStorage(':memory:');
  const tool = createManageCoreMemoryTool(storage);

  // Missing key on get
  const missingKeyGet = await tool.execute({ action: 'get' });
  assert.equal(missingKeyGet.success, false);
  assert.match(missingKeyGet.error, /key must be a non-empty string/);

  // Missing key on set
  const missingKeySet = await tool.execute({ action: 'set', directive: 'some directive' });
  assert.equal(missingKeySet.success, false);
  assert.match(missingKeySet.error, /key must be a non-empty string/);

  // Missing directive on set
  const missingDirSet = await tool.execute({ action: 'set', key: 'foo' });
  assert.equal(missingDirSet.success, false);
  assert.match(missingDirSet.error, /directive must be a string/);

  // Missing key on delete
  const missingKeyDel = await tool.execute({ action: 'delete' });
  assert.equal(missingKeyDel.success, false);
  assert.match(missingKeyDel.error, /key must be a non-empty string/);

  // Delete non-existent
  const delNotFound = await tool.execute({ action: 'delete', key: 'not_there' });
  assert.equal(delNotFound.success, false);
  assert.match(delNotFound.error, /not found/);

  storage.close();
});

test('Core Memories — Agent Tool: Capping List Results at 100', async () => {
  const storage = new MemoryStorage(':memory:');
  const tool = createManageCoreMemoryTool(storage);

  // Insert 120 memories
  for (let i = 0; i < 120; i++) {
    storage.setCoreMemory({
      namespace: 'global',
      key: `key_${String(i).padStart(3, '0')}`,
      directive: `Directive ${i}`,
      priority: i,
    });
  }

  const listRes = await tool.execute({ action: 'list' });
  assert.equal(listRes.success, true);
  assert.equal(listRes.total, 120);
  assert.equal(listRes.count, MAX_TOOL_LIST_RESULTS);
  assert.equal(listRes.count, 100);
  assert.equal(listRes.memories.length, 100);

  storage.close();
});

test('Core Memories — Integration with Harness defineTool', async () => {
  // Test using the harness's real defineTool compiler
  const harnessTools = await import('/export/DownloadsSSD/AI/TEXT/deepseek-harness/packages/core/tools/lib/index.js');
  const storage = new MemoryStorage(':memory:');

  const compiledTool = createManageCoreMemoryTool(storage, {
    defineTool: harnessTools.defineTool,
  });

  // Verify parameters and output conform to ToolDefinition
  assert.equal(compiledTool.name, 'manage_core_memory');
  assert.equal(typeof compiledTool.execute, 'function');
  assert.equal(typeof compiledTool.output.render, 'function');

  const res = await compiledTool.execute({
    action: 'set',
    key: 'strict_mode',
    directive: 'Never assume user intent',
    priority: 100,
  });

  assert.equal(res.success, true);
  assert.equal(res.memory.key, 'strict_mode');

  // Verify render block output
  const rendered = compiledTool.output.render({}, res);
  assert.equal(Array.isArray(rendered), true);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /"strict_mode"/);

  storage.close();
});
