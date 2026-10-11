/**
 * Tool-result retention — bundle entry point.
 *
 * One Host-plane row mounts two things:
 *
 *  1. the **strip pass**, on `agent/pre-step` — so the per-preset policy in the
 *     settings page governs the preset it names, for every preset at once. It is
 *     deliberately **not** a `ToolResultPruner` Service: `toolResultPruner` is
 *     provided once per realm, the shipped presets each isolate their own copy,
 *     and a Host-plane claim collides with them
 *     (`service "toolResultPruner" has been registered at <GuardedToolResultPruner>`).
 *     `pass.js` carries the reasoning and the turn-boundary rule.
 *  2. the **settings route**, which edits a JSON file. The file's mtime is what
 *     makes every reader pick the change up, so the page works whether or not a
 *     session is running.
 *
 * A failed prune must not fail the turn, so the pass logs and continues; a
 * failure to *start* still rethrows, because a half-registered row is worse.
 *
 * @module @local/dsh-tool-result-policy/plugin
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createPolicyCache } from './policy.js'
import { createPrunePass } from './pass.js'
import { PREFIX, createRouteHandler } from './route.js'

/** The harness's exported pairing cuts, injected so the pass stays pure. */
const PAIRING = {
  balancedBefore: toolPairingBalancedBefore,
  balancedAfter: toolPairingBalancedAfter,
}

/** A configured integer, or the default when the value is absent or not one. */
function intOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Where a plugin failure is written before it is rethrown.
 *
 * The harness reports a failed row as `fiberPhase: failed` and nothing else, and
 * the launcher's console is not readable from a session — so a start-up error can
 * cost an hour of guessing. Writing the stack to a file we own makes the next one
 * a `cat`. Set `DSH_PLUGIN_LOG_DIR` to move it; anything else uses the profile
 * home.
 */
export function logDir() {
  const configured = process.env.DSH_PLUGIN_LOG_DIR
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'plugin-errors')
}

