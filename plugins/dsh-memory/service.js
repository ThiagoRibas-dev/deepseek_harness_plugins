/**
 * Profile-Global Memory Service for dsh-memory.
 *
 * Core service layer combining:
 * - Tier 1: Core memories management and static prompt section rendering
 * - Tier 2 & 3: Episodic memories storage, vector candidate extraction, and FTS5 search
 * - Tier 3 & 4: Corpus chunks storage and documentation retrieval
 * - DigUp z-score hybrid ranking engine fusing dense vectors, BM25/FTS5, and token coverage
 * - Dense vector embedding generation with text ratio gating and MRL 256-d truncation
 *
 * @module @local/dsh-memory/service
 */

import { MemoryStorage, defaultStoragePath } from './storage.js';
import { CoreMemoryManager } from './core.js';
import { createDeterministicEmbedder, shouldBypassDenseEmbedding } from './embedding.js';
import { rankCandidates, DEFAULT_TYPE_BONUSES } from './ranking.js';

/** Default max results for hybrid search */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Maximum upper bound for search limit to prevent transcript bloat */
export const MAX_SEARCH_LIMIT = 20;

/**
 * Service managing profile-global hybrid memory and retrieval.
 */
export class MemoryService {
  /**
   * @param {object} [options]
   * @param {MemoryStorage} [options.storage] Existing storage instance
   * @param {string} [options.storagePath] Path to memory.db
   * @param {object} [options.storageOptions] Options for MemoryStorage constructor
   * @param {CoreMemoryManager} [options.core] Existing core manager instance
   * @param {object} [options.embedder] Dense vector embedder or EmbeddingEngine
   * @param {string} [options.defaultNamespace='global'] Default memory namespace
   * @param {object} [options.rankingOptions] Default options for rankCandidates
   */
  constructor(options = {}) {
    this.options = options;
    this.defaultNamespace = options.defaultNamespace || 'global';

    // 1. Storage layer
    if (options.storage instanceof MemoryStorage) {
      this.storage = options.storage;
    } else {
      const dbPath = options.storagePath || (options.inMemory ? ':memory:' : defaultStoragePath());
      this.storage = new MemoryStorage(dbPath, {
        inMemory: options.inMemory || false,
        ...options.storageOptions,
      });
    }

    // 2. Core memory manager
    this.core = options.core instanceof CoreMemoryManager
      ? options.core
      : new CoreMemoryManager(this.storage, {
          defaultNamespace: this.defaultNamespace,
          ...options.coreOptions,
        });

    // 3. Dense vector embedder
    this.embedder = options.embedder
      || options.embeddingEngine
      || createDeterministicEmbedder({ dimensions: options.dimensions || 256 });

    // 4. Ranking options
    this.rankingOptions = {
      typeBonuses: DEFAULT_TYPE_BONUSES,
      ...options.rankingOptions,
    };

    // Embedding is best-effort: a chunk without a vector is still findable by
    // FTS5. Swallowing the failure entirely made a broken model look like a
    // working one, so the first failure is reported once through this logger.
    this.logger = options.logger ?? null;
    this.embedFailure = null;
  }

  /**
   * Record an embedding failure, out loud the first time only.
   *
   * A thousand identical warnings bury the one that mattered; the first is the
   * one that explains the rest.
   *
   * @param {string} where
   * @param {unknown} error
   * @private
   */
  _noteEmbedFailure(where, error) {
    if (this.embedFailure !== null) return;
    this.embedFailure = `${where}: ${error?.message ?? error}`;
    this.logger?.warn?.(`memory: embedding failed (${this.embedFailure}); storing without a vector, retrieval falls back to FTS5`);
  }

  /**
   * The identity the active encoder stamps on the vectors it produces.
   *
   * @returns {string|null} null when the embedder does not declare one, in which
   *   case vectors are stored untagged and retrieval does not filter by model.
   */
  activeModel() {
    const declared = this.embedder?.modelId;
    if (typeof declared === 'string' && declared.length > 0) return declared;
    return null;
  }

