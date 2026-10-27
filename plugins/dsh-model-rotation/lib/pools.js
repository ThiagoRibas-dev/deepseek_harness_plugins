/**
 * Pure pool resolution for the model-rotation connector.
 *
 * One pool is one selectable model id. Its members are endpoints that serve
 * that logical model; rotation chooses which endpoint answers one request.
 * The pool key IS the model id shown by the model picker, so adding a pool
 * makes it selectable without a second naming decision.
 *
 * Resolution never throws for a stored document: a bad member is dropped with
 * a diagnostic beside the pool, and a pool with no usable member is excluded
 * from the model list but keeps its diagnostic for the settings page and the
 * request path (which refuses it by name).
 *
 * This module imports nothing, which is what lets the offline suite exercise
 * it without the Harness module loader.
 *
 * @module @local/dsh-model-rotation/pools
 */

/** Wire protocols a member may name. The same three a hand-declared pi-ai route accepts. */
export const PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** Rotation order across healthy members. */
export const STRATEGIES = Object.freeze(['round-robin', 'least-recently-used', 'fill-first', 'random'])

/** When the next member is chosen. */
export const CADENCES = Object.freeze(['request', 'turn'])

/** How stored provider replay metadata crosses an endpoint switch. */
export const REPLAY_MODES = Object.freeze(['auto', 'preserve', 'neutral'])

/** Context capacity assumed for a member that declares none. Mirrors the pi-ai adapter default. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Output capability assumed for a member that declares none. Mirrors the pi-ai adapter default. */
export const DEFAULT_MAX_TOKENS = 32_768

/** Default member cooldown after a transient endpoint failure. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** Highest number of members one request may try. */
export const MAX_ATTEMPTS = 16

