/**
 * Per-session request log for the model-rotation connector.
 *
 * One append-only JSONL file per session, under the plugin's state directory.
 * Each request writes a `start` row, one `failover` row per failed attempt,
 * and an `end` row; the reader groups them back into one row per request.
 *
 * Two properties matter more than detail:
 * - logging must never throw into the request path (a full disk must not fail
 *   a model call), and
 * - a provider error message may quote request content or a credential, so
 *   every stored message is capped and every known secret is redacted before
 *   it reaches disk or the HTTP reader.
 *
 * @module @local/dsh-model-rotation/log
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Longest provider message kept in one row, in characters. */
export const MAX_MESSAGE_CHARS = 2_000

/** Largest file tail the reader will load. */
export const MAX_READ_BYTES = 2_000_000

/** Largest number of request groups one read returns. */
export const MAX_GROUPS = 500

/** Longest captured request body kept for one request, in characters. */
export const MAX_BODY_CHARS = 32_000

/**
 * Turn a session id into a file name that cannot escape the log directory.
 * @param value - session id, branded or plain.
 * @returns a safe file stem.
 */
export function sanitizeSessionId(value) {
  const raw = value === undefined || value === null ? '' : String(value)
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_')
  return safe.length === 0 ? 'no-session' : safe.slice(0, 160)
}

/**
 * Serialize one captured request body with a hard ceiling.
 * @param payload - the JSON body passed to `onPayload`.
 * @returns the stored text.
 */