/** Append one failure, best-effort. Never throws: logging must not add a failure. */
export function logPluginError(plugin, stage, error) {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} [${plugin}] ${stage}: ${error?.stack ?? error}\n`
    appendFileSync(join(dir, 'tool-result-policy.log'), line)
  } catch {
    // A read-only home is not worth turning into a second error.
  }
}

/**
 * Run `body`, logging any throw to the filesystem before rethrowing.
 *
 * The rethrow is deliberate: swallowing the error would leave the row silently
 * half-registered, which is worse than a row that refuses to start.
 */
function guard(ctx, stage, body) {
  try {
    return body()
  } catch (error) {
    logPluginError(name, stage, error)
    ctx.logger?.error?.(`tool-result-policy: ${stage} failed — ${error?.message ?? error}`)
    throw error
  }
}

export const name = 'tool-result-policy'
// `webServer` is deliberately NOT a hard injection. The shipped `dsh-tts` bundle
// documents why: the service is not guaranteed to exist when a plugin applies, and
// a hard dependency makes the row fail to start instead of waiting. The route is
// mounted from `ctx.inject(['webServer'], …)` below, which waits for it.

/** Default policy location: `$DSH_HOME`, so it is deployment state, not campaign state. */
export function defaultPolicyPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'tool-result-policy.json')
}

/**
 * Read the presets this deployment knows about.
 *
 * Taken from the live registry rather than a hard-coded list, so a newly declared
 * preset appears in the table without editing this plugin.
 */
async function knownPresets(ctx) {
  try {
    const registry = ctx.get?.('agentPresets')
    if (registry === undefined || typeof registry.list !== 'function') return []
    const presets = await registry.list()
    return presets.map((preset) => preset.id).filter((id) => typeof id === 'string').sort()
  } catch {
    return []
  }
}

/**
 * Mount the read/write route behind the settings page.
 *
 * @param ctx - plugin context.
 * @param config - `{ policyPath }`.
 */
export function apply(ctx, config = {}) {
  return guard(ctx, 'apply', () => applyInner(ctx, config))
}

function applyInner(ctx, config = {}) {
  const policyPath = typeof config.policyPath === 'string' && config.policyPath.length > 0
    ? config.policyPath
    : defaultPolicyPath()
  const cache = createPolicyCache()

  // The shadow price for a pruned node. `compaction/prune` records the tokens the
  // replacement removed and pure consumers subtract them, so the price must be the
  // meter's own `estimateMessage` — do not guess it. The meter is a Host-plane
  // service; resolve it lazily (the same reason the route resolves its preset list
  // lazily: plugin load order is not ours to assume) and degrade to the character
  // heuristic in `commitPlan` if it is absent.
  let meter
  const estimateTokens = (message) => {
    if (meter === undefined) meter = ctx.get?.('tokenMeter') ?? null
    return typeof meter?.estimateMessage === 'function'
      ? meter.estimateMessage(message)
      : undefined
  }

  // The strip itself. Hosted here — not as a `ToolResultPruner` service — so one
  // mount applies the per-preset policy to every preset: the shipped presets own
  // their pruner inside an isolated realm and a Host-plane service is invisible
  // to them. `pass.js` carries the full reasoning.
  const prune = createPrunePass({
    readPolicy: (path) => cache.read(path),
    policyPath,
    fallback: config.stripTransientResults === true,
    thresholdChars: intOr(config.thresholdChars, 8192),
    headChars: intOr(config.headChars, 4096),
    tailChars: intOr(config.tailChars, 1024),
    pairing: PAIRING,
    estimateTokens,
    logger: ctx.logger,
  })

  ctx.on('agent/pre-step', ({ agent }, next) => {
    // A failed prune must not fail the turn: it removes content the session can
    // still send, so the honest degradation is to keep the history and log. This
    // is the one place the house `guard` rule is inverted — a start-up error must
    // rethrow, a prune error must not.
    try {
      const result = prune(agent?.session)
      if (result.ran && result.pruned.length > 0) {
        ctx.logger?.debug?.(
          `tool-result-policy: pruned ${result.pruned.length} result(s), freed `
          + `${result.charsRemoved} chars (preset ${result.agentPreset ?? 'none'}, from ${result.source})`,
        )
      }
    } catch (error) {
      logPluginError(name, 'prune', error)
      ctx.logger?.error?.(`tool-result-policy: prune failed — ${error?.message ?? error}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  // The preset list is async while the route handler is synchronous, so the route
  // asks for it and the resolution is cached here. Resolved **lazily, on the
  // request that needs it**, rather than on a timer: a refresh interval would need
  // `ctx.timer`, and Cordis refuses to read an undeclared service — which is
  // exactly how this plugin failed to start
  // (`cannot get property "timer" without inject`). A settings page does not need
  // a heartbeat.
  let known = []
  const refresh = () => { knownPresets(ctx).then((ids) => { known = ids }).catch(() => {}) }
  refresh()
  const listPresets = () => {
    // Refresh opportunistically: this is called per GET, which is as often as the
    // page is opened and far less often than a timer would fire.
    refresh()
    return known
  }

  const handler = createRouteHandler({
    path: policyPath,
    listPresets,
    // The route also changes the file's mtime, so this is belt-and-braces; but a
    // same-millisecond write would otherwise be missed, and the toggle is meant to
    // be live.
    invalidate: () => cache.reset(),
  })

  // The scoped `ctx.inject(deps, cb)` form waits for the web server instead of
  // requiring it: a profile with no browser surface then loses only the settings
  // page, not the plugin row.
  ctx.inject(['webServer'], (webCtx) => guard(ctx, 'mountRoute', () => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') {
      ctx.logger?.warn?.('tool-result-policy: webServer has no register(); the settings page has no backend')
      return
    }
    webCtx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler }))
    ctx.logger?.info?.(`tool-result-policy: settings route mounted at ${PREFIX} (${policyPath})`)
  }))
}
