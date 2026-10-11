/**
 * Durable logging for this plugin.
 *
 * A plugin that fails while registering leaves no trace. The loader swallows an
 * apply-time throw, the launcher console is not kept, and `$DSH_HOME` has no log
 * directory of its own — so a route that never mounted is indistinguishable from
 * a browser that asked for the wrong path. That is exactly how the quota route
 * went missing: the page reported an empty 404 and nothing on disk said why.
 *
 * So the mount path writes what it did. Best-effort throughout: a logger that
 * throws would replace the failure it is describing.
 *
 * @module @local/dsh-meridian-antigravity/lib/plugin-log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN = 'meridian-antigravity'

/** Where this plugin's log lives: beside the other `plugin-errors` files. */
export function logPath(env = process.env, home = homedir()) {
  const base = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(home, '.dsh')
  return join(base, 'plugin-errors', `${PLUGIN}.log`)
}

/**
 * Append one line, optionally with an error's stack.
 *
 * @param message - what happened, in the past tense.
 * @param error - the throw to record, when there was one.
 */
export function logPluginEvent(message, error) {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    const detail = error === undefined ? '' : `: ${error?.stack ?? error}`
    appendFileSync(file, `${new Date().toISOString()} ${message}${detail}\n`)
  } catch {
    // A read-only home is not worth turning into a second failure.
  }
}