export function serializeBody(payload) {
  let text
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return '[body is not JSON-serializable]'
  }
  if (typeof text !== 'string') return '[body is not JSON-serializable]'
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…[truncated]` : text
}

/**
 * Remove known secrets and cap one provider message.
 * @param value - message text.
 * @param secrets - strings that must not reach the log.
 * @returns the stored text.
 */
export function redactSecrets(value, secrets = []) {
  let text = value === undefined || value === null ? '' : String(value)
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    text = text.split(secret).join('[redacted]')
  }
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
  return text
}

/**
 * Merge raw log rows into one group per request.
 *
 * A group is created by a `start` row. `failover` rows append a failed attempt
 * and move the group's current member to the next one. An `end` row decides the
 * outcome. A group with only a `start` row is still in flight or was cut short
 * by a process exit, and is reported as `pending`.
 *
 * @param rows - rows in file order.
 * @param limit - maximum groups to return, newest kept.
 * @returns request groups in file order, plus whether older groups were dropped.
 */
export function groupRows(rows, limit = MAX_GROUPS) {
  const groups = new Map()
  const order = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = row.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (row.k === 'start') {
      if (groups.has(id)) continue
      groups.set(id, {
        id,
        t: row.t,
        sessionId: row.sessionId,
        request: row.request,
        pool: row.pool,
        model: row.model,
        turn: row.turn,
        step: row.step,
        purpose: row.purpose,
        member: row.member,
        memberModel: row.memberModel,
        cadence: row.cadence,
        strategy: row.strategy,
        allCooling: row.allCooling === true,
        coolingCount: row.coolingCount,
        committed: false,
        requestBody: undefined,
        attempts: [],
        outcome: 'pending',
        ms: undefined,
        code: undefined,
        status: undefined,
        message: undefined,
      })
      order.push(id)
      continue
    }
    const group = groups.get(id)
    if (group === undefined) continue
    if (row.k === 'failover') {
      group.attempts.push({
        member: row.member,
        memberModel: row.memberModel,
        code: row.code,
        status: row.status,
        message: row.message,
        ms: row.ms,
        t: row.t,
      })
      if (typeof row.next === 'string') group.member = row.next
      if (typeof row.nextModel === 'string') group.memberModel = row.nextModel
      continue
    }
    if (row.k === 'body') {
      if (typeof row.body === 'string' && row.body.length > 0) group.requestBody = row.body
      continue
    }
    if (row.k === 'end') {
      group.outcome = row.ok === true ? 'ok' : row.aborted === true ? 'aborted' : 'error'
      group.committed = row.committed === true
      group.ms = row.ms
      group.code = row.code
      group.status = row.status
      group.message = row.message
      if (typeof row.member === 'string') group.member = row.member
      if (typeof row.memberModel === 'string') group.memberModel = row.memberModel
      if (row.ok !== true && row.aborted !== true) {
        group.attempts.push({
          member: row.member,
          memberModel: row.memberModel,
          code: row.code,
          status: row.status,
          message: row.message,
          ms: row.ms,
          t: row.t,
        })
      }
    }
  }
  const capped = limit > 0 && order.length > limit ? order.slice(order.length - limit) : order
  return {
    groups: capped.map(id => groups.get(id)),
    truncated: capped.length !== order.length,
  }
}

/** Read the last `bytes` of a file as UTF-8, dropping a leading partial line. */
function readTail(path, bytes) {
  const size = statSync(path).size
  if (size <= bytes) return { text: readFileSync(path, 'utf8'), truncated: false }
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    readSync(fd, buffer, 0, bytes, size - bytes)
    return { text: buffer.toString('utf8'), truncated: true }
  } finally {
    closeSync(fd)
  }
}

/**
 * Create the log store.
 * @param options - log directory, optional clock, and size bounds.
 * @returns the store API; every method swallows its own I/O failures.
 */
export function createLogStore({
  dir,
  now = Date.now,
  maxBytes = 4_000_000,
  keepBytes = 1_500_000,
  idFactory = () => randomUUID(),
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('model-rotation log: a directory is required')
  /** Bytes written per file, seeded lazily from disk. */
  const sizes = new Map()
  /** Monotonic per-session request counter. */
  const counters = new Map()

  function pathFor(sessionId) {
    return join(dir, `${sanitizeSessionId(sessionId)}.jsonl`)
  }

  function fileSize(path) {
    if (sizes.has(path)) return sizes.get(path)
    let size = 0
    try {
      if (existsSync(path)) size = statSync(path).size
    } catch {
      size = 0
    }
    sizes.set(path, size)
    return size
  }

  /** Keep the file bounded by rewriting its tail atomically. */
  function trim(path) {
    const size = fileSize(path)
    if (size <= maxBytes) return
    try {
      const { text } = readTail(path, keepBytes)
      const newline = text.indexOf('\n')
      const aligned = newline === -1 ? '' : text.slice(newline + 1)
      const next = `${path}.tmp`
      writeFileSync(next, aligned, 'utf8')
      renameSync(next, path)
      sizes.set(path, Buffer.byteLength(aligned))
    } catch {
      // A failed trim leaves a larger file; the reader caps what it returns.
    }
  }

  /** Append one row, never throwing. */
  function append(sessionId, row) {
    try {
      mkdirSync(dir, { recursive: true })
      const path = pathFor(sessionId)
      const line = `${JSON.stringify({ v: 1, ...row })}\n`
      appendFileSync(path, line, 'utf8')
      sizes.set(path, fileSize(path) + Buffer.byteLength(line))
      trim(path)
    } catch {
      // Logging is an observer: a read-only home must not fail a model call.
    }
  }

  return {
    pathFor,

    /**
     * List the session log files on disk, newest first.
     * @param limit - maximum files to list.
     * @returns `{ sessionId, bytes, modified }` rows.
     */
    listSessions(limit = 50) {
      try {
        const names = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
        const rows = []
        for (const name of names) {
          try {
            const stats = statSync(join(dir, name))
            rows.push({
              sessionId: name.slice(0, -'.jsonl'.length),
              bytes: stats.size,
              modified: stats.mtimeMs,
            })
          } catch {
            // A file removed between readdir and stat is simply absent.
          }
        }
        rows.sort((left, right) => right.modified - left.modified)
        return rows.slice(0, Math.max(1, Math.min(200, Number.isSafeInteger(limit) ? limit : 50)))
      } catch {
        return []
      }
    },

    /**
     * Allocate the next request number for one session.
     * @param sessionId - session identity.
     * @returns a positive request number.
     */
    nextRequest(sessionId) {
      const key = sanitizeSessionId(sessionId)
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next)
      return next
    },

    /**
     * Start one request group.
     * @param entry - request facts.
     * @returns the group id.
     */
    begin(entry) {
      const id = entry.id ?? idFactory()
      append(entry.sessionId, {
        k: 'start',
        id,
        t: now(),
        sessionId: sanitizeSessionId(entry.sessionId),
        request: entry.request,
        pool: entry.pool,
        model: entry.model,
        turn: entry.turn,
        step: entry.step,
        purpose: entry.purpose,
        member: entry.member,
        memberModel: entry.memberModel,
        cadence: entry.cadence,
        strategy: entry.strategy,
        allCooling: entry.allCooling === true,
        coolingCount: entry.coolingCount,
      })
      return id
    },

    /**
     * Record a failed attempt and the member tried next.
     * @param id - request group id.
     * @param entry - failure and next member facts.
     */
    failover(id, entry) {
      append(entry.sessionId, {
        k: 'failover',
        id,
        t: now(),
        member: entry.member,
        memberModel: entry.memberModel,
        next: entry.next,
        nextModel: entry.nextModel,
        code: entry.code,
        status: entry.status,
        message: redactSecrets(entry.message, entry.secrets),
        ms: entry.ms,
        committed: entry.committed === true,
      })
    },

    /**
     * Record the exact body pi-ai is about to send, when capture is enabled.
     * @param id - request group id.
     * @param entry - session and body facts.
     */
    body(id, entry) {
      append(entry.sessionId, {
        k: 'body',
        id,
        t: now(),
        body: serializeBody(entry.body),
      })
    },

    /**
     * Finish one request group.
     * @param id - request group id.
     * @param entry - outcome facts.
     */
    finish(id, entry) {
      append(entry.sessionId, {
        k: 'end',
        id,
        t: now(),
        ok: entry.ok === true,
        aborted: entry.aborted === true,
        member: entry.member,
        memberModel: entry.memberModel,
        code: entry.code,
        status: entry.status,
        message: redactSecrets(entry.message, entry.secrets),
        ms: entry.ms,
        committed: entry.committed === true,
      })
    },

    /**
     * Read one session's requests, newest kept.
     * @param sessionId - session identity.
     * @param options - optional group limit.
     * @returns grouped requests, truncation flag, file path, and byte size.
     */
    readSession(sessionId, { limit = 200 } = {}) {
      const path = pathFor(sessionId)
      const cappedLimit = Math.max(1, Math.min(MAX_GROUPS, Number.isSafeInteger(limit) ? limit : 200))
      let bytes = 0
      let text = ''
      let tailTruncated = false
      try {
        if (!existsSync(path)) return { groups: [], truncated: false, path, bytes: 0 }
        bytes = statSync(path).size
        const tail = readTail(path, MAX_READ_BYTES)
        text = tail.text
        tailTruncated = tail.truncated
      } catch (error) {
        return { groups: [], truncated: false, path, bytes: 0, error: String(error?.message ?? error) }
      }
      const rows = []
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          // A partial first line after a tail read, or a torn write; skip it.
        }
      }
      const { groups, truncated } = groupRows(rows, cappedLimit)
      return { groups, truncated: truncated || tailTruncated, path, bytes }
    },
  }
}
