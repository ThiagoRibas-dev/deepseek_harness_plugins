/**
 * Plugin configuration and request-local resolution for the Meridian
 * Antigravity connector.
 *
 * Every deployment fact is a `Volatile` reference so a settings change takes
 * effect on the next request while an in-flight request keeps the snapshot it
 * resolved. Nothing here reads the network; the health gate and the live
 * catalogue live in `contract.js`.
 *
 * @module @local/dsh-meridian-antigravity/lib/config
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'

/** Default provider route registered on the harness `llm` service. */
export const DEFAULT_PROVIDER = 'meridian-antigravity'

/** Meridian's own default loopback origin for a standalone Antigravity service. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3457'

/** Credential reference holding the local Meridian shared secret. */
export const DEFAULT_API_KEY_ENV = 'MERIDIAN_API_KEY'

/** Environment variable naming the Meridian origin, honored only at launch. */
const BASE_URL_ENV = 'MERIDIAN_BASE_URL'

/**
 * The validated backend and CLI pin this connector was written against. A
 * different value is an operator error, never a retryable condition.
 */
export const CONTRACT_BACKEND = 'antigravity'
export const CONTRACT_CLI_VERSION = '1.2.7'

/**
 * Meridian caps a whole Messages request body at 8 MiB, base64 included. The
 * adapter refuses to build a larger one rather than letting the bridge reject
 * it after media preparation.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** Conservative harness-side context budget; `/v1/models` advertises no window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Advisory output instruction; Meridian copies `max_tokens` into the prompt. */
export const DEFAULT_MAX_TOKENS = 32_768

/** Live-process capacity is `MERIDIAN_AGY_MAX_CONCURRENT`, four by default. */
export const DEFAULT_MAX_CONCURRENT_TURNS = 3

/** One outstanding stream read may not idle longer than Meridian's turn deadline. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** How long a `/health` reading and a `/v1/models` catalogue stay usable. */
export const DEFAULT_HEALTH_TTL_MS = 60_000
export const DEFAULT_CATALOGUE_TTL_MS = 300_000
/**
 * Floor between provider-status reads.
 *
 * Meridian caches a quota reading for 60 seconds on success and 10 after a
 * failure, and starts at most one background refresh per 10 seconds
 * (`antigravityRuntime.ts:501,508`), so a minute is its own cadence rather than
 * a rate above it. Polling faster would return the same numbers.
 */
export const DEFAULT_QUOTA_REFRESH_MS = 60_000

/**
 * Injected user-role notices that carry no instruction for the model: they
 * describe harness state the process cannot act on, so sending them only adds
 * noise and can leave a notice as the newest user message the process answers.
 *
 * `model-selection` says which model produced earlier turns. `user-approval`
 * says the approval policy changed — the newest `runtime-context` snapshot
 * already reports the current policy, and approvals are enforced by the harness.
 *
 * Deliberately NOT dropped, because each carries something the model may act on:
 * `tool-jobs` (a background job finished; read its output), `subagent-settled`
 * (a subagent is done and no report is coming), `plan-mode`, `skill-catalog`,
 * `agent-instructions`, `goal`, `compact-checkpoint`, `agent-message` and
 * `tool-goal`.
 */
export const DEFAULT_IGNORED_NOTICE_KINDS = Object.freeze(['model-selection', 'user-approval'])

/**
 * Only transient, replay-safe failures are retried. Generation is never retried
 * blindly: the transcript-shaped 409 (`MERIDIAN_CONTINUATION_CONFLICT`), 422,
 * `AUTH`, `MISSING_CREDENTIAL`, `UNKNOWN_MODEL` and the remaining Meridian
 * contract codes are permanent.
 *
 * `MERIDIAN_PENDING_REPLAYABLE` is the one 409 that is retried. Meridian returns
 * it only after it has already released the process waiting for the tool result
 * and still holds the completed history, so the retry replays that history
 * instead of running a tool a second time.
 *
 * `MERIDIAN_AGENT_INTERRUPTED` splits the most frequent 5xx out of `SERVER` so it
 * can be counted and reported on its own; it is retryable for the same reason
 * `SERVER` is.
 */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze([
    'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'MERIDIAN_PENDING_REPLAYABLE',
    // Not a new policy, only a new name for the most frequent 5xx: Meridian's
    // subscriber to the agent dropping mid-request. It stays retryable exactly
    // as the `SERVER` it used to be, and the transport reclassifies it on a
    // continuation before the policy ever sees it.
    'MERIDIAN_AGENT_INTERRUPTED',
  ]),
  backoff: Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 15_000, jitterRatio: 0.1 }),
})

