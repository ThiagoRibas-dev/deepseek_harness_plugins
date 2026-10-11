/**
 * D&D 3.5e DM — oracle tables.
 *
 * The tables in `tables.json` are generated from `rules/dm_aids/tables/*.csv`. They
 * fall into three kinds, and the kind decides how a tool may draw from them
 * (spec: `docs/dd35-future-improvements.md`, FI-18/FI-19):
 *
 *   - **single vector** — one meaningful column, many rows
 *     (`keywords_table` 792 rows, `monster_intentions`, `monster_reactions`).
 *     Drawing several times is the point: unrelated words the DM reconciles.
 *   - **coherent row** — the columns belong together (`plot_hook_generator`,
 *     `dungeon_crawler`, `hex_crawler`, `npc_generator`, `muse_*`, the boon/bane
 *     tables). **One roll, never more**: the shipped generators drew once per
 *     field on the same table, so a room's location, encounter, object and exits
 *     were unrelated to each other.
 *   - **answer lookup** — a bounded question with one value
 *     (`oracle_table`, `dc_difficulty`).
 *
 * This module lives apart from `tools.js` because two consumers need the same
 * read path: the oracle tools the DM calls, and the scene-change injector that
 * rolls on its own. One implementation, two consumers.
 */
import { readFileSync } from 'node:fs'

const TABLES = JSON.parse(readFileSync(new URL('./tables.json', import.meta.url), 'utf8'))

/** Columns that carry a die result rather than content. */
const ROLL_COLUMNS = /^(Roll|roll|d20|d6|d12|Range|MinRoll|MaxRoll|Card_Value|D6_Roll)$/

export function table(name) {
  return TABLES[name] ?? []
}

export function tableNames() {
  return Object.keys(TABLES).sort()
}

/**
 * The columns of a table that hold content, excluding its die-result column.
 *
 * Union across every row, not just the first: a partially-parsed CSV leaves a
 * trailing `"null"` field on some rows only (`npc_generator.csv` is the live
 * example), so a first-row view can miss a column that a later row carries.
 * Nullish keys are dropped — they are a parse artifact, not data.
 */
export function contentColumns(name) {
  const rows = table(name)
  if (rows.length === 0) return []
  const columns = new Set()
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (ROLL_COLUMNS.test(column)) continue
      if (column === 'null' || column === 'undefined' || column === '') continue
      columns.add(column)
    }
  }
  return [...columns]
}

/**
 * Tables a **multi-vector** draw may use.
 *
 * Restricted to single-vector sources plus the focus and muse columns. Drawing
 * rows from a coherent-row table is the incoherence bug, so it is refused here
 * rather than left to each caller to remember.
 */
export const VECTOR_TABLES = Object.freeze({
  keywords: { table: 'keywords_table.csv', column: 'Keyword' },
  action: { table: 'focus_tables.csv', column: 'Action_Focus' },
  detail: { table: 'focus_tables.csv', column: 'Detail_Focus' },
  topic: { table: 'focus_tables.csv', column: 'Topic_Focus' },
  muse_upright: { table: 'muse_upright.csv', column: null },
  muse_inverted: { table: 'muse_inverted.csv', column: null },
})

/** The default consultation set: 3 keywords + action/detail/topic + one muse column. */
export const DEFAULT_VECTOR_SET = Object.freeze(['keywords', 'keywords', 'keywords', 'action', 'detail', 'topic', 'muse'])

// ---- draws ---------------------------------------------------------------

/**
 * A row chosen uniformly at random, with the RNG supplied by the caller.
 *
 * This is the general draw. Range lookup is only sound on a table whose printed
 * ranges actually cover its die — see the coverage table in `oracles.js`.
 */
export function rowAt(name, random = Math.random) {
  const rows = table(name)
  if (rows.length === 0) return null
  return rows[Math.floor(random() * rows.length)]
}

/** Inclusive numeric range from a cell like `"3-4"`, `"12"`, or `"11+"`. */
function rangeOf(value) {
  const text = String(value).trim()
  const plus = text.match(/^(\d+)\s*\+$/)
  if (plus) return [Number(plus[1]), Number.POSITIVE_INFINITY]
  const pair = text.match(/^(\d+)\s*-\s*(\d+)$/)
  if (pair) return [Number(pair[1]), Number(pair[2])]
  const single = Number(text)
  return Number.isFinite(single) ? [single, single] : null
}

/**
 * One row by die result.
 *
 * Two shapes exist in this corpus:
 *   - a **single range column** (`"3-4"`, `"12"`, `"11+"`) — `column` only;
 *   - **separate min/max columns** (`oracle_table.csv` uses `MinRoll`/`MaxRoll`) —
 *     pass `maxColumn` as well.
 *
 * @returns `{ row, matched }` — `matched` is false when the roll fell in no row.
 */
export function rowByRange(name, column, roll, maxColumn = null) {
  for (const row of table(name)) {
    const value = row[column]
    if (value === undefined) continue
    let range
    if (maxColumn !== null) {
      const min = Number(value)
      const max = Number(row[maxColumn])
      range = Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null
    } else {
      range = rangeOf(value)
    }
    if (range === null) continue
    if (range[0] <= roll && roll <= range[1]) return { row, matched: true }
  }
  return { row: null, matched: false }
}

/**
 * One row weighted by its printed range, across *every* range column.
 *
 * Used by the boon/bane tables, where each row covers a span of a d100 and some
 * rows are twice as likely as others as a result.
 */
export function weightedRow(name, rangeColumns, roll) {
  for (const column of rangeColumns) {
    const { row, matched } = rowByRange(name, column, roll)
    if (matched) return row
  }
  return null
}

/**
 * One draw from a single-vector table, or one column of a coherent-row table.
 * @returns the drawn text, or null when the table or column is absent.
 */
export function drawVector(sourceName, { uprightOnly = false, random = Math.random } = {}) {
  let key = sourceName
  if (key === 'muse') key = uprightOnly ? 'muse_upright' : (random() < 0.5 ? 'muse_upright' : 'muse_inverted')
  const source = VECTOR_TABLES[key]
  if (source === undefined) return null
  const row = rowAt(source.table, random)
  if (row === null) return null
  if (source.column !== null) return { source: key, value: row[source.column] ?? null }
  // A muse row carries four columns; draw one, so a consultation returns words
  // rather than a paragraph.
  const columns = contentColumns(source.table)
  const column = columns[Math.floor(random() * columns.length)]
  return { source: key, column, value: row[column] ?? null }
}

// ---- seeded randomness ---------------------------------------------------

/**
 * A deterministic stream, for rolls that must be reproducible from a key.
 *
 * The scene-change injector rolls once per scene but renders **per step**, so a
 * `Math.random()` draw would hand the DM different vectors on every step of the
 * same scene. Seeding by turn number makes the result stable within the turn and
 * fresh across turns, and means nothing has to be persisted to reproduce it.
 *
 * mulberry32: 32-bit state, one multiply-xor round, adequate for table indices
 * and small enough to keep in this file rather than in `dice.js` — which is
 * deliberately `Math.random`-based for real play.
 */
export function seededRandom(seed) {
  let state = (Number(seed) >>> 0) + 0x9e3779b9
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
