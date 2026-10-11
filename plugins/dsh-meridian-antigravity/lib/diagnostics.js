/**
 * Recovering *which* message moved, from the request captures.
 *
 * Meridian refuses a continuation by comparing the request against the history it
 * already delivered, and the connector never sees that history — only what it is
 * sending now. So on its own the connector can say that the prefix moved but not
 * what moved, which is what made a real `dd35` conflict take a full session-store
 * survey to attribute: the notice blamed the tool-result pruner, and the actual
 * correlate was the runtime-context snapshot being rebuilt.
 *
 * `lib/capture.js` already writes the exact body of each dispatch. Two of those
 * bodies for the same session and purpose differ in exactly the message that
 * caused the refusal, so diffing them turns "something moved" into "message 34
 * (user) changed, 3,201 -> 3,412 chars".
 *
 * Pure apart from reading the capture directory, so the diff itself is
 * unit-testable from fixtures. Never throws: this runs while reporting a failure,
 * and a diagnostic that fails must not replace the failure it is describing.
 *
 * @module @local/dsh-meridian-antigravity/lib/diagnostics
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CAPTURE_NAME } from './capture.js'

/** How many of the most recent captures to inspect. */
const SCAN_LIMIT = 20

/**
 * The text of one message, for comparing sizes.
 *
 * @param message - one entry of a request body's `messages`.
 * @returns its text, or a serialisation when it carries no text blocks.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block?.text === 'string' ? block.text : JSON.stringify(block ?? null)))
      .join('')
  }
  return JSON.stringify(message ?? null)
}

/** Describe one positional difference between two message lists. */
function differenceAt(kind, index, before, after) {
  return {
    kind,
    index,
    role: before?.role ?? after?.role ?? 'unknown',
    beforeChars: before === undefined ? 0 : messageText(before).length,
    afterChars: after === undefined ? 0 : messageText(after).length,
  }
}

/**
 * The first position at which two captured dispatches differ.
 *
 * Compares `body.messages` element by element, so a message that was rewritten in
 * place is found even when both dispatches carry the same number of messages.
 *
 * @param before - an earlier capture record.
 * @param after - a later capture record.
 * @returns the difference, or `undefined` when the two agree on every message.
 */
export function firstDifference(before, after) {
  const a = Array.isArray(before?.body?.messages) ? before.body.messages : []
  const b = Array.isArray(after?.body?.messages) ? after.body.messages : []
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    if (JSON.stringify(a[index]) === JSON.stringify(b[index])) continue
    return differenceAt('changed', index, a[index], b[index])
  }
  if (a.length !== b.length) {
    return a.length < b.length
      ? differenceAt('added', shared, undefined, b[shared])
      : differenceAt('removed', shared, a[shared], undefined)
  }
  return undefined
}

/**
 * The two most recent captures for one session and purpose, newest first.
 *
 * Purpose matters: a title-generation or compaction call carries a different
 * message list, and diffing against one of those would name a message that had
 * nothing to do with the refusal.
 *
 * @param captureDir - the directory `lib/capture.js` writes to.
 * @param session - the harness session id.
 * @param purpose - the request purpose, matched exactly.
 * @returns up to two capture records.
 */
function recentCaptures(captureDir, session, purpose) {
  let names
  try {
    names = readdirSync(captureDir)
  } catch {
    // Capture off, directory removed, or unreadable: not a diagnosis.
    return []
  }
  const found = []
  const ordered = names.filter(name => CAPTURE_NAME.test(name)).sort().reverse().slice(0, SCAN_LIMIT)
  for (const name of ordered) {
    try {
      const record = JSON.parse(readFileSync(join(captureDir, name), 'utf8'))
      if (record?.session === session && (record.purpose ?? null) === (purpose ?? null)) found.push(record)
    } catch {
      // A half-written or pruned capture is not evidence.
    }
    if (found.length === 2) break
  }
  return found
}

/**
 * One line naming the message that moved between the last two dispatches.
 *
 * @param connection - resolved adapter options, for the capture settings.
 * @param session - the harness session id.
 * @param purpose - the request purpose to compare within.
 * @returns a description, or `''` when capture is off or there is nothing to compare.
 */
export function describeMovedMessage(connection, session, purpose) {
  try {
    if (connection?.captureRequestBodies !== true) return ''
    const [current, previous] = recentCaptures(connection.captureDir, session, purpose)
    if (current === undefined || previous === undefined) return ''
    const difference = firstDifference(previous, current)
    if (difference === undefined) {
      return 'no message differs between the last two dispatches, so the delivered history is not what moved'
    }
    return `message ${difference.index} (${difference.role}) ${difference.kind}`
      + `, ${difference.beforeChars} -> ${difference.afterChars} chars`
  } catch {
    return ''
  }
}
