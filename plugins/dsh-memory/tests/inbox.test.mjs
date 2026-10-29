/**
 * UI upload tests: filename safety, the inbox folder, and the REST surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  sanitizeUploadName, sanitizeCollection, writeUpload, ingestUpload, listInbox, removeInboxFile,
  defaultIngestFolder,
} from '../inbox.js';
import { MemoryService } from '../service.js';
import { ingestFile, MAX_SOURCE_BYTES } from '../ingest.js';
import { routeRequest } from '../route.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-inbox-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- name safety

test('sanitizeUploadName reduces a path to one safe basename', () => {
  // A browser may send a directory-relative path, so the directories are dropped
  // rather than rejected: what matters is that the result cannot leave the inbox.
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('/abs/path/notes.md'), 'notes.md');
  assert.equal(sanitizeUploadName('..\\..\\win\\evil.md'), 'winevil.md');
  assert.equal(sanitizeUploadName('docs/deep/handout.md'), 'handout.md');
  assert.equal(sanitizeUploadName('a\u0000b\u001fc.md'), 'abc.md');
  assert.equal(sanitizeUploadName('...hidden.md'), 'hidden.md');
  assert.equal(sanitizeUploadName('my notes.md'), 'my-notes.md');
});

test('sanitizeUploadName keeps the extension and bounds each part', () => {
  const long = `${'x'.repeat(500)}.md`;
  const safe = sanitizeUploadName(long);
  assert.ok(safe.endsWith('.md'));
  assert.ok(safe.length <= 96, `expected a bounded name, saw ${safe.length}`);
});

test('sanitizeUploadName refuses a name with nothing usable left', () => {
  assert.equal(sanitizeUploadName(''), null);
  assert.equal(sanitizeUploadName('...'), null);
  assert.equal(sanitizeUploadName('/'), null);
  assert.equal(sanitizeUploadName(null), null);
});

test('sanitizeCollection keeps safe segments and replaces the rest', () => {
  assert.equal(sanitizeCollection('rules'), 'rules');
  assert.equal(sanitizeCollection('my-rules_2'), 'my-rules_2');
  assert.equal(sanitizeCollection('../escape'), 'uploads');
  assert.equal(sanitizeCollection('has space'), 'uploads');
  assert.equal(sanitizeCollection(''), 'uploads');
  assert.equal(sanitizeCollection(undefined, 'fallback'), 'fallback');
});

// ---------------------------------------------------------------- writing

test('writeUpload lands the file under the inbox and reports what it wrote', () => {
  const { dir, done } = scratch();
  try {
    const written = writeUpload({ inboxFolder: dir, collection: 'rules', filename: 'grapple.md', content: '# Grapple\n\nRules.' });
    assert.equal(written.collection, 'rules');
    assert.equal(written.filename, 'grapple.md');
    assert.equal(existsSync(join(dir, 'rules', 'grapple.md')), true);
    assert.equal(readFileSync(written.path, 'utf8'), '# Grapple\n\nRules.');
  } finally {
    done();
  }
});

test('writeUpload refuses an empty body, an unsupported extension, and an oversized body', () => {
  const { dir, done } = scratch();
  try {
    assert.throws(() => writeUpload({ inboxFolder: dir, collection: 'c', filename: 'a.md', content: '' }), /empty/);
    assert.throws(() => writeUpload({ inboxFolder: dir, collection: 'c', filename: 'a.exe', content: 'x' }), /not indexed/);
    assert.throws(() => writeUpload({ inboxFolder: dir, collection: 'c', filename: 'a', content: 'x' }), /not indexed/);
    assert.throws(
      () => writeUpload({ inboxFolder: dir, collection: 'c', filename: 'a.md', content: 'x'.repeat(MAX_SOURCE_BYTES + 1) }),
      /the limit is/,
    );
    assert.equal(existsSync(join(dir, 'c')), false, 'a refused upload writes nothing');
  } finally {
    done();
  }
});

test('a traversal filename cannot escape the inbox', () => {
  const { dir, done } = scratch();
  try {
    const written = writeUpload({ inboxFolder: dir, collection: 'c', filename: '../../escaped.md', content: 'body' });
    assert.ok(written.path.startsWith(dir), `expected the write inside the inbox, saw ${written.path}`);
    assert.equal(existsSync(join(dir, '..', '..', 'escaped.md')), false);
  } finally {
    done();
  }
});

test('a traversal collection falls back to uploads', () => {
  const { dir, done } = scratch();
  try {
    const written = writeUpload({ inboxFolder: dir, collection: '../outside', filename: 'a.md', content: 'body' });
    assert.equal(written.collection, 'uploads');
    assert.ok(written.path.startsWith(join(dir, 'uploads')));
  } finally {
    done();
  }
});

// ---------------------------------------------------------------- ingest

test('ingestUpload writes the file and indexes it', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const result = await ingestUpload(svc, {
      inboxFolder: dir, collection: 'rules', filename: 'grapple.md',
      content: '# Grappling\n\nA pinned creature cannot move.',
    });
    assert.equal(result.record.status, 'ingested');
    assert.equal(result.record.origin, 'upload');
    assert.equal(existsSync(result.path), true);
    const source = svc.getCorpusSource('rules', result.path);
    // ingestFile reports an absolute path here, because no root was supplied.
    assert.ok(source !== null || svc.listCorpusSources({ collection: 'rules' }).length === 1);
    assert.ok((await svc.searchReference('pinned creature', { collection: 'rules' })).results.length >= 1);
  } finally {
    svc.close();
    done();
  }
});

test('listInbox reports files by collection and removeInboxFile deletes one', () => {
  const { dir, done } = scratch();
  try {
    mkdirSync(join(dir, 'rules'), { recursive: true });
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'rules', 'a.md'), 'x');
    writeFileSync(join(dir, 'notes', 'b.md'), 'y');
    const listed = listInbox(dir);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((f) => f.collection).sort(), ['notes', 'rules']);
    assert.equal(removeInboxFile(dir, 'rules', 'a.md'), true);
    assert.equal(listInbox(dir).length, 1);
    // A delete refuses a name carrying a path, rather than acting on its basename.
    assert.equal(removeInboxFile(dir, 'rules', '../a.md'), false);
    assert.equal(removeInboxFile(dir, 'rules', 'sub/a.md'), false);
    assert.equal(listInbox(dir).length, 1, 'the refused deletes removed nothing');
  } finally {
    done();
  }
});

test('listInbox returns nothing for a folder that does not exist', () => {
  assert.deepEqual(listInbox(join(tmpdir(), 'definitely-not-here-12345')), []);
});

test('defaultIngestFolder sits under DSH_HOME', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/some-home';
    assert.equal(defaultIngestFolder(), join('/tmp/some-home', 'memory-inbox'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
});

// ---------------------------------------------------------------- REST surface

const statusOf = (response) => response.status;
const bodyOf = (response) => JSON.parse(response.body.toString());

test('POST /upload accepts a document and answers 201', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'note.md', content: '# Note\n\nBody text.', collection: 'notes' } },
      {
        service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20,
        uploadDocument: (upload) => ingestUpload(svc, { ...upload, inboxFolder: dir }),
      },
    );
    assert.equal(statusOf(response), 201);
    const payload = bodyOf(response);
    assert.equal(payload.record.status, 'ingested');
    assert.equal(existsSync(payload.path), true);
  } finally {
    svc.close();
    done();
  }
});

test('POST /upload accepts base64 content', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'b64.md', contentBase64: Buffer.from('# Base64\n\nBody.').toString('base64') } },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20, uploadDocument: (upload) => ingestUpload(svc, { ...upload, inboxFolder: dir }) },
    );
    assert.equal(statusOf(response), 201);
    assert.equal(readFileSync(join(dir, 'uploads', 'b64.md'), 'utf8'), '# Base64\n\nBody.');
  } finally {
    svc.close();
    done();
  }
});

test('POST /upload rejects a missing filename or body with 400', async () => {
  const svc = new MemoryService({ inMemory: true });
  try {
    const options = { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20, uploadDocument: () => ({}) };
    const noName = await routeRequest({ method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { content: 'x' } }, options);
    assert.equal(statusOf(noName), 400);
    assert.match(bodyOf(noName).error, /filename is required/);
    const noBody = await routeRequest({ method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'a.md' } }, options);
    assert.equal(statusOf(noBody), 400);
    assert.match(bodyOf(noBody).error, /content/);
  } finally {
    svc.close();
  }
});

test('POST /upload reports a refused upload as 400, not 500', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'bad.exe', content: 'x' } },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20, uploadDocument: (upload) => ingestUpload(svc, { ...upload, inboxFolder: dir }) },
    );
    assert.equal(statusOf(response), 400);
    assert.match(bodyOf(response).error, /not indexed/);
  } finally {
    svc.close();
    done();
  }
});

test('POST /upload answers 503 when no upload handler is wired', async () => {
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'a.md', content: 'x' } },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20 },
    );
    assert.equal(statusOf(response), 503);
  } finally {
    svc.close();
  }
});

test('GET /sources lists ingested sources and the inbox', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(join(dir, 'rules', 'pending.md'), '# Pending\n\nNot yet indexed.');
    await ingestUpload(svc, { inboxFolder: dir, collection: 'rules', filename: 'done.md', content: '# Done\n\nIndexed prose.' });
    const response = await routeRequest(
      { method: 'GET', pathname: '/sources', query: new URLSearchParams('collection=rules'), headers: {} },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20, listInboxFiles: () => listInbox(dir) },
    );
    assert.equal(statusOf(response), 200);
    const payload = bodyOf(response);
    assert.equal(payload.sources.length, 1);
    assert.equal(payload.inbox.length, 2);
    assert.ok(payload.inbox.some((f) => f.filename === 'pending.md'));
  } finally {
    svc.close();
    done();
  }
});

test('GET /sources caps the number it returns', async () => {
  const svc = new MemoryService({ inMemory: true });
  try {
    for (let i = 0; i < 5; i++) {
      await svc.upsertCorpusSource({ collection: 'c', sourcePath: `s${i}`, contentHash: `h${i}`, chunkCount: 1 });
    }
    const response = await routeRequest(
      { method: 'GET', pathname: '/sources', query: new URLSearchParams('limit=9999'), headers: {} },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20 },
    );
    assert.equal(statusOf(response), 200);
    assert.ok(bodyOf(response).sources.length <= 100, 'sources must be capped');
  } finally {
    svc.close();
  }
});

// ---------------------------------------------------------------- remove and re-index

/** The route options the plugin wires, over a scratch inbox. */
function corpusOptions(svc, root) {
  return {
    service: svc,
    enabled: true,
    allowAnonymous: true,
    maxSearchLimit: 20,
    listInboxFiles: () => listInbox(root),
    removeInboxFile: (collection, filename) => removeInboxFile(root, collection, filename),
    reindexCorpus: async ({ collection, filename }) => {
      const record = await ingestFile(svc, { filePath: join(root, collection, filename), collection, force: true, root });
      return { ok: record.status === 'ingested', ...record };
    },
  };
}

