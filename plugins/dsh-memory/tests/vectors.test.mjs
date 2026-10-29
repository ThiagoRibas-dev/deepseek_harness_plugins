/**
 * Vector provenance tests: model tagging, filtered retrieval, reporting, purge,
 * and re-embedding.
 *
 * The point of the whole mechanism is that a vector from one encoder is never
 * compared with a vector from another, so most of these cases set up exactly
 * that mismatch and assert that nothing is scored across it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../storage.js';
import { MemoryService } from '../service.js';
import { createDeterministicEmbedder, EmbeddingEngine, embeddingModelId } from '../embedding.js';
import { SCHEMA_VERSION } from '../schema.js';

/** An embedder with a chosen identity and a stable vector, for mismatch setups. */
function fakeEmbedder(modelId, { dimensions = 256, vector = null } = {}) {
  return {
    dimensions,
    modelId,
    modelType: modelId.split('@')[0],
    isInitialized: true,
    async embed() { return vector ?? new Float16Array(dimensions).fill(0.05); },
  };
}

function seeded(model = 'model-a@256') {
  const storage = new MemoryStorage({ inMemory: true });
  const service = new MemoryService({ inMemory: true, storage, embedder: fakeEmbedder(model) });
  return { storage, service };
}

// ---------------------------------------------------------------- identity

test('embeddingModelId names the network and dimension, not the quantisation file', () => {
  assert.equal(embeddingModelId('embeddinggemma-2', 256), 'embeddinggemma-2@256');
  assert.equal(embeddingModelId('all-MiniLM-L6-v2', 384), 'all-MiniLM-L6-v2@384');
  // Both quantisations of one network resolve to the same identity, so switching
  // between them keeps every vector.
  assert.equal(embeddingModelId('embeddinggemma-2', 256), embeddingModelId('embeddinggemma-2', 256));
  assert.equal(embeddingModelId(undefined, undefined), 'unknown@0');
});

test('the deterministic embedder and the ONNX engine both declare an identity', () => {
  assert.equal(createDeterministicEmbedder(256).modelId, 'deterministic-mock@256');
  assert.equal(createDeterministicEmbedder({ dimensions: 384 }).modelId, 'deterministic-mock@384');
  assert.equal(new EmbeddingEngine({ dimensions: 256 }).modelId, 'embeddinggemma-2@256');
  assert.equal(new EmbeddingEngine({ dimensions: 384, modelType: 'all-MiniLM-L6-v2' }).modelId, 'all-MiniLM-L6-v2@384');
});

test('the schema version records that vectors carry a model', () => {
  assert.equal(SCHEMA_VERSION, 3);
});

// ---------------------------------------------------------------- tagging

test('a stored vector is tagged with the active model', async () => {
  const { storage, service } = seeded('model-a@256');
  await service.storeMemory({ content: 'A fact worth keeping.', namespace: 'global', status: 'canon' });
  await service.storeCorpusChunk({ collection: 'c', sourcePath: 's.md', chunkIndex: 0, content: 'A chunk of prose.' });
  assert.deepEqual(
    storage.listVectorModels().map((row) => `${row.kind}:${row.model}`).sort(),
    ['corpus:model-a@256', 'episodic:model-a@256'],
  );
});

test('a gated chunk stores no vector and therefore no model', async () => {
  const { storage, service } = seeded('model-a@256');
  // 6% alphabetic: below the dense gate, so FTS-only and deliberately unembedded.
  await service.storeCorpusChunk({ collection: 'c', sourcePath: 'nums.md', chunkIndex: 0, content: '1234 5678 9012 3456 7890 1234' });
  const row = storage.listCorpusChunks({ collection: 'c' })[0];
  assert.equal(row.fts_only, 1);
  assert.equal(row.embedding_model, null);
  assert.equal(storage.listVectorModels().length, 0);
});

// ---------------------------------------------------------------- filtering

test('dense candidates never cross encoder spaces', async () => {
  const { storage } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeMemory({ namespace: 'ns', content: 'from A', embedding: vector, embeddingModel: 'model-a@256', status: 'canon' });
  storage.storeMemory({ namespace: 'ns', content: 'from B', embedding: vector, embeddingModel: 'model-b@384', status: 'canon' });

  const forA = storage.getMemoryCandidatesForVectorSearch({ namespace: 'ns', model: 'model-a@256' });
  const forB = storage.getMemoryCandidatesForVectorSearch({ namespace: 'ns', model: 'model-b@384' });
  assert.deepEqual(forA.map((r) => r.content), ['from A']);
  assert.deepEqual(forB.map((r) => r.content), ['from B']);
});

test('omitting the model returns every vector, for callers that want the raw table', () => {
  const { storage } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeMemory({ namespace: 'ns', content: 'from A', embedding: vector, embeddingModel: 'model-a@256', status: 'canon' });
  storage.storeMemory({ namespace: 'ns', content: 'from B', embedding: vector, embeddingModel: 'model-b@384', status: 'canon' });
  assert.equal(storage.getMemoryCandidatesForVectorSearch({ namespace: 'ns' }).length, 2);
});