const MODEL_EFFORTS = ['low', 'medium', 'high']

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])).min(1),
  /** Declared reasoning label; when omitted it is inferred from the slug suffix. */
  effort: z.union(MODEL_EFFORTS),
})

/**
 * Parsed plugin Config. Every field is optional in YAML; a missing API key
 * resolves per request and fails that request with `MISSING_CREDENTIAL` rather
 * than failing plugin load.
 */
export const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER).volatile(),
  displayName: z.string().default('Meridian Antigravity').volatile(),
  baseURL: z.string().volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  requireHealthGate: z.boolean().default(true).volatile(),
  expectedBackend: z.string().default(CONTRACT_BACKEND).volatile(),
  expectedCliVersion: z.string().default(CONTRACT_CLI_VERSION).volatile(),
  staticModels: z.array(catalogModel).default([]).volatile(),
  allowUnknownModels: z.boolean().default(false).volatile(),
  healthTtlMs: z.number().step(1).min(0).default(DEFAULT_HEALTH_TTL_MS).volatile(),
  catalogueTtlMs: z.number().step(1).min(0).default(DEFAULT_CATALOGUE_TTL_MS).volatile(),
  /** Expose the provider quota and activity snapshot to the browser half. */
  quotaEnabled: z.boolean().default(true).volatile(),
  /** Floor between quota reads; `0` reads on every trigger. */
  quotaRefreshMs: z.number().step(1).min(0).default(DEFAULT_QUOTA_REFRESH_MS).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  maxRequestBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_BYTES).volatile(),
  maxImagesPerRequest: z.number().step(1).min(1).default(64).volatile(),
  maxConcurrentTurns: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_TURNS).volatile(),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  /** Send `output_config.effort` alongside a suffixed slug. Off by default: the slug is the interface. */
  sendEffortOverride: z.boolean().default(false).volatile(),
  /** Strip advertised tools from `purpose: 'session-title'` helper turns. */
  stripToolsForSessionTitle: z.boolean().default(true).volatile(),
  /** Injected user-role notice kinds the provider never sees; `[]` disables the filter. */
  ignoredNoticeKinds: z.array(z.string()).default([...DEFAULT_IGNORED_NOTICE_KINDS]).volatile(),
  /** Send only the newest `runtime-context` snapshot instead of every superseded one. */
  keepLatestRuntimeContext: z.boolean().default(true).volatile(),
  /**
   * Stand in for a reply the backend blocked after Meridian consumed the tool
   * batch. Without it the conversation ends on a tool result nothing can answer,
   * so every later turn is refused as a spent continuation.
   */
  repairSpentBatch: z.boolean().default(true).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/** Read the current value behind every reference of a validated Config. */
export function plainOptions(config) {
  return Object.fromEntries(
    Object.entries(config ?? {}).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  )
}

/** Infer the reasoning label Meridian encodes in a slug suffix. */
export function effortOfSlug(id) {
  for (const effort of MODEL_EFFORTS) {
    if (id.endsWith(`-${effort}`)) return effort
  }
  return undefined
}

/**
 * Infer request modalities. `/v1/models` advertises no per-slug vision flag and
 * the contract warns that the Claude and GPT slugs do not see an image equally
 * well, so only the Gemini family is advertised as image-capable.
 */
export function modalitiesOfSlug(id) {
  return /^gemini-/u.test(id) ? ['text', 'image'] : ['text']
}

/** Normalize one catalogue entry into the shape the adapter advertises. */
function normalizeCatalogModel(entry, defaults) {
  const effort = entry.effort ?? effortOfSlug(entry.id)
  return Object.freeze({
    id: entry.id,
    name: entry.name ?? entry.id,
    ...entry.description === undefined ? {} : { description: entry.description },
    contextWindow: entry.contextWindow ?? defaults.contextWindow,
    maxTokens: entry.maxTokens ?? defaults.maxTokens,
    inputModalities: Object.freeze(entry.inputModalities ?? modalitiesOfSlug(entry.id)),
    ...effort === undefined ? {} : { effort },
  })
}

/**
 * Resolve, validate, and detach one request's complete option set.
 *
 * Connection facts are one value on purpose: a snapshot the resolver rejects
 * keeps the whole previous generation, so a request can never pair a stale
 * endpoint with a newer credential reference.
 *
 * @param config - parsed plugin Config (or plain options).
 * @param environment - environment lookup used for the origin fallback.
 * @returns frozen resolved options.
 */