/** Uppercase identifier fragment a credential reference can carry. */
function slug(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * Derive the conventional credential reference for one member: stable as long
 * as the pool id and member name are stable, which is also what makes a typed
 * key survive a settings reload without the key ever entering the settings
 * document.
 * @param poolKey - pool key (the model id).
 * @param memberName - member name, unique within its pool.
 * @returns a POSIX-identifier-shaped credential reference.
 */
export function deriveKeyRef(poolKey, memberName) {
  const raw = `MODEL_ROTATION_${slug(poolKey)}_${slug(memberName)}_API_KEY`
  // Keep the names readable but bounded; refs are used as log labels and
  // environment names, so an absurd pool id must not produce an absurd ref.
  if (raw.length <= 128) return raw
  const suffix = String(raw.length)
  return `${raw.slice(0, 120 - suffix.length)}_${suffix}`
}

/** Whether a string starts with an http(s) scheme. */
function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Whether a value is a positive safe integer. */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Compatibility switches the settings UI exposes and pi-ai reads per model. */
export const KNOWN_COMPAT_FIELDS = Object.freeze([
  'maxTokensField',
  'supportsStore',
  'supportsUsageInStreaming',
  'supportsStrictMode',
])

/** The two request-field spellings pi-ai accepts for the output cap. */
export const MAX_TOKENS_FIELDS = Object.freeze(['max_tokens', 'max_completion_tokens'])

/**
 * Validate one member's compatibility switches.
 * @param name - member name, for the diagnostic.
 * @param raw - stored compat object.
 * @returns the known switches, undefined, or a diagnostic string.
 */
function resolveCompat(name, raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return `member "${name}" compat must be an object`
  const compat = {}
  for (const key of KNOWN_COMPAT_FIELDS) {
    const value = raw[key]
    if (value === undefined) continue
    if (key === 'maxTokensField') {
      if (!MAX_TOKENS_FIELDS.includes(value)) {
        return `member "${name}" compat.maxTokensField must be max_tokens or max_completion_tokens`
      }
    } else if (typeof value !== 'boolean') {
      return `member "${name}" compat.${key} must be boolean`
    }
    compat[key] = value
  }
  return Object.keys(compat).length === 0 ? undefined : compat
}

/**
 * Validate one member's raw body overrides.
 * @param name - member name, for the diagnostic.
 * @param raw - stored body object.
 * @returns `{ set?, unset? }`, undefined, or a diagnostic string.
 */
function resolveBody(name, raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return `member "${name}" body must be an object`
  const set = raw.set
  const unset = raw.unset
  if (set !== undefined && (typeof set !== 'object' || set === null || Array.isArray(set))) {
    return `member "${name}" body.set must be an object`
  }
  if (unset !== undefined && (!Array.isArray(unset) || unset.some(key => typeof key !== 'string' || key.length === 0))) {
    return `member "${name}" body.unset must be an array of non-empty field names`
  }
  const hasSet = set !== undefined && Object.keys(set).length > 0
  const hasUnset = unset !== undefined && unset.length > 0
  if (!hasSet && !hasUnset) return undefined
  try {
    JSON.stringify(set ?? {})
  } catch {
    return `member "${name}" body.set must be JSON-serializable`
  }
  return {
    ...hasSet ? { set: { ...set } } : {},
    ...hasUnset ? { unset: [...unset] } : {},
  }
}

/**
 * Resolve one stored member into the shape the request path uses.
 * @param poolKey - owning pool.
 * @param raw - stored member.
 * @param seen - member names already used by this pool.
 * @returns the member, or a diagnostic string.
 */
function resolveMember(poolKey, raw, seen) {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0) return 'a member has no name'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `member "${name}" must start with a letter or digit and contain only letters, digits, dot, dash, or underscore`
  }
  if (seen.has(name)) return `member "${name}" is declared more than once`
  seen.add(name)
  const baseURL = typeof raw?.baseURL === 'string' ? raw.baseURL.trim() : ''
  if (!isHttpUrl(baseURL)) return `member "${name}" needs an http(s) baseURL`
  const api = raw?.api ?? 'openai-completions'
  if (!PROTOCOLS.includes(api)) return `member "${name}" names unknown api "${String(api)}"`
  const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
  if (model.length === 0) return `member "${name}" needs a model id`
  if (raw?.contextWindow !== undefined && !isPositiveInteger(raw.contextWindow)) {
    return `member "${name}" contextWindow must be a positive integer`
  }
  if (raw?.maxTokens !== undefined && !isPositiveInteger(raw.maxTokens)) {
    return `member "${name}" maxTokens must be a positive integer`
  }
  const headers = raw?.headers
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      return `member "${name}" headers must be a string map`
    }
    for (const [header, value] of Object.entries(headers)) {
      if (typeof value !== 'string') return `member "${name}" header "${header}" must be a string`
    }
  }
  if (raw?.temperature !== undefined
    && (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature)
      || raw.temperature < 0 || raw.temperature > 2)) {
    return `member "${name}" temperature must be a number from 0 through 2`
  }
  const compat = resolveCompat(name, raw?.compat)
  if (typeof compat === 'string') return compat
  const body = resolveBody(name, raw?.body)
  if (typeof body === 'string') return body
  const apiKeyEnv = typeof raw?.apiKeyEnv === 'string' && raw.apiKeyEnv.trim().length > 0
    ? raw.apiKeyEnv.trim()
    : deriveKeyRef(poolKey, name)
  return {
    name,
    key: `mr.${poolKey}.${name}`,
    baseURL,
    api,
    model,
    apiKeyEnv,
    contextWindow: raw?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: raw?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...headers === undefined ? {} : { headers: { ...headers } },
    ...raw?.temperature === undefined ? {} : { temperature: raw.temperature },
    ...compat === undefined ? {} : { compat },
    ...body === undefined ? {} : { body },
  }
}

/**
 * Resolve the stored pool document into the immutable shape one request uses.
 * Invalid members are dropped with a diagnostic; a pool left with no member is
 * reported and excluded from the selectable list.
 * @param raw - stored `pools` value, keyed by pool.
 * @returns selectable pools by key, plus a diagnostic per unusable pool.
 */
