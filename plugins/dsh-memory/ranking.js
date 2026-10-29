/**
 * DigUp z-Score Hybrid Ranking Engine for dsh-memory.
 *
 * Implements:
 * - Cosine similarity between Float16Array / BLOB vectors
 * - Adaptive candidate distribution calibration (z-score normalization: z = (s - μ) / σ)
 * - Query tokenization and lexical coverage calculation
 * - Identifier-heavy query detection (camelCase, snake_case, paths, hashes, versions)
 * - Candidate admission gate: admitted if z >= 2.0 OR coverage >= 0.50
 * - DigUp fusion scoring:
 *     General: Score = max(z, 0) + 2.0 * coverage^1.5 + type_bonus
 *     Identifier-heavy: Score_ID = 0.5 * max(z, 0) + 4.0 * coverage^1.5 + type_bonus
 * - Source deduplication for corpus chunks (max 1 hit per source_path)
 *
 * @module @local/dsh-memory/ranking
 */

import { blobToFloat16Array } from './storage.js';

/** Default type bonuses for multi-tier memory items */
export const DEFAULT_TYPE_BONUSES = {
  core: 0.5,
  core_memory: 0.5,
  episodic: 0.2,
  memory: 0.2,
  corpus: 0.0,
  corpus_chunk: 0.0,
};

/** Minimum z-score to pass candidate gate on dense similarity */
export const DEFAULT_MIN_Z = 2.0;

/** Minimum lexical coverage to pass candidate gate on lexical overlap */
export const DEFAULT_MIN_COVERAGE = 0.50;

/**
 * Compute cosine similarity between two float vectors.
 * Accepts Float16Array, Float32Array, number[], or Buffer/Uint8Array blobs.
 *
 * @param {Float16Array|Float32Array|Uint8Array|Buffer|number[]|null} vecA
 * @param {Float16Array|Float32Array|Uint8Array|Buffer|number[]|null} vecB
 * @returns {number} Cosine similarity between -1.0 and 1.0 (or 0.0 on error/zero norm)
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;

  const a = (vecA instanceof Uint8Array && !(vecA instanceof Float16Array) && !(vecA instanceof Float32Array))
    ? blobToFloat16Array(vecA)
    : vecA;
  const b = (vecB instanceof Uint8Array && !(vecB instanceof Float16Array) && !(vecB instanceof Float32Array))
    ? blobToFloat16Array(vecB)
    : vecB;

  if (!a || !b) return 0;

  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const valA = a[i];
    const valB = b[i];
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA <= 1e-12 || normB <= 1e-12) return 0;

  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Compute z-score normalization across a distribution of candidate similarity scores:
 * z = (s - μ) / σ
 *
 * @param {number[]} similarities
 * @returns {number[]} Array of z-scores matching input length
 */
export function computeZScores(similarities) {
  const n = similarities.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += similarities[i];
  }
  const mean = sum / n;

  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const diff = similarities[i] - mean;
    sumSqDiff += diff * diff;
  }
  const std = Math.sqrt(sumSqDiff / n);

  // If distribution is flat / zero variance, return 0 for all candidates
  if (std < 1e-7) {
    return similarities.map(() => 0);
  }

  return similarities.map((s) => (s - mean) / std);
}

/**
 * Extract normalized search terms from a query for lexical coverage checking.
 *
 * @param {string} query
 * @returns {string[]} Array of distinct lowercase tokens
 */
export function tokenizeQuery(query) {
  if (typeof query !== 'string') return [];
  const matches = query.toLowerCase().match(/[\p{L}\p{N}_$@.-]+/gu) || [];
  const unique = new Set();
  for (const m of matches) {
    // Exclude single special characters or whitespace
    const clean = m.replace(/^[.-]+|[.-]+$/g, '');
    if (clean.length >= 2) {
      unique.add(clean);
    }
  }
  return Array.from(unique);
}