test('an upload records a path relative to the inbox', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const result = await ingestUpload(svc, { inboxFolder: dir, collection: 'docs', filename: 'a.md', content: '# A\n\nAlpha text.' });
    assert.equal(result.record.sourcePath, join('docs', 'a.md'));
    assert.notEqual(svc.getCorpusSource('docs', join('docs', 'a.md')), null);
  } finally {
    svc.close();
    done();
  }
});

test('POST /corpus/remove forgets the source and, on request, the file', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    await ingestUpload(svc, { inboxFolder: dir, collection: 'docs', filename: 'a.md', content: '# A\n\nAlpha text about grappling.' });
    assert.equal((await svc.searchReference('grappling', { collection: 'docs' })).results.length, 1, 'findable before removal');

    const response = await routeRequest(
      { method: 'POST', pathname: '/corpus/remove', query: new URLSearchParams(), headers: {}, body: { collection: 'docs', sourcePath: join('docs', 'a.md'), inbox: true } },
      corpusOptions(svc, dir),
    );
    assert.equal(statusOf(response), 200);
    const payload = bodyOf(response);
    assert.equal(payload.removedChunks, 1);
    assert.equal(payload.removedFile, true);
    assert.equal(svc.getCorpusSource('docs', join('docs', 'a.md')), null);
    assert.equal(existsSync(join(dir, 'docs', 'a.md')), false);
    assert.equal((await svc.searchReference('grappling', { collection: 'docs' })).results.length, 0, 'gone from search');
  } finally {
    svc.close();
    done();
  }
});

