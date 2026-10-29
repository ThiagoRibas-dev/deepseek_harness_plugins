/**
 * Comprehensive test suite for dense vector embedding substrate
 * and DigUp z-score hybrid ranking engine in dsh-memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAlphaRatio,
  shouldBypassDenseEmbedding,
  formatQuery,
  formatDocument,
  l2Normalize,
  truncateAndNormalize,
  meanPool,
  createDeterministicEmbedder,
  DEFAULT_GEMMA_DIM,
} from '../embedding.js';
import {
  cosineSimilarity,
  computeZScores,
  tokenizeQuery,
  isIdentifierQuery,
  computeTokenCoverage,
  isCandidateAdmitted,
  calculateDigUpScore,
  deduplicateCorpusChunks,
  rankCandidates,
  DEFAULT_TYPE_BONUSES,
} from '../ranking.js';
import { embeddingToBlob } from '../storage.js';

test('Embedding Substrate: Text Gating and Ratio', async (t) => {
  await t.test('calculates alphabetic unicode character ratio accurately', () => {
    assert.equal(calculateAlphaRatio(''), 0);
    assert.equal(calculateAlphaRatio('   '), 0);
    assert.equal(calculateAlphaRatio(null), 0);
    assert.equal(calculateAlphaRatio('Hello World'), 1.0);
    assert.equal(calculateAlphaRatio('Bonjour le monde 1234'), 14 / 18);
  });

  await t.test('flags text with < 20% alphabetic letters to bypass dense embedding', () => {
    assert.equal(shouldBypassDenseEmbedding('Hello world this is normal text'), false);
    assert.equal(shouldBypassDenseEmbedding('0x12 0x34 9821 #$%! === !=='), true);
    assert.equal(shouldBypassDenseEmbedding('1234567890'), true);
    assert.equal(shouldBypassDenseEmbedding(';;;;;;;;;;'), true);
  });
});

test('Embedding Substrate: Task Formatting', async (t) => {
  await t.test('formats search query with task prefix', () => {
    assert.equal(formatQuery('sqlite performance'), 'task: search result | query: sqlite performance');
    assert.equal(formatQuery('  trimmed query  '), 'task: search result | query: trimmed query');
    assert.equal(formatQuery(''), 'task: search result | query: ');
  });

  await t.test('formats document and memory chunks with title/text prefix', () => {
    assert.equal(
      formatDocument('Content of memory', 'Important Note'),
      'title: Important Note | text: Content of memory'
    );
    assert.equal(
      formatDocument('No title provided', null),
      'title: none | text: No title provided'
    );
    assert.equal(
      formatDocument('Empty title provided', '   '),
      'title: none | text: Empty title provided'
    );
  });
});

test('Embedding Substrate: Vector Math and MRL Truncation', async (t) => {
  await t.test('l2Normalize produces unit norm vector', () => {
    const vec = new Float32Array([3, 4]);
    const norm = l2Normalize(vec);
    assert.equal(norm.length, 2);
    assert.ok(Math.abs(norm[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(norm[1] - 0.8) < 1e-6);
    const length = Math.sqrt(norm[0] * norm[0] + norm[1] * norm[1]);
    assert.ok(Math.abs(length - 1.0) < 1e-6);
  });

  await t.test('truncateAndNormalize truncates to target dimension and returns Float16Array', () => {
    const raw = new Float32Array(768);
    for (let i = 0; i < 768; i++) raw[i] = (i % 10) + 1;

    const truncated = truncateAndNormalize(raw, 256);
    assert.ok(truncated instanceof Float16Array);
    assert.equal(truncated.length, 256);

    let sumSq = 0;
    for (let i = 0; i < 256; i++) sumSq += truncated[i] * truncated[i];
    assert.ok(Math.abs(Math.sqrt(sumSq) - 1.0) < 1e-2);
  });

  await t.test('meanPool averages hidden states across unmasked tokens', () => {
    // 3 tokens, hiddenDim = 2
    // token 0: [2, 4], token 1: [6, 8], token 2: [100, 200] (masked out)
    const hiddenState = new Float32Array([2, 4, 6, 8, 100, 200]);
    const mask = new BigInt64Array([1n, 1n, 0n]);
    const pooled = meanPool(hiddenState, mask, 3, 2);

    assert.equal(pooled.length, 2);
    assert.equal(pooled[0], (2 + 6) / 2);
    assert.equal(pooled[1], (4 + 8) / 2);
  });
});

test('Embedding Substrate: Deterministic Embedder', async (t) => {
  const embedder = createDeterministicEmbedder(256);

  await t.test('generates reproducible Float16Array embeddings', async () => {
    const v1 = await embedder.embed('authentication token session', { isQuery: true });
    const v2 = await embedder.embed('authentication token session', { isQuery: true });
    assert.ok(v1 instanceof Float16Array);
    assert.equal(v1.length, 256);
    assert.deepEqual(Array.from(v1), Array.from(v2));

    const simSelf = cosineSimilarity(v1, v2);
    assert.ok(Math.abs(simSelf - 1.0) < 1e-3);
  });

  await t.test('respects text gating and bypass flags', async () => {
    const gated = await embedder.embed('1234567890 !@#$%^');
    assert.equal(gated, null);

    const bypassed = await embedder.embed('1234567890 !@#$%^', { bypassGating: true });
    assert.ok(bypassed instanceof Float16Array);

    const queryGated = await embedder.embed('1234567890', { isQuery: true });
    assert.ok(queryGated instanceof Float16Array);
  });

  await t.test('embedBatch processes string and object items', async () => {
    const items = [
      'Normal text item',
      { content: 'Second item with title', title: 'Doc Title' },
      ';;;; 9999',
    ];
    const results = await embedder.embedBatch(items);
    assert.equal(results.length, 3);
    assert.ok(results[0] instanceof Float16Array);
    assert.ok(results[1] instanceof Float16Array);
    assert.equal(results[2], null);
  });
});

test('DigUp Ranking: Cosine Similarity and Input Formats', async (t) => {
  await t.test('computes exact cosine similarity for Float16Array, Float32Array, and Blobs', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    const d = new Float32Array([-1, 0, 0]);

    assert.ok(Math.abs(cosineSimilarity(a, b) - 1.0) < 1e-5);
    assert.ok(Math.abs(cosineSimilarity(a, c) - 0.0) < 1e-5);
    assert.ok(Math.abs(cosineSimilarity(a, d) - (-1.0)) < 1e-5);

    // Converted to SQLite Float16 blob
    const blobA = embeddingToBlob(a);
    const blobB = embeddingToBlob(b);
    assert.ok(Math.abs(cosineSimilarity(blobA, blobB) - 1.0) < 1e-3);
  });

  await t.test('handles empty or null vectors gracefully', () => {
    assert.equal(cosineSimilarity(null, [1, 2]), 0);
    assert.equal(cosineSimilarity([1, 2], null), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
  });
});

test('DigUp Ranking: Z-Score Normalization', async (t) => {
  await t.test('computes z-score distribution across similarities', () => {
    // Mean = 0.5, std = sqrt(((0-0.5)^2 + (0.5-0.5)^2 + (1.0-0.5)^2)/3) = sqrt(0.5/3) = ~0.408248
    const sims = [0.0, 0.5, 1.0];
    const zScores = computeZScores(sims);
    assert.equal(zScores.length, 3);
    assert.ok(zScores[0] < 0);
    assert.ok(Math.abs(zScores[1] - 0.0) < 1e-5);
    assert.ok(zScores[2] > 0);
    assert.ok(Math.abs(zScores[0] + zScores[2]) < 1e-5);
  });

  await t.test('handles edge cases: empty, single item, zero variance', () => {
    assert.deepEqual(computeZScores([]), []);
    assert.deepEqual(computeZScores([0.8]), [0]);
    assert.deepEqual(computeZScores([0.5, 0.5, 0.5]), [0, 0, 0]);
  });
});

test('DigUp Ranking: Query Tokenization & Identifier Detection', async (t) => {
  await t.test('tokenizes query stripping non-alphanumeric edges', () => {
    const tokens = tokenizeQuery('hello world! test-case $DSH_HOME');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
    assert.ok(tokens.includes('test-case'));
    assert.ok(tokens.includes('$dsh_home'));
  });

  await t.test('detects identifier-heavy queries vs general queries', () => {
    // Identifier patterns
    assert.equal(isIdentifierQuery('InferenceSession'), true); // camelCase
    assert.equal(isIdentifierQuery('corpus_chunks'), true); // snake_case
    assert.equal(isIdentifierQuery('dsh-memory'), true); // kebab-case
    assert.equal(isIdentifierQuery('ctx.memory'), true); // dot property
    assert.equal(isIdentifierQuery('plugins/dsh-memory/ranking.js'), true); // path
    assert.equal(isIdentifierQuery('sha256'), true); // alpha-num code
    assert.equal(isIdentifierQuery('daa72c51243991dfcaf9f9137d2c573d8f7790c0'), true); // hex hash
    assert.equal(isIdentifierQuery('$DSH_HOME'), true); // env var

    // Natural language queries
    assert.equal(isIdentifierQuery('what is the memory service design'), false);
    assert.equal(isIdentifierQuery('summarize the key ideas from the meeting'), false);
    assert.equal(isIdentifierQuery('user preferences for code style'), false);
  });

  await t.test('computes token coverage ratio accurately', () => {
    const query = 'authentication token session';
    const textAll = 'We refreshed the authentication token in the active session';
    const textPart = 'The authentication failed due to timeout';
    const textNone = 'Unrelated baking recipe for chocolate cake';

    assert.equal(computeTokenCoverage(query, textAll), 1.0);
    assert.ok(Math.abs(computeTokenCoverage(query, textPart) - (1 / 3)) < 1e-5);
    assert.equal(computeTokenCoverage(query, textNone), 0.0);
  });
});

test('DigUp Ranking: Candidate Gate & Scoring Formula', async (t) => {
  await t.test('candidate admission gate: admitted if z >= 2.0 OR coverage >= 0.50', () => {
    assert.equal(isCandidateAdmitted({ zScore: 2.1, coverage: 0.1 }), true);
    assert.equal(isCandidateAdmitted({ zScore: 0.5, coverage: 0.55 }), true);
    assert.equal(isCandidateAdmitted({ zScore: 2.5, coverage: 0.8 }), true);
    assert.equal(isCandidateAdmitted({ zScore: 1.8, coverage: 0.45 }), false);
    assert.equal(isCandidateAdmitted({ zScore: -0.5, coverage: 0.2 }), false);
  });

  await t.test('DigUp fusion score calculates general vs identifier formulas', () => {
    // General: max(z,0) + 2.0 * coverage^1.5 + typeBonus
    const generalScore = calculateDigUpScore({
      zScore: 1.5,
      coverage: 0.64, // 0.64^1.5 = 0.512
      isIdentifier: false,
      typeBonus: 0.5,
    });
    // 1.5 + 2.0 * 0.512 + 0.5 = 1.5 + 1.024 + 0.5 = 3.024
    assert.ok(Math.abs(generalScore - 3.024) < 1e-5);

    // Identifier: 0.5 * max(z,0) + 4.0 * coverage^1.5 + typeBonus
    const idScore = calculateDigUpScore({
      zScore: 1.5,
      coverage: 0.64,
      isIdentifier: true,
      typeBonus: 0.5,
    });
    // 0.5 * 1.5 + 4.0 * 0.512 + 0.5 = 0.75 + 2.048 + 0.5 = 3.298
    assert.ok(Math.abs(idScore - 3.298) < 1e-5);
  });
});

test('DigUp Ranking: Deduplication and Candidate Ranking', async (t) => {
  await t.test('deduplicates corpus chunks by source file keeping highest score', () => {
    const items = [
      { id: '1', type: 'corpus', source_path: 'doc-a.md', score: 3.5 },
      { id: '2', type: 'corpus', source_path: 'doc-a.md', score: 2.1 },
      { id: '3', type: 'corpus', source_path: 'doc-b.md', score: 2.9 },
      { id: '4', type: 'core', score: 4.0 }, // Non-corpus
      { id: '5', type: 'episodic', score: 3.8 }, // Non-corpus
    ];

    const deduplicated = deduplicateCorpusChunks(items);
    assert.equal(deduplicated.length, 4);
    assert.ok(deduplicated.some((x) => x.id === '1'));
    assert.ok(!deduplicated.some((x) => x.id === '2')); // dropped duplicate
    assert.ok(deduplicated.some((x) => x.id === '3'));
    assert.ok(deduplicated.some((x) => x.id === '4'));
    assert.ok(deduplicated.some((x) => x.id === '5'));
  });

  await t.test('rankCandidates end-to-end integration', async () => {
    const embedder = createDeterministicEmbedder(256);
    const query = 'authSessionToken';
    const queryVec = await embedder.embed(query, { isQuery: true });

    const c1Text = 'Handling authSessionToken in secure cookie storage';
    const c2Text = 'Totally unrelated cooking instructions';
    const c3Text = 'Different chunk from same auth source file authSessionToken';

    const c1Vec = await embedder.embed(c1Text);
    const c2Vec = await embedder.embed(c2Text);
    const c3Vec = await embedder.embed(c3Text);

    const candidates = [
      {
        id: 'c1',
        type: 'corpus',
        source_path: 'auth/session.ts',
        content: c1Text,
        embedding: embeddingToBlob(c1Vec),
      },
      {
        id: 'c2',
        type: 'corpus',
        source_path: 'recipes/cake.md',
        content: c2Text,
        embedding: embeddingToBlob(c2Vec),
      },
      {
        id: 'c3',
        type: 'corpus',
        source_path: 'auth/session.ts', // same file as c1
        content: c3Text,
        embedding: embeddingToBlob(c3Vec),
      },
      {
        id: 'c4',
        type: 'core',
        directive: 'Always validate authSessionToken before proceeding',
        content: 'authSessionToken directive',
        embedding: embeddingToBlob(c1Vec),
      },
    ];

    const results = rankCandidates(query, candidates, {
      queryEmbedding: queryVec,
      limit: 10,
    });

    assert.ok(results.length > 0);
    // Highest ranked items should include c4 (core bonus) or c1
    assert.ok(results[0].score > 0);
    assert.ok(results[0].admitted);

    // c2 should be filtered out by gate or ranked lowest
    const c2Result = results.find((r) => r.id === 'c2');
    assert.equal(c2Result, undefined);

    // c1 and c3 come from the same source file; only 1 should remain
    const authChunks = results.filter((r) => r.source_path === 'auth/session.ts');
    assert.equal(authChunks.length, 1);
  });
});