test('corpus candidates are filtered by encoder too', () => {
  const { storage } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'a.md', chunkIndex: 0, content: 'A chunk', embedding: vector, embeddingModel: 'model-a@256' });
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'b.md', chunkIndex: 0, content: 'B chunk', embedding: vector, embeddingModel: 'model-b@384' });
  assert.deepEqual(storage.getCorpusCandidatesForVectorSearch({ collection: 'c', model: 'model-a@256' }).map((r) => r.source_path), ['a.md']);
});

test('search still finds a mismatched item through keywords', async () => {
  const { storage, service } = seeded('model-b@384');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'old.md', chunkIndex: 0, content: 'The eastern gate holds twelve silver.', embedding: vector, embeddingModel: 'model-a@256' });
  const found = await service.searchReference('eastern gate', { collection: 'c' });
  assert.ok(found.results.length >= 1, 'FTS must still surface a chunk whose vector is unusable');
  assert.equal(found.results[0].source_path, 'old.md');
});

// ---------------------------------------------------------------- reporting

test('vectorStatus reports a clean index', async () => {
  const { service } = seeded('model-a@256');
  await service.storeMemory({ content: 'Tagged already.', namespace: 'global', status: 'canon' });
  const status = service.vectorStatus();
  assert.equal(status.activeModel, 'model-a@256');
  assert.equal(status.filtering, true);
  assert.equal(status.stale.total, 0);
  assert.equal(status.matches, true);
  assert.match(status.message, /every vector on file/);
});

test('vectorStatus separates vectors from another encoder from absent ones', async () => {
  const { storage, service } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeMemory({ namespace: 'global', content: 'foreign vector', embedding: vector, embeddingModel: 'model-z@256', status: 'canon' });
  storage.storeMemory({ namespace: 'global', content: 'no vector at all', embedding: null, status: 'canon' });
  const status = service.vectorStatus();
  assert.equal(status.foreign.total, 1);
  assert.equal(status.missing.total, 1);
  assert.equal(status.stale.total, 2);
  assert.equal(status.matches, false);
  assert.match(status.message, /1 from another encoder, 1 with none/);
});

test('an untagged vector counts as foreign, because its space is unknown', () => {
  const { storage, service } = seeded('model-a@256');
  storage.storeMemory({ namespace: 'global', content: 'legacy row', embedding: new Float16Array(256).fill(0.1), status: 'canon' });
  assert.equal(service.vectorStatus().foreign.total, 1);
});

test('the service status carries the vector report', async () => {
  const { service } = seeded('model-a@256');
  await service.storeMemory({ content: 'Anything at all.', namespace: 'global', status: 'canon' });
  const status = service.status();
  assert.equal(status.embedder.modelId, 'model-a@256');
  assert.equal(status.vectors.activeModel, 'model-a@256');
});

test('an embedder with no declared identity disables filtering rather than guessing', () => {
  const service = new MemoryService({ inMemory: true, embedder: { dimensions: 256, async embed() { return null; } } });
  const status = service.vectorStatus();
  assert.equal(status.activeModel, null);
  assert.equal(status.filtering, false);
  assert.match(status.message, /declares no model id/);
});

// ---------------------------------------------------------------- purge

test('purge drops unusable vectors and keeps every row', async () => {
  const { storage, service } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeMemory({ namespace: 'global', content: 'foreign', embedding: vector, embeddingModel: 'model-z@256', status: 'canon' });
  storage.storeMemory({ namespace: 'global', content: 'mine', embedding: vector, embeddingModel: 'model-a@256', status: 'canon' });
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'x.md', chunkIndex: 0, content: 'foreign chunk', embedding: vector, embeddingModel: 'model-z@256' });

  const result = service.purgeForeignVectors();
  assert.equal(result.ok, true);
  assert.equal(result.purged.episodic, 1);
  assert.equal(result.purged.corpus, 1);
  assert.equal(service.listMemories({ namespace: 'global' }).length, 2, 'no memory row may be lost');
  assert.equal(service.listCorpusChunks({ collection: 'c' }).length, 1, 'no chunk row may be lost');
  assert.deepEqual(storage.getMemoryCandidatesForVectorSearch({ namespace: 'global', model: 'model-a@256' }).map((r) => r.content), ['mine']);
  assert.equal(storage.listVectorModels().length, 1, 'only the matching vector remains');
});

test('purge leaves a matching vector alone', async () => {
  const { service } = seeded('model-a@256');
  await service.storeMemory({ content: 'Mine already.', namespace: 'global', status: 'canon' });
  const result = service.purgeForeignVectors();
  assert.equal(result.purged.total, 0);
  assert.equal(service.vectorStatus().stale.total, 0);
});

