/**
 * Profile-global hybrid memory service (dsh-memory) — Cordis plugin entry.
 *
 * Registers:
 * - In-process service `ctx.memory` (MemoryService facade)
 * - Tier 1 prompt section (`memory:core`, order 110, interpolate: false)
 * - Agent tools: manage_core_memory, search_memories, store_memory, search_reference
 * - Deferred HTTP route mount (`/api/memory/*`) via webServer
 * - Standalone HTTP server fallback (`http://127.0.0.1:3180`)
 *
 * All dense embedding and extraction is deferred to background / off-cycle
 * hooks; no blocking work on the turn reply path.
 */
import { dirname, join } from 'node:path';
import { existsSync, statSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as http from 'node:http';
import { MemoryService } from './service.js';
import { createCorePromptSectionDescriptor, createManageCoreMemoryTool, CORE_PROMPT_SECTION_NAME, CORE_PROMPT_SECTION_ORDER } from './core.js';
import { createRouteHandler } from './route.js';
import { ensureAsset, isPinned, AssetError } from './download.js';
import { EmbeddingEngine, DEFAULT_GEMMA_DIM } from './embedding.js';
import { ingestText, ingestFile as ingestFileAt, hashContent, MAX_SOURCE_BYTES } from './ingest.js';
import { deriveTitle } from './chunker.js';
import { ingestUpload, listInbox, removeInboxFile, defaultIngestFolder } from './inbox.js';
import { createRecallPolicyReader, defaultRecallPolicyPath, readRecallPolicy, writeRecallPolicy as writeRecallPolicyFile } from './recall-policy.js';

/**
 * Logger for background work that outlives `apply`'s scope.
 *
 * The download runs after apply returns, so a captured `ctx` would either be
 * stale or — for the standalone path — undefined. One module-level reference,
 * set once per apply, keeps the background leg able to speak.
 */
let loggerRef = null;

/**
 * The live service, so a download finishing after `apply` returns can hand it
 * the real embedder. Without this the weights would be on disk and unused until
 * the next restart.
 */
let serviceRef = null;

/**
 * Build the ONNX engine for a fully cached variant.
 *
 * Returns null when anything is missing, which keeps the deterministic embedder
 * in place: a half-downloaded model must not become the active embedder.
 */
export function buildEmbedderEngine(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  const status = memoryEmbedderStatus(variant);
  if (!status.modelCached || !status.pinVerified) return null;
  const { root, meta } = embedAssetPaths(variant);
  if (!meta) return null;
  const shared = (name) => {
    const spec = ASSETS?.files?.[name];
    return spec ? join(root, name) : null;
  };
  const engine = new EmbeddingEngine({
    modelPath: status.cachedPath,
    tokenizerPath: shared('tokenizer.json'),
    tokenizerConfigPath: shared('tokenizer_config.json'),
    dimensions: DEFAULT_GEMMA_DIM,
    modelType: 'embeddinggemma-2',
  });
  return engine;
}

/** Install the real engine when the cache is complete; report what was chosen. */
function attachEmbedder(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  if (!serviceRef) return null;
  const engine = buildEmbedderEngine(variant);
  if (!engine) return null;
  serviceRef.embedder = engine;
  loggerRef?.info?.(`memory: embedding engine attached (${variant}, ${engine.dimensions}-d)`);
  return engine;
}

/** Live preparation state, readable through `/status`. */
const preparationState = {
  phase: 'unknown',
  reason: 'not started',
  variant: null,
  cacheRoot: null,
  completedBytes: 0,
  totalBytes: 0,
  cached: false,
  error: null,
};

/** Pinned asset manifest for the EmbeddingGemma-2-ONNX model and tokenizer. */
let ASSETS = null
try {
  ASSETS = JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8'))
} catch (e) {
  // Assets manifest missing — preparation will fail defensively when attempted.
}

/** Minimal embedder download/preparation mechanism. Non-blocking; defensive. */
export const DEFAULT_EMBED_MODEL_VARIANT = 'q8';
/** Cache root for the pinned embedder assets, under the profile home. */
let modelsRootOverride = null;

/**
 * Point the asset cache somewhere other than `$DSH_HOME/models`.
 *
 * Used by `apply` from `config.modelsPath`, and by the workspace CLI's
 * `--models-path`, so both resolve the same directory.
 *
 * @param {string|null} dir
 */
export function setModelsRootOverride(dir) {
  modelsRootOverride = typeof dir === 'string' && dir.length > 0 ? dir : null;
}

function embedCacheRoot() {
  if (modelsRootOverride) return join(modelsRootOverride, 'embeddinggemma-2-ONNX');
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'models', 'embeddinggemma-2-ONNX');
}

/**
 * Resolve every pinned asset a variant needs, with its cache destination.
 *
 * The variant contributes two files — the ONNX graph and its `.onnx_data`
 * external weights — and the shared `files` block adds the tokenizer. The graph
 * is reported separately because it is the path the ONNX session opens, but it
 * is not sufficient on its own.
 *
 * Returns `modelPath: null` when the manifest is absent or carries no
 * descriptor, so callers branch instead of throwing on a missing manifest.
 */
