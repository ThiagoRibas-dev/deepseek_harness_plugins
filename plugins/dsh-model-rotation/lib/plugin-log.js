/**
 * Failure logging for this bundle.
 *
 * The harness reports a failed plugin row as a single word, so a start-up
 * failure must reach a file this deployment can read. The logger itself never
 * throws: a read-only home must not become a second failure. The guard rethrows
 * after logging, because a half-registered row is worse than one that refuses
 * to start.
 *
 * Copied from the house pattern in `docs/lessons-learned.md` §5.
 *
 * @module @local/dsh-model-rotation/plugin-log
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The directory failures and diagnostics are written to. */
export function logDir() {
  const configured = process.env.DSH_PLUGIN_LOG_DIR
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'plugin-errors')
}

/**
 * Append one failure, best-effort. Never throws.
 * @param plugin - plugin id used as the file name.
 * @param stage - short stage name.
 * @param error - thrown value.
 */
export function logPluginError(plugin, stage, error) {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} [${plugin}] ${stage}: ${error?.stack ?? error}\n`
    appendFileSync(join(dir, `${plugin}.log`), line)
  } catch {
    // A read-only home is not worth turning into a second error.
  }
}

/**
 * Append one diagnostic event, best-effort. Never throws.
 * @param plugin - plugin id used as the file name.
 * @param message - one line of context.
 */
export function logPluginEvent(plugin, message) {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${plugin}.log`), `${new Date().toISOString()} [${plugin}] ${message}\n`)
  } catch {
    // See above.
  }
}

/**
 * Run one registration step, logging before rethrowing.
 * @param plugin - plugin id.
 * @param ctx - plugin context (its logger is used when available).
 * @param stage - short stage name.
 * @param body - step body.
 * @returns the body's value.
 */
export function guard(plugin, ctx, stage, body) {
  try {
    return body()
  } catch (error) {
    logPluginError(plugin, stage, error)
    try {
      ctx?.logger?.error?.(`${plugin}: ${stage} failed — ${error?.message ?? error}`)
    } catch {
      // A logger that throws is still not worth masking the original failure.
    }
    throw error
  }
}
