/**
 * Workspace ingestion CLI tests.
 *
 * `main` is called with injected writers and a temporary database, so the suite
 * exercises argument handling and the exit codes a script would branch on
 * without printing to the real console or touching a real corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseArgs, main, defaultIngestFolder } from '../../../scripts/ingest-corpus.mjs';
import { MemoryService } from '../service.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-cli-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Capture out/err lines and run main against one database. */
async function run(argv, dir) {
  const out = [];
  const err = [];
  const code = await main(
    [...argv, '--storage', join(dir, 'memory.db')],
    { out: (line) => out.push(String(line)), err: (line) => err.push(String(line)) },
  );
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
}

function seed(dir) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'corpus'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'alpha.md'), '# Alpha\n\nAlpha document about memory retrieval.\n');
  writeFileSync(join(dir, 'corpus', 'beta.md'), '# Beta\n\nBeta document about ranking.\n');
  writeFileSync(join(dir, 'docs', 'blob.md'), Buffer.from([0x61, 0x00, 0x62]));
}

test('parseArgs reads flags, repeats, and positional paths', () => {
  const options = parseArgs(['--collection', 'docs', '--dry-run', 'docs/', 'README.md']);
  assert.equal(options.collection, 'docs');
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.paths, ['docs/', 'README.md']);
});

test('parseArgs defaults to the workspace collection and no inbox', () => {
  const options = parseArgs([]);
  assert.equal(options.collection, 'workspace');
  assert.equal(options.origin, 'workspace');
  assert.equal(options.inbox, false);
  assert.equal(options.paths.length, 0);
});

test('parseArgs refuses an unknown flag and a flag without a value', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['--collection']), /needs a value/);
});

test('main prints usage for --help without touching the database', async () => {
  const { dir, done } = scratch();
  try {
    const { code, text } = await run(['--help'], dir);
    assert.equal(code, 0);
    assert.match(text, /Usage: node scripts\/ingest-corpus\.mjs/);
    assert.equal(existsSync(join(dir, 'memory.db')), false, '--help must not open a database');
  } finally {
    done();
  }
});

test('main rejects an unknown flag with exit code 2', async () => {
  const { dir, done } = scratch();
  try {
    const { code, errText } = await run(['--bogus'], dir);
    assert.equal(code, 2);
    assert.match(errText, /unknown option/);
  } finally {
    done();
  }
});

test('main indexes named paths and reports a summary', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    const { code, text } = await run(['--collection', 'docs', '--root', dir, join(dir, 'docs')], dir);
    assert.equal(code, 0);
    assert.match(text, /collection "docs"/);
    assert.match(text, /indexed 1 chunk\(s\)\s+docs\/alpha\.md/);
    assert.match(text, /unsupported 1/);

    const service = new MemoryService({ storagePath: join(dir, 'memory.db') });
    assert.equal(service.listCorpusSources({ collection: 'docs' }).length, 1);
    service.close();
  } finally {
    done();
  }
});

test('main skips unchanged content on a second run', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    await run(['--collection', 'docs', '--root', dir, join(dir, 'docs')], dir);
    const { text } = await run(['--collection', 'docs', '--root', dir, join(dir, 'docs')], dir);
    assert.match(text, /indexed 0 · skipped 1/);
  } finally {
    done();
  }
});

test('--dry-run reports chunk counts without writing', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    const { code, text } = await run(['--collection', 'docs', '--dry-run', '--root', dir, join(dir, 'docs')], dir);
    assert.equal(code, 0);
    assert.match(text, /dry run:/);
    assert.match(text, /would index 1 chunk\(s\)/);
    const service = new MemoryService({ storagePath: join(dir, 'memory.db') });
    assert.equal(service.listCorpusChunks({ collection: 'docs' }).length, 0);
    service.close();
  } finally {
    done();
  }
});

test('main warns about a named path that does not exist and exits 1', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    const { code, errText } = await run(['--collection', 'docs', join(dir, 'docs'), join(dir, 'ghost')], dir);
    assert.equal(code, 1);
    assert.match(errText, /ghost does not exist/);
  } finally {
    done();
  }
});

