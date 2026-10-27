/**
 * Model rotation connector — Host implementation.
 *
 * Loaded dynamically by `plugin.js` after the synchronous entry has exported
 * its `Config`. That split exists so a failure to import a native package is
 * written to `$DSH_HOME/plugin-errors` before it is rethrown: the Loader
 * reports a failed import as one opaque word, and the entry file's only static
 * dependency is the schemastery-backed schema.
 *
 * This bundle is additive: it inserts one Loader row, imports native packages
 * read-only, and writes only its own settings namespace, credentials, log
 * directory, and HTTP prefix. See `README.md` § Boundaries.
 *
 * @module @local/dsh-model-rotation/host
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { resolvePools } from './config.js'
import { createRotationEngine } from './rotation.js'
import { createLogStore } from './log.js'
import { buildMemberProfiles, createAuthContext, createInertCredentialStore } from './profiles.js'
import { ModelRotationAdapter } from './adapter.js'
import { createRouteHandler } from './route.js'
import { guard, logPluginError, logPluginEvent } from './plugin-log.js'

/** Stable identifier used for the failure log and diagnostics. */
const PLUGIN = 'dsh-model-rotation'

/** HTTP prefix owned by this bundle. */
const HTTP_PREFIX = '/api/model-rotation'

/** Largest number of sessions whose turn/step is remembered. */
const MAX_TRACKED_SESSIONS = 2_000

/** The Harness home, matching the launcher default. */
function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * Run an optional registration step. A failure is written to the plugin log and
 * the caller continues, because losing the tab or the settings form is better
 * than losing the connector.
 * @param ctx - plugin context.
 * @param stage - short stage name.
 * @param body - step body.
 */
function optional(ctx, stage, body) {
  try {
    return body()
  } catch (error) {
    logPluginError(PLUGIN, stage, error)
    try {
      ctx?.logger?.error?.(`${PLUGIN}: ${stage} failed — ${error?.message ?? error}`)
    } catch {
      // The original failure is already recorded.
    }
    return undefined
  }
}

/**
 * Mount the host connector.
 * @param ctx - plugin context.
 * @param config - validated row config.
 */
