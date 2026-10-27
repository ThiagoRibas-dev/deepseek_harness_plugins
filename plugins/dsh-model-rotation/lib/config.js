/**
 * Configuration schema for the model-rotation connector.
 *
 * The schema is kept apart from `pools.js` so the pure resolution logic can be
 * tested offline: schemastery is a Harness package the standalone test runner
 * cannot resolve, while `pools.js` imports nothing.
 *
 * @module @local/dsh-model-rotation/config
 */
import z from '@deepseek-ai/schemastery'
import {
  CADENCES, DEFAULT_COOLDOWN_MS, MAX_ATTEMPTS, PROTOCOLS, REPLAY_MODES, STRATEGIES,
} from './pools.js'

export * from './pools.js'

const memberSchema = z.object({
  name: z.string().required(),
  baseURL: z.string().required(),
  api: z.union(PROTOCOLS).default('openai-completions'),
  model: z.string().required(),
  apiKeyEnv: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  headers: z.dict(z.string()),
  temperature: z.number().min(0).max(2),
  compat: z.dict(z.any()),
  body: z.object({
    set: z.dict(z.any()),
    unset: z.array(z.string()),
  }),
})

const poolSchema = z.object({
  displayName: z.string(),
  members: z.array(memberSchema).default([]),
  strategy: z.union(STRATEGIES).default('round-robin'),
  cadence: z.union(CADENCES).default('request'),
  failover: z.boolean().default(true),
  maxAttempts: z.number().step(1).min(1).max(MAX_ATTEMPTS),
  cooldownMs: z.number().step(1).min(0).default(DEFAULT_COOLDOWN_MS),
  replay: z.union(REPLAY_MODES).default('auto'),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'])).default(['text']),
  captureRequestBodies: z.boolean().default(false),
})

/** Runtime schema for this plugin's row config. Only `pools` is settings-editable. */
export const Config = z.object({
  /** Provider route this connector registers. One route owns every pool. */
  provider: z.string().default('model-rotation'),
  /** Provider label shown by the model picker. */
  displayName: z.string().default('Model Rotation'),
  /** Optional fixed token for the read-only HTTP surface; empty generates one per start. */
  apiToken: z.string().default(''),
  /** Per-pool endpoint sets and rotation rules, keyed by the model id the pool exposes. */
  pools: z.dict(poolSchema).default({}).volatile(),
})
