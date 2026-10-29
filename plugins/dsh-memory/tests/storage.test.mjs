/**
 * Comprehensive test suite for SQLite schema and storage layer in dsh-memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, sanitizeFtsQuery, SCHEMA_VERSION } from '../schema.js';
import {
  MemoryStorage,
  embeddingToBlob,
  blobToFloat16Array,
} from '../storage.js';

test('FTS5 Query Sanitizer', async (t) => {
  await t.test('handles empty or non-string inputs', () => {
    assert.equal(sanitizeFtsQuery(''), null);
    assert.equal(sanitizeFtsQuery('   '), null);
    assert.equal(sanitizeFtsQuery(null), null);
    assert.equal(sanitizeFtsQuery(undefined), null);
    assert.equal(sanitizeFtsQuery(123), null);
  });

  await t.test('strips dangerous syntax operators without throwing', () => {
    assert.equal(sanitizeFtsQuery('test-123'), '"test" "123"');
    assert.equal(sanitizeFtsQuery('foo:bar'), '"foo" "bar"');
    assert.equal(sanitizeFtsQuery('hello (world) * "quoted"'), '"hello" "world" "quoted"');
  });

  await t.test('supports OR mode and prefix wildcards', () => {
    assert.equal(sanitizeFtsQuery('alpha beta', { mode: 'OR' }), '"alpha" OR "beta"');
    assert.equal(sanitizeFtsQuery('alpha beta', { prefix: true }), '"alpha"* "beta"*');
    assert.equal(sanitizeFtsQuery('alpha beta', { mode: 'OR', prefix: true }), '"alpha"* OR "beta"*');
  });
});

test('Float16 Embedding Helpers', async (t) => {
  await t.test('converts Float16Array, Float32Array, and numbers array to Float16 Buffer', () => {
    const rawNumbers = [0.25, -1.5, 3.0];
    const blobFromNumbers = embeddingToBlob(rawNumbers);
    assert.ok(blobFromNumbers instanceof Buffer);
    assert.equal(blobFromNumbers.length, rawNumbers.length * 2);

    const reconstructed = blobToFloat16Array(blobFromNumbers);
    assert.ok(reconstructed instanceof Float16Array);
    assert.equal(reconstructed.length, 3);
    assert.equal(reconstructed[0], 0.25);
    assert.equal(reconstructed[1], -1.5);
    assert.equal(reconstructed[2], 3.0);
  });

  await t.test('handles null and invalid inputs gracefully', () => {
    assert.equal(embeddingToBlob(null), null);
    assert.equal(embeddingToBlob(undefined), null);
    assert.equal(blobToFloat16Array(null), null);
    assert.equal(blobToFloat16Array('not a buffer'), null);
  });
});

test('Schema Initialization', async (t) => {
  await t.test('initializes schema and records schema_version in meta table', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);

    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.ok(versionRow);
    assert.equal(versionRow.value, String(SCHEMA_VERSION));
  });
});

test('MemoryStorage — Tier 1: Core Memories', async (t) => {
  let storage;

  t.beforeEach(() => {
    storage = new MemoryStorage(':memory:');
  });

  t.afterEach(() => {
    storage.close();
  });

  await t.test('stores and retrieves core memory directives', () => {
    const saved = storage.setCoreMemory({
      namespace: 'campaign-1',
      key: 'dm_tone',
      directive: 'Always maintain a grim, gothic tone.',
      priority: 10,
    });

    assert.ok(saved.id);
    assert.equal(saved.namespace, 'campaign-1');
    assert.equal(saved.key, 'dm_tone');
    assert.equal(saved.directive, 'Always maintain a grim, gothic tone.');
    assert.equal(saved.priority, 10);

    const retrieved = storage.getCoreMemory('campaign-1', 'dm_tone');
    assert.ok(retrieved);
    assert.equal(retrieved.id, saved.id);
    assert.equal(retrieved.directive, saved.directive);

    const byId = storage.getCoreMemoryById(saved.id);
    assert.ok(byId);
    assert.equal(byId.key, 'dm_tone');
  });

  await t.test('upserts on conflict of (namespace, key)', () => {
    storage.setCoreMemory({
      namespace: 'ns1',
      key: 'pref',
      directive: 'Initial directive',
      priority: 1,
    });

    storage.setCoreMemory({
      namespace: 'ns1',
      key: 'pref',
      directive: 'Updated directive',
      priority: 5,
    });

    const current = storage.getCoreMemory('ns1', 'pref');
    assert.equal(current.directive, 'Updated directive');
    assert.equal(current.priority, 5);

    const all = storage.listCoreMemories('ns1');
    assert.equal(all.length, 1);
  });

  await t.test('lists core memories ordered by priority DESC', () => {
    storage.setCoreMemory({ namespace: 'ns1', key: 'low', directive: 'Low prio', priority: 1 });
    storage.setCoreMemory({ namespace: 'ns1', key: 'high', directive: 'High prio', priority: 100 });
    storage.setCoreMemory({ namespace: 'ns1', key: 'med', directive: 'Medium prio', priority: 50 });
    storage.setCoreMemory({ namespace: 'ns2', key: 'other', directive: 'Other ns', priority: 200 });

    const ns1List = storage.listCoreMemories('ns1');
    assert.equal(ns1List.length, 3);
    assert.equal(ns1List[0].key, 'high');
    assert.equal(ns1List[1].key, 'med');
    assert.equal(ns1List[2].key, 'low');

    const globalList = storage.listCoreMemories();
    assert.equal(globalList.length, 4);
  });

  await t.test('deletes core memory by key or ID', () => {
    const mem1 = storage.setCoreMemory({ namespace: 'ns1', key: 'k1', directive: 'd1' });
    const mem2 = storage.setCoreMemory({ namespace: 'ns1', key: 'k2', directive: 'd2' });

    assert.equal(storage.deleteCoreMemory('ns1', 'k1'), true);
    assert.equal(storage.deleteCoreMemory('ns1', 'k1'), false);
    assert.equal(storage.getCoreMemory('ns1', 'k1'), null);

    assert.equal(storage.deleteCoreMemoryById(mem2.id), true);
    assert.equal(storage.deleteCoreMemoryById(mem2.id), false);
    assert.equal(storage.getCoreMemory('ns1', 'k2'), null);
  });

  await t.test('validates inputs', () => {
    assert.throws(() => storage.setCoreMemory({ namespace: '', key: 'k', directive: 'd' }));
    assert.throws(() => storage.setCoreMemory({ namespace: 'ns', key: '', directive: 'd' }));
    assert.throws(() => storage.setCoreMemory({ namespace: 'ns', key: 'k', directive: 123 }));
  });
});

test('MemoryStorage — Tier 2: Episodic Memories & FTS5', async (t) => {
  let storage;

  t.beforeEach(() => {
    storage = new MemoryStorage(':memory:');
  });

  t.afterEach(() => {
    storage.close();
  });

  await t.test('stores and retrieves episodic memories', () => {
    const rawEmb = new Float16Array([0.1, 0.2, -0.3, 0.4]);
    const mem = storage.storeMemory({
      namespace: 'camp-1',
      content: 'The party entered the Sunless Citadel and defeated the kobold sentry.',
      summary: 'Citadel entrance encounter',
      tags: ['citadel', 'kobold', 'combat'],
      status: 'canon',
      turnRef: 'turn-42',
      embedding: rawEmb,
    });

    assert.ok(mem.id);
    assert.equal(mem.namespace, 'camp-1');
    assert.equal(mem.status, 'canon');

    const fetched = storage.getMemory(mem.id);
    assert.ok(fetched);
    assert.equal(fetched.content, mem.content);
    assert.equal(fetched.tags, 'citadel,kobold,combat');

    const restoredEmb = blobToFloat16Array(fetched.embedding);
    assert.equal(restoredEmb.length, 4);
    assert.ok(Math.abs(restoredEmb[0] - 0.1) < 0.001);
  });

  await t.test('validates status constraint', () => {
    assert.throws(() => {
      storage.storeMemory({
        namespace: 'ns',
        content: 'content',
        status: 'invalid_status',
      });
    });
  });

  await t.test('updates memory status', () => {
    const mem = storage.storeMemory({
      namespace: 'ns',
      content: 'Provisional observation',
      status: 'provisional',
    });

    assert.equal(storage.updateMemoryStatus(mem.id, 'canon'), true);
    const updated = storage.getMemory(mem.id);
    assert.equal(updated.status, 'canon');

    assert.equal(storage.updateMemoryStatus('non-existent-id', 'canon'), false);
  });

  await t.test('searches memories using FTS5 and verifies sync triggers', () => {
    const mem1 = storage.storeMemory({
      namespace: 'ns1',
      content: 'The rusty iron key was hidden inside the skull of the minotaur.',
      summary: 'Iron key location',
      tags: ['puzzle', 'dungeon'],
      status: 'canon',
    });

    const mem2 = storage.storeMemory({
      namespace: 'ns1',
      content: 'A golden dragon statue stood in the center of the fountain courtyard.',
      summary: 'Courtyard dragon statue',
      tags: ['courtyard', 'statue'],
      status: 'canon',
    });

    const mem3 = storage.storeMemory({
      namespace: 'ns2',
      content: 'The minotaur roamed the endless labyrinth.',
      summary: 'Labyrinth patrol',
      tags: ['minotaur'],
      status: 'canon',
    });

    // Match on content
    const keyHits = storage.searchMemoriesFTS({ query: 'iron key', namespace: 'ns1' });
    assert.equal(keyHits.length, 1);
    assert.equal(keyHits[0].id, mem1.id);
    assert.ok(keyHits[0].score > 0);

    // Match across namespace with filter
    const minotaurHitsNs1 = storage.searchMemoriesFTS({ query: 'minotaur', namespace: 'ns1' });
    assert.equal(minotaurHitsNs1.length, 1);
    assert.equal(minotaurHitsNs1[0].id, mem1.id);

    const minotaurHitsAll = storage.searchMemoriesFTS({ query: 'minotaur' });
    assert.equal(minotaurHitsAll.length, 2);

    // Test sanitization with special chars
    const specialHits = storage.searchMemoriesFTS({ query: 'iron-key:dungeon' });
    assert.equal(specialHits.length, 1);
    assert.equal(specialHits[0].id, mem1.id);

    // Test trigger on update
    storage.storeMemory({
      id: mem1.id,
      namespace: 'ns1',
      content: 'The silver key was hidden inside the chest.',
      summary: 'Silver key',
      status: 'canon',
    });

    const oldHits = storage.searchMemoriesFTS({ query: 'minotaur', namespace: 'ns1' });
    assert.equal(oldHits.length, 0);

    const newHits = storage.searchMemoriesFTS({ query: 'silver key', namespace: 'ns1' });
    assert.equal(newHits.length, 1);
    assert.equal(newHits[0].id, mem1.id);

    // Test trigger on delete
    storage.deleteMemory(mem1.id);
    const delHits = storage.searchMemoriesFTS({ query: 'silver key', namespace: 'ns1' });
    assert.equal(delHits.length, 0);
  });

  await t.test('retrieves candidates for vector search', () => {
    storage.storeMemory({
      namespace: 'ns1',
      content: 'With vector',
      status: 'canon',
      embedding: [0.1, 0.2],
    });

    storage.storeMemory({
      namespace: 'ns1',
      content: 'No vector',
      status: 'canon',
      embedding: null,
    });

    storage.storeMemory({
      namespace: 'ns1',
      content: 'FTS only',
      status: 'canon',
      ftsOnly: true,
      embedding: [0.1, 0.2],
    });

    storage.storeMemory({
      namespace: 'ns1',
      content: 'Provisional with vector',
      status: 'provisional',
      embedding: [0.3, 0.4],
    });

    const canonCandidates = storage.getMemoryCandidatesForVectorSearch({ namespace: 'ns1', status: 'canon' });
    assert.equal(canonCandidates.length, 1);
    assert.equal(canonCandidates[0].content, 'With vector');

    const allCandidates = storage.getMemoryCandidatesForVectorSearch({ namespace: 'ns1', status: null });
    assert.equal(allCandidates.length, 2);
  });
});

test('MemoryStorage — Tier 4: Reference Corpus Chunks', async (t) => {
  let storage;

  t.beforeEach(() => {
    storage = new MemoryStorage(':memory:');
  });

  t.afterEach(() => {
    storage.close();
  });

  await t.test('stores, retrieves, and bulk stores corpus chunks', () => {
    const chunk1 = {
      collection: 'rules-dnd35',
      sourcePath: 'phb/combat.md',
      chunkIndex: 0,
      title: 'Attacks of Opportunity',
      content: 'An attack of opportunity is a single melee attack you can make when an opponent lowers defense.',
      textRatio: 0.95,
      ftsOnly: false,
      embedding: [0.1, 0.5, 0.9],
    };

    const chunk2 = {
      collection: 'rules-dnd35',
      sourcePath: 'phb/combat.md',
      chunkIndex: 1,
      title: 'Grapple Rules',
      content: 'Grappling means wrestling with a foe. Initiating a grapple provokes an attack of opportunity.',
      textRatio: 0.92,
      ftsOnly: false,
      embedding: [0.2, 0.4, 0.6],
    };

    const storedCount = storage.storeCorpusChunks([chunk1, chunk2]);
    assert.equal(storedCount, 2);

    const list = storage.listCorpusChunks({ collection: 'rules-dnd35' });
    assert.equal(list.length, 2);
    assert.equal(list[0].title, 'Attacks of Opportunity');
    assert.equal(list[1].title, 'Grapple Rules');

    // FTS search on corpus
    const grappleHits = storage.searchCorpusFTS({ query: 'wrestling foe', collection: 'rules-dnd35' });
    assert.equal(grappleHits.length, 1);
    assert.equal(grappleHits[0].title, 'Grapple Rules');

    // Delete entire source file
    const delCount = storage.deleteCorpusSource('rules-dnd35', 'phb/combat.md');
    assert.equal(delCount, 2);

    const afterDel = storage.listCorpusChunks({ collection: 'rules-dnd35' });
    assert.equal(afterDel.length, 0);

    const ftsAfterDel = storage.searchCorpusFTS({ query: 'grappling', collection: 'rules-dnd35' });
    assert.equal(ftsAfterDel.length, 0);
  });
});

test('MemoryStorage — Transactions', async (t) => {
  let storage;

  t.beforeEach(() => {
    storage = new MemoryStorage(':memory:');
  });

  t.afterEach(() => {
    storage.close();
  });

  await t.test('commits successful transaction', () => {
    storage.transaction((s) => {
      s.setCoreMemory({ namespace: 'ns', key: 'k1', directive: 'd1' });
      s.setCoreMemory({ namespace: 'ns', key: 'k2', directive: 'd2' });
    });

    const list = storage.listCoreMemories('ns');
    assert.equal(list.length, 2);
  });

  await t.test('rolls back transaction on error', () => {
    assert.throws(() => {
      storage.transaction((s) => {
        s.setCoreMemory({ namespace: 'ns', key: 'k1', directive: 'd1' });
        throw new Error('Forced failure');
      });
    });

    const list = storage.listCoreMemories('ns');
    assert.equal(list.length, 0);
  });
});