test('POST /corpus/remove leaves the file alone unless the inbox is named', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    await ingestUpload(svc, { inboxFolder: dir, collection: 'docs', filename: 'keep.md', content: '# Keep\n\nBody.' });
    const response = await routeRequest(
      { method: 'POST', pathname: '/corpus/remove', query: new URLSearchParams(), headers: {}, body: { collection: 'docs', sourcePath: join('docs', 'keep.md') } },
      corpusOptions(svc, dir),
    );
    assert.equal(statusOf(response), 200);
    assert.equal(bodyOf(response).removedFile, false, 'the reversible choice is the default');
    assert.equal(existsSync(join(dir, 'docs', 'keep.md')), true, 'the uploaded file survives');
  } finally {
    svc.close();
    done();
  }
});

test('POST /corpus/remove demands both identity fields', async () => {
  const svc = new MemoryService({ inMemory: true });
  try {
    const options = corpusOptions(svc, tmpdir());
    const noCollection = await routeRequest({ method: 'POST', pathname: '/corpus/remove', query: new URLSearchParams(), headers: {}, body: { sourcePath: 'a.md' } }, options);
    assert.equal(statusOf(noCollection), 400);
    const noPath = await routeRequest({ method: 'POST', pathname: '/corpus/remove', query: new URLSearchParams(), headers: {}, body: { collection: 'c' } }, options);
    assert.equal(statusOf(noPath), 400);
  } finally {
    svc.close();
  }
});

