/**
 * SQLite Storage Layer for dsh-memory.
 *
 * Provides typed CRUD operations, transactions, FTS5 BM25 search,
 * and vector candidate extraction using Node.js built-in node:sqlite.
 *
 * @module @local/dsh-memory/storage
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { initSchema, sanitizeFtsQuery } from './schema.js';

/**
 * Default database path within the user's active DSH profile.
 *
 * @returns {string}
 */
export function defaultStoragePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'storages', 'memory.db');
}

/**
 * Convert arbitrary embedding array or buffer into a Float16 Buffer for SQLite BLOB storage.
 *
 * @param {Float16Array|Float32Array|number[]|Uint8Array|Buffer|null} embedding
 * @returns {Buffer|null}
 */
export function embeddingToBlob(embedding) {
  if (!embedding) return null;
  if (Buffer.isBuffer(embedding)) return embedding;
  if (embedding instanceof Float16Array) {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }
  if (embedding instanceof Float32Array || Array.isArray(embedding)) {
    const f16 = new Float16Array(embedding);
    return Buffer.from(f16.buffer, f16.byteOffset, f16.byteLength);
  }
  if (embedding instanceof Uint8Array) {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }
  return null;
}

/**
 * Reconstruct a Float16Array view from a stored SQLite BLOB Uint8Array.
 *
 * @param {Uint8Array|Buffer|null} blob
 * @returns {Float16Array|null}
 */
export function blobToFloat16Array(blob) {
  if (!blob || !(blob instanceof Uint8Array)) return null;
  return new Float16Array(blob.buffer, blob.byteOffset, blob.byteLength / 2);
}

/**
 * Core storage manager for profile-global memory.
 */
