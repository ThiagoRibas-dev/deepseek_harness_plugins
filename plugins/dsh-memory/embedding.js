/**
 * Dense vector embedding substrate for dsh-memory.
 *
 * Implements:
 * - Text gating (<20% alphabetic letters skips dense vectors)
 * - DigUp task formatting:
 *     Query: "task: search result | query: <text>"
 *     Chunk: "title: <title|none> | text: <text>"
 * - MRL (Matryoshka Representation Learning) truncation to 256-d Float16Array
 * - L2 normalization and mean pooling with attention mask weighting
 * - OnnxRuntime session lifecycle with intraOpNumThreads: 1
 * - Resilient fallback module resolution (via plugins/dsh-tts fallback)
 * - Deterministic embedder for offline/testing scenarios
 *
 * @module @local/dsh-memory/embedding
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { blobToFloat16Array, embeddingToBlob } from './storage.js';

/**
 * The identity a stored vector is tagged with.
 *
 * Network and dimension, deliberately **not** the quantisation file: `q8` and
 * `q4f16` are the same network at different precision, so their vectors occupy
 * the same space and switching between them must not invalidate anything. Two
 * different networks, or the same network at a different dimension, do not.
 *
 * @param {string} modelType
 * @param {number} dimensions
 * @returns {string}
 */
export function embeddingModelId(modelType, dimensions) {
  const type = typeof modelType === 'string' && modelType.length > 0 ? modelType : 'unknown';
  const dim = Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 0;
  return `${type}@${dim}`;
}

/** Default MRL dimension for EmbeddingGemma-2 */
export const DEFAULT_GEMMA_DIM = 256;

/** Default dimension for all-MiniLM-L6-v2 fallback */
export const DEFAULT_MINILM_DIM = 384;

/** Max token limit for EmbeddingGemma-2 context window */
export const GEMMA_MAX_TOKENS = 8192;

/** Max token limit for all-MiniLM-L6-v2 context window */
export const MINILM_MAX_TOKENS = 512;

/** Pinned EmbeddingGemma-2 ONNX model commit */
export const GEMMA_PINNED_COMMIT = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0';

/**
 * Calculate the ratio of alphabetic Unicode characters among non-whitespace characters.
 *
 * @param {string} text
 * @returns {number} Float ratio between 0.0 and 1.0
 */
export function calculateAlphaRatio(text) {
  if (typeof text !== 'string') return 0;
  const nonWs = text.replace(/\s+/g, '');
  if (nonWs.length === 0) return 0;
  const letters = nonWs.match(/\p{L}/gu);
  return letters ? letters.length / nonWs.length : 0;
}

/**
 * Determine whether a text chunk should bypass dense vector generation.
 * Text with < 20% alphabetic characters skips vector embedding and uses FTS-only.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldBypassDenseEmbedding(text) {
  return calculateAlphaRatio(text) < 0.20;
}

/**
 * Format search query with task prefix for dense embedding.
 *
 * @param {string} query
 * @returns {string}
 */
export function formatQuery(query) {
  const clean = String(query ?? '').trim();
  return `task: search result | query: ${clean}`;
}

/**
 * Format document / memory chunk with title and text prefix for dense embedding.
 *
 * @param {string} text
 * @param {string|null} [title]
 * @returns {string}
 */
export function formatDocument(text, title = null) {
  const cleanText = String(text ?? '').trim();
  const cleanTitle = (title && String(title).trim().length > 0) ? String(title).trim() : 'none';
  return `title: ${cleanTitle} | text: ${cleanText}`;
}

/**
 * Normalize a float vector to unit Euclidean (L2) norm in-place or returning a new array.
 *
 * @param {Float32Array|Float64Array|number[]} vector
 * @returns {Float32Array}
 */
export function l2Normalize(vector) {
  const len = vector.length;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const val = vector[i];
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(len);
  if (norm > 1e-12) {
    for (let i = 0; i < len; i++) {
      out[i] = vector[i] / norm;
    }
  } else {
    out.set(vector);
  }
  return out;
}

