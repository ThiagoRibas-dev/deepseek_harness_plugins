/**
 * Corpus ingestion: turn documents into searchable chunks, once.
 *
 * One engine serves all four entry points — the workspace CLI, the
 * `ingest_reference` agent tool, transcript capture, and UI uploads — so a
 * document is chunked and deduplicated the same way no matter who supplied it.
 *
 * Re-ingestion is decided by content, not by time: the sha256 of the text is
 * compared against the record left by the previous run, and a match skips the
 * source entirely. Size and mtime were the cheaper test and the wrong one — an
 * edit that preserves both would be missed, and a `touch` would re-embed
 * everything.
 *
 * @module @local/dsh-memory/ingest
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chunkText, deriveTitle, looksBinary } from './chunker.js';

/** Refuse to read a source larger than this; a corpus is documents, not databases. */
export const MAX_SOURCE_BYTES = 2_000_000;

/** Files walked in one run, so a wrong `--path` cannot spin forever. */
export const MAX_FILES_PER_RUN = 2000;

/** Extensions treated as text. Anything else is skipped rather than guessed at. */
export const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.adoc',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.graphql', '.gql',
  '.html', '.htm', '.xml', '.svg', '.css', '.scss', '.less',
  '.csv', '.tsv', '.log',
]);

/** Directories never worth walking. */
export const DEFAULT_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', 'target', '.next', '.cache', '.turbo', 'coverage',
]);

/** sha256 of a document's text, used as the re-ingestion key. */
export function hashContent(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Whether a path is a text document this engine will read.
 *
 * The extension allowlist decides first, and the content's own first kilobyte
 * decides second: a `.md` that is really a binary blob is skipped rather than
 * decoded into noise. Only the head is read here — the full file is read once,
 * later, by whichever caller actually ingests it.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTextFile(filePath) {
  if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return false;
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(1024);
    const read = readSync(fd, head, 0, head.length, 0);
    return !looksBinary(head.subarray(0, read));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** The path a record reports for a file: relative to `root` when it sits inside it. */
function sourcePathFor(filePath, root) {
  if (!root) return resolve(filePath);
  const base = resolve(root);
  const absolute = resolve(filePath);
  return absolute.startsWith(base + sep) ? absolute.slice(base.length + 1) : absolute;
}

/**
 * Walk a directory for ingestable files.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {number} [options.maxFiles=2000]
 * @param {string[]} [options.extensions] Restrict to these extensions
 * @returns {{ files: string[], truncated: boolean }}
 */
export function walkFiles(dir, options = {}) {
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_FILES_PER_RUN);
  const extensions = options.extensions ? new Set(options.extensions.map((e) => e.toLowerCase())) : null;
  const files = [];
  const stack = [resolve(dir)];
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (extensions && !extensions.has(ext)) continue;
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      files.push(full);
    }
    if (truncated) break;
  }
  return { files: files.sort(), truncated };
}

/**
 * Ingest one piece of text.
 *
 * @param {object} service A `MemoryService` (or anything exposing the corpus methods)
 * @param {object} params
 * @param {string} params.content
 * @param {string} params.collection
 * @param {string} params.sourcePath Stable identity of the document
 * @param {string} [params.title]
 * @param {string} [params.origin='workspace'] workspace | session | transcript | upload
 * @param {string} [params.namespace]
 * @param {boolean} [params.force=false] Re-ingest even when the hash matches
 * @param {number} [params.maxChars]
 * @param {number} [params.overlapChars]
 * @returns {Promise<object>} an ingestion record
 */
export async function ingestText(service, params) {
  const {
    content,
    collection,
    sourcePath,
    title = null,
    origin = 'workspace',
    namespace = null,
    force = false,
    maxChars,
    overlapChars,
  } = params;
  if (typeof content !== 'string') throw new Error('ingestText: content must be a string');
  if (!collection) throw new Error('ingestText: collection is required');
  if (!sourcePath) throw new Error('ingestText: sourcePath is required');

  const hash = hashContent(content);
  const existing = service.getCorpusSource(collection, sourcePath);
  if (!force && existing && existing.content_hash === hash) {
    return {
      status: 'skipped',
      reason: 'content unchanged',
      collection,
      sourcePath,
      origin,
      hash,
      bytes: existing.bytes,
      chunkCount: existing.chunk_count,
    };
  }

  const { chunks, truncated, totalChunks } = chunkText(content, { maxChars, overlapChars });
  if (chunks.length === 0) {
    // An empty document has no chunks; drop any stale ones and record nothing,
    // so a later non-empty write is not skipped by a hash for empty content.
    service.deleteCorpusSource(collection, sourcePath);
    return { status: 'empty', reason: 'no text to chunk', collection, sourcePath, origin, hash, bytes: content.length, chunkCount: 0 };
  }

  // Replace, never merge: chunk identity shifts when a document changes, so
  // leftovers from the previous version would surface as ghost hits.
  service.deleteCorpusSource(collection, sourcePath);
  let written = 0;
  for (const chunk of chunks) {
    await service.storeCorpusChunk({
      collection,
      sourcePath,
      chunkIndex: chunk.index,
      title: title ?? deriveTitle(content),
      content: chunk.content,
      textRatio: chunk.textRatio,
      origin,
      namespace,
    });
    written += 1;
  }

  service.upsertCorpusSource({
    collection,
    sourcePath,
    title: title ?? deriveTitle(content),
    origin,
    namespace,
    contentHash: hash,
    bytes: content.length,
    chunkCount: written,
  });

  return {
    status: 'ingested',
    collection,
    sourcePath,
    origin,
    hash,
    bytes: content.length,
    chunkCount: written,
    ...(truncated ? { truncated: true, totalChunks } : {}),
  };
}

