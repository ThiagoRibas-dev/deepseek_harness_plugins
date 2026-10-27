/**
 * Build the pi-ai member profiles a rotation pool dispatches through.
 *
 * The wire translation is not reimplemented here. Each member is described as
 * the same resolved profile shape `@deepseek-ai/dsh-llm-pi-ai` builds for a
 * hand-declared route — a pi-ai `Provider` over the protocol's own stream
 * implementation, plus the harness service defaults that adapter reads — and
 * `PiAiAdapter` from that package does the request. Reusing that adapter keeps
 * tool calls, reasoning blocks, image projection, replay, and attribution
 * headers on the same tested path as the shipped Custom model API route.
 *
 * @module @local/dsh-model-rotation/profiles
 */
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { MEMBER_KEY_PREFIX } from './replay.js'
import { applyBodyOverrides } from './body.js'
import { currentCapture } from './capture-context.js'
import { captureGeminiResponse, isGeminiBaseURL, replayGeminiSignatures } from './gemini-signatures.js'
import { logPluginEvent } from './plugin-log.js'

/** Plugin id used by the failure log. */
const PLUGIN = 'dsh-model-rotation'

/**
 * Cap one diagnostic string so a failed request cannot fill the plugin log.
 * @param value - text to cap.
 * @returns the capped text.
 */
function capDiagnostic(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > 16_000 ? `${text.slice(0, 16_000)}…[truncated]` : text
}

/** Lazy pi-ai protocol implementations, keyed the way a member names them. */
const PROTOCOLS = Object.freeze({
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
})

// Harness-service defaults the pi-ai adapter reads from a resolved profile.
// They mirror `llm-pi-ai/config.ts`; a member declares no override for them in
// this connector, so the shipped defaults are the honest values.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Zero pricing: the harness meter prices from its own tables. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Credential store handed to pi-ai's collection. This connector authenticates
 * every member with an explicit api-key override resolved from the harness
 * credentials service, so the store is never written; it exists because the
 * collection constructor requires one.
 * @returns an inert, in-memory store.
 */
export function createInertCredentialStore() {
  return {
    async read() { return undefined },
    async list() { return [] },
    async modify(_providerId, fn) { return fn(undefined) },
    async delete() {},
  }
}

/** Ambient lookups a provider performs while resolving its own auth. */
export function createAuthContext(env = process.env) {
  return {
    async env(name) { return env[name] },
    async fileExists() { return false },
  }
}

/**
 * The pi-ai api-key auth method for a route whose key arrives as the request's
 * `apiKey` override. This mirrors the shipped adapter's `harnessApiKeyAuth`:
 * a missing key hands the decision to the protocol rather than inventing an
 * ambient one.
 * @param name - display name used as the resolution's status label.
 * @returns the auth method.
 */