test('POST /corpus/reindex forces a source back through the engine', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    await ingestUpload(svc, { inboxFolder: dir, collection: 'docs', filename: 'a.md', content: '# A\n\nFirst body.' });
    // A plain re-ingest would skip it, because the content hash has not changed.
    const skipped = await ingestFile(svc, { filePath: join(dir, 'docs', 'a.md'), collection: 'docs', root: dir });
    assert.equal(skipped.status, 'skipped');
    const forced = await routeRequest(
      { method: 'POST', pathname: '/corpus/reindex', query: new URLSearchParams(), headers: {}, body: { collection: 'docs', filename: 'a.md' } },
      corpusOptions(svc, dir),
    );
    assert.equal(statusOf(forced), 200);
    assert.equal(bodyOf(forced).status, 'ingested');
    assert.equal(bodyOf(forced).ok, true);
  } finally {
    svc.close();
    done();
  }
});

test('POST /corpus/reindex reports a missing file as a client error', async () => {
  const { dir, done } = scratch();
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/corpus/reindex', query: new URLSearchParams(), headers: {}, body: { collection: 'docs', filename: 'ghost.md' } },
      corpusOptions(svc, dir),
    );
    assert.equal(statusOf(response), 200, 'the route answers; the body carries the failure');
    assert.equal(bodyOf(response).ok, false);
    assert.equal(bodyOf(response).status, 'failed');
  } finally {
    svc.close();
    done();
  }
});

test('POST /corpus/reindex answers 503 when unwired', async () => {
  const svc = new MemoryService({ inMemory: true });
  try {
    const response = await routeRequest(
      { method: 'POST', pathname: '/corpus/reindex', query: new URLSearchParams(), headers: {}, body: {} },
      { service: svc, enabled: true, allowAnonymous: true, maxSearchLimit: 20 },
    );
    assert.equal(statusOf(response), 503);
  } finally {
    svc.close();
  }
});