export function apply(ctx, config) {
  const route = typeof config.provider === 'string' && config.provider.length > 0
    ? config.provider
    : 'model-rotation'
  const displayName = typeof config.displayName === 'string' && config.displayName.length > 0
    ? config.displayName
    : 'Model Rotation'
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'model-rotation'

  // The settings page is hand-written; there is no generated form to show.
  optional(ctx, 'settings-presentation', () => {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  })

  // ---- Config snapshot -----------------------------------------------------
  // `pools` is volatile: the settings remote rewrites it, the loader publishes
  // the change, and this reader picks up a new object identity on the next
  // request. Memoizing by identity keeps the adapter's profile map stable
  // between changes, which is what makes `PiAiAdapter` reuse its collection.
  let lastRaw
  let lastSnapshot
  const poolsSnapshot = () => {
    const raw = config.pools.get()
    if (raw === lastRaw && lastSnapshot !== undefined) return lastSnapshot
    const resolved = resolvePools(raw)
    lastRaw = raw
    lastSnapshot = { ...resolved, raw }
    return lastSnapshot
  }
  poolsSnapshot()

  let profilesFor
  let profilesMemo
  const profiles = () => {
    const snapshot = poolsSnapshot()
    if (profilesFor === snapshot) return profilesMemo
    profilesFor = snapshot
    profilesMemo = buildMemberProfiles(snapshot.pools)
    return profilesMemo
  }

  // ---- Credentials ---------------------------------------------------------
  const resolveApiKey = async (provider, profile) => {
    const ref = profile.apiKeyEnv
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[ref]
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, PLUGIN, ref)
    throw new LlmError(
      `model-rotation: no credential for member "${provider}"; its profile resolves ${ref}, which is not set —`
      + ` open Settings → Model Rotation and enter that member's API key, or store ${ref} through the`
      + ' credentials service',
      'MISSING_CREDENTIAL',
    )
  }

  // ---- Rotation, log, turn tracking ---------------------------------------
  const engine = createRotationEngine()
  const log = createLogStore({
    dir: process.env.DSH_MODEL_ROTATION_LOG_DIR ?? join(dshHome(), 'model-rotation', 'logs'),
  })
  const positions = new Map()
  const rememberPosition = (sessionId, turn, step) => {
    if (sessionId.length === 0) return
    positions.delete(sessionId)
    positions.set(sessionId, { turn, step })
    if (positions.size > MAX_TRACKED_SESSIONS) {
      const oldest = positions.keys().next().value
      if (oldest !== undefined) positions.delete(oldest)
    }
  }
  // A waterfall listener must advance the chain. This one only observes the
  // position the loop is about to use for its model call.
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    try {
      const id = agent?.session?.header?.id
      if (typeof id === 'string') rememberPosition(id, turn, step)
    } catch (error) {
      logPluginEvent(PLUGIN, `pre-step tracker: ${error?.message ?? error}`)
    }
    return next()
  })
  ctx.on('session/disposed', (session) => {
    try {
      const id = session?.header?.id
      if (typeof id !== 'string') return
      positions.delete(id)
      engine.forgetSession(id)
    } catch {
      // A disposed session must not fail the disposal path.
    }
  })

  // ---- pi-ai member adapter ------------------------------------------------
  const auth = {
    credentials: createInertCredentialStore(),
    authContext: createAuthContext(process.env),
  }
  const inner = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      logPluginEvent(PLUGIN, `replay degraded for ${provider}/${model}: ${reason}`)
      try {
        ctx.logger?.warn?.(`model-rotation: replay degraded for ${provider}/${model}: ${reason}`)
      } catch {
        // A logging failure cannot change the request.
      }
    },
  })

  const adapter = new ModelRotationAdapter({
    route,
    displayName,
    pools: poolsSnapshot,
    engine,
    inner: () => inner,
    log,
    positions: sessionId => positions.get(sessionId),
  })

  // ---- Provider route ------------------------------------------------------
  let registration
  guard(PLUGIN, ctx, 'register-adapter', () => {
    registration = ctx.llm.registerAdapter([route], adapter)
  })
  ctx.effect(() => () => registration())

  // Re-advertise the route when the pool document changes so an open model
  // picker sees added or removed pools without a restart. A same-set replace is
  // legal and only publishes `llm/adapters-updated`.
  let lastPoolsJson = JSON.stringify(config.pools.get())
  ctx.on('loader/volatile-update', () => {
    try {
      const raw = config.pools.get()
      const next = JSON.stringify(raw)
      if (next === lastPoolsJson) return
      lastPoolsJson = next
      registration.replace([route])
    } catch (error) {
      logPluginEvent(PLUGIN, `re-advertise failed: ${error?.stack ?? error}`)
      try {
        ctx.logger?.error?.(`model-rotation: re-advertise failed — ${error?.message ?? error}`)
      } catch {
        // Already recorded.
      }
    }
  })

  const startup = poolsSnapshot()
  logPluginEvent(
    PLUGIN,
    `mounted provider "${route}" with ${startup.pools.size} pool(s)`
    + (startup.errors.size === 0 ? '' : `; ${startup.errors.size} unusable pool(s)`),
  )

  // ---- Read-only HTTP surface ---------------------------------------------
  const token = typeof config.apiToken === 'string' && config.apiToken.length > 0
    ? config.apiToken
    : randomUUID()
  optional(ctx, 'http-surface', () => {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        logPluginEvent(PLUGIN, 'webServer unavailable; the Rotation tab has no data source')
        return
      }
      const handler = createRouteHandler({
        log,
        engine,
        pools: () => poolsSnapshot().pools,
        token,
        prefix: HTTP_PREFIX,
      })
      webCtx.effect(() => {
        try {
          return webServer.register({ kind: 'prefix', path: HTTP_PREFIX, handler })
        } catch (error) {
          // A duplicate route is a composition conflict, not a reason to lose
          // the connector. The tab reports that its data source is missing.
          logPluginError(PLUGIN, 'http-route', error)
          return () => {}
        }
      }, 'model-rotation.http-route')

      if (typeof webServer.tapIndex !== 'function') {
        logPluginEvent(PLUGIN, 'webServer has no tapIndex; the Rotation tab will not receive its token')
        return
      }
      webCtx.effect(() => webServer.tapIndex((html) => {
        const identity = {
          prefix: HTTP_PREFIX,
          token,
          settingsNs,
          provider: route,
          displayName,
        }
        const tag = `<script>window.__DSH_MODEL_ROTATION__=${JSON.stringify(identity).replace(/</g, '\\u003c')}</script>`
        return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
      }), 'model-rotation.index-identity')
      logPluginEvent(PLUGIN, `HTTP surface mounted at ${HTTP_PREFIX}`)
    })
  })
}