/**
 * Detect whether a search query is identifier-heavy.
 * Identifier queries contain camelCase, snake_case, kebab-case, paths, hashes,
 * dots, or mixed alphanumeric codes where exact lexical match takes precedence.
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isIdentifierQuery(query) {
  if (typeof query !== 'string' || query.trim().length === 0) return false;

  const text = query.trim();

  // Pattern 1: camelCase or PascalCase (e.g., InferenceSession, getEpisodicCandidates)
  if (/[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(text)) return true;

  // Pattern 2: snake_case or kebab-case identifiers (e.g., corpus_chunks, dsh-memory)
  if (/[a-zA-Z0-9]+[_-][a-zA-Z0-9]+/.test(text)) return true;

  // Pattern 3: Dotted property or method access (e.g., ctx.memory, fs.promises)
  if (/[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+/.test(text)) return true;

  // Pattern 4: File paths or URLs (e.g., plugins/dsh-memory, /root/.dsh)
  if (/[\/\\][a-zA-Z0-9_.-]+/.test(text)) return true;

  // Pattern 5: Alphanumerics mixing digits and letters (e.g., v1alpha, FTS5, sha256)
  if (/\b(?=[a-zA-Z]*\d)(?=\d*[a-zA-Z])[a-zA-Z0-9]+\b/.test(text)) return true;

  // Pattern 6: Hexadecimal hashes or UUIDs (e.g., daa72c51, 1939ad2a8e41)
  if (/\b[0-9a-fA-F]{8,}\b/.test(text)) return true;

  // Pattern 7: Environment variables or Cordis service prefixes (e.g., $DSH_HOME, @local/dsh)
  if (/[$@][a-zA-Z0-9_/-]+/.test(text)) return true;

  return false;
}

/**
 * Compute the fraction of query terms covered in the candidate text.
 *
 * @param {string[]|string} queryTokens Token list or raw query
 * @param {string} candidateText Document or memory text
 * @returns {number} Coverage ratio between 0.0 and 1.0
 */
export function computeTokenCoverage(queryTokens, candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return 0;
  const tokens = Array.isArray(queryTokens) ? queryTokens : tokenizeQuery(queryTokens);
  if (tokens.length === 0) return 0;

  const target = candidateText.toLowerCase();
  let matched = 0;

  for (const token of tokens) {
    if (target.includes(token)) {
      matched++;
    }
  }

  return matched / tokens.length;
}

/**
 * Check whether a candidate passes the adaptive DigUp candidate gate.
 * Admitted if z-score >= minZ OR coverage >= minCoverage.
 *
 * @param {object} params
 * @param {number} params.zScore
 * @param {number} params.coverage
 * @param {number} [params.minZ=2.0]
 * @param {number} [params.minCoverage=0.50]
 * @returns {boolean}
 */
export function isCandidateAdmitted({
  zScore,
  coverage,
  minZ = DEFAULT_MIN_Z,
  minCoverage = DEFAULT_MIN_COVERAGE,
}) {
  return zScore >= minZ || coverage >= minCoverage;
}

/**
 * Calculate the DigUp composite fusion score.
 *
 * General query:
 *   Score = max(z, 0) + 2.0 * (coverage)^1.5 + type_bonus
 *
 * Identifier-heavy query:
 *   Score_ID = 0.5 * max(z, 0) + 4.0 * (coverage)^1.5 + type_bonus
 *
 * @param {object} params
 * @param {number} params.zScore
 * @param {number} params.coverage
 * @param {boolean} [params.isIdentifier=false]
 * @param {number} [params.typeBonus=0.0]
 * @returns {number}
 */
export function calculateDigUpScore({
  zScore,
  coverage,
  isIdentifier = false,
  typeBonus = 0.0,
}) {
  const zPart = Math.max(zScore, 0);
  const covPart = Math.pow(Math.max(0, Math.min(1, coverage)), 1.5);

  if (isIdentifier) {
    return 0.5 * zPart + 4.0 * covPart + typeBonus;
  }
  return zPart + 2.0 * covPart + typeBonus;
}

