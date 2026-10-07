/**
 * Context-pressure policy for the pre-compaction nudge.
 *
 * Pure module: no imports at all, so every rule here is unit-testable offline
 * with plain `node --test`. The Loader-facing config schema lives in
 * `index.js`, because importing `schemastery` here would make this module
 * unresolvable outside the harness.
 *
 * @module @local/dsh-context-pressure/lib/pressure
 */

/**
 * Chosen to sit just below compaction's own trigger. `thresholdRatio` defaults
 * to 0.8, so a nudge at 0.75 lands in the window before compaction replaces
 * earlier history rather than after.
 */
export const DEFAULTS = Object.freeze({
  warnRatio: 0.75,
  rearmRatio: 0.6,
  message: 'Context is at {percent}% of this model\'s window and earlier history may be compacted soon. '
    + 'Before continuing, write anything you would need to resume — current state, decisions, and open '
    + 'threads — to a file you can read later.',
})

/**
 * Normalize untrusted configuration.
 *
 * @param config - the row's config, possibly absent or malformed.
 * @returns a frozen, fully populated configuration.
 */
export function resolveConfig(config = {}) {
  const warnRatio = ratio(config.warnRatio, DEFAULTS.warnRatio)
  const rearmRatio = ratio(config.rearmRatio, DEFAULTS.rearmRatio)
  const message = typeof config.message === 'string' && config.message.trim().length > 0
    ? config.message
    : DEFAULTS.message
  return Object.freeze({
    warnRatio,
    // A re-arm band at or above the warn band would fire a nudge on every
    // single step, so the re-arm band is clamped strictly below it.
    rearmRatio: Math.min(rearmRatio, Math.max(0, warnRatio - 0.01)),
    message,
  })
}

/**
 * @param value - candidate ratio.
 * @param fallback - value to use when the candidate is unusable.
 * @returns a finite ratio in [0, 1].
 */
function ratio(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback
}

/**
 * Decide what one measured window fraction means.
 *
 * The two bands give hysteresis: one nudge per pressure episode, re-armed only
 * once the window has actually dropped back — which in practice means a
 * compaction landed. Without it the nudge would repeat on every step.
 *
 * @param ratio - measured window fraction, `used / usable`.
 * @param warned - whether this session has already been nudged in this episode.
 * @param settings - resolved configuration.
 * @returns `'warn'`, `'rearm'`, or `'none'`.
 */
export function classify(ratioValue, warned, settings) {
  if (!Number.isFinite(ratioValue)) return 'none'
  if (ratioValue < settings.rearmRatio) return warned ? 'rearm' : 'none'
  if (ratioValue >= settings.warnRatio && !warned) return 'warn'
  return 'none'
}

/**
 * Fill `{placeholder}` slots, leaving unknown ones untouched so a typo in a
 * configured template is visible rather than silently blank.
 *
 * @param template - message template.
 * @param values - placeholder values.
 * @returns the rendered message.
 */
export function renderMessage(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ))
}
