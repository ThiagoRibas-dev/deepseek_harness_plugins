/**
 * UI uploads: write a document into the ingestion inbox, then index it.
 *
 * The file is written first and indexed second, on purpose. The inbox is the
 * durable artefact: a re-run of the workspace CLI picks up anything the indexer
 * missed, and the operator can see what was uploaded by looking in one folder.
 * Indexing straight from the request body would lose both properties.
 *
 * @module @local/dsh-memory/inbox
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { ingestFile, MAX_SOURCE_BYTES, TEXT_EXTENSIONS } from './ingest.js';

/**
 * The configured ingestion folder: `$DSH_HOME/memory-inbox`.
 *
 * One definition, used by the plugin and the workspace CLI, so a file the UI
 * wrote is the file a CLI run finds.
 *
 * @returns {string}
 */
export function defaultIngestFolder() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'memory-inbox');
}

/** Collections are folders under the inbox, so they must be safe path segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/** A filename the inbox will accept: no separators, no traversal, one extension. */
export function sanitizeUploadName(name) {
  const base = basename(String(name ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const collapsed = base.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
  const withoutTraversal = collapsed.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  if (withoutTraversal.length === 0) return null;
  const extension = extname(withoutTraversal).toLowerCase();
  const stem = extension ? withoutTraversal.slice(0, -extension.length) : withoutTraversal;
  const boundedStem = stem.slice(0, 80) || 'upload';
  const boundedExtension = extension.slice(0, 16);
  return `${boundedStem}${boundedExtension}`;
}

/** A collection name that is safe as one folder under the inbox. */
export function sanitizeCollection(name, fallback = 'uploads') {
  const candidate = String(name ?? '').trim();
  return SAFE_SEGMENT.test(candidate) ? candidate : fallback;
}

/**
 * Write an upload into the inbox.
 *
 * @param {object} params
 * @param {string} params.inboxFolder Configured ingestion folder
 * @param {string} params.collection
 * @param {string} params.filename
 * @param {string} params.content
 * @returns {{ path: string, collection: string, filename: string, bytes: number }}
 * @throws {Error} when the name or content is unusable
 */
export function writeUpload({ inboxFolder, collection, filename, content }) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) throw new Error('content is empty');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(`content is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  }
  const safeName = sanitizeUploadName(filename);
  if (safeName === null) throw new Error('filename has no usable characters');
  const extension = extname(safeName).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`extension "${extension || '(none)'}" is not indexed; supported types include .md, .txt, .json, .csv, .py, .ts`);
  }
  const safeCollection = sanitizeCollection(collection);
  const directory = join(inboxFolder, safeCollection);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, safeName);
  writeFileSync(path, content, 'utf8');
  return { path, collection: safeCollection, filename: safeName, bytes };
}

/**
 * Write an upload and index it.
 *
 * A write that succeeds and an index that fails still leaves the file in the
 * inbox, and the result says so rather than pretending nothing happened.
 *
 * @param {object} service
 * @param {object} params
 * @param {string} params.inboxFolder
 * @param {string} params.collection
 * @param {string} params.filename
 * @param {string} params.content
 * @param {string} [params.title]
 * @param {string} [params.namespace]
 * @param {boolean} [params.force=false]
 * @returns {Promise<object>}
 */
export async function ingestUpload(service, params) {
  const written = writeUpload(params);
  const record = await ingestFile(service, {
    filePath: written.path,
    collection: written.collection,
    origin: 'upload',
    namespace: params.namespace ?? null,
    force: params.force === true,
    // The inbox is the root, so the recorded identity is `collection/file.md`
    // rather than an absolute path. That keeps the source list readable, makes
    // removal exact, and matches what `--root` produces for the workspace CLI.
    root: params.inboxFolder,
  });
  return { ...written, record };
}

/**
 * List the files currently sitting in the inbox.
 *
 * @param {string} inboxFolder
 * @param {number} [limit=200]
 * @returns {Array<{ collection: string, filename: string, bytes: number, path: string, ingested: boolean }>}
 */
export function listInbox(inboxFolder, limit = 200) {
  const files = [];
  let collections;
  try {
    collections = readdirSync(inboxFolder, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of collections) {
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
    const directory = join(inboxFolder, entry.name);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of entries) {
      if (files.length >= limit) return files;
      if (!file.isFile()) continue;
      const path = join(directory, file.name);
      let bytes = 0;
      try { bytes = statSync(path).size; } catch { continue; }
      files.push({ collection: entry.name, filename: file.name, bytes, path, ingested: false });
    }
  }
  return files;
}

/**
 * Remove one file from the inbox.
 *
 * @param {string} inboxFolder
 * @param {string} collection
 * @param {string} filename
 * @returns {boolean}
 */
export function removeInboxFile(inboxFolder, collection, filename) {
  const safeCollection = sanitizeCollection(collection, '\u0000invalid');
  // Unlike an upload, a delete refuses a name carrying a path at all: silently
  // acting on the basename would remove a file the caller did not name.
  const raw = String(filename ?? '');
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return false;
  const safeName = sanitizeUploadName(raw);
  if (safeName === null || !SAFE_SEGMENT.test(safeCollection)) return false;
  try {
    rmSync(join(inboxFolder, safeCollection, safeName), { force: true });
    return true;
  } catch {
    return false;
  }
}