/**
 * Deduplicate corpus chunks so that at most one chunk per source file is returned.
 * Keeps the highest scoring chunk for each source_path.
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function deduplicateCorpusChunks(items) {
  const seenSources = new Set();
  const out = [];

  for (const item of items) {
    const isCorpus = item.type === 'corpus' || item.type === 'corpus_chunk' || Boolean(item.source_path);
    if (isCorpus && item.source_path) {
      if (seenSources.has(item.source_path)) {
        continue;
      }
      seenSources.add(item.source_path);
    }
    out.push(item);
  }

  return out;
}

/**
 * Rank candidates using DigUp z-score hybrid ranking algorithm.
 *
 * @param {string} query Search query string
 * @param {Array<object>} candidates Candidate items from storage
 * @param {object} [options]
 * @param {Float16Array|Float32Array|Buffer|Uint8Array|null} [options.queryEmbedding=null] Dense query vector
 * @param {boolean} [options.isIdentifier] Override identifier query detection
 * @param {number} [options.minZ=2.0] Candidate gate z-score threshold
 * @param {number} [options.minCoverage=0.50] Candidate gate coverage threshold
 * @param {boolean} [options.enforceGate=true] Whether to filter candidates that fail the gate
 * @param {boolean} [options.fallbackIfEmpty=true] Return top raw-scoring candidates if gate filters all
 * @param {boolean} [options.deduplicateCorpus=true] Max 1 chunk per source file
 * @param {number} [options.limit=10] Maximum results to return
 * @param {object} [options.typeBonuses=DEFAULT_TYPE_BONUSES] Custom type bonuses
 * @returns {Array<object>} Ranked candidates with scoring metadata
 */
export function rankCandidates(query, candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const {
    queryEmbedding = null,
    isIdentifier = isIdentifierQuery(query),
    minZ = DEFAULT_MIN_Z,
    minCoverage = DEFAULT_MIN_COVERAGE,
    enforceGate = true,
    fallbackIfEmpty = true,
    deduplicateCorpus = true,
    limit = 10,
    typeBonuses = DEFAULT_TYPE_BONUSES,
  } = options;

  const queryTokens = tokenizeQuery(query);

  // 1. Calculate cosine similarities
  const rawSimilarities = candidates.map((cand) => {
    if (!queryEmbedding || !cand.embedding) return 0;
    return cosineSimilarity(queryEmbedding, cand.embedding);
  });

  // 2. Compute z-scores across candidate similarities
  const zScores = computeZScores(rawSimilarities);

  // 3. Score and annotate each candidate
  const scored = candidates.map((cand, idx) => {
    const textCorpus = [
      cand.title,
      cand.summary,
      cand.directive,
      cand.content,
      cand.tags,
      cand.source_path,
    ].filter(Boolean).join(' ');

    const coverage = computeTokenCoverage(queryTokens, textCorpus);
    const zScore = zScores[idx];
    const similarity = rawSimilarities[idx];

    const typeKey = (cand.type || (cand.directive ? 'core' : cand.source_path ? 'corpus' : 'episodic')).toLowerCase();
    const typeBonus = typeof typeBonuses[typeKey] === 'number' ? typeBonuses[typeKey] : 0.0;

    const score = calculateDigUpScore({
      zScore,
      coverage,
      isIdentifier,
      typeBonus,
    });

    const admitted = isCandidateAdmitted({
      zScore,
      coverage,
      minZ,
      minCoverage,
    });

    return {
      ...cand,
      cosine_sim: similarity,
      z_score: zScore,
      coverage,
      score,
      admitted,
      is_identifier: isIdentifier,
    };
  });

  // 4. Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 5. Apply admission gate filter
  let filtered = scored;
  if (enforceGate) {
    const passed = scored.filter((item) => item.admitted);
    if (passed.length > 0) {
      filtered = passed;
    } else if (!fallbackIfEmpty) {
      filtered = [];
    }
  }

  // 6. Source deduplication for corpus chunks
  let deduplicated = filtered;
  if (deduplicateCorpus) {
    deduplicated = deduplicateCorpusChunks(filtered);
  }

  // 7. Apply limit
  return deduplicated.slice(0, Math.max(1, limit));
}