  // =========================================================================
  // Tier 1: Core Memories
  // =========================================================================

  /**
   * List core memories for a namespace.
   *
   * @param {string} [namespace]
   * @param {number} [limit=100]
   * @returns {Array<object>}
   */
  listCoreMemories(namespace = this.defaultNamespace, limit = 100) {
    const all = this.core.list(namespace);
    return all.slice(0, Math.max(1, limit));
  }

  /**
   * Get all core memories for a namespace.
   *
   * @param {string} [namespace]
   * @returns {Array<object>}
   */
  getCoreMemories(namespace = this.defaultNamespace) {
    return this.core.list(namespace);
  }

  /**
   * Get a single core memory by key.
   *
   * @param {string} key
   * @param {string} [namespace]
   * @returns {object|null}
   */
  getCoreMemory(key, namespace = this.defaultNamespace) {
    return this.core.get(key, namespace);
  }

  /**
   * Get a core memory by its unique ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getCoreMemoryById(id) {
    return this.core.getById(id);
  }

  /**
   * Set or update a core memory directive.
   *
   * @param {object|string} keyOrEntry
   * @param {string} [directive]
   * @param {number} [priority]
   * @param {string} [namespace]
   * @returns {object}
   */
  setCoreMemory(keyOrEntry, directive, priority, namespace) {
    return this.core.set(keyOrEntry, directive, priority, namespace);
  }

  /**
   * Delete a core memory by key.
   *
   * @param {string} key
   * @param {string} [namespace]
   * @returns {boolean}
   */
  deleteCoreMemory(key, namespace = this.defaultNamespace) {
    return this.core.delete(key, namespace);
  }

  /**
   * Delete a core memory by its unique ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteCoreMemoryById(id) {
    return this.core.deleteById(id);
  }

  /**
   * Render deterministic XML prompt section for core memories.
   *
   * @param {string} [namespace]
   * @returns {string}
   */
  formatCorePromptSection(namespace = this.defaultNamespace) {
    return this.core.formatSection(namespace);
  }

  // =========================================================================
  // Tier 2 & 3: Episodic Memories
  // =========================================================================