export function embedAssetPaths(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  const root = embedCacheRoot();
  const meta = ASSETS?.variants?.[variant] || null;
  if (!ASSETS || !meta?.files) return { root, meta: null, modelPath: null, assets: [], allPinned: false };

  const shared = Object.entries(ASSETS.files || {})
    .filter(([name]) => !name.startsWith('$'))
    .map(([fileName, spec]) => ({ path: fileName, ...spec }));
  const variantFiles = Object.entries(meta.files).map(([fileName, spec]) => ({ path: fileName, ...spec }));

  const assets = [...shared, ...variantFiles].map((spec) => ({
    asset: spec,
    dest: join(root, spec.path),
  }));
  const graph = variantFiles.find((spec) => !spec.path.endsWith('.onnx_data')) ?? variantFiles[0] ?? null;
  const allPinned = assets.length > 0 && assets.every(({ asset }) => typeof asset.sha256 === 'string' && asset.sha256.length === 64);

  return { root, meta, modelPath: graph ? join(root, graph.path) : null, assets, allPinned };
}

/**
 * The variants a user may choose between, with the copy the panel shows.
 *
 * The descriptions travel with the pin, so a label cannot drift from the file it
 * describes. No entry is recommended here: which one wins depends on the CPU,
 * and this host measured the whole spread within 17%.
 */
export function listEmbedVariants() {
  if (!ASSETS) return [];
  const sharedBytes = Object.entries(ASSETS.files || {})
    .filter(([name]) => !name.startsWith('$'))
    .reduce((sum, [, spec]) => sum + (spec.bytes || 0), 0);
  return Object.entries(ASSETS.variants || {}).map(([id, meta]) => {
    const weightsBytes = Object.values(meta.files || {}).reduce((sum, spec) => sum + (spec.bytes || 0), 0);
    return {
      id,
      label: meta.label ?? id,
      note: meta.note ?? '',
      weightsBytes,
      totalBytes: sharedBytes + weightsBytes,
      isDefault: id === DEFAULT_EMBED_MODEL_VARIANT,
    };
  });
}

/**
 * Synchronous readiness report.
 *
 * Only the sizes are checked here: the full sha256 verification costs a read of
 * every byte and belongs to preparation, not to a status poll.
 */
export function memoryEmbedderStatus(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  const estimate = setupEstimate(variant);
  const { root, meta, modelPath, assets, allPinned } = embedAssetPaths(variant);
  const variants = listEmbedVariants();
  if (!ASSETS || !meta) {
    return { phase: 'unprepared', reason: 'assets manifest missing', estimate, pinVerified: false, variants, modelVariant: variant };
  }
  const cacheRoot = embedCacheRoot();
  // A run in flight is only "live" for the question that matches it: a status
  // poll for another variant, or for another cache root, must read its own cache
  // rather than inherit somebody else's download.
  const live = ['downloading', 'verifying'].includes(preparationState.phase)
    && preparationState.variant === variant
    && preparationState.cacheRoot === cacheRoot
    ? preparationState : null;
  let present = 0;
  for (const { asset, dest } of assets) {
    try {
      if (existsSync(dest) && statSync(dest).size === asset.bytes) present += 1;
    } catch {
      // An unreadable path counts as absent.
    }
  }
  const modelCached = assets.length > 0 && present === assets.length;
  const reason = live ? live.reason
    : modelCached ? 'model cached'
    : !allPinned ? 'asset pin not verified'
    : present > 0 ? `incomplete cache (${present}/${assets.length} files)`
    : 'model file not downloaded';
  return {
    phase: live ? live.phase : (modelCached ? 'ready' : 'unprepared'),
    reason,
    estimate,
    modelVariant: variant,
    defaultVariant: DEFAULT_EMBED_MODEL_VARIANT,
    modelType: 'embeddinggemma-2',
    variants,
    cacheRoot: root,
    cachedPath: modelPath,
    modelCached,
    presentFiles: present,
    totalFiles: assets.length,
    pinVerified: allPinned,
    progress: live ? { completedBytes: live.completedBytes, totalBytes: live.totalBytes } : null,
    error: preparationState.error,
  };
}

/**
 * Download, verify, and cache the pinned embedder assets.
 *
 * One step: fetch the shared tokenizer files, then the variant's graph and
 * weights, verifying each digest and publishing each with an atomic rename.
 * Never called from `apply`; the caller decides when the download cost is worth
 * paying, and the deterministic embedder covers every turn until it is.
 *
 * @returns the graph path once every asset is verified.
 * @throws {AssetError} with a `download.reason` the caller can surface.
 */
export async function prepareEmbedder(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  const { modelPath, assets, allPinned } = embedAssetPaths(variant);
  if (!ASSETS || !modelPath || assets.length === 0) {
    throw new AssetError('assets manifest missing or incomplete', { reason: 'manifest', resource: variant });
  }
  if (!ASSETS.baseUrl || typeof ASSETS.baseUrl !== 'string') {
    throw new AssetError('assets manifest has no baseUrl', { reason: 'manifest', resource: variant });
  }
  if (!allPinned) {
    throw new AssetError('assets manifest carries an unverified sha256 pin', { reason: 'unpinned', resource: variant });
  }

  const totalBytes = assets.reduce((sum, { asset }) => sum + (asset.bytes || 0), 0);
  preparationState.phase = 'downloading';
  preparationState.reason = 'download-started';
  preparationState.variant = variant;
  preparationState.cacheRoot = embedCacheRoot();
  preparationState.error = null;
  preparationState.completedBytes = 0;
  preparationState.totalBytes = totalBytes;

  let finishedBytes = 0;
  const onProgress = ({ completedBytes }) => {
    // Progress is reported per file, so add the files already published.
    preparationState.completedBytes = finishedBytes + (completedBytes ?? 0);
    preparationState.totalBytes = totalBytes;
  };

  try {
    for (const { asset, dest } of assets) {
      await ensureAsset({ url: ASSETS.baseUrl + asset.path, asset, dest, onProgress, origin: ASSETS.baseUrl });
      finishedBytes += asset.bytes || 0;
    }
    preparationState.phase = 'ready';
    preparationState.reason = 'model cached';
    preparationState.cached = true;
    preparationState.completedBytes = totalBytes;
    loggerRef?.info?.(`memory: embedder ready at ${modelPath}`);
    return modelPath;
  } catch (error) {
    preparationState.phase = 'failed';
    preparationState.reason = error?.download?.reason ?? 'unknown';
    preparationState.error = error?.message ?? String(error);
    logPluginError(name, 'embedder-download', error);
    loggerRef?.warn?.(`memory: embedder download failed (${preparationState.reason}) — ${preparationState.error}`);
    throw error;
  }
}