function apiKeyAuth(name) {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * Build one pi-ai provider for a single member model.
 * @param member - resolved member.
 * @param displayName - member label used by provider diagnostics.
 * @param input - modalities the pool advertises.
 * @returns the provider, its single model, and the member profile key.
 */
function buildMemberProvider(member, displayName, input) {
  const factory = PROTOCOLS[member.api]
  if (factory === undefined) {
    throw new Error(`model-rotation: member "${member.name}" names api "${member.api}", which this build cannot serve`)
  }
  const api = factory()
  const model = {
    id: member.model,
    name: member.model,
    api: member.api,
    provider: member.key,
    baseUrl: member.baseURL,
    reasoning: false,
    input: [...input],
    cost: { ...NO_COST },
    contextWindow: member.contextWindow,
    maxTokens: member.maxTokens,
    ...member.compat === undefined ? {} : { compat: { ...member.compat } },
  }
  /**
   * Add member-owned request options, then rewrite the payload on its way out.
   * Temperature is a default: a caller that already set one keeps it. The
   * body override runs after the protocol built the body and can add, replace,
   * or remove any JSON field; headers and auth are untouched.
   */
  const gemini = isGeminiBaseURL(member.baseURL)
  const wrapOptions = (options) => {
    const next = { ...options }
    if (member.temperature !== undefined && next.temperature === undefined) {
      next.temperature = member.temperature
    }
    // A non-2xx body is invisible to pi-ai, which reports the SDK's generic
    // "400 status code (no body)". Log the request and response once on failure
    // so the plugin error log names the actual request that was rejected.
    const baseFetch = next.fetch ?? globalThis.fetch
    if (typeof baseFetch === 'function') {
      next.fetch = async (url, init) => {
        const response = await baseFetch(url, init)
        if (!response.ok) {
          let responseText = ''
          try {
            responseText = await response.clone().text()
          } catch {
            responseText = '[response body unavailable]'
          }
          let requestText = ''
          try {
            if (typeof init?.body === 'string') requestText = init.body
            else if (init?.body !== undefined) requestText = '[non-text request body]'
          } catch {
            requestText = '[request body unavailable]'
          }
          const headerText = [...response.headers.entries()]
            .map(([name, value]) => `${name}=${value}`)
            .join('; ')
          logPluginEvent(
            PLUGIN,
            `HTTP ${response.status} ${response.statusText} ${String(url)}`
            + ` method=${String(init?.method ?? 'POST')}`
            + ` headers=${capDiagnostic(headerText)}`
            + ` request=${capDiagnostic(requestText)}`
            + ` response=${capDiagnostic(responseText)}`,
          )
        }
        if (gemini && response.body !== null && typeof response.body?.tee === 'function') {
          const [passThrough, inspection] = response.body.tee()
          void captureGeminiResponse(inspection, member.key)
          return new Response(passThrough, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }
        return response
      }
    }

    const previousOnPayload = next.onPayload
    next.onPayload = async (payload, selectedModel) => {
      let value = payload
      if (typeof previousOnPayload === 'function') {
        const replaced = await previousOnPayload(payload, selectedModel)
        if (replaced !== undefined) value = replaced
      }
      value = applyBodyOverrides(value, member.body)
      if (gemini) replayGeminiSignatures(value, member.key)
      const capture = currentCapture()
      if (capture !== undefined && typeof capture.body === 'function') {
        try {
          capture.body(value)
        } catch {
          // Capture is an observer; it must not fail the request.
        }
      }
      return value
    }
    return next
  }
  const provider = {
    id: member.key,
    name: displayName,
    baseUrl: member.baseURL,
    auth: { apiKey: apiKeyAuth(displayName) },
    getModels: () => [model],
    stream: (selected, context, options) => api.stream(selected, context, wrapOptions(options)),
    streamSimple: (selected, context, options) => api.streamSimple(selected, context, wrapOptions(options)),
  }
  return { provider, model }
}

/**
 * Build every pool member's resolved profile.
 *
 * Keys are internal (`mr.<pool>.<member>`) and stable for as long as the pool
 * id and the member name are. A stored replay envelope records that key, so a
 * rename degrades old history to provider-neutral content instead of failing
 * a request.
 *
 * @param pools - resolved pools by key.
 * @returns profiles by internal member key.
 */
export function buildMemberProfiles(pools) {
  const profiles = new Map()
  for (const pool of pools.values()) {
    for (const member of pool.members) {
      if (!member.key.startsWith(MEMBER_KEY_PREFIX)) {
        throw new Error(`model-rotation: member key "${member.key}" does not carry the member prefix`)
      }
      const displayName = `${pool.displayName} (${member.name})`
      const { provider } = buildMemberProvider(member, displayName, pool.input)
      profiles.set(member.key, {
        provider: member.key,
        displayName,
        apiKeyEnv: member.apiKeyEnv,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        retryPolicy: resolveRetryPolicy(undefined, `model-rotation: member "${member.key}" retryPolicy`),
        piProvider: provider,
        modelErrors: new Map(),
        configuredMaxTokens: new Map(),
        ...member.headers === undefined ? {} : { headers: { ...member.headers } },
      })
    }
  }
  return profiles
}