/**
 * Apply Matryoshka Representation Learning (MRL) truncation to target dimension
 * followed by L2 normalization, returning a Float16Array view.
 *
 * @param {Float32Array|Float64Array|number[]} vector Full embedding vector
 * @param {number} [targetDim=256] Truncation dimension
 * @returns {Float16Array}
 */
export function truncateAndNormalize(vector, targetDim = DEFAULT_GEMMA_DIM) {
  const dim = Math.min(vector.length, targetDim);
  const slice = vector.slice(0, dim);
  const normalized = l2Normalize(slice);
  return new Float16Array(normalized);
}

/**
 * Compute weighted mean pooling over token embeddings using the attention mask.
 *
 * @param {Float32Array|number[]} lastHiddenState Flattened [batch, seq_len, hidden_dim]
 * @param {BigInt64Array|Int32Array|number[]} attentionMask [batch, seq_len]
 * @param {number} seqLen Number of tokens
 * @param {number} hiddenDim Embedding hidden dimension
 * @returns {Float32Array} Pooled embedding vector of length hiddenDim
 */
export function meanPool(lastHiddenState, attentionMask, seqLen, hiddenDim) {
  const pooled = new Float32Array(hiddenDim);
  let maskSum = 0;

  for (let i = 0; i < seqLen; i++) {
    const maskVal = Number(attentionMask[i]);
    if (maskVal > 0) {
      maskSum += maskVal;
      const tokenOffset = i * hiddenDim;
      for (let d = 0; d < hiddenDim; d++) {
        pooled[d] += lastHiddenState[tokenOffset + d] * maskVal;
      }
    }
  }

  const divisor = Math.max(maskSum, 1e-9);
  for (let d = 0; d < hiddenDim; d++) {
    pooled[d] /= divisor;
  }

  return pooled;
}

/**
 * Lazily load onnxruntime-node with multiple fallback resolution strategies.
 * Handles differences between harness plugin loader and standard Node module resolution.
 *
 * @returns {Promise<any>}
 */
export async function loadOrt() {
  // Strategy 1: Direct ESM dynamic import
  try {
    const ns = await import('onnxruntime-node');
    const ort = typeof ns?.InferenceSession === 'function' ? ns : ns?.default;
    if (typeof ort?.InferenceSession === 'function') return ort;
  } catch {
    // Continue to fallback strategies
  }

  // Strategy 2: createRequire from dsh-tts package
  const possibleRoots = [
    new URL('../dsh-tts/package.json', import.meta.url),
    new URL('../../plugins/dsh-tts/package.json', import.meta.url),
    new URL('plugins/dsh-tts/package.json', 'file://' + process.cwd() + '/'),
  ];

  for (const pkgUrl of possibleRoots) {
    try {
      const req = createRequire(pkgUrl);
      const ort = req('onnxruntime-node');
      const resolved = typeof ort?.InferenceSession === 'function' ? ort : ort?.default;
      if (typeof resolved?.InferenceSession === 'function') return resolved;
    } catch {
      // Try next
    }
  }

  throw new Error('Failed to load onnxruntime-node: package not found in current module tree or dsh-tts fallback.');
}

/**
 * Lazily load @huggingface/tokenizers with multiple fallback resolution strategies.
 *
 * @returns {Promise<any>}
 */
export async function loadTokenizer() {
  // Strategy 1: Direct ESM dynamic import
  try {
    const tok = await import('@huggingface/tokenizers');
    if (typeof tok?.Tokenizer === 'function') return tok;
  } catch {
    // Continue to fallback strategies
  }

  // Strategy 2: createRequire from dsh-tts package
  const possibleRoots = [
    new URL('../dsh-tts/package.json', import.meta.url),
    new URL('../../plugins/dsh-tts/package.json', import.meta.url),
    new URL('plugins/dsh-tts/package.json', 'file://' + process.cwd() + '/'),
  ];

  for (const pkgUrl of possibleRoots) {
    try {
      const req = createRequire(pkgUrl);
      const tok = req('@huggingface/tokenizers');
      if (typeof tok?.Tokenizer === 'function') return tok;
    } catch {
      // Try next
    }
  }

  throw new Error('Failed to load @huggingface/tokenizers: package not found in current module tree or dsh-tts fallback.');
}