export function resolvePools(raw) {
  const pools = new Map()
  const errors = new Map()
  if (raw === undefined || raw === null) return { pools, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.set('*', 'pools must be an object keyed by model id')
    return { pools, errors }
  }
  for (const [poolKey, stored] of Object.entries(raw)) {
    if (poolKey.length === 0) {
      errors.set(poolKey, 'a pool has an empty model id')
      continue
    }
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      errors.set(poolKey, `pool "${poolKey}" must be an object`)
      continue
    }
    const rawMembers = Array.isArray(stored.members) ? stored.members : []
    const members = []
    const diagnostics = []
    const seen = new Set()
    for (const rawMember of rawMembers) {
      const resolved = resolveMember(poolKey, rawMember, seen)
      if (typeof resolved === 'string') diagnostics.push(resolved)
      else members.push(resolved)
    }
    if (members.length === 0) {
      errors.set(poolKey, diagnostics.length > 0
        ? diagnostics.join('; ')
        : `pool "${poolKey}" has no members`)
      continue
    }
    if (stored.input !== undefined && !Array.isArray(stored.input)) {
      errors.set(poolKey, `pool "${poolKey}" input must be an array`)
      continue
    }
    const input = [...new Set(stored.input ?? ['text'])].filter(value => value === 'text' || value === 'image')
    if (input.length === 0) {
      errors.set(poolKey, `pool "${poolKey}" input must name text or image`)
      continue
    }
    const failover = stored.failover !== false
    const requestedAttempts = stored.maxAttempts ?? 3
    const maxAttempts = failover
      ? Math.max(1, Math.min(MAX_ATTEMPTS, Number.isSafeInteger(requestedAttempts) ? requestedAttempts : 3, members.length))
      : 1
    const cooldownMs = Number.isSafeInteger(stored.cooldownMs) && stored.cooldownMs >= 0
      ? stored.cooldownMs
      : DEFAULT_COOLDOWN_MS
    const displayName = typeof stored.displayName === 'string' && stored.displayName.trim().length > 0
      ? stored.displayName.trim()
      : poolKey
    // The pool's advertised capacity is what EVERY member must be able to
    // serve, so an unset pool-level value is the minimum over its members. A
    // deployment that knows better sets it explicitly.
    const contextWindow = isPositiveInteger(stored.contextWindow)
      ? stored.contextWindow
      : Math.min(...members.map(member => member.contextWindow))
    const maxTokens = isPositiveInteger(stored.maxTokens)
      ? stored.maxTokens
      : Math.min(...members.map(member => member.maxTokens))
    pools.set(poolKey, Object.freeze({
      key: poolKey,
      displayName,
      members: Object.freeze(members.map(member => Object.freeze(member))),
      strategy: STRATEGIES.includes(stored.strategy) ? stored.strategy : 'round-robin',
      cadence: CADENCES.includes(stored.cadence) ? stored.cadence : 'request',
      failover,
      maxAttempts,
      cooldownMs,
      replay: REPLAY_MODES.includes(stored.replay) ? stored.replay : 'auto',
      contextWindow,
      maxTokens,
      input: Object.freeze(input),
      captureRequestBodies: stored.captureRequestBodies === true,
      diagnostics: Object.freeze(diagnostics),
    }))
  }
  return { pools, errors }
}

/**
 * Whether one resolved pool's config differs from another's in a way that
 * requires re-advertising the model list (membership, label, or capacities).
 * @param left - previous pool, or undefined.
 * @param right - next pool, or undefined.
 * @returns whether the advertised facts changed.
 */
export function poolListChanged(left, right) {
  if (left === undefined || right === undefined) return left !== right
  return left.key !== right.key
    || left.displayName !== right.displayName
    || left.contextWindow !== right.contextWindow
    || left.input.length !== right.input.length
    || left.input.some((value, index) => value !== right.input[index])
}
