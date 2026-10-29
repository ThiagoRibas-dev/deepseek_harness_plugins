/**
 * Chunker and ingestion-engine tests.
 *
 * Every case runs against a temporary directory or an in-memory database, so the
 * suite never touches a real corpus or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  chunkText, deriveTitle, looksBinary,
  DEFAULT_CHUNK_CHARS, DEFAULT_OVERLAP_CHARS, MAX_CHUNKS_PER_SOURCE,
} from '../chunker.js';
import {
  hashContent, isTextFile, walkFiles, ingestText, ingestFile, ingestPaths,
  MAX_SOURCE_BYTES, TEXT_EXTENSIONS,
} from '../ingest.js';
import { MemoryService } from '../service.js';

/** A throwaway directory per test. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ingest-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function service() {
  return new MemoryService({ inMemory: true, defaultNamespace: 'test' });
}

// ---------------------------------------------------------------- chunker

test('chunkText returns nothing for whitespace', () => {
  assert.deepEqual(chunkText('   \n\n  '), { chunks: [], truncated: false, totalChunks: 0 });
});

test('chunkText keeps a short document as one unchanged chunk', () => {
  const { chunks } = chunkText('Hello world.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, 'Hello world.');
  assert.equal(chunks[0].index, 0);
});

test('chunkText splits a long document within budget and numbers chunks densely', () => {
  const body = 'Sentence about retrieval and ranking. '.repeat(30);
  const text = Array.from({ length: 8 }, (_, i) => `## Part ${i}\n\n${body}`).join('\n\n');
  const { chunks } = chunkText(text);
  assert.ok(chunks.length > 1, 'expected several chunks');
  assert.ok(chunks.every((c) => c.content.length <= DEFAULT_CHUNK_CHARS), 'every chunk within budget');
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  assert.ok(chunks.every((c) => c.content.trim().length > 0), 'no empty chunks');
  assert.ok(chunks.every((c) => c.textRatio > 0.3), 'prose chunks keep a high alphabetic ratio');
});

test('chunkText carries an overlap from the previous chunk', () => {
  const text = Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\n${'Words that matter here. '.repeat(25)}`).join('\n\n');
  const { chunks } = chunkText(text, { maxChars: 600, overlapChars: DEFAULT_OVERLAP_CHARS });
  assert.ok(chunks.length >= 2);
  // The overlap is the previous chunk's tail, so the next chunk opens with text
  // the previous one already ended on. Checking a prefix against the tail is
  // exact, where comparing word sets was only probabilistic.
  const prefix = chunks[1].content.slice(0, 40);
  assert.ok(chunks[0].content.includes(prefix), 'second chunk opens with the first chunk\'s tail');
  assert.equal(chunks[1].content.slice(0, 1), chunks[1].content.slice(0, 1).trim(), 'no leading partial word');
});

test('chunkText caps the number of chunks and says so', () => {
  const { chunks, truncated, totalChunks } = chunkText('word '.repeat(20000), { maxChars: 400, maxChunks: 3 });
  assert.equal(chunks.length, 3);
  assert.equal(truncated, true);
  assert.ok(totalChunks > 3);
  assert.equal(MAX_CHUNKS_PER_SOURCE, 500);
});

test('deriveTitle prefers a heading and falls back to the first line', () => {
  assert.equal(deriveTitle('# Real Title\n\nbody'), 'Real Title');
  assert.equal(deriveTitle('## Second Level ##\n\nbody'), 'Second Level');
  assert.equal(deriveTitle('first line\nsecond'), 'first line');
  assert.equal(deriveTitle('   '), null);
});

test('looksBinary finds a NUL byte and leaves text alone', () => {
  assert.equal(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true);
  assert.equal(looksBinary(Buffer.from('plain text')), false);
});

// ---------------------------------------------------------------- hashing

test('hashContent is stable and distinguishes edits', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abd'));
  assert.match(hashContent('abc'), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- file filtering

test('isTextFile accepts known extensions and refuses binary content', () => {
  const { dir, done } = scratch();
  try {
    writeFileSync(join(dir, 'a.md'), '# ok');
    writeFileSync(join(dir, 'blob.md'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50]));
    assert.equal(isTextFile(join(dir, 'a.md')), true);
    assert.equal(isTextFile(join(dir, 'blob.md')), false);
    assert.equal(isTextFile(join(dir, 'image.png')), false);
    assert.ok(TEXT_EXTENSIONS.has('.md'));
  } finally {
    done();
  }
});

test('walkFiles skips ignored directories and unsupported extensions', () => {
  const { dir, done } = scratch();
  try {
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'docs', 'keep.md'), 'x');
    writeFileSync(join(dir, 'docs', 'skip.png'), 'x');
    writeFileSync(join(dir, 'node_modules', 'dep.md'), 'x');
    const { files, truncated } = walkFiles(dir);
    assert.deepEqual(files, [join(dir, 'docs', 'keep.md')]);
    assert.equal(truncated, false);
  } finally {
    done();
  }
});

test('walkFiles honours its file ceiling', () => {
  const { dir, done } = scratch();
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.md`), 'x');
    const { files, truncated } = walkFiles(dir, { maxFiles: 2 });
    assert.equal(files.length, 2);
    assert.equal(truncated, true);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------- ingestText

test('ingestText writes chunks and records the source hash', async () => {
  const svc = service();
  const content = '# Doc\n\n' + 'A durable fact about retrieval. '.repeat(40);
  const record = await ingestText(svc, { content, collection: 'c', sourcePath: 'doc.md', origin: 'session', namespace: 'ns1' });
  assert.equal(record.status, 'ingested');
  assert.ok(record.chunkCount >= 1);
  assert.equal(record.hash, hashContent(content));
  const stored = svc.getCorpusSource('c', 'doc.md');
  assert.equal(stored.content_hash, record.hash);
  assert.equal(stored.origin, 'session');
  assert.equal(stored.namespace, 'ns1');
  assert.equal(svc.listCorpusChunks({ collection: 'c' }).length, record.chunkCount);
  svc.close();
});

test('ingestText skips a source whose content hash is unchanged', async () => {
  const svc = service();
  const content = '# Doc\n\nSomething worth indexing.';
  await ingestText(svc, { content, collection: 'c', sourcePath: 'doc.md' });
  const second = await ingestText(svc, { content, collection: 'c', sourcePath: 'doc.md' });
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'content unchanged');
  svc.close();
});

test('ingestText replaces chunks when the content changes', async () => {
  const svc = service();
  await ingestText(svc, { content: '# Doc\n\nFirst version.', collection: 'c', sourcePath: 'doc.md' });
  const changed = await ingestText(svc, { content: '# Doc\n\nSecond version, longer.', collection: 'c', sourcePath: 'doc.md' });
  assert.equal(changed.status, 'ingested');
  const chunks = svc.listCorpusChunks({ collection: 'c' });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /Second version/);
  svc.close();
});

test('ingestText re-ingests on force even when the hash matches', async () => {
  const svc = service();
  const content = '# Doc\n\nUnchanged body.';
  await ingestText(svc, { content, collection: 'c', sourcePath: 'doc.md' });
  const forced = await ingestText(svc, { content, collection: 'c', sourcePath: 'doc.md', force: true });
  assert.equal(forced.status, 'ingested');
  svc.close();
});

test('ingestText drops a source that becomes empty', async () => {
  const svc = service();
  await ingestText(svc, { content: '# Doc\n\nBody.', collection: 'c', sourcePath: 'doc.md' });
  const emptied = await ingestText(svc, { content: '   ', collection: 'c', sourcePath: 'doc.md' });
  assert.equal(emptied.status, 'empty');
  assert.equal(svc.listCorpusChunks({ collection: 'c' }).length, 0);
  assert.equal(svc.getCorpusSource('c', 'doc.md'), null, 'registry row must not survive an emptied source');
  svc.close();
});

test('ingestText refuses missing identity fields', async () => {
  const svc = service();
  await assert.rejects(() => ingestText(svc, { content: 'x', sourcePath: 'a.md' }), /collection is required/);
  await assert.rejects(() => ingestText(svc, { content: 'x', collection: 'c' }), /sourcePath is required/);
  await assert.rejects(() => ingestText(svc, { content: null, collection: 'c', sourcePath: 'a' }), /content must be a string/);
  svc.close();
});

test('ingested prose produces dense vectors, not empty ones', async () => {
  const svc = service();
  await ingestText(svc, { content: '# Doc\n\nDense retrieval needs a real vector.', collection: 'c', sourcePath: 'doc.md' });
  const sizes = svc.storage.db.prepare('SELECT length(embedding) AS n FROM corpus_chunks').all();
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((row) => row.n === 512), `expected 512-byte float16 vectors, saw ${sizes.map((r) => r.n)}`);
  svc.close();
});

// ---------------------------------------------------------------- ingestFile

test('ingestFile records a path relative to its root and skips binary content', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'ok.md'), '# Ok\n\nIndexable prose.');
    writeFileSync(join(dir, 'docs', 'blob.md'), Buffer.from([0x61, 0x00, 0x62]));
    const ok = await ingestFile(svc, { filePath: join(dir, 'docs', 'ok.md'), collection: 'c', root: dir });
    assert.equal(ok.status, 'ingested');
    assert.equal(ok.sourcePath, join('docs', 'ok.md'));
    const binary = await ingestFile(svc, { filePath: join(dir, 'docs', 'blob.md'), collection: 'c', root: dir });
    assert.equal(binary.status, 'binary');
  } finally {
    svc.close();
    done();
  }
});

test('ingestFile refuses an oversized source and reports a missing one', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    const big = join(dir, 'big.md');
    writeFileSync(big, 'x'.repeat(MAX_SOURCE_BYTES + 1));
    const tooLarge = await ingestFile(svc, { filePath: big, collection: 'c' });
    assert.equal(tooLarge.status, 'too-large');
    const missing = await ingestFile(svc, { filePath: join(dir, 'nope.md'), collection: 'c' });
    assert.equal(missing.status, 'failed');
  } finally {
    svc.close();
    done();
  }
});

// ---------------------------------------------------------------- ingestPaths

test('ingestPaths walks a tree, skips unsupported files, and reports a summary', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'docs', 'a.md'), '# A\n\nAlpha content.');
    writeFileSync(join(dir, 'docs', 'b.py'), 'beta = 1\n');
    writeFileSync(join(dir, 'docs', 'c.png'), 'not really an image');
    writeFileSync(join(dir, 'node_modules', 'dep.md'), 'ignored');
    const { records, summary } = await ingestPaths(svc, { paths: [dir], collection: 'c' });
    assert.equal(summary.collection, 'c');
    assert.equal(summary.ingested, 2);
    assert.equal(summary.failed, 0);
    // Unsupported extensions are filtered before they become targets, so the
    // honest assertion is absence rather than a per-file skip record.
    assert.ok(!records.some((r) => /\.png$/.test(r.sourcePath ?? '')));
    assert.equal(summary.scanned, 2, 'only the two supported files are scanned');
    assert.ok(!records.some((r) => (r.sourcePath ?? '').includes('node_modules')));
  } finally {
    svc.close();
    done();
  }
});

test('ingestPaths skips unchanged sources on a second run', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    writeFileSync(join(dir, 'a.md'), '# A\n\nAlpha content.');
    await ingestPaths(svc, { paths: [dir], collection: 'c' });
    const { summary } = await ingestPaths(svc, { paths: [dir], collection: 'c' });
    assert.equal(summary.ingested, 0);
    assert.equal(summary.skipped, 1);
  } finally {
    svc.close();
    done();
  }
});

test('ingestPaths re-ingests only the file that changed', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    writeFileSync(join(dir, 'a.md'), '# A\n\nAlpha.');
    writeFileSync(join(dir, 'b.md'), '# B\n\nBeta.');
    await ingestPaths(svc, { paths: [dir], collection: 'c' });
    writeFileSync(join(dir, 'b.md'), '# B\n\nBeta, revised.');
    const { records } = await ingestPaths(svc, { paths: [dir], collection: 'c' });
    const ingested = records.filter((r) => r.status === 'ingested').map((r) => r.sourcePath);
    assert.deepEqual(ingested, [join(dir, 'b.md')], 'default identity is the absolute path');
  } finally {
    svc.close();
    done();
  }
});

test('ingestPaths dry-run reports changes without writing', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    writeFileSync(join(dir, 'a.md'), '# A\n\nAlpha.');
    const first = await ingestPaths(svc, { paths: [dir], collection: 'c', dryRun: true });
    assert.equal(first.summary.wouldIngest, 1);
    assert.equal(first.summary.ingested, 0);
    assert.equal(svc.listCorpusChunks({ collection: 'c' }).length, 0, 'dry-run must not write chunks');
    await ingestPaths(svc, { paths: [dir], collection: 'c' });
    const second = await ingestPaths(svc, { paths: [dir], collection: 'c', dryRun: true });
    assert.equal(second.summary.wouldIngest, 0);
    assert.equal(second.summary.skipped, 1);
  } finally {
    svc.close();
    done();
  }
});

test('ingestPaths records the origin it was given and reports a missing path', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    writeFileSync(join(dir, 'a.md'), '# A\n\nAlpha.');
    await ingestPaths(svc, { paths: [dir], collection: 'c', origin: 'upload', namespace: 'sess-1', root: dir });
    const source = svc.getCorpusSource('c', 'a.md');
    assert.equal(source.origin, 'upload');
    assert.equal(source.namespace, 'sess-1');
    const { records } = await ingestPaths(svc, { paths: [join(dir, 'ghost')], collection: 'c' });
    assert.equal(records[0].status, 'failed');
    assert.match(records[0].reason, /does not exist/);
  } finally {
    svc.close();
    done();
  }
});

test('deleting a source removes both its chunks and its registry row', async () => {
  const svc = service();
  await ingestText(svc, { content: '# A\n\nAlpha.', collection: 'c', sourcePath: 'a.md' });
  assert.equal(svc.listCorpusChunks({ collection: 'c' }).length, 1);
  const removed = svc.deleteCorpusSource('c', 'a.md');
  assert.equal(removed, 1);
  assert.equal(svc.getCorpusSource('c', 'a.md'), null);
  assert.equal(svc.listCorpusSources({ collection: 'c' }).length, 0);
  svc.close();
});


test('an explicit root makes source paths relative, and a direct file matches the walk', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), '# A\n\nAlpha.');
    await ingestPaths(svc, { paths: [dir], collection: 'c', root: dir });
    assert.equal(svc.getCorpusSource('c', join('docs', 'a.md')) !== null, true, 'walk reports a relative path');
    // The same file reached directly must resolve to the same identity.
    const direct = await ingestPaths(svc, { paths: [join(dir, 'docs', 'a.md')], collection: 'c', root: dir });
    assert.equal(direct.records[0].status, 'skipped', 'direct path matches the walked identity');
    assert.equal(svc.listCorpusSources({ collection: 'c' }).length, 1);
  } finally {
    svc.close();
    done();
  }
});

test('an ingested corpus is searchable through the hybrid engine', async () => {
  const { dir, done } = scratch();
  const svc = service();
  try {
    writeFileSync(join(dir, 'guide.md'), '# Guide\n\nMemory keeps facts. It also keeps promises.\n');
    await ingestPaths(svc, { paths: [dir], collection: 'c' });
    const result = await svc.searchReference('promises', { collection: 'c' });
    assert.ok(result.results.length >= 1, 'expected a hit');
    assert.match(result.results[0].source_path, /guide\.md$/);
    assert.ok(result.results[0].coverage > 0, 'lexical coverage must contribute');
  } finally {
    svc.close();
    done();
  }
});