/**
 * Create a deterministic pseudo-random embedder for offline unit tests and mock environments.
 * Uses SHA-256 hashing of normalized text tokens to produce stable, normalized vectors.
 *
 * Accepts either a bare dimension count or an options object. The service passes
 * `{ dimensions }`, and reading that as a length produced a zero-length vector —
 * an embedder that silently returned nothing and left every dense comparison at
 * zero. Both shapes are honoured here so the two call sites cannot disagree.
 *
 * @param {number|object} [options=256] Dimension count, or `{ dimensions }`
 * @returns {object} Embedder interface matching EmbeddingEngine
 */
export function createDeterministicEmbedder(options = DEFAULT_GEMMA_DIM) {
  const requested = typeof options === 'number' ? options : options?.dimensions;
  const dimensions = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_GEMMA_DIM;
  return {
    dimensions,
    modelType: 'deterministic-mock',
    modelId: embeddingModelId('deterministic-mock', dimensions),
    isInitialized: true,

    async init() {
      return this;
    },

    /**
     * Compute deterministic vector for text.
     *
     * @param {string} text
     * @param {object} [opts]
     * @param {boolean} [opts.isQuery=false]
     * @param {string|null} [opts.title=null]
     * @param {boolean} [opts.bypassGating=false]
     * @returns {Promise<Float16Array|null>}
     */
    async embed(text, { isQuery = false, title = null, bypassGating = false } = {}) {
      if (typeof text !== 'string' || text.trim().length === 0) return null;
      if (!bypassGating && !isQuery && shouldBypassDenseEmbedding(text)) {
        return null;
      }

      const formatted = isQuery ? formatQuery(text) : formatDocument(text, title);
      const tokens = formatted.toLowerCase().split(/\s+/).filter(Boolean);

      const vector = new Float32Array(dimensions);
      for (const token of tokens) {
        const hash = createHash('sha256').update(token).digest();
        for (let i = 0; i < dimensions; i++) {
          // Map hash bytes into signed floats
          const byteVal = hash[i % hash.length];
          const sign = (byteVal & 1) === 1 ? 1 : -1;
          const mag = ((byteVal >> 1) / 128.0);
          vector[i] += sign * mag;
        }
      }

      return truncateAndNormalize(vector, dimensions);
    },

    async embedBatch(items, { isQuery = false, bypassGating = false } = {}) {
      const results = [];
      for (const item of items) {
        if (typeof item === 'string') {
          results.push(await this.embed(item, { isQuery, bypassGating }));
        } else if (item && typeof item === 'object') {
          results.push(await this.embed(item.text || item.content, {
            isQuery,
            title: item.title,
            bypassGating,
          }));
        } else {
          results.push(null);
        }
      }
      return results;
    },
  };
}

/**
 * Dense vector embedding engine.
 * Wraps OnnxRuntime InferenceSession and HuggingFace Tokenizer.
 */