export function resolveOptions(config, environment = process.env) {
  const plain = plainOptions(config)
  const rawBase = plain.baseURL ?? environment?.[BASE_URL_ENV]
  const baseURL = normalizeBaseURL(rawBase ?? DEFAULT_BASE_URL)
  const provider = requireNonEmpty(plain.provider ?? DEFAULT_PROVIDER, 'provider')
  const expectedCliVersion = requireNonEmpty(
    plain.expectedCliVersion ?? CONTRACT_CLI_VERSION,
    'expectedCliVersion',
  )
  const defaults = {
    contextWindow: plain.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: plain.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  }
  const seen = new Set()
  const models = (plain.staticModels ?? []).map((entry) => {
    const model = normalizeCatalogModel(entry, defaults)
    if (seen.has(model.id)) throw new Error(`meridian-antigravity: duplicate catalogue model "${model.id}"`)
    seen.add(model.id)
    return model
  })
  return Object.freeze({
    provider,
    displayName: plain.displayName ?? 'Meridian Antigravity',
    baseURL,
    apiKeyEnv: plain.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    requireHealthGate: plain.requireHealthGate ?? true,
    expectedBackend: plain.expectedBackend ?? CONTRACT_BACKEND,
    expectedCliVersion,
    staticModels: Object.freeze(models),
    allowUnknownModels: plain.allowUnknownModels ?? false,
    healthTtlMs: plain.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS,
    catalogueTtlMs: plain.catalogueTtlMs ?? DEFAULT_CATALOGUE_TTL_MS,
    quotaEnabled: plain.quotaEnabled ?? true,
    quotaRefreshMs: plain.quotaRefreshMs ?? DEFAULT_QUOTA_REFRESH_MS,
    defaultContextWindow: defaults.contextWindow,
    defaultMaxTokens: defaults.maxTokens,
    maxRequestBytes: plain.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    maxImagesPerRequest: plain.maxImagesPerRequest ?? 64,
    maxConcurrentTurns: plain.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS,
    streamIdleTimeoutMs: plain.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    sendEffortOverride: plain.sendEffortOverride ?? false,
    stripToolsForSessionTitle: plain.stripToolsForSessionTitle ?? true,
    ignoredNoticeKinds: Object.freeze(resolveIgnoredNoticeKinds(plain.ignoredNoticeKinds)),
    keepLatestRuntimeContext: plain.keepLatestRuntimeContext ?? true,
    repairSpentBatch: plain.repairSpentBatch ?? true,
    retryPolicy: resolveRetryPolicy(plain.retryPolicy ?? DEFAULT_RETRY_POLICY, 'meridian-antigravity retryPolicy'),
  })
}

/** Advertise one configured catalogue entry as harness model metadata. */
export function toModelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities,
  }
}

/** Advertise one configured catalogue entry with its resolved capabilities. */
export function toResolvedModelInfo(provider, model) {
  return {
    ...toModelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
  }
}

function requireNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`meridian-antigravity: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Validate the notice kinds a deployment wants dropped. Each entry is a message
 * source kind exactly as DSH records it, so the list is free-form by design: a
 * kind this connector has never heard of is simply never matched.
 */
function resolveIgnoredNoticeKinds(raw) {
  const value = raw ?? DEFAULT_IGNORED_NOTICE_KINDS
  if (!Array.isArray(value) || value.some(kind => typeof kind !== 'string' || kind.length === 0)) {
    throw new Error('meridian-antigravity: ignoredNoticeKinds must be an array of non-empty source kinds')
  }
  return [...value]
}

/**
 * Accept only an HTTP(S) origin without credentials, query, or fragment, and
 * return it without a trailing slash. A `/v1` suffix is tolerated because
 * operators paste it from OpenAI-shaped client docs.
 */
export function normalizeBaseURL(raw) {
  let url
  try {
    url = new URL(raw)
  } catch (error) {
    throw new Error(`meridian-antigravity: baseURL must be an absolute HTTP(S) URL (got ${JSON.stringify(raw)})`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`meridian-antigravity: baseURL must use http or https (got ${url.protocol})`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('meridian-antigravity: baseURL must not embed credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('meridian-antigravity: baseURL must not carry a query or fragment')
  }
  let path = url.pathname.replace(/\/+$/u, '')
  if (path === '/v1') path = ''
  return `${url.origin}${path}`
}