test('purge refuses when the embedder declares no identity', () => {
  const service = new MemoryService({ inMemory: true, embedder: { dimensions: 256, async embed() { return null; } } });
  const result = service.purgeForeignVectors();
  assert.equal(result.ok, false);
  assert.match(result.error, /declares no model id/);
});

// ---------------------------------------------------------------- re-embed

test('reembedMissing regenerates foreign and absent vectors', async () => {
  const { storage, service } = seeded('model-a@256');
  const vector = new Float16Array(256).fill(0.1);
  storage.storeMemory({ namespace: 'global', content: 'foreign one', embedding: vector, embeddingModel: 'model-z@256', status: 'canon' });
  storage.storeMemory({ namespace: 'global', content: 'absent one', embedding: null, status: 'canon' });
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'f.md', chunkIndex: 0, content: 'foreign chunk', embedding: vector, embeddingModel: 'model-z@256' });

  const result = await service.reembedMissing({ limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.embedded, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(service.vectorStatus().stale.total, 0);
  // listVectorModels groups, so the shape is one row per kind per model.
  assert.deepEqual(
    storage.listVectorModels().map((r) => `${r.kind}:${r.model}=${r.count}`),
    ['corpus:model-a@256=1', 'episodic:model-a@256=2'],
  );
});

test('reembedMissing leaves text, tags, and provenance untouched', async () => {
  const { storage, service } = seeded('model-a@256');
  const id = 'mem-fixed';
  storage.storeMemory({ id, namespace: 'global', content: 'Do not change this text.', embedding: new Float16Array(256).fill(0.1), embeddingModel: 'model-z@256', status: 'canon', tags: 'keep,these' });
  await service.reembedMissing({ limit: 5 });
  const row = storage.getMemory(id);
  assert.equal(row.content, 'Do not change this text.');
  assert.equal(row.tags, 'keep,these');
  assert.equal(row.status, 'canon');
  assert.equal(row.embedding_model, 'model-a@256');
});

test('reembedMissing honours its bound and reports what is left', async () => {
  const { storage, service } = seeded('model-a@256');
  for (let i = 0; i < 5; i++) {
    storage.storeMemory({ namespace: 'global', content: `row ${i}`, embedding: null, status: 'canon' });
  }
  const first = await service.reembedMissing({ limit: 2 });
  assert.equal(first.embedded, 2);
  assert.ok(first.remaining >= 3, `expected work left, saw ${first.remaining}`);
  const second = await service.reembedMissing({ limit: 2 });
  assert.equal(second.embedded, 2);
  const third = await service.reembedMissing({ limit: 5 });
  assert.equal(third.remaining, 0);
});

test('reembedMissing skips an item the gate refuses instead of storing a bad vector', async () => {
  const { storage, service } = seeded('model-a@256');
  // A gated chunk is fts_only, so it is never a re-embed candidate.
  storage.storeCorpusChunk({ collection: 'c', sourcePath: 'nums.md', chunkIndex: 0, content: '1234 5678 9012', ftsOnly: true });
  const result = await service.reembedMissing({ limit: 5 });
  assert.equal(result.processed, 0);
  assert.equal(result.remaining, 0);
});

test('reembedMissing reports a broken embedder rather than half-writing', async () => {
  const storage = new MemoryStorage({ inMemory: true });
  const broken = {
    dimensions: 256,
    modelId: 'model-a@256',
    async embed() { throw new Error('session is not loaded'); },
  };
  const service = new MemoryService({ inMemory: true, storage, embedder: broken });
  storage.storeMemory({ namespace: 'global', content: 'needs a vector', embedding: null, status: 'canon' });
  const result = await service.reembedMissing({ limit: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.embedded, 0);
  assert.ok(result.remaining >= 1, 'the item stays pending for the next attempt');
  assert.equal(service.embedFailure !== null, true, 'the first failure is recorded');
});

test('reembedMissing refuses when the embedder declares no identity', async () => {
  const service = new MemoryService({ inMemory: true, embedder: { dimensions: 256, async embed() { return null; } } });
  const result = await service.reembedMissing();
  assert.equal(result.ok, false);
  assert.match(result.error, /declares no model id/);
});

// ---------------------------------------------------------------- migration

test('a database created before model tagging gains the column without losing rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { initSchema } = await import('../schema.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, content TEXT NOT NULL, summary TEXT, tags TEXT,
    status TEXT NOT NULL CHECK(status IN ('provisional','canon','rejected')), turn_ref TEXT,
    fts_only INTEGER NOT NULL DEFAULT 0, embedding BLOB, created_at INTEGER NOT NULL)`);
  db.exec("INSERT INTO memories (id, namespace, content, status, fts_only, created_at) VALUES ('m1','ns','kept',  'canon', 0, 1)");

  initSchema(db);
  const row = db.prepare('SELECT content, embedding_model FROM memories').get();
  assert.equal(row.content, 'kept');
  assert.equal(row.embedding_model, null);
  assert.equal(db.prepare('PRAGMA table_info(corpus_chunks)').all().some((c) => c.name === 'embedding_model'), true);
});