export class EmbeddingEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.modelPath] Path to onnx model file
   * @param {string} [options.tokenizerPath] Path to tokenizer.json
   * @param {string} [options.tokenizerConfigPath] Path to tokenizer_config.json
   * @param {number} [options.dimensions=256] MRL output dimension
   * @param {number} [options.maxTokens=8192] Maximum sequence token length
   * @param {string} [options.modelType='embeddinggemma-2']
   */
  constructor(options = {}) {
    this.modelPath = options.modelPath || null;
    this.tokenizerPath = options.tokenizerPath || null;
    this.tokenizerConfigPath = options.tokenizerConfigPath || null;
    this.dimensions = options.dimensions || DEFAULT_GEMMA_DIM;
    this.maxTokens = options.maxTokens || GEMMA_MAX_TOKENS;
    this.modelType = options.modelType || 'embeddinggemma-2';
    this.modelId = options.modelId || embeddingModelId(this.modelType, this.dimensions);

    this.session = null;
    this.tokenizer = null;
    this.ort = null;
    this.isInitialized = false;
  }

  /**
   * Initialize ONNX session and Tokenizer instance.
   *
   * @returns {Promise<EmbeddingEngine>}
   */
  async init() {
    if (this.isInitialized) return this;

    if (!this.modelPath || !existsSync(this.modelPath)) {
      throw new Error(`Embedding model file not found: ${this.modelPath}`);
    }
    if (!this.tokenizerPath || !existsSync(this.tokenizerPath)) {
      throw new Error(`Tokenizer file not found: ${this.tokenizerPath}`);
    }

    this.ort = await loadOrt();
    const tokenizersModule = await loadTokenizer();
    const { Tokenizer } = tokenizersModule;

    const tokJson = JSON.parse(readFileSync(this.tokenizerPath, 'utf8'));
    const tokCfg = this.tokenizerConfigPath && existsSync(this.tokenizerConfigPath)
      ? JSON.parse(readFileSync(this.tokenizerConfigPath, 'utf8'))
      : {};

    this.tokenizer = new Tokenizer(tokJson, tokCfg);

    // Host hardware: 2-core CPU without AVX-512 VNNI.
    // 1 thread avoids thread scheduling contention and yields highest throughput.
    this.session = await this.ort.InferenceSession.create(this.modelPath, {
      intraOpNumThreads: 1,
    });

    this.isInitialized = true;
    return this;
  }

  /**
   * Embed a single text string.
   *
   * @param {string} text Input text
   * @param {object} [options]
   * @param {boolean} [options.isQuery=false] Whether input is a search query
   * @param {string|null} [options.title=null] Document title
   * @param {boolean} [options.bypassGating=false] Skip alphabetic gating check
   * @returns {Promise<Float16Array|null>} MRL truncated Float16Array or null if gated
   */
  async embed(text, { isQuery = false, title = null, bypassGating = false } = {}) {
    if (!this.isInitialized) {
      await this.init();
    }

    const clean = String(text ?? '').trim();
    if (clean.length === 0) return null;

    // Apply text gating check for non-query inputs
    if (!bypassGating && !isQuery && shouldBypassDenseEmbedding(clean)) {
      return null;
    }

    const formatted = isQuery ? formatQuery(clean) : formatDocument(clean, title);
    const encoded = this.tokenizer.encode(formatted);

    const rawIds = encoded.ids;
    const ids = rawIds.length > this.maxTokens ? rawIds.slice(0, this.maxTokens) : rawIds;
    if (ids.length === 0) return null;

    const seqLen = ids.length;
    const inputIds = BigInt64Array.from(ids, (id) => BigInt(id));
    const attentionMask = BigInt64Array.from(ids, () => 1n);

    const feeds = {
      input_ids: new this.ort.Tensor('int64', inputIds, [1, seqLen]),
      attention_mask: new this.ort.Tensor('int64', attentionMask, [1, seqLen]),
    };

    const outputs = await this.session.run(feeds);

    let pooledVector;
    if (outputs.sentence_embedding) {
      // Direct sentence embedding output if present
      pooledVector = new Float32Array(outputs.sentence_embedding.data);
    } else {
      // Mean pooling over last_hidden_state
      const outputTensor = outputs.last_hidden_state || outputs[this.session.outputNames[0]];
      const hiddenDim = outputTensor.dims[2];
      pooledVector = meanPool(outputTensor.data, attentionMask, seqLen, hiddenDim);
    }

    return truncateAndNormalize(pooledVector, this.dimensions);
  }

  /**
   * Batch embed multiple texts sequentially to avoid memory spikes on low-resource host.
   *
   * @param {Array<string|object>} items
   * @param {object} [options]
   * @returns {Promise<Array<Float16Array|null>>}
   */
  async embedBatch(items, { isQuery = false, bypassGating = false } = {}) {
    const results = [];
    for (const item of items) {
      if (typeof item === 'string') {
        results.push(await this.embed(item, { isQuery, bypassGating }));
      } else if (item && typeof item === 'object') {
        results.push(await this.embed(item.text || item.content, {
          isQuery,
          title: item.title,
          bypassGating,
        }));
      } else {
        results.push(null);
      }
    }
    return results;
  }

  /**
   * Close ONNX session and free resources.
   */
  async close() {
    if (this.session) {
      this.session = null;
    }
    this.tokenizer = null;
    this.isInitialized = false;
  }
}
