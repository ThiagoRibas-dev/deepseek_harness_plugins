/**
 * Model rotation connector — Host entry.
 *
 * This file is the Loader row's module. It keeps one static native dependency
 * (the schemastery-backed `Config` schema, which the Loader needs before the
 * row can activate) and loads the implementation dynamically inside `apply`.
 *
 * The dynamic step is deliberate: a failed `import()` of `@deepseek-ai/dsh-llm`,
 * `@deepseek-ai/dsh-llm-pi-ai`, or `@earendil-works/pi-ai` would otherwise be
 * reported by the Harness as the single string "failed to import", with no
 * stack. Here it is written to `$DSH_HOME/plugin-errors/dsh-model-rotation.log`
 * and then rethrown, which is the house rule for every plugin failure.
 *
 * @module @local/dsh-model-rotation
 */
import { Config } from './lib/config.js'
import { logPluginError } from './lib/plugin-log.js'

/** Stable identifier used for the failure log and diagnostics. */
const PLUGIN = 'dsh-model-rotation'

export const name = 'model-rotation'
export const inject = ['llm']
export { Config }

/**
 * Load the Host implementation and mount it.
 * @param ctx - plugin context.
 * @param config - validated row config.
 * @returns the implementation's result.
 */
export async function apply(ctx, config) {
  let host
  try {
    host = await import('./lib/host.js')
  } catch (error) {
    logPluginError(PLUGIN, 'native-import', error)
    try {
      ctx?.logger?.error?.(`${PLUGIN}: native-import failed — ${error?.message ?? error}`)
    } catch {
      // The original failure is already recorded.
    }
    throw error
  }
  return host.apply(ctx, config)
}
