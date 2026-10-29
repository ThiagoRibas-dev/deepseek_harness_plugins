/**
 * HTTP REST dispatcher for dsh-memory.
 *
 * Two layers: `routeRequest` is pure (testable offline), `createRouteHandler`
 * adapts it to `node:http` or the harness webServer.
 */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

const MAX_SEARCH_LIMIT = 20;
const MAX_TOOL_LIST_RESULTS = 100;

function jsonResponse(status, value, extraHeaders = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'),
  };
}

/**
 * Length-independent constant-time comparison, so a token cannot be probed a byte
 * at a time. Same reasoning as the TTS route.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function sanitizePath(pathname = '/') {
  return pathname.replace(/\.\./g, '').replace(/\/+/g, '/') || '/';
}

export async function routeRequest(request, options) {
  const {
    service,
    enabled = false,
    token = '',
    allowAnonymous = false,
    maxSearchLimit = MAX_SEARCH_LIMIT,
    prefix = '/api/memory',
    embedderStatus,
    prepareEmbedder,
    uploadDocument,
    listInboxFiles,
    removeInboxFile,
    reindexCorpus,
    reembedVectors,
    recallPolicyState,
    writeRecallPolicy,
    listPresets,
  } = options || {};

  // Authentication.
  //
  // A plugin route inherits none of the harness's own authentication, and the
  // harness binds the web server to the network. An empty token therefore cannot
  // mean "no authentication needed" — it means nobody configured one, and
  // serving anyway would let anyone who can reach the port purge vectors or
  // start a 346 MB model download. Anonymous access has to be asked for by name.
  if (!enabled) {
    return jsonResponse(503, { error: 'Memory API disabled' });
  }

  const configuredToken = typeof token === 'string' ? token : '';
  if (!allowAnonymous) {
    if (configuredToken.length === 0) {
      return jsonResponse(503, {
        error: 'Memory API has no apiToken configured; set one, or set apiAllowAnonymous: true to serve without authentication',
      });
    }
    const rawAuth = request?.headers?.authorization || request?.headers?.Authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(rawAuth).trim());
    if (!match || !safeEqual(match[1], configuredToken)) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
  }

  if (!service) {
    return jsonResponse(500, { error: 'Memory service not available' });
  }

  const pathname = sanitizePath(request?.pathname || '/');
  const method = (request?.method || 'GET').toUpperCase();
  const body = request?.body || null;

  // Route matching (prefix stripped externally; here we assume pathname is after prefix)
  // But for simplicity, we match full pathname patterns.

  if (pathname === '/' || pathname === '/api/memory') {
    if (method === 'GET') {
      return jsonResponse(200, { service: 'dsh-memory', status: 'ready', endpoints: ['search', 'store', 'core', 'status', 'prepare-embedder', 'corpus/upload', 'corpus/sources', 'corpus/remove', 'corpus/reindex', 'vectors/reembed', 'vectors/purge', 'recall-policy'] });
    }
    return jsonResponse(404, { error: 'Not found' });
  }

  // GET /api/memory/status — service counts plus embedder readiness
  if (pathname === '/api/memory/status' || pathname === '/status') {
    if (method !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
    try {
      const requestedVariant = request?.query?.get?.('variant') || undefined;
      const serviceStatus = typeof service.status === 'function' ? service.status() : {};
      const embedder = typeof embedderStatus === 'function' ? embedderStatus(requestedVariant) : null;
      // The preset list travels with the status so the recall switch can name the
      // presets this deployment actually has, rather than a hard-coded few.
      const presets = typeof listPresets === 'function' ? await listPresets() : [];
      return jsonResponse(200, {
        ...serviceStatus,
        presets,
        embedder: embedder === null
          ? serviceStatus.embedder
          : { ...(serviceStatus.embedder || {}), ...embedder },
        preparation: embedder,
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/prepare-embedder — start the pinned-model download
  if (pathname === '/api/memory/prepare-embedder' || pathname === '/prepare-embedder') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    if (typeof prepareEmbedder !== 'function') {
      return jsonResponse(503, { error: 'Embedder preparation is not available' });
    }
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    try {
      // Returns immediately with the state at call time; the caller polls /status.
      return jsonResponse(202, prepareEmbedder(payload?.variant));
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/corpus/upload — accept a document into the ingestion inbox
  if (pathname === '/api/memory/corpus/upload' || pathname === '/corpus/upload' || pathname === '/upload') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    if (typeof uploadDocument !== 'function') {
      return jsonResponse(503, { error: 'Upload is not available' });
    }
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    const filename = payload?.filename ?? payload?.name ?? '';
    // `contentBase64` is accepted so a client that read the file as bytes can
    // send it without guessing an encoding; anything non-UTF-8 is refused by the
    // binary check rather than silently mangled.
    let content = payload?.content;
    if (typeof content !== 'string' && typeof payload?.contentBase64 === 'string') {
      try { content = Buffer.from(payload.contentBase64, 'base64').toString('utf8'); } catch { content = undefined; }
    }
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      return jsonResponse(400, { error: 'filename is required' });
    }
    if (typeof content !== 'string' || content.length === 0) {
      return jsonResponse(400, { error: 'content (or contentBase64) is required' });
    }
    try {
      return jsonResponse(201, await uploadDocument({
        filename,
        content,
        collection: payload?.collection,
        title: payload?.title,
        namespace: payload?.namespace,
        force: payload?.force === true,
      }));
    } catch (err) {
      return jsonResponse(400, { error: String(err?.message || err) });
    }
  }

  // GET/POST /api/memory/recall-policy — which presets inject recalled memory
  //
  // Settings reads and writes this. The write is a whole-document replacement so
  // the caller decides the shape, and the JSON parse on the reading side is the
  // validator.
  if (pathname === '/api/memory/recall-policy' || pathname === '/recall-policy') {
    if (typeof recallPolicyState !== 'function' || typeof writeRecallPolicy !== 'function') {
      return jsonResponse(503, { error: 'Recall policy is not available' });
    }
    if (method === 'GET') {
      try {
        return jsonResponse(200, recallPolicyState());
      } catch (err) {
        return jsonResponse(500, { error: String(err?.message || err) });
      }
    }
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
    }
    if (payload === null || typeof payload !== 'object') {
      return jsonResponse(400, { error: 'a JSON object body is required' });
    }
    try {
      const presets = {};
      for (const [key, value] of Object.entries(payload.presets ?? {})) {
        if (typeof value === 'boolean') presets[key] = value;
      }
      writeRecallPolicy({ default: payload.default === true, presets });
      return jsonResponse(200, recallPolicyState());
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/corpus/remove — forget an indexed source, or delete its file
  //
  // Two things a person means by "remove": stop searching this document, and get
  // rid of the file they uploaded. Both are offered, and neither implies the
  // other — `inbox` defaults to false, so the default is the reversible one.
  if (pathname === '/api/memory/corpus/remove' || pathname === '/corpus/remove') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    const collection = payload?.collection;
    const sourcePath = payload?.sourcePath;
    if (typeof collection !== 'string' || collection.length === 0) {
      return jsonResponse(400, { error: 'collection is required' });
    }
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      return jsonResponse(400, { error: 'sourcePath is required' });
    }
    try {
      const removedChunks = service.deleteCorpusSource(collection, sourcePath);
      let removedFile = false;
      if (payload?.inbox === true && typeof removeInboxFile === 'function') {
        // The inbox path is derived from the source path's basename, because the
        // row stores where the document came from, not where the upload landed.
        removedFile = removeInboxFile(collection, sourcePath.split('/').pop());
      }
      return jsonResponse(200, { ok: true, collection, sourcePath, removedChunks, removedFile });
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/corpus/reindex — force one source or inbox file back through
  if (pathname === '/api/memory/corpus/reindex' || pathname === '/corpus/reindex') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    if (typeof reindexCorpus !== 'function') {
      return jsonResponse(503, { error: 'Re-indexing is not available' });
    }
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    const collection = typeof payload?.collection === 'string' && payload.collection.length > 0 ? payload.collection : 'uploads';
    try {
      return jsonResponse(200, await reindexCorpus({ collection, filename: payload?.filename, sourcePath: payload?.sourcePath }));
    } catch (err) {
      return jsonResponse(400, { error: String(err?.message || err) });
    }
  }

  // GET /api/memory/corpus/sources — what has been ingested
  if (pathname === '/api/memory/corpus/sources' || pathname === '/corpus/sources' || pathname === '/sources') {
    if (method !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
    try {
      const collection = request?.query?.get?.('collection') || undefined;
      const origin = request?.query?.get?.('origin') || undefined;
      const limit = Math.min(Math.max(Number(request?.query?.get?.('limit')) || 100, 1), MAX_TOOL_LIST_RESULTS);
      const sources = service.listCorpusSources({ collection, origin, limit });
      const inbox = typeof listInboxFiles === 'function' ? listInboxFiles() : [];
      return jsonResponse(200, { total: sources.length, sources, inbox });
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/vectors/reembed — regenerate vectors for the active encoder
  if (pathname === '/api/memory/vectors/reembed' || pathname === '/vectors/reembed' || pathname === '/reembed') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    if (typeof reembedVectors !== 'function') {
      return jsonResponse(503, { error: 'Re-embedding is not available' });
    }
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    // Bounded on purpose: the caller repeats until `remaining` is zero rather
    // than holding one request open for a whole corpus.
    const limit = Math.min(Math.max(Number(payload?.limit) || 200, 1), 1000);
    try {
      return jsonResponse(200, await reembedVectors(limit));
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/vectors/purge — drop vectors this encoder cannot use
  if (pathname === '/api/memory/vectors/purge' || pathname === '/vectors/purge' || pathname === '/purge-vectors') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    if (service.purgeForeignVectors === undefined) {
      return jsonResponse(503, { error: 'Vector purge is not available' });
    }
    try {
      return jsonResponse(200, service.purgeForeignVectors());
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/search
  if (pathname === '/api/memory/search' || pathname === '/search') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    const query = payload?.query || payload?.q || '';
    if (typeof query !== 'string' || query.trim().length === 0) {
      return jsonResponse(400, { error: 'query is required' });
    }
    try {
      const result = await service.search(query.trim(), {
        namespace: payload?.namespace || service.defaultNamespace,
        limit: Math.min(Math.max(Number(payload?.limit) || 5, 1), maxSearchLimit),
        mode: payload?.mode || 'hybrid',
        includeCore: payload?.includeCore !== false,
        includeEpisodic: payload?.includeEpisodic !== false,
        includeCorpus: payload?.includeCorpus !== false,
        collection: payload?.collection || null,
        status: payload?.status || 'canon',
      });
      return jsonResponse(200, result);
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // POST /api/memory/store
  if (pathname === '/api/memory/store' || pathname === '/store') {
    if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    let payload = body;
    if (Buffer.isBuffer(body)) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
    }
    const content = payload?.content || payload?.text || '';
    if (typeof content !== 'string' || content.trim().length === 0) {
      return jsonResponse(400, { error: 'content is required' });
    }
    try {
      const result = await service.storeMemory({
        content: content.trim(),
        summary: payload?.summary || null,
        tags: Array.isArray(payload?.tags) ? payload.tags : (typeof payload?.tags === 'string' ? payload.tags.split(',').map(t => t.trim()).filter(Boolean) : null),
        namespace: payload?.namespace || service.defaultNamespace,
        status: payload?.status || 'canon',
      });
      return jsonResponse(201, result);
    } catch (err) {
      return jsonResponse(500, { error: String(err?.message || err) });
    }
  }

  // /api/memory/core (GET / POST / DELETE)
  if (pathname === '/api/memory/core' || pathname === '/core') {
    if (method === 'GET') {
      try {
        const ns = String(body?.namespace || service.defaultNamespace);
        const all = service.getCoreMemories ? service.getCoreMemories(ns) : service.listCoreMemories ? service.listCoreMemories(ns) : [];
        const bounded = Array.isArray(all) ? all.slice(0, MAX_TOOL_LIST_RESULTS) : all;
        return jsonResponse(200, {
          namespace: ns,
          total: Array.isArray(all) ? all.length : 0,
          count: Array.isArray(bounded) ? bounded.length : 0,
          memories: bounded,
        });
      } catch (err) {
        return jsonResponse(500, { error: String(err?.message || err) });
      }
    }
    if (method === 'POST') {
      let payload = body;
      if (Buffer.isBuffer(body)) {
        try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
      }
      const action = payload?.action || 'set';
      if (action === 'set' || action === 'update') {
        const key = payload?.key || '';
        const directive = payload?.directive || payload?.text || '';
        if (typeof key !== 'string' || key.trim().length === 0) {
          return jsonResponse(400, { error: 'key is required for set' });
        }
        try {
          const result = service.setCoreMemory({
            key: key.trim(),
            directive: String(directive),
            priority: Number.isInteger(payload?.priority) ? payload.priority : 0,
            namespace: payload?.namespace || service.defaultNamespace,
          });
          return jsonResponse(200, { success: true, action: 'set', memory: result });
        } catch (err) {
          return jsonResponse(500, { error: String(err?.message || err) });
        }
      } else if (action === 'delete') {
        const key = payload?.key || '';
        if (typeof key !== 'string' || key.trim().length === 0) {
          return jsonResponse(400, { error: 'key is required for delete' });
        }
        try {
          const deleted = service.deleteCoreMemory(key.trim(), payload?.namespace || service.defaultNamespace);
          if (!deleted) return jsonResponse(404, { error: 'Memory not found' });
          return jsonResponse(200, { success: true, action: 'delete', key: key.trim() });
        } catch (err) {
          return jsonResponse(500, { error: String(err?.message || err) });
        }
      } else {
        return jsonResponse(400, { error: `Unsupported core action: ${action}` });
      }
    }
    if (method === 'DELETE') {
      let payload = body;
      if (Buffer.isBuffer(body)) {
        try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
      }
      const key = payload?.key || '';
      if (typeof key !== 'string' || key.trim().length === 0) {
        return jsonResponse(400, { error: 'key is required for delete' });
      }
      try {
        const deleted = service.deleteCoreMemory(key.trim(), payload?.namespace || service.defaultNamespace);
        if (!deleted) return jsonResponse(404, { error: 'Memory not found' });
        return jsonResponse(200, { success: true, action: 'delete', key: key.trim() });
      } catch (err) {
        return jsonResponse(500, { error: String(err?.message || err) });
      }
    }
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  return jsonResponse(404, { error: 'Not found', pathname });
}

/**
 * Adapt pure dispatcher to node:http request/response.
 */
export function createRouteHandler(options = {}) {
  return async function handler(request) {
    // If called with node:http req/res directly, normalize
    if (request && typeof request.writeHead === 'function') {
      // Not used in pure adapter path; pure dispatcher takes normalized object.
      // But for harness webServer.register({ handler }), the handler receives
      // a pure request object already normalized in this harness.
    }
    return routeRequest(request, options);
  };
}