/**
 * Kick off preparation without waiting for it.
 *
 * Returns the state at call time, not a promise: the caller is a click, and the
 * panel learns the outcome by polling `/status`.
 */
export function startEmbedderPreparation(variant = DEFAULT_EMBED_MODEL_VARIANT) {
  if (preparationState.phase === 'downloading' || preparationState.phase === 'verifying') {
    return { ...preparationState, joined: true };
  }
  try {
    const status = memoryEmbedderStatus(variant);
    if (status.modelCached) {
      preparationState.phase = 'ready';
      preparationState.reason = 'model cached';
      preparationState.variant = variant;
      preparationState.cacheRoot = embedCacheRoot();
      preparationState.completedBytes = status.estimate.recommendedDiskBytes;
      preparationState.totalBytes = status.estimate.recommendedDiskBytes;
      return { ...preparationState };
    }
    if (!status.pinVerified) {
      const error = new AssetError('asset sha256 pin is not verified', { reason: 'unpinned', resource: variant });
      logPluginError(name, 'embedder-prepare', error);
      return { phase: 'failed', reason: 'unpinned', variant, error: error.message };
    }
    // Fire and forget: the rejection is handled inside prepareEmbedder, which
    // records it in `preparationState` and writes the stack to disk. On success
    // the freshly verified weights become the active embedder immediately,
    // rather than waiting for a restart to notice them.
    prepareEmbedder(variant)
      .then(() => { attachEmbedder(variant); })
      .catch(() => {});
    return { phase: 'downloading', reason: 'download-started', variant, totalBytes: status.estimate.recommendedDiskBytes };
  } catch (err) {
    logPluginError(name, 'embedder-prepare', err);
    return { phase: 'failed', reason: String(err?.message || err), variant };
  }
}

export const name = 'memory';

/**
 * Whether a preset injects recalled memory.
 *
 * Precedence: the preset's own entry in the policy, then the policy's default,
 * then the plugin config. An unknown preset is therefore off unless the config
 * or the policy says otherwise.
 */
export function recallEnabledForPreset(policy, presetId, fallback = false) {
  if (policy === null || typeof policy !== 'object') return fallback === true;
  if (typeof presetId === 'string' && Object.prototype.hasOwnProperty.call(policy.presets ?? {}, presetId)) {
    return policy.presets[presetId] === true;
  }
  if (policy.default === true) return true;
  return fallback === true;
}

/** Disk/memory/estimate for the embedder download, matching TTS setupEstimate pattern. */
export function setupEstimate(modelVariant = DEFAULT_EMBED_MODEL_VARIANT) {
  const empty = { recommendedDiskBytes: 0, expectedMemoryBytes: 0, minimumMinutes: 0, maximumMinutes: 0, modelVariant, modelType: 'embeddinggemma-2' };
  if (!ASSETS) return empty;
  const meta = ASSETS.variants?.[modelVariant];
  if (!meta) return empty;
  const shared = Object.entries(ASSETS.files || {})
    .filter(([name]) => !name.startsWith('$'))
    .reduce((sum, [, spec]) => sum + (spec.bytes || 0), 0);
  const variantBytes = Object.values(meta.files || {}).reduce((sum, spec) => sum + (spec.bytes || 0), 0);
  const diskBytes = shared + variantBytes;
  return {
    recommendedDiskBytes: diskBytes,
    // The ONNX session holds the weights plus its own working set.
    expectedMemoryBytes: Math.round(variantBytes * 1.6),
    // Roughly a minute per 100 MB on this host's uplink; the range is wide on purpose.
    minimumMinutes: Math.max(1, Math.round(diskBytes / 1e8)),
    maximumMinutes: Math.max(2, Math.round(diskBytes / 4e7)),
    modelVariant,
    modelType: 'embeddinggemma-2',
    label: meta.label,
    note: meta.note,
  };
}

/**
 * Required services.
 *
 * `systemPrompt` and `tools` are read directly, and a direct property read on an
 * undeclared service throws — optional chaining does not soften it. `webServer`
 * is deliberately absent: it may not exist when this row applies, so it is
 * awaited through `ctx.inject(['webServer'], ...)` below instead.
 */
export const inject = ['systemPrompt', 'tools'];

/** Default standalone server port for headless environments. */
export const DEFAULT_STANDALONE_PORT = 3180;

/** Characters of one turn kept when indexing a transcript. */
export const MAX_TRANSCRIPT_CHARS = 16000;

/** Characters of caller-supplied text accepted by `ingest_reference`. */
export const MAX_REFERENCE_INPUT_CHARS = 200000;

