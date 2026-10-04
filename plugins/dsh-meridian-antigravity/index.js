/**
 * Meridian Antigravity model API connector for the DeepSeek Harness.
 *
 * Mount this plugin beside `@deepseek-ai/dsh-llm` and it registers one provider
 * route on the harness `llm` service. The route speaks Anthropic Messages to a
 * local Meridian bridge over a signed-in `agy` process, and it is written to the
 * Meridian Antigravity contract rather than to the generic OpenAI-compatible
 * shape the same service also exposes:
 *
 * - `GET /health` is read first and the route refuses to serve a different
 *   backend or a different `agy` pin, because an unsupported CLI is an operator
 *   error on the host and not a retryable outage;
 * - `GET /v1/models` is the signed-in account's own catalogue, cached and
 *   refreshed after a probe failure, and a slug missing from it is a hard error
 *   because Meridian substitutes nothing;
 * - reasoning effort is a slug rather than a sampling parameter, and
 *   `temperature`, `top_p`, `top_k`, thinking controls and structured-output
 *   controls are never sent;
 * - `tool_use` blocks are held until `message_stop`, so a stream that never
 *   completed cannot execute anything;
 * - every logical turn carries one content-addressed `idempotency-key`, reused
 *   across transport retries and replaced for a genuine regeneration;
 * - an interrupted stream is recovered by re-asking the saved answer with
 *   `x-meridian-replay-only: true` under the same identity, never by starting a
 *   second generation.
 *
 * @module @local/dsh-meridian-antigravity
 */

import { LlmAdapter, LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { Config, normalizeBaseURL, resolveOptions } from './lib/config.js'
import { MeridianContract } from './lib/contract.js'
import { TurnLedger } from './lib/idempotency.js'
import { readImageRefs } from './lib/images.js'
import { TurnGate } from './lib/limiter.js'
import { runTurn } from './lib/transport.js'

export { Config, normalizeBaseURL, resolveOptions } from './lib/config.js'
export { MeridianContract } from './lib/contract.js'
export { TurnLedger, logicalRequestHash } from './lib/idempotency.js'
export { readImageRefs } from './lib/images.js'
export { MeridianTranslator, parseSse } from './lib/stream.js'
export { serializeRequest, enforceRequestBudget } from './lib/serialize.js'

export const name = 'meridian-antigravity'

/** The plugin is inert in a profile without the model-call service. */
export const inject = ['llm']

const NS = 'meridian-antigravity'

/** How long one turn waits for a local slot before reporting 429-shaped pressure. */
const GATE_WAIT_TIMEOUT_MS = 120_000

/**
 * Register the Meridian Antigravity provider route.
 * @param ctx - the plugin context, which owns every registration made here.
 * @param config - validated plugin Config.
 */
export function apply(ctx, config) {
  const optionsOf = () => resolveOptions(config, process.env)
  // Fail plugin load on an unusable configuration rather than at first request.
  optionsOf()

  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'meridian-antigravity', ref)
    } else {
      // Without the credentials seam the launching environment is the whole
      // credential plane.
      const ambient = process.env[ref]
      if (typeof ambient === 'string' && ambient.length > 0) {
        return assertUsableApiKey(ambient, 'meridian-antigravity', ref)
      }
    }
    throw new LlmError(
      `meridian-antigravity: no shared secret for provider route "${connection.provider}";`
      + ` store ${ref} through the credentials service (the web Models page writes it), or export ${ref}`
      + ' in the launching environment. This is the local Meridian key, not a Google key.',
      'MISSING_CREDENTIAL',
    )
  }

  const contract = new MeridianContract({ resolveApiKey, logger: ctx.logger })
  const ledger = new TurnLedger()
  let gateLimit = optionsOf().maxConcurrentTurns
  let gate = new TurnGate(gateLimit, GATE_WAIT_TIMEOUT_MS)

  /** Re-read settings, rebuilding the gate only when its limit actually moved. */
  const refresh = () => {
    const connection = optionsOf()
    if (connection.maxConcurrentTurns !== gateLimit) {
      gateLimit = connection.maxConcurrentTurns
      gate = new TurnGate(gateLimit, GATE_WAIT_TIMEOUT_MS)
    }
    return connection
  }

  const adapter = new MeridianAdapter({
    ctx,
    optionsOf,
    contract,
    ledger,
    gateOf: () => gate,
    resolveApiKey,
  })

  const settingsNs = ctx.fiber?.entry?.options.id ?? NS
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: optionsOf().provider,
    displayName: optionsOf().displayName,
    settingsNs,
    settingsPath: [],
  }])

  // Let the Models page manage this plugin's configuration when the settings
  // service is mounted. Activation must never depend on it.
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch (error) {
    ctx.logger?.debug?.(`meridian-antigravity: settings integration unavailable (${String(error)})`)
  }

  // Offer endpoint interrogation so a surface can offer this account's real
  // model slugs instead of a hand-copied list.
  try {
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const connection = optionsOf()
      const baseURL = request.baseURL === undefined ? connection.baseURL : normalizeBaseURL(request.baseURL)
      const key = request.apiKey ?? await resolveApiKey(connection)
      const response = await fetch(`${baseURL}/v1/models`, {
        method: 'GET',
        signal,
        redirect: 'error',
        headers: { 'x-api-key': key },
      })
      if (!response.ok) {
        throw new LlmError(
          `Meridian Antigravity model discovery failed at ${baseURL}/v1/models (${response.status})`,
          response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
          { status: response.status },
        )
      }
      const body = await response.json()
      const listed = Array.isArray(body?.data) ? body.data : []
      return listed
        .filter(entry => typeof entry?.id === 'string' && entry.id.length > 0)
        .map(entry => ({
          id: entry.id,
          name: typeof entry.display_name === 'string' ? entry.display_name : entry.id,
          contextWindow: connection.defaultContextWindow,
          maxTokens: connection.defaultMaxTokens,
        }))
    })
  } catch (error) {
    ctx.logger?.warn?.(`meridian-antigravity: model discovery was not registered (${String(error)})`)
  }

  const connection = refresh()
  const registration = ctx.llm.registerAdapter([connection.provider], adapter)
  let provider = connection.provider
  let registeredPolicy = connection.retryPolicy

  // The registry captures the route set and the retry policy at registration, so
  // those two facts are what a live settings change has to push through
  // `replace`; everything else is re-read per request.
  ctx.on('loader/volatile-update', () => {
    let next
    try {
      next = refresh()
    } catch (error) {
      // A stored configuration the resolver refuses keeps the current
      // registration; each request then fails on its own resolve.
      ctx.logger?.warn?.(error)
      return
    }
    const policyMoved = JSON.stringify(next.retryPolicy) !== JSON.stringify(registeredPolicy)
    const routeMoved = next.provider !== provider
    if (!policyMoved && !routeMoved) return
    registration.replace([next.provider])
    directory.replace([{
      provider: next.provider,
      displayName: next.displayName,
      settingsNs,
      settingsPath: [],
    }])
    adapter.providerName = next.provider
    provider = next.provider
    registeredPolicy = next.retryPolicy
  })
}

