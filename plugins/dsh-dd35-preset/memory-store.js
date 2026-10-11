/**
 * Turn-memory storage: transcripts, the scene index, and the shared text
 * search engine.
 *
 * Layout:
 *   campaign/<id>/events/transcripts/NNNN_turn.md   one file per completed turn
 *   campaign/<id>/events/memory_index.json          the scene index (incremental)
 *
 * The transcript is the durable record of what was actually said **and** of the
 * scene state the turn closed in; the index is a derived convenience that can
 * always be rebuilt from the transcripts, so a lost or corrupt index is never
 * data loss. There is deliberately no second turn file: a hand-maintained
 * `campaign_log.md` used to duplicate this content, and the two drifted.
 *
 * Nothing here writes to a campaign except `writeTranscript` and the index
 * writers — the read paths (`loadTranscripts`, `readMemoryIndex`) are safe to
 * call from a tool at any time.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, eventsDir, transcriptsDir, workspace, writeJson, readJson } from './state-store.js'

export function memoryIndexPath(id) { return join(eventsDir(id), 'memory_index.json') }

export const UNTITLED = 'Untitled Scene'

// ---- transcripts ---------------------------------------------------------

/**
 * Write one completed turn's transcript. Returns the file name.
 *
 * This is the campaign's only turn record. It holds both what was said and the
 * scene state at the end of the turn, so no other file is needed and the index can
 * be rebuilt from it.
 *
 * The header carries the turn's clock reading as well as its title, so the
 * campaign's date span is also derivable from the transcripts alone.
 *
 * State values are collapsed to a single line because `parseTranscript` reads the
 * header line by line; a micro-state containing a newline would otherwise swallow
 * every field after it.
 */
export function writeTranscript(id, {
  number, title, date, location, entities, microState, pendingAction, playerInput, dmOutput,
}) {
  const dir = transcriptsDir(id)
  ensureDir(dir)
  const file = `${String(number).padStart(4, '0')}_turn.md`
  const head = [`# Turn ${String(number).padStart(4, '0')} — ${title || UNTITLED}`]
  if (date) head.push(`- Date: ${date}`)
  if (location) head.push(`- Location: ${location}`)
  if (entities && entities.length > 0) head.push(`- Entities: ${entities.join(', ')}`)
  if (microState) head.push(`- Micro-State: ${oneLine(microState)}`)
  if (pendingAction) head.push(`- Pending Action: ${oneLine(pendingAction)}`)
  writeFileSync(join(dir, file),
    `${head.join('\n')}\n\n## Player\n${playerInput ?? ''}\n\n## DM\n${dmOutput ?? ''}\n`)
  return file
}

/** Collapse a state value onto one line, since the header is parsed per line. */
function oneLine(value) {
  return String(value).replace(/\s*\n\s*/gu, ' ').trim()
}

/**
 * Index of the heading's own line, searching from the end.
 *
 * The **last** occurrence is the real section start, because a real transcript's
 * prose can quote a heading (turn 1 opens with `## User Prompt` before the actual
 * sections) but cannot contain one after the section has begun.
 */
function lastHeadingIndex(text, heading) {
  const pattern = new RegExp(`^##\\s*${heading}\\s*$`, 'gm')
  let index = -1
  let end = -1
  for (const match of text.matchAll(pattern)) {
    index = match.index
    end = match.index + match[0].length
  }
  return index === -1 ? null : { index, end }
}


/**
 * The player's and the DM's sections.
 *
 * Anchored on the **section order** (`## Player` then `## DM`) rather than by
 * counting level-2 headings, because a player message may itself contain `## `
 * markdown — a plan, a contingency, a quoted rule — and a heading count cannot
 * tell that apart from a real boundary.
 *
 * The DM section deliberately runs to the **end of file** and is not bounded by
 * a following heading. A turn routinely ends with the DM's own `###` subsection
 * (turn 142 closes on `### 📍 Current Situation`), so treating a later heading as
 * a boundary would throw away the very prose this parser exists to preserve.
 *
 * Known limit: a player message that itself contains a line reading `## DM` is
 * indistinguishable from the real heading. That is inherent to a markdown
 * transcript and is not worth a sentinel to fix.
 */