  /**
   * Store an episodic memory, generating dense vector embedding if not bypassed.
   *
   * @param {object} entry
   * @param {string} entry.content Memory content / fact (required)
   * @param {string} [entry.summary] Short summary
   * @param {Array<string>|string} [entry.tags] Categorization tags
   * @param {string} [entry.namespace='global']
   * @param {string} [entry.status='canon'] 'canon' | 'provisional'
   * @param {string} [entry.turnRef] Associated turn identifier
   * @param {Float16Array|Float32Array|Buffer|null} [entry.embedding] Precomputed embedding
   * @param {string} [entry.id] Explicit UUID (optional)
   * @returns {Promise<object>} Stored memory record
   */
  async storeMemory(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('storeMemory requires an entry object');
    }
    const { content, summary, tags, namespace = this.defaultNamespace, status = 'canon', turnRef, id } = entry;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('content is required and must be a non-empty string');
    }

    let embedding = entry.embedding || null;
    if (!embedding && this.embedder) {
      try {
        embedding = await this.embedder.embed(content, {
          isQuery: false,
          title: summary || null,
        });
      } catch (error) {
        this._noteEmbedFailure('storeMemory', error);
        embedding = null;
      }
    }

    const inserted = this.storage.storeMemory({
      id,
      namespace,
      content: content.trim(),
      summary: summary ? summary.trim() : null,
      tags: Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : null),
      status,
      turnRef: turnRef || null,
      embedding,
      embeddingModel: embedding === null ? null : this.activeModel(),
    });

    return inserted;
  }

  /**
   * Convenience alias for storeMemory.
   */
  async store(entry) {
    return this.storeMemory(entry);
  }

  /**
   * Get an episodic memory by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getMemory(id) {
    return this.storage.getMemory(id);
  }

  /**
   * Update an episodic memory status (canon, provisional, rejected).
   *
   * @param {string} id
   * @param {string} status
   * @returns {boolean}
   */
  updateMemoryStatus(id, status) {
    return this.storage.updateMemoryStatus(id, status);
  }

  /**
   * Delete an episodic memory by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteMemory(id) {
    return this.storage.deleteMemory(id);
  }

  /**
   * List episodic memories with pagination.
   *
   * @param {object} [opts]
   * @param {string} [opts.namespace]
   * @param {string} [opts.status]
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @returns {Array<object>}
   */
  listMemories(opts = {}) {
    return this.storage.listMemories({
      namespace: opts.namespace !== undefined ? opts.namespace : this.defaultNamespace,
      status: opts.status,
      limit: opts.limit,
      offset: opts.offset,
    });
  }

  // =========================================================================
  // Tier 3 & 4: Corpus Knowledge Chunks
  // =========================================================================

  /**
   * Store or update a corpus knowledge chunk.
   *
   * @param {object} chunk
   * @param {string} chunk.collection Collection identifier (e.g. 'docs', 'rules')
   * @param {string} chunk.sourcePath Source file path
   * @param {number} [chunk.chunkIndex=0]
   * @param {string} [chunk.title] Chunk or document title
   * @param {string} chunk.content Text content of the chunk
   * @param {number} [chunk.textRatio] Precalculated alphabetic ratio
   * @param {boolean} [chunk.ftsOnly] Force FTS-only
   * @param {Float16Array|Float32Array|Buffer|null} [chunk.embedding]
   * @param {string} [chunk.id]
   * @returns {Promise<object>}
   */
  async storeCorpusChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') {
      throw new Error('storeCorpusChunk requires a chunk object');
    }
    const { collection, sourcePath, chunkIndex = 0, title, content, id } = chunk;
    if (!collection || typeof collection !== 'string') {
      throw new Error('collection is required');
    }
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('sourcePath is required');
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('content is required and must be a non-empty string');
    }

    const trimmedContent = content.trim();
    const ftsOnly = chunk.ftsOnly !== undefined
      ? Boolean(chunk.ftsOnly)
      : shouldBypassDenseEmbedding(trimmedContent);

    let embedding = chunk.embedding || null;
    if (!embedding && !ftsOnly && this.embedder) {
      try {
        embedding = await this.embedder.embed(trimmedContent, {
          isQuery: false,
          title: title || null,
        });
      } catch (error) {
        this._noteEmbedFailure('storeCorpusChunk', error);
        embedding = null;
      }
    }

    const stored = this.storage.storeCorpusChunk({
      id,
      collection,
      sourcePath,
      chunkIndex,
      title: title || null,
      content: trimmedContent,
      textRatio: chunk.textRatio,
      ftsOnly,
      embedding,
      embeddingModel: embedding === null ? null : this.activeModel(),
    });

    return stored;
  }

  /**
   * Get a corpus chunk by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getCorpusChunk(id) {
    return this.storage.getCorpusChunk(id);
  }

  /**
   * Delete a corpus chunk by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteCorpusChunk(id) {
    return this.storage.deleteCorpusChunk(id);
  }

  /**
   * Delete all chunks for a source document in a collection.
   *
   * @param {string} collection
   * @param {string} sourcePath
   * @returns {number}
   */
  deleteCorpusSource(collection, sourcePath) {
    return this.storage.deleteCorpusSource(collection, sourcePath);
  }

  /**
   * List corpus chunks.
   *
   * @param {object} [opts]
   * @returns {Array<object>}
   */
  listCorpusChunks(opts = {}) {
    return this.storage.listCorpusChunks(opts);
  }

  /**
   * Read the ingestion record for one source.
   *
   * @param {string} collection
   * @param {string} sourcePath
   * @returns {object|null}
   */
  getCorpusSource(collection, sourcePath) {
    return this.storage.getCorpusSource(collection, sourcePath);
  }

  /**
   * Record that a source was ingested, with the hash of the content indexed.
   *
   * @param {object} entry
   * @returns {object}
   */
  upsertCorpusSource(entry) {
    return this.storage.upsertCorpusSource(entry);
  }

  /**
   * List ingested sources.
   *
   * @param {object} [opts]
   * @returns {Array<object>}
   */
  listCorpusSources(opts = {}) {
    return this.storage.listCorpusSources(opts);
  }

  // =========================================================================
  // Hybrid Search & DigUp Retrieval Engine
  // =========================================================================

  /**
   * Unified hybrid search across memory tiers using DigUp z-score ranking.
   *
   * @param {string} query Search query string
   * @param {object} [options]
   * @param {string} [options.namespace] Namespace for episodic/core memories
   * @param {number} [options.limit=5] Maximum hits to return (capped at 20)
   * @param {string} [options.mode='hybrid'] 'hybrid' | 'fts' | 'vector'
   * @param {boolean} [options.includeCore=true] Include core memories
   * @param {boolean} [options.includeEpisodic=true] Include episodic memories
   * @param {boolean} [options.includeCorpus=true] Include corpus knowledge chunks
   * @param {string} [options.collection] Optional collection filter for corpus
   * @param {string} [options.status='canon'] Filter for episodic memory status
   * @param {number} [options.minScore] Optional minimum composite score threshold
   * @returns {Promise<{ query: string, total: number, results: Array<object> }>}
   */
  async search(query, options = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { query: String(query || ''), total: 0, results: [] };
    }

    const cleanQuery = query.trim();
    const {
      namespace = this.defaultNamespace,
      limit = DEFAULT_SEARCH_LIMIT,
      mode = 'hybrid',
      includeCore = true,
      includeEpisodic = true,
      includeCorpus = true,
      collection = null,
      status = 'canon',
      minScore = null,
    } = options;

    const boundedLimit = Math.min(Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    // 1. Calculate query embedding if not pure FTS
    let queryEmbedding = null;
    if (mode !== 'fts' && this.embedder) {
      try {
        queryEmbedding = await this.embedder.embed(cleanQuery, { isQuery: true });
      } catch {
        queryEmbedding = null;
      }
    }

    // 2. Candidate collection across requested tiers
    const candidateMap = new Map();

    // Tier 1: Core memories
    if (includeCore) {
      try {
        const cores = this.core.list(namespace);
        for (const c of cores) {
          candidateMap.set(`core:${c.id}`, {
            id: c.id,
            type: 'core',
            namespace: c.namespace,
            key: c.key,
            directive: c.directive,
            title: c.key,
            content: c.directive,
            priority: c.priority,
            // Carried so the recall block can date a core directive the same way it
            // dates a conversation memory.
            updated_at: c.updated_at,
            embedding: null, // Core memories rely on lexical coverage + 0.5 type bonus
          });
        }
      } catch {
        // Continue on core retrieval error
      }
    }

    // Tier 2 & 3: Episodic memories
    if (includeEpisodic) {
      try {
        // A. FTS candidates
        const ftsMatches = this.storage.searchMemoriesFTS({
          query: cleanQuery,
          namespace,
          status,
          limit: boundedLimit * 5,
        });
        for (const m of ftsMatches) {
          candidateMap.set(`mem:${m.id}`, {
            ...m,
            type: 'episodic',
          });
        }

        // B. Vector candidates
        if (mode !== 'fts' && queryEmbedding) {
          const vectorCandidates = this.storage.getMemoryCandidatesForVectorSearch({
            namespace,
            status,
            model: this.activeModel(),
            limit: 200,
          });
          for (const vc of vectorCandidates) {
            const key = `mem:${vc.id}`;
            if (!candidateMap.has(key)) {
              candidateMap.set(key, {
                ...vc,
                type: 'episodic',
              });
            }
          }
        }
      } catch {
        // Continue on episodic retrieval error
      }
    }

    // Tier 3 & 4: Corpus chunks
    if (includeCorpus) {
      try {
        // A. FTS candidates
        const corpusFts = this.storage.searchCorpusFTS({
          query: cleanQuery,
          collection: collection || undefined,
          limit: boundedLimit * 5,
        });
        for (const c of corpusFts) {
          candidateMap.set(`corp:${c.id}`, {
            ...c,
            type: 'corpus',
            source_path: c.source_path,
          });
        }

        // B. Vector candidates
        if (mode !== 'fts' && queryEmbedding) {
          const corpusVectors = this.storage.getCorpusCandidatesForVectorSearch({
            collection: collection || undefined,
            model: this.activeModel(),
            limit: 200,
          });
          for (const cv of corpusVectors) {
            const key = `corp:${cv.id}`;
            if (!candidateMap.has(key)) {
              candidateMap.set(key, {
                ...cv,
                type: 'corpus',
                source_path: cv.source_path,
              });
            }
          }
        }
      } catch {
        // Continue on corpus retrieval error
      }
    }

    const allCandidates = Array.from(candidateMap.values());
    if (allCandidates.length === 0) {
      return { query: cleanQuery, total: 0, results: [] };
    }

    // 3. Rank candidates using DigUp z-score hybrid ranking
    const ranked = rankCandidates(cleanQuery, allCandidates, {
      queryEmbedding,
      limit: boundedLimit,
      typeBonuses: this.rankingOptions.typeBonuses || DEFAULT_TYPE_BONUSES,
      ...this.rankingOptions,
    });

    // 4. Optional score thresholding
    let filtered = ranked;
    if (typeof minScore === 'number' && Number.isFinite(minScore)) {
      filtered = ranked.filter((item) => item.score >= minScore);
    }

    // 5. Strip large BLOB embeddings from response to ensure clean transcripts
    const cleanResults = filtered.map((item) => {
      const sanitized = { ...item };
      delete sanitized.embedding;
      return sanitized;
    });

    return {
      query: cleanQuery,
      total: cleanResults.length,
      results: cleanResults,
    };
  }

  /**
   * Search episodic and core memories only.
   *
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<{ query: string, total: number, results: Array<object> }>}
   */
  async searchMemories(query, options = {}) {
    return this.search(query, {
      ...options,
      includeCorpus: false,
    });
  }

  /**
   * Search reference documentation and corpus chunks only.
   *
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<{ query: string, total: number, results: Array<object> }>}
   */
  async searchReference(query, options = {}) {
    return this.search(query, {
      ...options,
      includeCore: false,
      includeEpisodic: false,
      includeCorpus: true,
    });
  }

  // =========================================================================
  // Vector provenance: report, re-embed, purge
  // =========================================================================

  /**
   * What the vector store holds, and how much of it this encoder can use.
   *
   * Reported, never acted on: re-embedding a corpus is minutes of CPU on this
   * class of host, so the decision belongs to whoever is paying for it.
   *
   * @param {object} [options]
   * @param {number} [options.limit=500] Cap on the sample of items needing work
   * @returns {object}
   */
  vectorStatus({ limit = 500 } = {}) {
    const active = this.activeModel();
    const byModel = this.storage.listVectorModels();
    if (active === null) {
      return { activeModel: null, filtering: false, byModel, stale: { episodic: 0, corpus: 0, total: 0 }, message: 'the active embedder declares no model id, so vectors are stored untagged and no filtering is applied' };
    }
    const pending = this.storage.findUnembedded(active, { limit: 1 });
    // Foreign and absent are different problems with different remedies: a
    // foreign vector can be purged to reclaim space, an absent one can only be
    // regenerated. Reporting them as one number would offer the wrong button.
    const foreign = this.storage.countForeignVectors(active);
    const stale = { episodic: pending.episodic, corpus: pending.corpus, total: pending.total };
    const missing = {
      episodic: Math.max(0, stale.episodic - foreign.episodic),
      corpus: Math.max(0, stale.corpus - foreign.corpus),
      total: Math.max(0, stale.total - foreign.total),
    };
    return {
      activeModel: active,
      filtering: true,
      byModel,
      foreign,
      missing,
      stale,
      matches: stale.total === 0,
      message: stale.total === 0
        ? 'every vector on file was produced by the active encoder'
        : `${stale.total} item(s) have no vector from ${active} (${foreign.total} from another encoder, ${missing.total} with none); dense retrieval skips them and FTS still finds them`,
      sample: this.storage.findUnembedded(active, { limit }).total,
    };
  }

  /**
   * Re-embed items whose vector the active encoder cannot use.
   *
   * Bounded by `limit` so one call is a step, not a marathon; the caller repeats
   * until `remaining` reaches zero. Text is never touched — only the vector and
   * its tag are replaced.
   *
   * @param {object} [options]
   * @param {number} [options.limit=200] Items to process in this call
   * @param {number} [options.batchLog] Unused; present for callers that pass it
   * @returns {Promise<object>}
   */
  async reembedMissing({ limit = 200 } = {}) {
    const active = this.activeModel();
    if (active === null) return { ok: false, error: 'the active embedder declares no model id' };
    if (!this.embedder) return { ok: false, error: 'no embedder is configured' };
    const bounded = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const pending = this.storage.findUnembedded(active, { limit: bounded });

    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    // Episodic first: there are usually far fewer, and a failure there is the
    // one worth learning about before spending minutes on the corpus.
    for (const memory of pending.memories) {
      try {
        const vector = await this.embedder.embed(memory.content, { isQuery: false, title: memory.summary ?? null });
        if (vector === null) { skipped += 1; continue; }
        if (this.storage.setEmbedding('episodic', memory.id, vector, active)) embedded += 1;
      } catch (error) {
        failed += 1;
        this._noteEmbedFailure('reembed:episodic', error);
      }
    }
    for (const chunk of pending.chunks) {
      try {
        const vector = await this.embedder.embed(chunk.content, { isQuery: false, title: chunk.title ?? null });
        if (vector === null) { skipped += 1; continue; }
        if (this.storage.setEmbedding('corpus', chunk.id, vector, active)) embedded += 1;
      } catch (error) {
        failed += 1;
        this._noteEmbedFailure('reembed:corpus', error);
      }
    }

    const after = this.storage.findUnembedded(active, { limit: 1 });
    return {
      ok: failed === 0,
      activeModel: active,
      processed: pending.memories.length + pending.chunks.length,
      embedded,
      skipped,
      failed,
      remaining: after.total,
    };
  }

  /**
   * Drop vectors the active encoder cannot use, keeping every row's text.
   *
   * @returns {object}
   */
  purgeForeignVectors() {
    const active = this.activeModel();
    if (active === null) return { ok: false, error: 'the active embedder declares no model id' };
    const purged = this.storage.purgeForeignVectors(active);
    return { ok: true, activeModel: active, purged, remaining: this.storage.findUnembedded(active, { limit: 1 }).total };
  }

  // =========================================================================
  // Status & Introspection
  // =======================================================================

  /**
   * Report health status, row counts, and embedder information.
   *
   * @returns {object}
   */
  status() {
    let coreCount = 0;
    let memoryCount = 0;
    let corpusCount = 0;

    try {
      const coreRow = this.storage.db.prepare('SELECT COUNT(*) AS count FROM core_memories').get();
      coreCount = coreRow?.count ?? 0;
      const memRow = this.storage.db.prepare('SELECT COUNT(*) AS count FROM memories').get();
      memoryCount = memRow?.count ?? 0;
      const corpRow = this.storage.db.prepare('SELECT COUNT(*) AS count FROM corpus_chunks').get();
      corpusCount = corpRow?.count ?? 0;
    } catch {
      // Ignore counting failure
    }

    return {
      status: 'ready',
      storagePath: this.storage.path,
      defaultNamespace: this.defaultNamespace,
      counts: {
        coreMemories: coreCount,
        memories: memoryCount,
        corpusChunks: corpusCount,
      },
      embedder: {
        dimensions: this.embedder?.dimensions || 256,
        modelType: this.embedder?.modelType || 'unknown',
        modelId: this.activeModel(),
        isInitialized: Boolean(this.embedder?.isInitialized),
      },
      vectors: this.vectorStatus(),
    };
  }

  /**
   * Close storage and release resources.
   */
  close() {
    try {
      this.storage.close();
    } catch {
      // Best-effort close
    }
  }
}