/**
 * The `llm` adapter for the Meridian Antigravity route.
 *
 * Every method re-reads the connection snapshot, because a settings change must
 * affect the next request while an in-flight turn keeps the one it resolved when
 * the call was prepared.
 */
class MeridianAdapter extends LlmAdapter {
  #ctx
  #optionsOf
  #contract
  #ledger
  #gateOf
  #resolveApiKey
  providerName

  constructor({ ctx, optionsOf, contract, ledger, gateOf, resolveApiKey }) {
    super()
    this.#ctx = ctx
    this.#optionsOf = optionsOf
    this.#contract = contract
    this.#ledger = ledger
    this.#gateOf = gateOf
    this.#resolveApiKey = resolveApiKey
    this.providerName = optionsOf().provider
  }

  providerInfo(provider) {
    return { id: provider, name: this.#optionsOf().displayName }
  }

  providerRetryPolicy(provider) {
    void provider
    return this.#optionsOf().retryPolicy
  }

  async listModels(provider, signal) {
    const connection = this.#optionsOf()
    this.#contract.bind(connection)
    return this.#contract.listModels(provider, signal)
  }

  async resolveModel(provider, model, signal) {
    const connection = this.#optionsOf()
    this.#contract.bind(connection)
    return this.#contract.resolveModel(provider, model, signal)
  }

  /**
   * Bind one adapter generation: the metadata resolved here and the stream
   * dispatched later share this connection snapshot.
   */
  async prepareCall(provider, model, signal) {
    const connection = this.#optionsOf()
    this.#contract.bind(connection)
    const resolved = await this.#contract.resolveModel(provider, model, signal)
    return { model: resolved, stream: options => this.#turn(options, connection) }
  }

  stream(options) {
    return this.#turn(options, this.#optionsOf())
  }

  async *#turn(options, connection) {
    this.#contract.bind(connection)
    const images = await readImageRefs({
      ctx: this.#ctx,
      messages: options.messages,
      signal: options.signal,
      maxImages: connection.maxImagesPerRequest,
    })
    yield* runTurn({
      connection,
      contract: this.#contract,
      ledger: this.#ledger,
      gate: this.#gateOf(),
      resolveApiKey: this.#resolveApiKey,
      logger: this.#ctx.logger,
      images,
      warn: (message) => this.#ctx.logger?.warn?.(message),
    }, options)
  }
}