test('main exits 1 when nothing it was asked to ingest exists', async () => {
  const { dir, done } = scratch();
  try {
    const { code, errText } = await run(['--collection', 'docs', join(dir, 'ghost')], dir);
    assert.equal(code, 1);
    assert.match(errText, /nothing to ingest/);
  } finally {
    done();
  }
});

test('--json emits one parseable document', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    const { text } = await run(['--collection', 'docs', '--json', '--root', dir, join(dir, 'docs')], dir);
    const payload = JSON.parse(text);
    assert.equal(payload.summary.collection, 'docs');
    assert.equal(payload.summary.ingested, 1);
    assert.ok(Array.isArray(payload.records));
  } finally {
    done();
  }
});

test('--list reads back what was ingested', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    await run(['--collection', 'docs', '--root', dir, join(dir, 'docs')], dir);
    const { code, text } = await run(['--collection', 'docs', '--list'], dir);
    assert.equal(code, 0);
    assert.match(text, /1 source\(s\) in collection "docs"/);
    assert.match(text, /alpha\.md/);
  } finally {
    done();
  }
});

test('--inbox ingests the configured folder alongside the named paths', async () => {
  const { dir, done } = scratch();
  const previous = process.env.DSH_HOME;
  try {
    // The inbox lives under $DSH_HOME, so point that at the scratch directory
    // rather than the real profile.
    process.env.DSH_HOME = dir;
    seed(dir);
    const inbox = defaultIngestFolder();
    mkdirSync(join(inbox, 'sub'), { recursive: true });
    writeFileSync(join(inbox, 'sub', 'upload.md'), '# Upload\n\nAn uploaded handout.\n');
    const { code, text } = await run(['--collection', 'docs', '--inbox', '--root', dir, join(dir, 'docs')], dir);
    assert.equal(code, 0);
    assert.match(text, /upload\.md/);
    assert.match(text, /indexed 2 chunk\(s\)|indexed 1 chunk\(s\)/);
    const service = new MemoryService({ storagePath: join(dir, 'memory.db') });
    assert.equal(service.listCorpusSources({ collection: 'docs' }).length, 2);
    service.close();
    rmSync(inbox, { recursive: true, force: true });
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous;
    done();
  }
});

test('--inbox-only ignores the command-line paths', async () => {
  const { dir, done } = scratch();
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    seed(dir);
    const inbox = defaultIngestFolder();
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'only.md'), '# Only\n\nOnly this one.\n');
    const { code, text } = await run(['--collection', 'inboxed', '--inbox-only', join(dir, 'docs')], dir);
    assert.equal(code, 0);
    assert.match(text, /only\.md/);
    assert.ok(!text.includes('alpha.md'), 'the named path must be ignored under --inbox-only');
    rmSync(inbox, { recursive: true, force: true });
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous;
    done();
  }
});

test('--origin and --namespace are recorded on the source', async () => {
  const { dir, done } = scratch();
  try {
    seed(dir);
    await run(['--collection', 'docs', '--origin', 'upload', '--namespace', 'sess-7', '--root', dir, join(dir, 'docs')], dir);
    const service = new MemoryService({ storagePath: join(dir, 'memory.db') });
    const source = service.getCorpusSource('docs', join('docs', 'alpha.md'));
    assert.equal(source.origin, 'upload');
    assert.equal(source.namespace, 'sess-7');
    service.close();
  } finally {
    done();
  }
});

test('the module path guard resolves the script and its import URL', () => {
  // Guards the `import.meta.url` comparison the CLI uses to decide whether it is
  // being run directly; a mismatch there makes `node scripts/...` a silent no-op.
  const url = new URL('../../../scripts/ingest-corpus.mjs', import.meta.url);
  assert.equal(resolve(url.pathname).endsWith(join('scripts', 'ingest-corpus.mjs')), true);
});
