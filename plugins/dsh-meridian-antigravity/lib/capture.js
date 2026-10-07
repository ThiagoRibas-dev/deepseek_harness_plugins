/**
 * Opt-in capture of the request bodies this connector sends.
 *
 * Meridian reports a refused continuation as a mismatch against the history it
 * already delivered, and the connector never sees that history: it can only see
 * what it is sending now. Keeping the exact bytes of the last few dispatches is
 * the only way to tell which message moved between them.
 *
 * A captured body is a complete transcript — every message, every tool result —
 * and nothing in it is redacted, so this is off by default and the directory
 * must be treated as session data.
 *
 * @module @local/dsh-meridian-antigravity/lib/capture
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One capture file name: sorts by time, then by identity. */
const CAPTURE_NAME = /^\d{13,}-[^/\\]+\.json$/u

/**
 * The file name for one capture.
 *
 * @param time - epoch milliseconds.
 * @param identity - the request identity id sent as `idempotency-key`.
 * @returns a name that sorts in dispatch order.
 */
export function captureFileName(time, identity) {
  return `${time}-${identity}.json`
}

/**
 * Which captures to delete so the directory keeps at most `max` of them.
 *
 * Only names this module produces are eligible, so pointing `captureDir` at a
 * directory that holds other files cannot lose them.
 *
 * @param names - the directory's entries.
 * @param max - captures to keep.
 * @returns the oldest names beyond the cap, in deletion order.
 */
export function filesToPrune(names, max) {
  const ours = names.filter(name => CAPTURE_NAME.test(name)).sort()
  const keep = Number.isInteger(max) && max > 0 ? max : 0
  return ours.slice(0, Math.max(0, ours.length - keep))
}

/**
 * Write one capture, keeping the directory bounded.
 *
 * Capture is a diagnostic. A failure to write must never fail the turn, so
 * anything thrown here is reported through the logger and dropped.
 *
 * @param connection - resolved adapter options.
 * @param record - what to write: identity, hash, session, model and the body.
 * @param logger - optional diagnostic sink.
 * @returns the path written, or `undefined` when capture is off or failed.
 */
export function writeCapture(connection, record, logger) {
  if (connection.captureRequestBodies !== true) return undefined
  const file = join(connection.captureDir, captureFileName(record.time, record.identity))
  try {
    mkdirSync(connection.captureDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, undefined, 2)}\n`)
    for (const stale of filesToPrune(readdirSync(connection.captureDir), connection.captureMaxFiles)) {
      rmSync(join(connection.captureDir, stale), { force: true })
    }
    return file
  } catch (error) {
    logger?.warn?.(`meridian-antigravity: request capture failed: ${error.message}`)
    return undefined
  }
}
