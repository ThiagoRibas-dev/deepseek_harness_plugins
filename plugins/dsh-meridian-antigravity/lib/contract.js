/**
 * The Meridian service contract: the connect-time health gate and the live
 * account model catalogue.
 *
 * Both readings are cached and single-flighted, and both are refreshed after a
 * probe failure because the contract makes the catalogue authoritative rather
 * than advisory: a slug missing from it is a hard error, never a nearby
 * substitution.
 *
 * @module @local/dsh-meridian-antigravity/lib/contract
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { retryAfterMs } from './errors.js'
import { toModelInfo, toResolvedModelInfo, modalitiesOfSlug, effortOfSlug } from './config.js'

/** The process in front of us is not the service this connector was built for. */
const UNSUPPORTED_SERVICE = 'MERIDIAN_UNSUPPORTED_SERVICE'

/** One cached reading plus the in-flight probe that produced it. */
class Reading {
  constructor(ttlMs) {
    this.ttlMs = ttlMs
    this.at = 0
    this.value = undefined
    this.inflight = undefined
  }

  stale(now = Date.now()) {
    return this.value === undefined || now - this.at >= this.ttlMs
  }

  /** Read through the cache, collapsing concurrent probes into one request. */
  async read(probe) {
    if (!this.stale()) return this.value
    if (this.inflight !== undefined) return this.inflight
    this.inflight = (async () => {
      try {
        const value = await probe()
        this.value = value
        this.at = Date.now()
        return value
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  /** Drop the cached reading so the next read probes again. */
  invalidate() {
    this.value = undefined
    this.at = 0
  }
}

/**
 * Owns every HTTP interaction that is not a model call: `/health` and
 * `/v1/models`.
 */
export class MeridianContract {
  #options
  #resolveApiKey
  #logger
  #health
  #catalogue

  /**
   * @param options - resolved adapter options.
   * @param resolveApiKey - resolves the local shared secret per request.
   * @param logger - harness logger for diagnostics.
   */
  constructor({ resolveApiKey, logger }) {
    this.#options = undefined
    this.#resolveApiKey = resolveApiKey
    this.#logger = logger
    this.#health = undefined
    this.#catalogue = undefined
  }

  /** Rebinding the option snapshot also re-bases both caches. */
  bind(options) {
    if (this.#options?.baseURL !== options.baseURL
      || this.#options?.apiKeyEnv !== options.apiKeyEnv
      || this.#options?.expectedCliVersion !== options.expectedCliVersion) {
      this.#health = new Reading(options.healthTtlMs)
      this.#catalogue = new Reading(options.catalogueTtlMs)
    }
    this.#options = options
  }

  /** Forget both readings; the next request probes the service again. */
  invalidate() {
    this.#health?.invalidate()
    this.#catalogue?.invalidate()
  }

  get healthReading() {
    return this.#health?.value
  }

  /**
   * Enforce the connect-time refusal.
   *
   * A wrong backend, an unpinned `agy`, or a service that does not answer the
   * documented shape fails closed. An unsupported version is an operator error
   * on the host, not a retryable condition, so it never looks like a 503.
   *
   * @param signal - caller cancellation.
   * @returns the validated health document.
   */
  async ensureHealthy(signal) {
    const options = this.#options
    if (options === undefined || !options.requireHealthGate) return undefined
    try {
      return await this.#health.read(() => this.#probeHealth(options, signal))
    } catch (error) {
      // A probe failure is exactly when the contract says to refresh: a
      // restarted bridge may be a different build than the cached reading.
      this.#health.invalidate()
      this.#catalogue.invalidate()
      throw error
    }
  }

  async #probeHealth(options, signal) {
    const url = `${options.baseURL}/health`
    let response
    try {
      response = await fetch(url, { method: 'GET', signal, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new LlmError(
        `Meridian Antigravity health probe could not reach ${url}: ${errorMessage(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }
    const body = await response.text()
    if (!response.ok) {
      const delay = retryAfterMs(response.headers)
      throw new LlmError(
        `Meridian Antigravity health probe failed at ${url} (${response.status})`,
        response.status >= 500 ? 'SERVER' : `HTTP_${response.status}`,
        { status: response.status, ...delay === undefined ? {} : { providerRetryAfterMs: delay } },
      )
    }
    let health
    try {
      health = JSON.parse(body)
    } catch (error) {
      throw new LlmError(
        `Meridian Antigravity health probe at ${url} did not return JSON; the process in front of you is not Meridian`,
        UNSUPPORTED_SERVICE,
        { cause: error },
      )
    }
    this.#assertContract(options, health, url)
    return Object.freeze({
      version: typeof health.version === 'string' ? health.version : undefined,
      backend: health.backend,
      cliVersion: health.support?.cliVersion,
      nativeReasoning: health.capabilities?.nativeReasoning === true,
      thinkingBudgets: health.capabilities?.thinkingBudgets === true,
      structuredOutput: health.capabilities?.structuredOutput === true,
      maxTokens: health.capabilities?.maxTokens,
      processes: health.processes,
      activeProcesses: health.activeProcesses,
      pendingToolProcesses: health.pendingToolProcesses,
    })
  }

  #assertContract(options, health, url) {
    const problems = []
    if (health.backend !== options.expectedBackend) {
      problems.push(`backend is ${JSON.stringify(health.backend)}, expected ${JSON.stringify(options.expectedBackend)}`)
    }
    const cliVersion = health.support?.cliVersion
    const verified = health.support?.verifiedCliVersion
    if (cliVersion !== options.expectedCliVersion) {
      problems.push(`support.cliVersion is ${JSON.stringify(cliVersion)}, expected ${JSON.stringify(options.expectedCliVersion)}`)
    }
    if (verified !== options.expectedCliVersion) {
      problems.push(`support.verifiedCliVersion is ${JSON.stringify(verified)}, expected ${JSON.stringify(options.expectedCliVersion)}`)
    }
    if (problems.length === 0) return
    throw new LlmError(
      `Meridian Antigravity refuses to serve ${url}: ${problems.join('; ')}.`
      + ' This is an operator error on the host: fix the service configuration or restore the pinned agy build.'
      + ' Do not run `agy update` and do not treat this as a retryable outage.',
      UNSUPPORTED_SERVICE,
    )
  }

  /**
   * Read the signed-in account's catalogue, merged with any static entries.
   * @param signal - caller cancellation.
   * @returns a frozen Map from slug to resolved catalogue model.
   */
  async catalogue(signal) {
    const options = this.#options
    if (options === undefined) throw new Error('meridian-antigravity: contract used before bind()')
    if (options.staticModels.length > 0 && options.catalogueTtlMs === 0) {
      return new Map(options.staticModels.map(model => [model.id, model]))
    }
    try {
      return await this.#catalogue.read(() => this.#probeCatalogue(options, signal))
    } catch (error) {
      this.#catalogue.invalidate()
      throw error
    }
  }

  async #probeCatalogue(options, signal) {
    const url = `${options.baseURL}/v1/models`
    const key = await this.#resolveApiKey(options)
    let response
    try {
      response = await fetch(url, { method: 'GET', signal, redirect: 'error', headers: { 'x-api-key': key } })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new LlmError(
        `Meridian Antigravity catalogue probe could not reach ${url}: ${errorMessage(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }
    if (!response.ok) {
      const text = await response.text()
      const delay = retryAfterMs(response.headers)
      throw new LlmError(
        `Meridian Antigravity catalogue probe failed at ${url} (${response.status}): ${text.slice(0, 300)}`,
        response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
        { status: response.status, ...delay === undefined ? {} : { providerRetryAfterMs: delay } },
      )
    }
    const body = await response.json()
    const listed = Array.isArray(body?.data) ? body.data : undefined
    if (listed === undefined) {
      throw new LlmError(
        `Meridian Antigravity catalogue at ${url} did not return the documented {object, data} shape`,
        UNSUPPORTED_SERVICE,
      )
    }
    const declared = new Map(options.staticModels.map(model => [model.id, model]))
    const models = new Map()
    for (const entry of listed) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined
      if (id === undefined || id.length === 0) continue
      const override = declared.get(id)
      if (override !== undefined) {
        models.set(id, override)
        continue
      }
      const effort = effortOfSlug(id)
      models.set(id, Object.freeze({
        id,
        name: typeof entry.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : id,
        contextWindow: options.defaultContextWindow,
        maxTokens: options.defaultMaxTokens,
        inputModalities: Object.freeze(modalitiesOfSlug(id)),
        ...effort === undefined ? {} : { effort },
      }))
    }
    // A static entry the account does not list stays advertised: the catalogue
    // is the account's, and a configured pin may be temporarily absent.
    for (const model of options.staticModels) {
      if (!models.has(model.id)) models.set(model.id, model)
    }
    if (models.size === 0) {
      throw new LlmError('Meridian Antigravity catalogue is empty; the signed-in account advertises no models', UNSUPPORTED_SERVICE)
    }
    return models
  }

  /** Advisory catalogue for `LlmAdapter.listModels`. */
  async listModels(provider, signal) {
    const models = await this.catalogue(signal)
    return [...models.values()].map(model => toModelInfo(provider, model))
  }

  /**
   * Resolve one exact slug. A slug the account does not advertise is a hard
   * error: Meridian substitutes nothing, and neither does this adapter.
   */
  async resolveModel(provider, model, signal) {
    const options = this.#options
    const models = await this.catalogue(signal)
    const found = models.get(model)
    if (found !== undefined) return toResolvedModelInfo(provider, found)
    if (options.allowUnknownModels) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: options.defaultContextWindow },
        defaultMaxTokens: options.defaultMaxTokens,
        inputModalities: modalitiesOfSlug(model),
      }
    }
    const available = [...models.keys()]
    throw new LlmError(
      `Meridian Antigravity does not advertise model ${JSON.stringify(model)}.`
      + ` The catalogue is the signed-in account's own list and no nearby slug is substituted. Available: ${available.join(', ')}`,
      'UNKNOWN_MODEL',
    )
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