function bodies(text) {
  const player = lastHeadingIndex(text, 'Player')
  if (player === null) return { player: null, dm: null }
  const dm = lastHeadingIndex(text, 'DM')
  // The player's body runs to the DM heading itself — not to the next heading of
  // any kind, because the player's own message may contain `## ` markdown.
  const playerEnd = dm === null || dm.index < player.end ? text.length : dm.index
  return {
    player: text.slice(player.end, playerEnd).trim(),
    dm: dm === null ? null : text.slice(dm.end).trim(),
  }
}

/** Parse one transcript file into its header fields and its two messages. */
export function parseTranscript(text, number) {
  const titleMatch = text.match(/^#\s*Turn\s+\d+\s*[—–-]\s*(.+)$/m)
  const dateMatch = text.match(/^-\s*Date:\s*(.+)$/m)
  const locationMatch = text.match(/^-\s*Location:\s*(.+)$/m)
  const entitiesMatch = text.match(/^-\s*Entities:\s*(.+)$/m)
  const microMatch = text.match(/^-\s*Micro-State:\s*(.+)$/m)
  const pendingMatch = text.match(/^-\s*Pending Action:\s*(.+)$/m)
  const clean = (value) => (value === undefined ? undefined : value.trim())
  const { player, dm } = bodies(text)
  return {
    number,
    title: clean(titleMatch?.[1]) || UNTITLED,
    date: clean(dateMatch?.[1]) ?? null,
    location: clean(locationMatch?.[1]) ?? null,
    entities: entitiesMatch === null
      ? []
      : entitiesMatch[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0),
    microState: clean(microMatch?.[1]) ?? null,
    pendingAction: clean(pendingMatch?.[1]) ?? null,
    player: player ?? '',
    dm: dm ?? '',
  }
}

/** Transcript file names in turn order, against an explicit root. */
export function transcriptFilesIn(root, id) {
  if (typeof root !== 'string' || root.length === 0) return []
  const dir = join(root, 'campaign', id, 'events', 'transcripts')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((file) => ({ file, match: file.match(/^(\d+)/) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ file: entry.file, number: Number.parseInt(entry.match[1], 10) }))
    .sort((a, b) => a.number - b.number)
}

/** Transcript file names in turn order. Turn numbers come from the name, not the position. */
export function transcriptFiles(id) {
  return transcriptFilesIn(workspace(), id)
}

/**
 * One parsed turn's messages in recall form: stable id, role, text, and the scene
 * snapshot the turn closed in.
 *
 * The id shape (`NNNN:player` / `NNNN:dm`) is defined only here, so a listing that
 * offers ids and a search that returns them cannot disagree. Both messages carry
 * the turn's scene snapshot, so recalling either one reports the state at the end
 * of that turn.
 */
export function messagesOf(turn) {
  const meta = {
    turn: turn.number,
    title: turn.title,
    date: turn.date,
    location: turn.location,
    microState: turn.microState,
    pendingAction: turn.pendingAction,
  }
  const out = []
  if (turn.player) out.push({ id: `${pad(turn.number)}:player`, role: 'player', text: turn.player, ...meta })
  if (turn.dm) out.push({ id: `${pad(turn.number)}:dm`, role: 'dm', text: turn.dm, ...meta })
  return out
}

/**
 * Parsed transcripts plus a flat, message-level view of them, against an
 * **explicit root**.
 *
 * Cached by workspace, directory mtime and file mtime so a tool call does not
 * re-read the whole campaign, and invalidated the moment a transcript is
 * written. The workspace is part of the key because two sessions can share a
 * campaign id in different folders.
 *
 * The root is a parameter rather than the bound {@link workspace} because prompt
 * assembly also reads transcripts — for the known-cast recency map — and assembly
 * runs before any tool call has bound a workspace.
 */
let cache = { root: null, id: null, stamp: '', turns: [], messages: [] }

function dirStampIn(root, id) {
  const dir = join(root, 'campaign', id, 'events', 'transcripts')
  if (!existsSync(dir)) return 'absent'
  return readdirSync(dir).sort()
    .map((file) => `${file}:${statSync(join(dir, file)).mtimeMs}:${statSync(join(dir, file)).size}`)
    .join('|')
}

export function loadTranscriptsIn(root, id) {
  if (typeof root !== 'string' || root.length === 0) return { turns: [], messages: [] }
  const stamp = dirStampIn(root, id)
  if (cache.root === root && cache.id === id && cache.stamp === stamp) return cache
  const dir = join(root, 'campaign', id, 'events', 'transcripts')
  const turns = transcriptFilesIn(root, id).map(({ file, number }) =>
    parseTranscript(readFileSync(join(dir, file), 'utf8'), number))
  const messages = []
  for (const turn of turns) messages.push(...messagesOf(turn))
  cache = { root, id, stamp, turns, messages }
  return cache
}

export function loadTranscripts(id) {
  return loadTranscriptsIn(workspace(), id)
}

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * How recently each named actor appears in the campaign's own text.
 *
 * This is the derived half of the cast-tier decision (spec §11.5). A sheet's id
 * is almost never what the prose uses — searching `events/transcripts` for
 * `dire_wolf_1` finds nothing while "Dire Wolf (Alpha Pair, male)" occurs in five
 * turns — so a candidate is matched on its id *and* its display name, with any
 * parenthetical qualifier stripped (`Gareth (Watch Sergeant…)` → `Gareth`).
 *
 * Cheap enough to run per prompt assembly: the parsed transcripts are already
 * cached on directory stamp, so this is one regex pass over in-memory text.
 *
 * @param root - explicit workspace root, because prompt assembly runs unbound.
 * @param id - campaign identifier.
 * @param candidates - `[{ id, name }]`, typically the campaign's actor sheets.
 * @returns a Map of candidate id → `{ lastTurn, turns }`.
 */
export function lastSeenByActor(root, id, candidates) {
  const out = new Map()
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return out
  const { turns } = loadTranscriptsIn(root, id)
  if (turns.length === 0) return out

  for (const candidate of list) {
    const needles = [candidate.id, String(candidate.name ?? '').split(' (')[0].trim()]
      .filter((needle) => typeof needle === 'string' && needle.length > 2)
      .map(escapeRe)
    if (needles.length === 0) {
      out.set(candidate.id, { lastTurn: null, turns: 0 })
      continue
    }
    const pattern = new RegExp(`\\b(?:${needles.join('|')})\\b`, 'i')
    let lastTurn = null
    let count = 0
    for (const turn of turns) {
      if (pattern.test(`${turn.player}\n${turn.dm}`)) {
        lastTurn = turn.number
        count += 1
      }
    }
    out.set(candidate.id, { lastTurn, turns: count })
  }
  return out
}

/** Drop the parse cache — called on plugin reload so a stale workspace is never served. */
export function resetMemoryCache() { cache = { root: null, id: null, stamp: '', turns: [], messages: [] } }

function pad(n) { return String(n).padStart(4, '0') }

/** Turn numbers of a bounded range, inclusive, clipped to what exists. */
export function selectTurns(turns, fromTurn, toTurn) {
  return turns.filter((turn) =>
    (fromTurn === undefined || turn.number >= fromTurn)
    && (toTurn === undefined || turn.number <= toTurn))
}

// ---- the scene index -----------------------------------------------------

function emptyIndex(id) {
  return { campaign: id, total_turns: 0, first_date: null, last_date: null, segments: [], updated_at: null }
}

/**
 * Fold one completed turn into the index.
 *
 * Only the *last* segment is compared, deliberately: leaving a place at turn
 * 102 and returning at turn 300 opens a second segment rather than merging two
 * separate visits into one misleading range.
 */
export function recordTurn(index, { turn, title, date }) {
  const clean = (title ?? '').trim()
  const last = index.segments.at(-1)
  // An untitled turn inherits the running title, so one missed update_scene
  // does not shatter a scene into one-turn rows.
  const effective = clean || last?.title || UNTITLED

  index.total_turns = Math.max(index.total_turns, turn)
  if (date) {
    index.last_date = date
    index.first_date ??= date
  }
  if (last && last.title === effective) last.end = turn
  else index.segments.push({ start: turn, end: turn, title: effective })
  return index
}

/** Rebuild the index from the transcripts. The repair path, and the migration path for old campaigns. */
export function rebuildIndex(id) {
  const index = emptyIndex(id)
  for (const turn of loadTranscripts(id).turns) {
    recordTurn(index, { turn: turn.number, title: turn.title, date: turn.date })
  }
  index.updated_at = new Date().toISOString()
  writeJson(memoryIndexPath(id), index)
  return index
}

/**
 * Read the index, rebuilding it when absent or when it is behind the
 * transcripts. A campaign played before this feature existed simply has no
 * index file and gets one on first read.
 */
export function readMemoryIndex(id, { rebuild = false } = {}) {
  const stored = rebuild ? null : readJson(memoryIndexPath(id))
  const turns = loadTranscripts(id).turns
  const newest = turns.at(-1)?.number ?? 0
  if (!stored || (stored.total_turns ?? 0) < newest || (stored.segments ?? []).length === 0) {
    if (turns.length === 0) return stored ?? emptyIndex(id)
    return rebuildIndex(id)
  }
  return stored
}

/** Append one turn to the index on disk, in O(1) — never by rescanning. */
export function commitTurnToIndex(id, entry) {
  const index = readJson(memoryIndexPath(id)) ?? emptyIndex(id)
  // A gap (a lost transcript, a repair) makes the incremental view wrong, so
  // fall back to a full rebuild rather than write a bogus range.
  if ((index.total_turns ?? 0) !== entry.turn - 1) return rebuildIndex(id)
  recordTurn(index, entry)
  index.updated_at = new Date().toISOString()
  writeJson(memoryIndexPath(id), index)
  return index
}

const WINDOW = 25

/** Group a wholly-untitled campaign into fixed windows, so its index is still a map. */
function windowize(segments) {
  if (segments.length === 0 || segments.some((segment) => segment.title !== UNTITLED)) return segments
  const out = []
  for (const segment of segments) {
    const current = out.at(-1)
    if (current && segment.end - current.start + 1 <= WINDOW) current.end = segment.end
    else out.push({ start: segment.start, end: segment.end, title: UNTITLED })
  }
  return out
}

/**
 * Render the index as the markdown the model reads.
 *
 * Bounded: past `maxRows` the middle is elided, showing the opening scenes and
 * the most recent ones — the two ends a model actually orients by.
 */
export function renderMemoryIndex(index, { maxRows = 13 } = {}) {
  const total = index.total_turns ?? 0
  if (total === 0) return '## Turn Memory\nNo turns recorded yet.'
  const segments = windowize(index.segments ?? [])
  const span = index.first_date && index.last_date
    ? ` · ${index.first_date} → ${index.last_date}`
    : ''
  const rows = []
  if (segments.length <= maxRows) {
    for (const segment of segments) rows.push({ range: `${segment.start}–${segment.end}`, title: segment.title })
  } else {
    const head = segments.slice(0, 3)
    const tail = segments.slice(-10)
    const elided = segments.slice(head.length, segments.length - tail.length)
    for (const segment of head) rows.push({ range: `${segment.start}–${segment.end}`, title: segment.title })
    rows.push({ range: '…', title: `… ${elided.length} scenes elided (turns ${elided[0].start}–${elided.at(-1).end}) …` })
    for (const segment of tail) rows.push({ range: `${segment.start}–${segment.end}`, title: segment.title })
  }
  const rangeWidth = Math.max('turns'.length, ...rows.map((r) => r.range.length))
  const titleWidth = Math.max('scene'.length, ...rows.map((r) => r.title.length))
  const lines = [
    '## Turn Memory',
    `${total} turns stored${span} · searchable by keyword`,
    '',
    `| ${'turns'.padEnd(rangeWidth)} | ${'scene'.padEnd(titleWidth)} |`,
    `|${'-'.repeat(rangeWidth + 2)}|${'-'.repeat(titleWidth + 2)}|`,
  ]
  for (const r of rows) lines.push(`| ${r.range.padEnd(rangeWidth)} | ${r.title.padEnd(titleWidth)} |`)
  lines.push('', 'Search with grep_memories; read hits with fetch_memories.')
  return lines.join('\n')
}

// ---- the shared text search engine (also used by reference search) --------

/**
 * Parse a query into positive and negative clauses.
 *
 *   bare terms          all must match (AND), case-insensitive
 *   "quoted phrase"     exact substring
 *   /regex/             JavaScript regular expression
 *   -term  -"phrase"  -/regex/     must NOT match
 *
 * Returns `{ error }` instead of throwing so a tool can hand the model a
 * usable message rather than a stack trace.
 */
export function parseQuery(query) {
  const clauses = []
  const source = String(query ?? '').trim()
  if (source === '') return { clauses, error: 'query is empty' }
  let i = 0
  while (i < source.length) {
    if (/\s/.test(source[i])) { i += 1; continue }
    let negated = false
    if (source[i] === '-' && i + 1 < source.length && !/\s/.test(source[i + 1])) { negated = true; i += 1 }
    const char = source[i]
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, i + 1)
      if (end === -1) return { clauses, error: `unterminated quoted phrase at position ${i}` }
      const value = source.slice(i + 1, end)
      if (value) clauses.push({ kind: 'phrase', value: value.toLowerCase(), source: `${negated ? '-' : ''}${char}${value}${char}`, negated })
      i = end + 1
      continue
    }
    if (char === '/') {
      const end = source.indexOf('/', i + 1)
      if (end === -1) return { clauses, error: `unterminated regex at position ${i}` }
      const body = source.slice(i + 1, end)
      try {
        clauses.push({ kind: 'regex', value: new RegExp(body, 'gi'), source: `${negated ? '-' : ''}/${body}/`, negated })
      } catch (error) {
        return { clauses, error: `invalid regex /${body}/: ${error.message}` }
      }
      i = end + 1
      continue
    }
    let end = i
    while (end < source.length && !/\s/.test(source[end])) end += 1
    const word = source.slice(i, end).replace(/^["']|["']$/g, '')
    if (word) clauses.push({ kind: 'term', value: word.toLowerCase(), source: `${negated ? '-' : ''}${word}`, negated })
    i = end
  }
  if (!clauses.some((clause) => !clause.negated)) {
    return { clauses, error: 'query has only negated terms, so results are unranked' }
  }
  return { clauses }
}

/**
 * Score one text against parsed clauses.
 *
 * `hits` counts occurrences of the positive clauses; any negative clause that
 * matches rejects the text outright. Returns null when the text does not match,
 * so callers can filter with `.filter(Boolean)`.
 */
export function matchQuery(text, clauses) {
  const haystack = String(text ?? '')
  const lower = haystack.toLowerCase()
  let hits = 0
  const matched = []
  for (const clause of clauses) {
    if (clause.kind === 'regex') {
      clause.value.lastIndex = 0
      const found = haystack.match(clause.value)
      const count = found ? found.length : 0
      if (clause.negated) { if (count > 0) return null; continue }
      if (count === 0) return null
      hits += count
      matched.push(found[0])
      continue
    }
    const needle = clause.value
    let count = 0
    let at = lower.indexOf(needle)
    while (at !== -1) { count += 1; at = lower.indexOf(needle, at + needle.length) }
    if (clause.negated) { if (count > 0) return null; continue }
    if (count === 0) return null
    hits += count
    matched.push(needle)
  }
  return { hits, matched }
}

/** The first matched position in `text`, for excerpting. Case-insensitive. */
export function firstMatchIndex(text, clauses) {
  const lower = String(text).toLowerCase()
  let best = -1
  for (const clause of clauses) {
    if (clause.negated) continue
    let at
    if (clause.kind === 'regex') {
      clause.value.lastIndex = 0
      const m = clause.value.exec(String(text))
      at = m ? m.index : -1
    } else {
      at = lower.indexOf(clause.value)
    }
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  return best
}

/** A window of `text` around `index`, ellipsized at both ends. */
export function excerpt(text, index, pad = 150) {
  const source = String(text ?? '')
  if (index < 0) return clip(source, pad * 2)
  const start = Math.max(0, index - pad)
  const end = Math.min(source.length, index + pad)
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`
}

/** Clip to `max` characters with an ellipsis. */
export function clip(text, max) {
  const source = String(text ?? '')
  return source.length <= max ? source : `${source.slice(0, max - 1)}…`
}