/**
 * Ingest one file from disk.
 *
 * @param {object} service
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} params.collection
 * @param {string} [params.origin='workspace']
 * @param {string} [params.namespace]
 * @param {boolean} [params.force=false]
 * @param {string} [params.root] Directory the reported source path is relative to
 * @param {boolean} [params.checkBinary=true] Sniff the content before reading it as text
 * @returns {Promise<object>}
 */
export async function ingestFile(service, params) {
  const { filePath, collection, origin = 'workspace', namespace = null, force = false, root = null, checkBinary = true } = params;
  const sourcePath = sourcePathFor(filePath, root);

  let info;
  try {
    info = statSync(filePath);
  } catch (err) {
    return { status: 'failed', reason: `unreadable: ${err?.code ?? err?.message}`, collection, sourcePath, origin };
  }
  if (!info.isFile()) return { status: 'skipped', reason: 'not a file', collection, sourcePath, origin };
  if (info.size > MAX_SOURCE_BYTES) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds ${MAX_SOURCE_BYTES}`, collection, sourcePath, origin, bytes: info.size };
  }

  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    return { status: 'failed', reason: `unreadable: ${err?.code ?? err?.message}`, collection, sourcePath, origin };
  }
  if (checkBinary && looksBinary(buffer)) {
    return { status: 'binary', reason: 'binary content', collection, sourcePath, origin, bytes: info.size };
  }

  return await ingestText(service, {
    content: buffer.toString('utf8'),
    collection,
    sourcePath,
    title: null,
    origin,
    namespace,
    force,
  });
}

/**
 * Ingest a list of files and directories.
 *
 * Directories are walked; files are taken as given. Failures are reported per
 * source rather than thrown, so one unreadable file does not abandon a run.
 *
 * @param {object} service
 * @param {object} params
 * @param {string[]} params.paths Files or directories
 * @param {string} params.collection
 * @param {string} [params.origin='workspace']
 * @param {string} [params.namespace]
 * @param {boolean} [params.force=false]
 * @param {boolean} [params.dryRun=false] Report what would change without writing
 * @param {number} [params.maxFiles=2000]
 * @returns {Promise<{ records: object[], summary: object }>}
 */
export async function ingestPaths(service, params) {
  const {
    paths, collection, origin = 'workspace', namespace = null,
    force = false, dryRun = false, maxFiles = MAX_FILES_PER_RUN,
    // When a root is given, every reported source path is relative to it. Absent
    // one, paths stay absolute — a direct file and the same file reached through
    // a walk must not end up under two different identities, which is what an
    // implicit per-target root produced.
    root = null,
  } = params;
  const rootDir = root ? resolve(root) : null;

  const targets = [];
  let truncated = false;
  for (const path of paths) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) {
      targets.push({ filePath: absolute, missing: true });
      continue;
    }
    let info;
    try { info = statSync(absolute); } catch { targets.push({ filePath: absolute, missing: true }); continue; }
    if (info.isDirectory()) {
      const walked = walkFiles(absolute, { maxFiles: maxFiles - targets.length });
      truncated = truncated || walked.truncated;
      for (const file of walked.files) targets.push({ filePath: file, root: rootDir });
    } else {
      targets.push({ filePath: absolute, root: rootDir });
    }
  }

  const records = [];
  for (const target of targets) {
    if (target.missing) {
      records.push({ status: 'failed', reason: 'path does not exist', collection, sourcePath: target.filePath, origin });
      continue;
    }
    if (!isTextFile(target.filePath)) {
      // Cheap pre-filter; ingestFile repeats the check on the bytes it reads.
      const ext = extname(target.filePath).toLowerCase();
      records.push({
        status: TEXT_EXTENSIONS.has(ext) ? 'binary' : 'skipped',
        reason: TEXT_EXTENSIONS.has(ext) ? 'binary content' : `extension ${ext || '(none)'} not indexed`,
        collection,
        sourcePath: sourcePathFor(target.filePath, target.root),
        origin,
      });
      continue;
    }
    if (dryRun) {
      let content;
      try { content = readFileSync(target.filePath, 'utf8'); } catch { content = null; }
      if (content === null) {
        records.push({ status: 'failed', reason: 'unreadable', collection, sourcePath: target.filePath, origin });
        continue;
      }
      const hash = hashContent(content);
      const sourcePath = sourcePathFor(target.filePath, target.root);
      const existing = service.getCorpusSource(collection, sourcePath);
      const wouldChange = force || !existing || existing.content_hash !== hash;
      // Chunking here costs no embedding and tells the caller what the run would
      // actually write, which is the number a dry run exists to report.
      const planned = wouldChange ? chunkText(content) : { chunks: [], truncated: false, totalChunks: 0 };
      records.push({
        status: wouldChange ? 'would-ingest' : 'skipped',
        reason: wouldChange ? (existing ? 'content changed' : 'new source') : 'content unchanged',
        collection,
        sourcePath,
        origin,
        hash,
        chunkCount: planned.chunks.length,
        ...(planned.truncated ? { truncated: true, totalChunks: planned.totalChunks } : {}),
      });
      continue;
    }
    records.push(await ingestFile(service, { ...target, collection, origin, namespace, force, root: target.root ?? null }));
  }

  const summary = {
    collection,
    origin,
    dryRun,
    truncated,
    scanned: records.length,
    ingested: records.filter((r) => r.status === 'ingested').length,
    wouldIngest: records.filter((r) => r.status === 'would-ingest').length,
    skipped: records.filter((r) => r.status === 'skipped').length,
    failed: records.filter((r) => r.status === 'failed').length,
    unsupported: records.filter((r) => r.status === 'binary' || r.status === 'too-large').length,
    chunks: records.reduce((n, r) => n + (r.chunkCount ?? 0), 0),
  };
  return { records, summary };
}