export class MemoryStorage {
  /**
   * @param {string|import('node:sqlite').DatabaseSync} [dbOrPath] Path or existing DatabaseSync
   * @param {object} [options]
   * @param {boolean} [options.inMemory=false] Force in-memory database
   */
  constructor(dbOrPath = defaultStoragePath(), options = {}) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath === ':memory:' || options.inMemory) {
        this.path = ':memory:';
        this.db = new DatabaseSync(':memory:');
      } else {
        this.path = dbOrPath;
        mkdirSync(dirname(this.path), { recursive: true });
        this.db = new DatabaseSync(this.path);
      }
    } else if (dbOrPath && typeof dbOrPath === 'object' && dbOrPath.inMemory) {
      this.path = ':memory:';
      this.db = new DatabaseSync(':memory:');
    } else {
      this.db = dbOrPath;
      this.path = options.path || ':memory:';
    }

    initSchema(this.db);
    this._prepareStatements();
  }

  /**
   * Prepare statement caches for recurring operations.
   * @private
   */
  _prepareStatements() {
    // Tier 1: Core memories
    this._stmtUpsertCore = this.db.prepare(`
      INSERT INTO core_memories (id, namespace, key, directive, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        id = excluded.id,
        directive = excluded.directive,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `);

    this._stmtGetCore = this.db.prepare(`
      SELECT id, namespace, key, directive, priority, updated_at
      FROM core_memories
      WHERE namespace = ? AND key = ?
    `);

    this._stmtGetCoreById = this.db.prepare(`
      SELECT id, namespace, key, directive, priority, updated_at
      FROM core_memories
      WHERE id = ?
    `);

    this._stmtListCoreByNs = this.db.prepare(`
      SELECT id, namespace, key, directive, priority, updated_at
      FROM core_memories
      WHERE namespace = ?
      ORDER BY priority DESC, updated_at DESC
    `);

    this._stmtListAllCore = this.db.prepare(`
      SELECT id, namespace, key, directive, priority, updated_at
      FROM core_memories
      ORDER BY namespace ASC, priority DESC, updated_at DESC
    `);

    this._stmtDeleteCore = this.db.prepare(`
      DELETE FROM core_memories
      WHERE namespace = ? AND key = ?
    `);

    this._stmtDeleteCoreById = this.db.prepare(`
      DELETE FROM core_memories
      WHERE id = ?
    `);

    // Tier 2: Episodic memories
    this._stmtUpsertMemory = this.db.prepare(`
      INSERT INTO memories (id, namespace, content, summary, tags, status, turn_ref, fts_only, embedding, embedding_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        namespace = excluded.namespace,
        content = excluded.content,
        summary = excluded.summary,
        tags = excluded.tags,
        status = excluded.status,
        turn_ref = excluded.turn_ref,
        fts_only = excluded.fts_only,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        created_at = excluded.created_at
    `);

    this._stmtGetMemory = this.db.prepare(`
      SELECT id, namespace, content, summary, tags, status, turn_ref, fts_only, embedding, embedding_model, created_at
      FROM memories
      WHERE id = ?
    `);

    this._stmtUpdateMemoryStatus = this.db.prepare(`
      UPDATE memories
      SET status = ?
      WHERE id = ?
    `);

    this._stmtDeleteMemory = this.db.prepare(`
      DELETE FROM memories
      WHERE id = ?
    `);

    // Tier 4: Corpus chunks
    this._stmtUpsertCorpusChunk = this.db.prepare(`
      INSERT INTO corpus_chunks (id, collection, source_path, chunk_index, title, content, text_ratio, fts_only, embedding, embedding_model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, source_path, chunk_index) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        content = excluded.content,
        text_ratio = excluded.text_ratio,
        fts_only = excluded.fts_only,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        updated_at = excluded.updated_at
    `);

    this._stmtGetCorpusChunk = this.db.prepare(`
      SELECT id, collection, source_path, chunk_index, title, content, text_ratio, fts_only, embedding, embedding_model, updated_at
      FROM corpus_chunks
      WHERE id = ?
    `);

    this._stmtDeleteCorpusChunk = this.db.prepare(`
      DELETE FROM corpus_chunks
      WHERE id = ?
    `);

    this._stmtDeleteCorpusSource = this.db.prepare(`
      DELETE FROM corpus_chunks
      WHERE collection = ? AND source_path = ?
    `);

    // Ingestion registry
    this._stmtUpsertCorpusSource = this.db.prepare(`
      INSERT INTO corpus_sources (collection, source_path, title, origin, namespace, content_hash, bytes, chunk_count, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, source_path) DO UPDATE SET
        title = excluded.title,
        origin = excluded.origin,
        namespace = excluded.namespace,
        content_hash = excluded.content_hash,
        bytes = excluded.bytes,
        chunk_count = excluded.chunk_count,
        ingested_at = excluded.ingested_at
    `);

    this._stmtGetCorpusSource = this.db.prepare(`
      SELECT collection, source_path, title, origin, namespace, content_hash, bytes, chunk_count, ingested_at
      FROM corpus_sources
      WHERE collection = ? AND source_path = ?
    `);

    this._stmtDeleteCorpusSourceRow = this.db.prepare(`
      DELETE FROM corpus_sources
      WHERE collection = ? AND source_path = ?
    `);
  }

  // ==========================================
  // Tier 1: Core Memories
  // ==========================================

  /**
   * Insert or update a Core Memory directive.
   *
   * @param {object} param
   * @param {string} [param.id]
   * @param {string} param.namespace
   * @param {string} param.key
   * @param {string} param.directive
   * @param {number} [param.priority=0]
   * @param {number} [param.updatedAt]
   * @returns {object}
   */
  setCoreMemory({ id, namespace, key, directive, priority = 0, updatedAt }) {
    if (!namespace || typeof namespace !== 'string') {
      throw new Error('setCoreMemory: namespace must be a non-empty string');
    }
    if (!key || typeof key !== 'string') {
      throw new Error('setCoreMemory: key must be a non-empty string');
    }
    if (typeof directive !== 'string') {
      throw new Error('setCoreMemory: directive must be a string');
    }

    const recordId = id || randomUUID();
    const ts = Number.isInteger(updatedAt) ? updatedAt : Date.now();
    const prio = Number.isInteger(priority) ? priority : 0;

    this._stmtUpsertCore.run(recordId, namespace, key, directive, prio, ts);
    return {
      id: recordId,
      namespace,
      key,
      directive,
      priority: prio,
      updated_at: ts,
    };
  }

  /**
   * Retrieve a Core Memory by namespace and key.
   *
   * @param {string} namespace
   * @param {string} key
   * @returns {object|null}
   */
  getCoreMemory(namespace, key) {
    const row = this._stmtGetCore.get(namespace, key);
    return row || null;
  }

  /**
   * Retrieve a Core Memory by its stable UUID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getCoreMemoryById(id) {
    const row = this._stmtGetCoreById.get(id);
    return row || null;
  }

  /**
   * List Core Memories, optionally filtered by namespace.
   *
   * @param {string} [namespace]
   * @returns {object[]}
   */
  listCoreMemories(namespace) {
    if (namespace) {
      return this._stmtListCoreByNs.all(namespace);
    }
    return this._stmtListAllCore.all();
  }

  /**
   * Delete a Core Memory by namespace and key.
   *
   * @param {string} namespace
   * @param {string} key
   * @returns {boolean} True if deleted, false if not found
   */
  deleteCoreMemory(namespace, key) {
    const res = this._stmtDeleteCore.run(namespace, key);
    return res.changes > 0;
  }

  /**
   * Delete a Core Memory by ID.
   *
   * @param {string} id
   * @returns {boolean} True if deleted, false if not found
   */
  deleteCoreMemoryById(id) {
    const res = this._stmtDeleteCoreById.run(id);
    return res.changes > 0;
  }

  // ==========================================
  // Tier 2: Episodic Memories
  // ==========================================

  /**
   * Store or update an episodic memory.
   *
   * @param {object} param
   * @param {string} [param.id]
   * @param {string} param.namespace
   * @param {string} param.content
   * @param {string} [param.summary]
   * @param {string|string[]} [param.tags]
   * @param {'provisional'|'canon'|'rejected'} [param.status='provisional']
   * @param {string} [param.turnRef]
   * @param {boolean} [param.ftsOnly=false]
   * @param {Float16Array|Float32Array|number[]|Uint8Array|Buffer|null} [param.embedding]
   * @param {number} [param.createdAt]
   * @returns {object}
   */
  storeMemory({
    id,
    namespace,
    content,
    summary = null,
    tags = null,
    status = 'provisional',
    turnRef = null,
    ftsOnly = false,
    embedding = null,
    embeddingModel = null,
    createdAt,
  }) {
    if (!namespace || typeof namespace !== 'string') {
      throw new Error('storeMemory: namespace must be a non-empty string');
    }
    if (!content || typeof content !== 'string') {
      throw new Error('storeMemory: content must be a non-empty string');
    }
    if (!['provisional', 'canon', 'rejected'].includes(status)) {
      throw new Error(`storeMemory: invalid status "${status}"`);
    }

    const recordId = id || randomUUID();
    const tagString = Array.isArray(tags) ? tags.join(',') : (typeof tags === 'string' ? tags : null);
    const ts = Number.isInteger(createdAt) ? createdAt : Date.now();
    const embBlob = embeddingToBlob(embedding);
    const ftsFlag = ftsOnly ? 1 : 0;

    this._stmtUpsertMemory.run(
      recordId,
      namespace,
      content,
      summary,
      tagString,
      status,
      turnRef,
      ftsFlag,
      embBlob,
      embBlob === null ? null : embeddingModel,
      ts
    );

    return {
      id: recordId,
      namespace,
      content,
      summary,
      tags: tagString,
      status,
      turn_ref: turnRef,
      fts_only: ftsFlag,
      embedding: embBlob,
      embedding_model: embBlob === null ? null : embeddingModel,
      created_at: ts,
    };
  }

  /**
   * Retrieve an episodic memory by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getMemory(id) {
    const row = this._stmtGetMemory.get(id);
    return row || null;
  }

  /**
   * Update status of an episodic memory ('provisional', 'canon', 'rejected').
   *
   * @param {string} id
   * @param {'provisional'|'canon'|'rejected'} status
   * @returns {boolean}
   */
  updateMemoryStatus(id, status) {
    if (!['provisional', 'canon', 'rejected'].includes(status)) {
      throw new Error(`updateMemoryStatus: invalid status "${status}"`);
    }
    const res = this._stmtUpdateMemoryStatus.run(status, id);
    return res.changes > 0;
  }

  /**
   * Delete an episodic memory by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteMemory(id) {
    const res = this._stmtDeleteMemory.run(id);
    return res.changes > 0;
  }

  /**
   * List episodic memories with optional filters and pagination.
   *
   * @param {object} [params]
   * @param {string} [params.namespace]
   * @param {'provisional'|'canon'|'rejected'} [params.status]
   * @param {number} [params.limit=50]
   * @param {number} [params.offset=0]
   * @returns {object[]}
   */
  listMemories({ namespace, status, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];

    if (namespace) {
      clauses.push('namespace = ?');
      params.push(namespace);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT id, namespace, content, summary, tags, status, turn_ref, fts_only, created_at
      FROM memories
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(Math.max(1, limit), Math.max(0, offset));

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Search episodic memories using FTS5 BM25 keyword ranking.
   *
   * @param {object} params
   * @param {string} params.query User query text
   * @param {string} [params.namespace] Filter by namespace
   * @param {'provisional'|'canon'|'rejected'} [params.status] Filter by status
   * @param {number} [params.limit=10]
   * @param {'AND'|'OR'} [params.mode='AND'] Match mode
   * @param {boolean} [params.prefix=false] Enable prefix wildcard matching
   * @returns {object[]} Results ordered by BM25 relevance (descending score)
   */
  searchMemoriesFTS({ query, namespace, status, limit = 10, mode = 'AND', prefix = false } = {}) {
    const sanitized = sanitizeFtsQuery(query, { mode, prefix });
    if (!sanitized) return [];

    const clauses = ['memories_fts MATCH ?'];
    const params = [sanitized];

    if (namespace) {
      clauses.push('m.namespace = ?');
      params.push(namespace);
    }
    if (status) {
      clauses.push('m.status = ?');
      params.push(status);
    }

    const sql = `
      SELECT m.id, m.namespace, m.content, m.summary, m.tags, m.status, m.turn_ref, m.created_at,
             bm25(memories_fts, 5.0, 3.0, 2.0) AS rank
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank ASC
      LIMIT ?
    `;
    params.push(Math.max(1, limit));

    try {
      const rows = this.db.prepare(sql).all(...params);
      return rows.map(r => ({
        id: r.id,
        namespace: r.namespace,
        content: r.content,
        summary: r.summary,
        tags: r.tags,
        status: r.status,
        turn_ref: r.turn_ref,
        created_at: r.created_at,
        bm25_rank: r.rank,
        score: -r.rank,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Retrieve memory records that have embeddings for vector similarity comparison.
   *
   * @param {object} [params]
   * @param {string} [params.namespace]
   * @param {string} [params.status='canon']
   * @param {number} [params.limit=1000]
   * @returns {object[]}
   */
  getMemoryCandidatesForVectorSearch({ namespace, status = 'canon', model, limit = 1000 } = {}) {
    const clauses = ['embedding IS NOT NULL', 'fts_only = 0'];
    const params = [];

    if (namespace) {
      clauses.push('namespace = ?');
      params.push(namespace);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    // Vectors from another encoder are not comparable with this query's vector,
    // so they are left out of the dense leg entirely rather than scored badly.
    if (model) {
      clauses.push('embedding_model = ?');
      params.push(model);
    }

    const sql = `
      SELECT id, namespace, content, summary, tags, status, turn_ref, embedding, created_at
      FROM memories
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(Math.max(1, limit));

    return this.db.prepare(sql).all(...params);
  }

  // ==========================================
  // Tier 4: Reference Corpus Chunks
  // ==========================================

  /**
   * Store or update a reference corpus chunk.
   *
   * @param {object} param
   * @param {string} [param.id]
   * @param {string} param.collection
   * @param {string} param.sourcePath
   * @param {number} param.chunkIndex
   * @param {string} [param.title]
   * @param {string} param.content
   * @param {number} [param.textRatio=1.0]
   * @param {boolean} [param.ftsOnly=false]
   * @param {Float16Array|Float32Array|number[]|Uint8Array|Buffer|null} [param.embedding]
   * @param {number} [param.updatedAt]
   * @returns {object}
   */
  storeCorpusChunk({
    id,
    collection,
    sourcePath,
    chunkIndex,
    title = null,
    content,
    textRatio = 1.0,
    ftsOnly = false,
    embedding = null,
    embeddingModel = null,
    updatedAt,
  }) {
    if (!collection || typeof collection !== 'string') {
      throw new Error('storeCorpusChunk: collection must be a non-empty string');
    }
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('storeCorpusChunk: sourcePath must be a non-empty string');
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error('storeCorpusChunk: chunkIndex must be a non-negative integer');
    }
    if (!content || typeof content !== 'string') {
      throw new Error('storeCorpusChunk: content must be a non-empty string');
    }

    const recordId = id || randomUUID();
    const ratio = typeof textRatio === 'number' ? textRatio : 1.0;
    const ftsFlag = ftsOnly ? 1 : 0;
    const embBlob = embeddingToBlob(embedding);
    const ts = Number.isInteger(updatedAt) ? updatedAt : Date.now();

    this._stmtUpsertCorpusChunk.run(
      recordId,
      collection,
      sourcePath,
      chunkIndex,
      title,
      content,
      ratio,
      ftsFlag,
      embBlob,
      embBlob === null ? null : embeddingModel,
      ts
    );

    return {
      id: recordId,
      collection,
      source_path: sourcePath,
      chunk_index: chunkIndex,
      title,
      content,
      text_ratio: ratio,
      fts_only: ftsFlag,
      embedding: embBlob,
      embedding_model: embBlob === null ? null : embeddingModel,
      updated_at: ts,
    };
  }

  /**
   * Bulk store corpus chunks in a single transaction.
   *
   * @param {object[]} chunks
   * @returns {number} Count of inserted/updated chunks
   */
  storeCorpusChunks(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return 0;
    return this.transaction(() => {
      let count = 0;
      for (const ch of chunks) {
        this.storeCorpusChunk(ch);
        count++;
      }
      return count;
    });
  }

  /**
   * Retrieve a corpus chunk by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getCorpusChunk(id) {
    const row = this._stmtGetCorpusChunk.get(id);
    return row || null;
  }

  /**
   * Delete all chunks associated with a specific source path in a collection.
   *
   * The ingestion registry row goes with them: a source with no chunks must not
   * keep a hash that would make the next run skip it.
   *
   * @param {string} collection
   * @param {string} sourcePath
   * @returns {number} Count of deleted chunks
   */
  deleteCorpusSource(collection, sourcePath) {
    const res = this._stmtDeleteCorpusSource.run(collection, sourcePath);
    this._stmtDeleteCorpusSourceRow.run(collection, sourcePath);
    return res.changes;
  }

  /**
   * Read the ingestion record for one source.
   *
   * @param {string} collection
   * @param {string} sourcePath
   * @returns {object|null}
   */
  getCorpusSource(collection, sourcePath) {
    const row = this._stmtGetCorpusSource.get(collection, sourcePath);
    return row || null;
  }

  /**
   * Record that a source was ingested, with the hash of the content indexed.
   *
   * @param {object} param
   * @param {string} param.collection
   * @param {string} param.sourcePath
   * @param {string} [param.title]
   * @param {string} [param.origin='workspace'] One of workspace | session | transcript | upload
   * @param {string} [param.namespace]
   * @param {string} param.contentHash
   * @param {number} [param.bytes=0]
   * @param {number} [param.chunkCount=0]
   * @param {number} [param.ingestedAt]
   * @returns {object}
   */
  upsertCorpusSource({
    collection,
    sourcePath,
    title = null,
    origin = 'workspace',
    namespace = null,
    contentHash,
    bytes = 0,
    chunkCount = 0,
    ingestedAt,
  }) {
    if (!collection || typeof collection !== 'string') {
      throw new Error('upsertCorpusSource: collection must be a non-empty string');
    }
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('upsertCorpusSource: sourcePath must be a non-empty string');
    }
    if (!contentHash || typeof contentHash !== 'string') {
      throw new Error('upsertCorpusSource: contentHash must be a non-empty string');
    }
    const ts = Number.isInteger(ingestedAt) ? ingestedAt : Date.now();
    this._stmtUpsertCorpusSource.run(collection, sourcePath, title, origin, namespace, contentHash, bytes, chunkCount, ts);
    return { collection, sourcePath, title, origin, namespace, content_hash: contentHash, bytes, chunk_count: chunkCount, ingested_at: ts };
  }

  /**
   * Forget one source without touching its chunks.
   *
   * @param {string} collection
   * @param {string} sourcePath
   * @returns {boolean}
   */
  deleteCorpusSourceRecord(collection, sourcePath) {
    const res = this._stmtDeleteCorpusSourceRow.run(collection, sourcePath);
    return res.changes > 0;
  }

  /**
   * List ingested sources, newest first.
   *
   * @param {object} [params]
   * @param {string} [params.collection]
   * @param {string} [params.origin]
   * @param {string} [params.namespace]
   * @param {number} [params.limit=100]
   * @param {number} [params.offset=0]
   * @returns {object[]}
   */
  listCorpusSources({ collection, origin, namespace, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (collection) { clauses.push('collection = ?'); params.push(collection); }
    if (origin) { clauses.push('origin = ?'); params.push(origin); }
    if (namespace) { clauses.push('namespace = ?'); params.push(namespace); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, limit), Math.max(0, offset));
    return this.db.prepare(`
      SELECT collection, source_path, title, origin, namespace, content_hash, bytes, chunk_count, ingested_at
      FROM corpus_sources
      ${where}
      ORDER BY ingested_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);
  }

  /**
   * Delete a single corpus chunk by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteCorpusChunk(id) {
    const res = this._stmtDeleteCorpusChunk.run(id);
    return res.changes > 0;
  }

  /**
   * List corpus chunks with optional filters and pagination.
   *
   * @param {object} [params]
   * @param {string} [params.collection]
   * @param {string} [params.sourcePath]
   * @param {number} [params.limit=100]
   * @param {number} [params.offset=0]
   * @returns {object[]}
   */
  listCorpusChunks({ collection, sourcePath, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];

    if (collection) {
      clauses.push('collection = ?');
      params.push(collection);
    }
    if (sourcePath) {
      clauses.push('source_path = ?');
      params.push(sourcePath);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT id, collection, source_path, chunk_index, title, content, text_ratio, fts_only, embedding_model, updated_at
      FROM corpus_chunks
      ${where}
      ORDER BY collection ASC, source_path ASC, chunk_index ASC
      LIMIT ? OFFSET ?
    `;
    params.push(Math.max(1, limit), Math.max(0, offset));

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Search reference corpus chunks using FTS5 BM25 keyword ranking.
   *
   * @param {object} params
   * @param {string} params.query User query text
   * @param {string} [params.collection] Filter by collection
   * @param {number} [params.limit=10]
   * @param {'AND'|'OR'} [params.mode='AND'] Match mode
   * @param {boolean} [params.prefix=false] Enable prefix wildcard matching
   * @returns {object[]} Results ordered by BM25 relevance (descending score)
   */
  searchCorpusFTS({ query, collection, limit = 10, mode = 'AND', prefix = false } = {}) {
    const sanitized = sanitizeFtsQuery(query, { mode, prefix });
    if (!sanitized) return [];

    const clauses = ['corpus_fts MATCH ?'];
    const params = [sanitized];

    if (collection) {
      clauses.push('c.collection = ?');
      params.push(collection);
    }

    const sql = `
      SELECT c.id, c.collection, c.source_path, c.chunk_index, c.title, c.content, c.text_ratio, c.fts_only, c.updated_at,
             bm25(corpus_fts, 5.0, 2.0) AS rank
      FROM corpus_fts f
      JOIN corpus_chunks c ON f.rowid = c.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank ASC
      LIMIT ?
    `;
    params.push(Math.max(1, limit));

    try {
      const rows = this.db.prepare(sql).all(...params);
      return rows.map(r => ({
        id: r.id,
        collection: r.collection,
        source_path: r.source_path,
        chunk_index: r.chunk_index,
        title: r.title,
        content: r.content,
        text_ratio: r.text_ratio,
        fts_only: r.fts_only,
        updated_at: r.updated_at,
        bm25_rank: r.rank,
        score: -r.rank,
      }));
    } catch {
      return [];
    }
  }

  // ==========================================
  // Vector provenance: model tagging, purge, re-embed support
  // ==========================================

  /**
   * Which encoders produced the vectors on file, and how many each owns.
   *
   * A row with a vector but no model is counted under `(untagged)`: it predates
   * the column and its space is unknown, which is exactly what the caller needs
   * to know when deciding whether to re-embed.
   *
   * @returns {Array<{ model: string, kind: string, count: number }>}
   */
  listVectorModels() {
    return this.db.prepare(`
      SELECT COALESCE(embedding_model, '(untagged)') AS model, 'episodic' AS kind, COUNT(*) AS count
      FROM memories
      WHERE embedding IS NOT NULL
      GROUP BY embedding_model
      UNION ALL
      SELECT COALESCE(embedding_model, '(untagged)') AS model, 'corpus' AS kind, COUNT(*) AS count
      FROM corpus_chunks
      WHERE embedding IS NOT NULL
      GROUP BY embedding_model
      ORDER BY kind, model
    `).all();
  }

  /**
   * How many vectors were produced by something other than `model`.
   *
   * @param {string} model
   * @returns {{ episodic: number, corpus: number, total: number }}
   */
  countForeignVectors(model) {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_model <> ?)) AS episodic,
        (SELECT COUNT(*) FROM corpus_chunks WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_model <> ?)) AS corpus
    `).get(model, model);
    return { episodic: row.episodic, corpus: row.corpus, total: row.episodic + row.corpus };
  }

  /**
   * Drop vectors this encoder cannot use, keeping their text.
   *
   * The row survives and FTS5 still finds it; only the incomparable vector goes.
   * That is the cheap, safe end of the choice — reclaiming space without paying
   * for an embedding pass.
   *
   * @param {string} model The active model; anything else is purged
   * @returns {{ episodic: number, corpus: number, total: number }}
   */
  purgeForeignVectors(model) {
    const episodic = this.db.prepare(
      'UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_model <> ?)',
    ).run(model).changes;
    const corpus = this.db.prepare(
      'UPDATE corpus_chunks SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_model <> ?)',
    ).run(model).changes;
    return { episodic, corpus, total: episodic + corpus };
  }

  /**
   * Items whose text has no vector this encoder can use.
   *
   * Re-embedding is the expensive end of the choice, so the caller needs to know
   * what it is buying before it starts.
   *
   * @param {string} model
   * @param {object} [options]
   * @param {number} [options.limit=500] Bounded, so one call cannot run away
   * @returns {{ episodic: number, corpus: number, total: number, memories: object[], chunks: object[] }}
   */
  findUnembedded(model, { limit = 500 } = {}) {
    const bounded = Math.max(1, limit);
    const memories = this.db.prepare(`
      SELECT id, namespace, content, summary
      FROM memories
      WHERE fts_only = 0 AND content IS NOT NULL AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model <> ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(model, bounded);
    const chunks = this.db.prepare(`
      SELECT id, collection, source_path, chunk_index, title, content
      FROM corpus_chunks
      WHERE fts_only = 0 AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model <> ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(model, bounded);
    const counts = this.countForeignVectors(model);
    const missing = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memories WHERE fts_only = 0 AND embedding IS NULL) AS episodic,
        (SELECT COUNT(*) FROM corpus_chunks WHERE fts_only = 0 AND embedding IS NULL) AS corpus
    `).get();
    return {
      episodic: counts.episodic + missing.episodic,
      corpus: counts.corpus + missing.corpus,
      total: counts.total + missing.episodic + missing.corpus,
      memories,
      chunks,
    };
  }

  /**
   * Attach a vector to an existing row, without touching its text.
   *
   * @param {'episodic'|'corpus'} kind
   * @param {string} id
   * @param {Float16Array|Float32Array|Buffer|null} embedding
   * @param {string} model
   * @returns {boolean}
   */
  setEmbedding(kind, id, embedding, model) {
    const blob = embeddingToBlob(embedding);
    const table = kind === 'episodic' ? 'memories' : 'corpus_chunks';
    const res = this.db.prepare(`UPDATE ${table} SET embedding = ?, embedding_model = ? WHERE id = ?`).run(blob, blob === null ? null : model, id);
    return res.changes > 0;
  }

  /**
   * Retrieve corpus chunks that have embeddings for vector similarity search.
   *
   * @param {object} [params]
   * @param {string} [params.collection]
   * @param {number} [params.limit=1000]
   * @returns {object[]}
   */
  getCorpusCandidatesForVectorSearch({ collection, model, limit = 1000 } = {}) {
    const clauses = ['fts_only = 0', 'embedding IS NOT NULL'];
    const params = [];

    if (collection) {
      clauses.push('collection = ?');
      params.push(collection);
    }
    if (model) {
      clauses.push('embedding_model = ?');
      params.push(model);
    }

    const sql = `
      SELECT id, collection, source_path, chunk_index, title, content, text_ratio, embedding, updated_at
      FROM corpus_chunks
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    params.push(Math.max(1, limit));

    return this.db.prepare(sql).all(...params);
  }

  // ==========================================
  // Transactions & Lifecycle
  // ==========================================

  /**
   * Execute callback within an immediate SQLite transaction.
   *
   * @template T
   * @param {(storage: MemoryStorage) => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn(this);
      this.db.exec('COMMIT;');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Rollback failure is ignored if connection already aborting
      }
      throw err;
    }
  }

  /**
   * Close database connection and release resources.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