/** Where plugin errors are written before rethrow, per docs/lessons-learned.md §5. */
function logPluginError(plugin, stage, error) {
  try {
    const dir = (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'plugin-errors') : join(homedir(), '.dsh', 'plugin-errors'));
    mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} [${plugin}] ${stage}: ${error?.stack ?? error}\n`;
    appendFileSync(join(dir, 'dsh-memory.log'), line);
  } catch {
    // Best-effort; never throw on logging.
  }
}

/** Guard: log to disk, then rethrow so the harness sees the failure. */
function guard(ctx, stage, body) {
  try {
    return body();
  } catch (error) {
    logPluginError(name, stage, error);
    ctx.logger?.error?.(`memory: ${stage} failed — ${error?.message ?? error}`);
    throw error;
  }
}

/** Resolve defineTool with harness fallback. */
async function resolveDefineTool() {
  try {
    const pkg = await import('@deepseek-ai/dsh-tools');
    if (typeof pkg.defineTool === 'function') return pkg.defineTool;
  } catch {
    // Fallback
  }
  try {
    const harnessPath = '/export/DownloadsSSD/AI/TEXT/deepseek-harness/packages/core/tools/lib/index.js';
    const harnessPkg = await import(harnessPath);
    if (typeof harnessPkg.defineTool === 'function') return harnessPkg.defineTool;
  } catch {
    // Final fallback: identity wrapper
  }
  return (tool) => tool;
}

export function apply(ctx, config = {}) {
  return guard(ctx, 'apply', () => {
    // Background work outlives this scope; give it a logger it can still reach.
    loggerRef = ctx.logger ?? null;
    // A deployment may keep weights somewhere other than the profile home —
    // an unwritable $DSH_HOME is the common reason. Absent the option, the
    // documented location stands.
    setModelsRootOverride(config.modelsPath);
    const namespace = config.namespace || 'global';
    // Transcript capture writes to the corpus every completed turn, so it is a
    // switch, not an assumption. On by default, because a corpus with no session
    // history cannot answer questions about earlier work.
    const captureTranscripts = config.captureTranscripts !== false;
    // Passive recall is OFF by default. It changes what every agent sees on every
    // turn, and a profile-global bundle must not make that decision for a preset
    // whose author never considered it. The config is the pre-policy default; the
    // per-preset table below is what actually decides.
    const recallFallback = config.recallEnabled === true;
    const recallPolicyPath = typeof config.recallPolicyPath === 'string' && config.recallPolicyPath.length > 0
      ? config.recallPolicyPath
      : defaultRecallPolicyPath();
    const recallPolicy = createRecallPolicyReader(recallPolicyPath);
    const recallFor = (agent) => recallEnabledForPreset(recallPolicy(), agent?.session?.header?.agentPreset, recallFallback);
    // Where uploads land. The same folder the workspace CLI reads, so a file the
    // UI wrote is picked up by a later CLI run even if indexing failed here.
    const ingestFolder = typeof config.ingestFolder === 'string' && config.ingestFolder.length > 0
      ? config.ingestFolder
      : defaultIngestFolder();
    const storagePath = config.storagePath || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages', 'memory.db') : join(process.cwd(), 'storages', 'memory.db'));
    const inMemory = Boolean(config.inMemory);

    // 1. Build service (no blocking embedding on init)
    const service = new MemoryService({
      storagePath: inMemory ? ':memory:' : storagePath,
      inMemory,
      defaultNamespace: namespace,
    });
    // A download that finishes later hands its engine to this reference.
    serviceRef = service;
    // If the weights are already on disk, use them now. Construction stays
    // synchronous: the ONNX session loads on first embed, not here.
    const attached = attachEmbedder(DEFAULT_EMBED_MODEL_VARIANT);
    if (!attached) {
      ctx.logger?.info?.('memory: embedding model not cached; using the deterministic embedder until /api/memory/prepare-embedder runs');
    }

    // Provide service globally
    if (typeof ctx.provide === 'function') {
      ctx.provide('memory', service);
    }

    // 2. Core prompt section (static prefix, order 110, interpolate false)
    if (typeof ctx.systemPrompt?.section === 'function') {
      const descriptor = createCorePromptSectionDescriptor(service.core || service, {
        name: CORE_PROMPT_SECTION_NAME,
        order: CORE_PROMPT_SECTION_ORDER,
        namespace,
      });
      ctx.effect(() => ctx.systemPrompt.section({
        ...descriptor,
        text: () => descriptor.text(),
      }), 'memory.prompt-section');
    }

    // 3. Agent tools
    const registerTools = async () => {
      const define = await resolveDefineTool();

      // manage_core_memory (Tier 1)
      const manageTool = createManageCoreMemoryTool(service.core || service, {
        defineTool: define,
        defaultNamespace: namespace,
      });
      if (manageTool && typeof manageTool.execute === 'function') {
        ctx.tools?.register?.(manageTool);
      }

      // search_memories (Tier 2 & 3)
      ctx.tools?.register?.(define({
        name: 'search_memories',
        description: 'Search episodic memories and core directives using hybrid FTS5 + dense embedding retrieval (DigUp). Returns bounded results capped at 20.',
        parameters: {
          query: { type: 'string', description: 'Search query text.', required: true },
          namespace: { type: 'string', description: 'Namespace filter.' },
          limit: { type: 'integer', description: 'Max results (default 5, max 20).' },
          mode: { type: 'string', enum: ['hybrid', 'fts', 'vector'], description: 'Search mode.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async ({ query, namespace: ns, limit, mode }) => {
          const opts = {
            namespace: ns || namespace,
            limit: Math.min(Math.max(Number(limit) || 5, 1), 20),
            mode: mode || 'hybrid',
          };
          return await service.searchMemories(query, opts);
        },
      }));

      // store_memory (Tier 2 & 3)
      ctx.tools?.register?.(define({
        name: 'store_memory',
        description: 'Store an episodic memory with optional tags, summary, and dense vector embedding.',
        parameters: {
          content: { type: 'string', description: 'Memory content.', required: true },
          summary: { type: 'string', description: 'Short summary.' },
          tags: { type: 'array', description: 'String tags array.' },
          namespace: { type: 'string', description: 'Namespace.' },
          status: { type: 'string', enum: ['canon', 'provisional', 'rejected'], description: 'Memory status.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async ({ content, summary, tags, namespace: ns, status }) => {
          return await service.storeMemory({
            content,
            summary: summary || null,
            tags: Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : null),
            namespace: ns || namespace,
            status: status || 'canon',
          });
        },
      }));

      // search_reference (Tier 4 — corpus chunks)
      ctx.tools?.register?.(define({
        name: 'search_reference',
        description: 'Search reference documentation and corpus knowledge chunks.',
        parameters: {
          query: { type: 'string', description: 'Search query.', required: true },
          collection: { type: 'string', description: 'Collection filter.' },
          limit: { type: 'integer', description: 'Max results (default 5, max 20).' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async ({ query, collection, limit }) => {
          return await service.searchReference(query, {
            limit: Math.min(Math.max(Number(limit) || 5, 1), 20),
            collection: collection || undefined,
          });
        },
      }));

      // ingest_reference (Tier 4 — session-supplied documents)
      //
      // The session-level half of corpus ingestion, alongside the workspace CLI
      // and UI uploads. It writes reference material the model or user supplies
      // during a conversation: a pasted handout, a rules excerpt, a document the
      // agent just read. Nothing is captured implicitly here — transcript
      // capture is the hook's separate job.
      ctx.tools?.register?.(define({
        name: 'ingest_reference',
        description:
          'Add a document or excerpt to the searchable reference corpus so `search_reference` can find it later. '
          + 'Use it for material worth keeping verbatim: rules, handouts, specifications, or a document just read. '
          + 'Re-ingesting identical content is a no-op.',
        parameters: {
          content: { type: 'string', description: 'The document text to index.', required: true },
          title: { type: 'string', description: 'Short title for the document.' },
          collection: { type: 'string', description: 'Collection to file it under. Defaults to "session".' },
          sourcePath: { type: 'string', description: 'Stable label for this document; re-ingesting the same label with new content replaces it.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async ({ content, title, collection, sourcePath }, exec) => {
          if (typeof content !== 'string' || content.trim().length === 0) {
            return { success: false, error: 'content must be a non-empty string' };
          }
          if (content.length > MAX_REFERENCE_INPUT_CHARS) {
            return {
              success: false,
              error: `content is ${content.length} characters; the limit is ${MAX_REFERENCE_INPUT_CHARS}. Split it into several calls.`,
            };
          }
          const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? 'unknown';
          const hash = hashContent(content);
          const target = sourcePath && sourcePath.trim().length > 0
            ? sourcePath.trim()
            : `session:${sessionId}/${hash.slice(0, 12)}`;
          try {
            const record = await ingestText(service, {
              content,
              collection: collection && collection.trim().length > 0 ? collection.trim() : 'session',
              sourcePath: target,
              title: title ?? null,
              origin: 'session',
              namespace: `session:${sessionId}`,
            });
            return {
              success: true,
              status: record.status,
              collection: record.collection,
              sourcePath: record.sourcePath,
              chunkCount: record.chunkCount,
              ...(record.truncated ? { truncated: true, totalChunks: record.totalChunks } : {}),
              ...(record.reason ? { reason: record.reason } : {}),
            };
          } catch (error) {
            logPluginError(name, 'ingest_reference', error);
            return { success: false, error: String(error?.message ?? error) };
          }
        },
      }));
    };

    // Register synchronously; tool registry is usually available at apply time.
    registerTools().catch(err => {
      logPluginError(name, 'register-tools', err);
      ctx.logger?.warn?.(`memory: tool registration deferred — ${err?.message ?? err}`);
    });

    // Shared route options. Getters keep the embedder state readable per request
    // rather than frozen at mount, so a preparation started later is visible.
    const routeOptions = {
      service,
      prefix: config.apiPath || '/api/memory',
      enabled: config.apiEnabled !== false,
      token: config.apiToken || '',
      allowAnonymous: Boolean(config.apiAllowAnonymous),
      maxSearchLimit: 20,
      // The variant argument is forwarded, not dropped: a panel asking about
      // q4f16 must read q4f16's cache rather than the default's.
      embedderStatus: (variant) => memoryEmbedderStatus(variant),
      prepareEmbedder: (variant) => startEmbedderPreparation(variant || DEFAULT_EMBED_MODEL_VARIANT),
      // UI uploads land in the configured ingestion folder and are then indexed,
      // so the same folder a workspace CLI run reads is the folder the UI writes.
      uploadDocument: (upload) => ingestUpload(service, { ...upload, inboxFolder: ingestFolder }),
      listInboxFiles: () => listInbox(ingestFolder),
      removeInboxFile: (collection, filename) => removeInboxFile(ingestFolder, collection, filename),
      // Force one document back through the engine. `force` is what makes this a
      // re-index rather than a no-op: the content hash would otherwise report the
      // source as unchanged and skip it.
      reindexCorpus: async ({ collection, filename, sourcePath }) => {
        if (typeof filename !== 'string' || filename.length === 0) {
          throw new Error('filename is required to re-index: pass the inbox file to read');
        }
        const path = join(ingestFolder, collection, filename);
        const result = await ingestFileAt(service, { filePath: path, collection, force: true });
        return { ok: result.status === 'ingested', ...result };
      },
      reembedVectors: (limit) => service.reembedMissing({ limit }),
      recallPolicyPath,
      writeRecallPolicy: (next) => writeRecallPolicyFile(recallPolicyPath, next),
      // Read from the live registry, so a newly declared preset appears in the
      // switch without editing this plugin.
      listPresets: async () => {
        try {
          const registry = ctx.get?.('agentPresets');
          if (registry === undefined || typeof registry.list !== 'function') return [];
          const listed = await registry.list();
          return listed.map((entry) => entry?.id).filter((id) => typeof id === 'string').sort();
        } catch {
          return [];
        }
      },
      recallPolicyState: () => {
        const policy = readRecallPolicy(recallPolicyPath);
        return { path: recallPolicyPath, default: policy.default, presets: policy.presets, problem: policy.problem, fallback: recallFallback };
      },
    };

    // 4. Deferred HTTP route mount (do not declare static inject: ['webServer'])
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer;
      if (!webServer || typeof webServer.register !== 'function') {
        ctx.logger?.info?.('memory: webServer unavailable; route deferred');
        return;
      }
      const prefix = routeOptions.prefix;
      const handler = createRouteHandler(routeOptions);
      webCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: prefix,
        handler,
      }), 'memory.http-route');
      ctx.logger?.info?.(`memory: HTTP API mounted at ${prefix}`);

      // The route authenticates itself, so the browser half needs the credential,
      // and the page is only ever served to an already-authenticated browser.
      // Injecting it into the document is how the TTS bundle bridges the same
      // gap; a rotated token needs a page refresh, which is the acceptable trade
      // for not inventing a second authentication story.
      if (typeof webServer.tapIndex !== 'function') {
        ctx.logger?.warn?.('memory: webServer has no tapIndex; the settings panel will not receive its credential');
        return;
      }
      webCtx.effect(() => webServer.tapIndex((html) => {
        const identity = { prefix, token: routeOptions.token };
        const tag = `<script>window.__DSH_MEMORY__=${JSON.stringify(identity).replace(/</g, '\\u003c')}</script>`;
        return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
      }), 'memory.index-identity');
    });

    // 5. Standalone HTTP server fallback for headless environments
    const startStandaloneServer = () => {
      try {
        const handler = createRouteHandler(routeOptions);
        const server = http.createServer((req, res) => {
          // Minimal adapter; pure dispatcher handles routing
          // Use pure dispatcher directly for simplicity
          const url = new URL(req.url || '/', `http://localhost:${DEFAULT_STANDALONE_PORT}`);
          const pathname = url.pathname || '/';
          const queryStr = url.search || '';
          const query = new URLSearchParams(queryStr);
          // Read body for POST
          let body = Buffer.alloc(0);
          let bodyDone = false;
          const finish = () => {
            const parsedBody = body.length > 0 ? (() => {
              try { return JSON.parse(body.toString('utf8')); } catch { return body.toString('utf8'); }
            })() : null;
            const request = {
              method: req.method || 'GET',
              pathname,
              query,
              headers: Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
              body: parsedBody,
            };
            handler(request).then(({ status = 200, headers = {}, body: respBody }) => {
              res.writeHead(status || 200, headers || {});
              if (Buffer.isBuffer(respBody)) {
                res.end(respBody);
              } else {
                res.end(respBody ? String(respBody) : '');
              }
            }).catch(err => {
              res.writeHead(500, { 'content-type': 'text/plain' });
              res.end(String(err?.message || err));
            });
          };
          if (req.method === 'POST' || req.method === 'PUT') {
            req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
            req.on('end', () => { bodyDone = true; finish(); });
          } else {
            finish();
          }
        });
        server.listen(DEFAULT_STANDALONE_PORT, '127.0.0.1', () => {
          ctx.logger?.info?.(`memory: standalone HTTP server running on http://127.0.0.1:${DEFAULT_STANDALONE_PORT}`);
        });
      } catch (err) {
        ctx.logger?.warn?.(`memory: standalone server failed — ${err?.message ?? err}`);
      }
    };

    // Only start standalone if webServer was not immediately available
    if (ctx.get?.('webServer', false) === undefined && config.standalone !== false) {
      ctx.logger?.info?.('memory: webServer not up yet; standalone server will try on port ' + DEFAULT_STANDALONE_PORT);
      // Defer standalone start slightly so plugin init completes
      setTimeout(startStandaloneServer, 500);
    }

    // 6. Pre-turn passive recall hook (`agent/pre-step` — waterfall, must call next)
    if (typeof ctx.on === 'function') {
      ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
        try {
          const decision = typeof next === 'function' ? await next() : undefined;
          if (signal?.aborted) return decision;
          if (decision && decision.kind === 'reject') return decision;
          // Mounted but disabled costs one boolean test and nothing else: no
          // search, no embedding, no message built. The row stays loaded so
          // enabling it later needs no restart.
          if (!recallFor(agent)) return decision;
          // Once per turn, on the step that opens it. A turn can take many steps,
          // and re-embedding the same query for each one would put an avoidable
          // search in front of every model call on a 2-core host. `step !== 1` is
          // the idiom the shipped context plugins use for the same reason.
          if (step !== undefined && step !== 1) return decision;
          const messages = (decision && Array.isArray(decision.messages)) ? decision.messages : [];
          if (messages.length === 0) return decision;
          // Find the most recent direct user message to seed the recall query
          const lastUser = messages.slice().reverse().find((m) => m?.source?.kind === 'user' || (m?.content && Array.isArray(m.content)));
          if (!lastUser) return decision;
          const userText = (lastUser.content || [])
            .filter((b) => b?.type === 'text')
            .map((b) => String(b.text || ''))
            .join(' ').trim();
          if (userText.length < 3) return decision;
          // Light bounded search: cap query text, cap results at 5, include core + episodic only
          const recall = await service.searchMemories(userText.slice(0, 200), {
            namespace,
            limit: 5,
            mode: 'hybrid',
            includeCore: true,
            includeEpisodic: true,
            includeCorpus: false,
            status: 'canon',
          }).catch(() => ({ query: userText.slice(0, 200), total: 0, results: [] }));
          if (recall.results && recall.results.length > 0) {
            // Chronological, oldest first, each line dated. Retrieval ranks by
            // score, and a remembered fact without its place in the sequence is
            // half a memory — "the gate is open" means something different before
            // and after the siege.
            const stamp = (item) => item.created_at ?? item.updated_at ?? 0;
            const label = (item) => {
              const when = stamp(item);
              const date = when ? new Date(when).toISOString().slice(0, 10) : null;
              const turnRef = item.turn_ref ?? null;
              const parts = [];
              if (turnRef) parts.push(`turn ${turnRef}`);
              if (date) parts.push(date);
              return parts.length > 0 ? `[${parts.join(' · ')}] ` : '';
            };
            const capped = recall.results
              .slice(0, 3)
              .sort((a, b) => stamp(a) - stamp(b));
            const briefText = capped
              .map((r) => {
                // Core memories have a key worth naming; an episodic memory's only
                // name is a uuid, and a uuid in the block is noise the model cannot
                // use. The date and turn already place it.
                const name = r.key ? `${r.key}: ` : '';
                return `- ${label(r)}${name}${String(r.content || r.directive || '').slice(0, 200)}`;
              })
              .join('\n');
            const brief = `Passive recall (${capped.length} item(s), oldest first):\n${briefText}`;
            // Inject a source-tagged system message into the step messages if safe
            const injectedMessages = Array.isArray(messages) ? [...messages] : messages;
            injectedMessages.push({
              source: { kind: 'system', plugin: 'memory', form: 'passive-recall', turn: agent?.turn ?? 0 },
              content: [{ type: 'text', text: brief }],
            });
            return { ...decision, messages: injectedMessages };
          }
          return decision;
        } catch (err) {
          logPluginError(name, 'agent/pre-step', err);
          return typeof next === 'function' ? await next() : undefined;
        }
      }, { prepend: true });
    }

    /**
     * Index one completed turn as reference material.
     *
     * The transcript is the session's own record, so it belongs in the corpus
     * under a per-session namespace. Identity is `session:<id>/turn-<n>`, which
     * makes the content hash meaningful: re-deriving an unchanged turn is a skip
     * rather than a second copy.
     *
     * Only genuine player input is captured. Injected context uses other source
     * kinds, and including it would index this plugin's own recall blocks as if
     * the user had written them.
     *
     * The shape follows the dd35 preset's transcripts: a `# Turn NNNN — title`
     * heading, one-line metadata beneath it, then the exchange under `## User`
     * and `## Assistant`. A transcript that carries its own turn number, session,
     * and clock reading is self-locating — a hit can say when and where it came
     * from without a second lookup, and a plain-text reader can still sort it.
     */
    async function captureTurnTranscript(agent, messages, turn) {
      const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown';
      const assistantMsg = messages.slice().reverse().find((m) => m?.role === 'assistant' || m?.source?.kind === 'assistant');
      const userMsg = messages.slice().reverse().find((m) => m?.role === 'user' && m?.source?.kind === 'user');
      const assistantText = textOfMessage(assistantMsg);
      if (assistantText.length < 10) return null;
      const userText = textOfMessage(userMsg);
      const turnNumber = Number.isInteger(turn) ? turn : (agent?.turn ?? 'unknown');
      const padded = typeof turnNumber === 'number' ? String(turnNumber).padStart(4, '0') : String(turnNumber);

      const head = [`# Turn ${padded} — ${deriveTitle(userText) ?? 'Untitled turn'}`];
      head.push(`- Session: ${sessionId}`);
      head.push(`- Captured: ${new Date().toISOString()}`);
      const tools = toolsOf(assistantMsg);
      if (tools.length > 0) head.push(`- Tools: ${tools.join(', ')}`);
      const messageId = userMsg?.source?.rpcId ?? userMsg?.id;
      if (typeof messageId === 'string' && messageId.length > 0) head.push(`- Player-Message: ${messageId}`);

      const body = [
        head.join('\n'),
        '',
        '## User',
        userText.length > 0 ? userText : '(no direct input recorded)',
        '',
        '## Assistant',
        assistantText,
      ].join('\n');
      // Bound what one turn can add; a long reply is still worth indexing, but not
      // at the cost of an unbounded write from a hook. The header is at the front,
      // so the metadata survives a truncation.
      const capped = body.length > MAX_TRANSCRIPT_CHARS
        ? `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[truncated at ${MAX_TRANSCRIPT_CHARS} characters]`
        : body;
      return await ingestText(service, {
        content: capped,
        collection: 'transcripts',
        sourcePath: `session:${sessionId}/turn-${turnNumber}`,
        title: `Turn ${padded}`,
        origin: 'transcript',
        namespace: `session:${sessionId}`,
      });
    }

    /**
     * Tool names a turn called, in order, de-duplicated.
     *
     * The block shape has been `{ type: 'tool-call', name }` where it was read,
     * but the name has moved before; the alternates are checked rather than
     * assumed, and a block that carries none is skipped instead of rendering
     * `undefined` into the header.
     */
    function toolsOf(message) {
      const names = [];
      for (const block of message?.content ?? []) {
        if (typeof block?.type !== 'string' || !block.type.includes('tool')) continue;
        const name = block.name ?? block.toolName ?? block.tool;
        if (typeof name === 'string' && name.length > 0 && !names.includes(name)) names.push(name);
      }
      return names.slice(0, 20);
    }

    /** Characters kept from one turn's exchange in an episodic memory. */
    const MAX_EPISODIC_CHARS = 2000;

    /** The text blocks of a message, joined. */
    function textOfMessage(message) {
      return (message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('\n').trim();
    }

    /**
     * Render one turn as it happened: the player's words, then the reply.
     *
     * A memory of the answer without the question cannot be judged later, and the
     * injected recall block shows these in order, so the shape matters.
     */
    function exchangeOf(messages, assistantText) {
      const userMsg = messages.slice().reverse().find((m) => m?.role === 'user' && m?.source?.kind === 'user');
      const userText = textOfMessage(userMsg);
      if (userText.length === 0) return assistantText;
      return `Player: ${userText}\n\nAssistant: ${assistantText}`;
    }

    /**
     * Sessions with a transcript capture still running.
     *
     * Capture is off the turn, so a slow embedder could let several turns' worth of
     * work stack up behind each other. The guard is per session rather than
     * global: one session's turns must not queue behind another's, and a turn that
     * arrives while its own session is still capturing is skipped — its transcript
     * is worth less than the reply it would otherwise compete with.
     */
    const transcriptCaptureInFlight = new Set();

    // 7. Post-turn background work (`agent/turn-stopping` — serial, no next)
    //
    // Two things happen here, both off the reply path: the turn's exchange becomes
    // an episodic memory, and the turn itself is indexed as reference material.
    //
    // The memory is `canon`. If it happened in the conversation it is a memory —
    // there is no provisional class of "maybe", and a machine-extracted turn is no
    // less real than one the model chose to store.
    if (typeof ctx.on === 'function') {
      ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        try {
          if (signal?.aborted) return;
          // A subagent turn is not the session's record. Subagents inherit the
          // composition opportunistically, so this hook fires for them too, and
          // indexing their internal work would fill the corpus with scaffolding
          // nobody asked to keep.
          if (agent?.session?.header?.origin === 'subagent') return;
          // Derive messages safely; harvest only the latest assistant message content
          const messages = (agent && typeof agent.deriveMessages === 'function') ? agent.deriveMessages() : [];
          const assistantMsg = messages.slice().reverse().find((m) => m?.role === 'assistant' || m?.source?.kind === 'assistant');
          if (!assistantMsg || !assistantMsg.content) return;
          const assistantText = textOfMessage(assistantMsg);
          if (assistantText.length < 10) return; // Skip very short turns (no harvestable substance)
          // The exchange, not just the reply: the player's message is half of what
          // happened, and a memory of the answer alone loses the question.
          const recordedTurn = Number.isInteger(turn) ? turn : (agent?.turn ?? 'unknown');
          const exchange = exchangeOf(messages, assistantText);
          setTimeout(async () => {
            try {
              await service.storeMemory({
                content: exchange.slice(0, MAX_EPISODIC_CHARS),
                summary: assistantText.slice(0, 180),
                // The date and turn are carried in the content as well as the tags:
                // retrieval ranks by score, and a remembered fact without its place
                // in the sequence is only half a memory.
                tags: ['conversation', `turn:${recordedTurn}`, new Date().toISOString().slice(0, 10)],
                namespace,
                status: 'canon',
                turnRef: String(recordedTurn),
              });
            } catch (storeErr) {
              ctx.logger?.warn?.(`memory: post-turn harvest store failed — ${storeErr?.message ?? storeErr}`);
            }
          }, 50);
          // Transcript capture, when the operator has left it on.
          const captureKey = agent?.session?.id ?? agent?.id ?? 'unknown';
          if (captureTranscripts && !transcriptCaptureInFlight.has(captureKey)) {
            transcriptCaptureInFlight.add(captureKey);
            setTimeout(() => {
              void captureTurnTranscript(agent, messages, turn)
                .catch((error) => {
                  logPluginError(name, 'transcript-capture', error);
                  ctx.logger?.warn?.(`memory: transcript capture failed — ${error?.message ?? error}`);
                })
                .finally(() => { transcriptCaptureInFlight.delete(captureKey); });
            }, 60);
          }
        } catch (err) {
          logPluginError(name, 'agent/turn-stopping', err);
        }
      });
    }

    // 8. Embedder preparation status (lazy, non-blocking; matches TTS setupEstimate + prepare pattern)
    const embedStatus = memoryEmbedderStatus();
    ctx.logger?.info?.(`memory: embedder status: phase=${embedStatus.phase}, reason=${embedStatus.reason}, estimate=${JSON.stringify(embedStatus.estimate)}`);

    // 9. Status log
    ctx.logger?.info?.(`memory: service initialized (namespace: ${namespace}, storage: ${inMemory ? ':memory:' : storagePath})`);

    return { service };
  });
}
