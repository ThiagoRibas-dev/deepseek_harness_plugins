/**
 * Database schema and DDL definitions for dsh-memory.
 *
 * Implements Tier 1 Core Memories, Tier 2 Episodic Memories with FTS5,
 * and Tier 4 Offline Reference Corpus with FTS5.
 *
 * Designed for Node.js built-in node:sqlite (DatabaseSync) on SQLite 3.53.4.
 *
 * @module @local/dsh-memory/schema
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_DDL = `
-- Pragmas for integrity and concurrency
PRAGMA foreign_keys = ON;

-- Metadata tracking
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tier 1: Core Memories (persistent instructions & user directives)
CREATE TABLE IF NOT EXISTS core_memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  directive TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_core_memories_ns ON core_memories(namespace, priority DESC, updated_at DESC);

-- Tier 2: Episodic Memories
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  status TEXT NOT NULL CHECK(status IN ('provisional', 'canon', 'rejected')),
  turn_ref TEXT,
  fts_only INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  -- Which encoder produced the vector. Vectors from different networks are not
  -- comparable, so this decides whether a dense comparison means anything at all.
  embedding_model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_ns_status ON memories(namespace, status, created_at DESC);

-- FTS5 External Content Table for Episodic Memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  summary,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers keeping memories_fts synchronized with memories
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, coalesce(new.summary, ''), coalesce(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''), coalesce(old.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''), coalesce(old.tags, ''));
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, coalesce(new.summary, ''), coalesce(new.tags, ''));
END;

-- Tier 4: Reference Corpus Chunks
CREATE TABLE IF NOT EXISTS corpus_chunks (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  source_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  text_ratio REAL NOT NULL,
  fts_only INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedding_model TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(collection, source_path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_corpus_col ON corpus_chunks(collection, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_corpus_source ON corpus_chunks(collection, source_path);

-- Ingestion registry: one row per ingested source.
--
-- Kept beside the chunks rather than as a column on them: a source's hash
-- describes the whole document, and a chunk has no document to hash. This is
-- also additive, so an existing database picks it up without a table rewrite.
CREATE TABLE IF NOT EXISTS corpus_sources (
  collection TEXT NOT NULL,
  source_path TEXT NOT NULL,
  title TEXT,
  origin TEXT NOT NULL DEFAULT 'workspace',
  namespace TEXT,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (collection, source_path)
);
CREATE INDEX IF NOT EXISTS idx_corpus_sources_origin ON corpus_sources(collection, origin);
CREATE INDEX IF NOT EXISTS idx_corpus_sources_ns ON corpus_sources(namespace, ingested_at DESC);

-- FTS5 External Content Table for Corpus Chunks
CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
  title,
  content,
  content='corpus_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers keeping corpus_fts synchronized with corpus_chunks
CREATE TRIGGER IF NOT EXISTS corpus_ai AFTER INSERT ON corpus_chunks BEGIN
  INSERT INTO corpus_fts(rowid, title, content)
  VALUES (new.rowid, coalesce(new.title, ''), new.content);
END;

CREATE TRIGGER IF NOT EXISTS corpus_ad AFTER DELETE ON corpus_chunks BEGIN
  INSERT INTO corpus_fts(corpus_fts, rowid, title, content)
  VALUES ('delete', old.rowid, coalesce(old.title, ''), old.content);
END;

CREATE TRIGGER IF NOT EXISTS corpus_au AFTER UPDATE ON corpus_chunks BEGIN
  INSERT INTO corpus_fts(corpus_fts, rowid, title, content)
  VALUES ('delete', old.rowid, coalesce(old.title, ''), old.content);
  INSERT INTO corpus_fts(rowid, title, content)
  VALUES (new.rowid, coalesce(new.title, ''), new.content);
END;
`;

/**
 * Initialize database schema, pragmas, and version stamp.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initSchema(db) {
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // In-memory or temporary databases might not switch to WAL; ignore
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_DDL);
  migrate(db);

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'");
  const current = getMeta.get();
  if (!current) {
    const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)");
    setMeta.run(String(SCHEMA_VERSION));
  } else if (current.value !== String(SCHEMA_VERSION)) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }
}

/**
 * Add a column when the table predates it.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so a
 * database made before v3 has no `embedding_model` column and every query naming
 * it would fail. The check is by `PRAGMA table_info`, which makes this safe to
 * run on every open.
 */
function ensureColumn(db, table, column, ddl) {
  let columns;
  try {
    columns = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return;
  }
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** Bring an older database up to the current shape. Additive only. */
function migrate(db) {
  ensureColumn(db, 'memories', 'embedding_model', 'embedding_model TEXT');
  ensureColumn(db, 'corpus_chunks', 'embedding_model', 'embedding_model TEXT');
}

/**
 * Sanitize a search string into a safe FTS5 query with quoted tokens.
 *
 * Strips punctuation and syntax operators that trigger FTS5 syntax errors
 * (colons, hyphens, parentheses, quotes, asterisks) while preserving
 * meaningful alphanumeric word tokens.
 *
 * @param {string} query Raw user query string
 * @param {object} [options]
 * @param {'AND'|'OR'} [options.mode='AND'] Boolean conjunction between tokens
 * @param {boolean} [options.prefix=false] Whether to append '*' for prefix search
 * @returns {string|null} Sanitized FTS5 MATCH expression, or null if no tokens
 */
export function sanitizeFtsQuery(query, { mode = 'AND', prefix = false } = {}) {
  if (typeof query !== 'string') return null;
  // Replace syntax characters with spaces
  const cleaned = query.replace(/[\x00-\x1f"'*^:()\-+~{}[\]]/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return null;

  const formatted = tokens.map(t => {
    const escaped = t.replace(/"/g, '""');
    return prefix ? `"${escaped}"*` : `"${escaped}"`;
  });

  const sep = mode === 'OR' ? ' OR ' : ' ';
  return formatted.join(sep);
}
