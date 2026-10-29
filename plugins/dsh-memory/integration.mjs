#!/usr/bin/env node
/**
 * Integration verification: full memory lifecycle.
 *
 * Tests service, storage, REST dispatcher, agent hooks, and client module
 * without a running harness browser.
 */
import { MemoryService } from './service.js';
import { routeRequest, createRouteHandler } from './route.js';
import { readFileSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

async function verify() {
  const results = { passed: 0, failed: 0, errors: [] };
  const assert = (label, condition) => {
    if (condition) { results.passed++; console.log('✓', label); }
    else { results.failed++; results.errors.push(label); console.log('✗', label); }
  };

  // 1. Service initialization
  const service = new MemoryService({ inMemory: true, defaultNamespace: 'test' });
  assert('service initialized', service !== null && service.status !== undefined);

  // 2. Core memory lifecycle
  const coreResult = service.setCoreMemory({ key: 'test_key', directive: 'Test directive for integration.', priority: 5, namespace: 'test' });
  assert('core memory set', coreResult && coreResult.key === 'test_key');
  const cores = service.getCoreMemories('test');
  assert('core memory list contains item', Array.isArray(cores) && cores.length === 1);
  const format = service.formatCorePromptSection('test');
  assert('core prompt section non-empty', typeof format === 'string' && format.includes('test_key'));

  // 3. Episodic memory lifecycle
  const stored = await service.storeMemory({ content: 'Integration test content.', summary: 'Summary.', tags: ['integration'], namespace: 'test', status: 'canon' });
  assert('episodic memory stored', stored && stored.id !== undefined);
  const mem = service.getMemory(stored.id);
  assert('episodic memory retrievable', mem !== null && mem.id === stored.id);

  // 4. Search lifecycle
  const searchResult = await service.search('test', { namespace: 'test', limit: 5, includeCore: true, includeEpisodic: true, includeCorpus: false });
  assert('search returns results array', searchResult && Array.isArray(searchResult.results));
  assert('search bounded (max 20)', searchResult.results.length <= 20);

  // 5. REST dispatcher (pure, no server)
  const dispatch = await routeRequest({ method: 'GET', pathname: '/core', query: new URLSearchParams(), headers: {} }, { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20 });
  assert('REST dispatch GET /core returns JSON body', dispatch && dispatch.status === 200 && Buffer.isBuffer(dispatch.body));

  const searchPost = await routeRequest({ method: 'POST', pathname: '/search', query: new URLSearchParams(), headers: {}, body: { query: 'test', namespace: 'test' } }, { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20 });
  assert('REST POST /search bounded', searchPost.status === 200);
  const storePost = await routeRequest({ method: 'POST', pathname: '/store', query: new URLSearchParams(), headers: {}, body: { content: 'REST store test.', namespace: 'test' } }, { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20 });
  assert('REST POST /store creates memory', storePost.status === 201);

  // 6. Hooks registered in plugin (mock apply)
  const plugin = await import('./plugin.js');
  assert('plugin exports apply', typeof plugin.apply === 'function');
  assert('plugin exports name', plugin.name === 'memory');

  // 7. Client module loadable
  const clientContent = readFileSync('plugins/dsh-memory/client.js', 'utf8');
  assert('client module exists and has React.createElement reference', clientContent.includes('createElement'));
  assert('client registers settings.plugins.tab', clientContent.includes('settings.plugins.tab'));

  // 9. Embedding setup mechanism (manifest pins, asset set, preparation non-blocking)
  const pluginModule = await import('./plugin.js');
  assert('plugin exports setupEstimate', typeof pluginModule.setupEstimate === 'function');
  const assetStatus = pluginModule.memoryEmbedderStatus ? pluginModule.memoryEmbedderStatus() : null;
  assert('asset manifest loads (ASSETS pinned)', assetStatus !== null && assetStatus.modelType === 'embeddinggemma-2');
  assert('embedding setup mechanism exists', pluginModule.setupEstimate && pluginModule.startEmbedderPreparation);
  assert('every copied asset pin is a real sha256', assetStatus.pinVerified === true);
  const assetPaths = pluginModule.embedAssetPaths('q8');
  assert('q8 pairs its graph with external weights', assetPaths.assets.some(({ asset }) => asset.path.endsWith('.onnx_data')));
  assert('shared tokenizer travels with the weights', assetPaths.assets.some(({ asset }) => asset.path === 'tokenizer.json'));
  assert('readiness reports file counts', assetStatus.totalFiles === assetPaths.assets.length && assetStatus.presentFiles <= assetStatus.totalFiles);
  const estimate = pluginModule.setupEstimate('q8');
  assert('estimate counts shared files too', estimate.recommendedDiskBytes === assetPaths.assets.reduce((n, { asset }) => n + asset.bytes, 0));

  // 10. Client module references setup mechanism (prepare card component)
  assert('client references PrepareEmbedderCard', clientContent.includes('PrepareEmbedderCard'));

  // 11. Download substrate refuses an unverified pin rather than trusting it
  const downloadModule = await import('./download.js');
  assert('download module exports ensureAsset', typeof downloadModule.ensureAsset === 'function');
  assert('download module exports isPinned', typeof downloadModule.isPinned === 'function');
  assert('download module exports AssetError', typeof downloadModule.AssetError === 'function');
  let unpinnedRefused = false;
  try {
    await downloadModule.ensureAsset({
      url: 'http://127.0.0.1:1/never',
      asset: { path: 'x.onnx', bytes: 1, sha256: 'PENDING_VERIFICATION' },
      dest: '/tmp/dsh-memory-never.onnx',
    });
  } catch (err) {
    unpinnedRefused = err instanceof downloadModule.AssetError && err.download?.reason === 'unpinned';
  }
  assert('download refuses an unverified sha256 pin', unpinnedRefused);

  // A digest mismatch must be refused as an integrity failure, not accepted.
  let integrityRefused = false;
  try {
    await downloadModule.ensureAsset({
      url: 'http://127.0.0.1:1/never',
      asset: { path: 'x.onnx', bytes: 1, sha256: 'a'.repeat(64) },
      dest: '/tmp/dsh-memory-never.onnx',
    });
  } catch (err) {
    // No server is listening, so this can surface as a network failure; either
    // way the call must reject rather than report success.
    integrityRefused = err instanceof downloadModule.AssetError;
  }
  assert('download rejects instead of reporting success', integrityRefused);

  // 12. Embedder REST endpoints
  const statusRoute = await routeRequest(
    { method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} },
    { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20, embedderStatus: () => pluginModule.memoryEmbedderStatus() },
  );
  assert('REST GET /status reports preparation', statusRoute.status === 200 && JSON.parse(statusRoute.body.toString()).preparation !== undefined);
  // The route contract is checked with a stub so the suite never pulls 346 MB;
  // the real download path is exercised against the live pin separately.
  const prepareRoute = await routeRequest(
    { method: 'POST', pathname: '/prepare-embedder', query: new URLSearchParams(), headers: {}, body: { variant: 'q4f16' } },
    { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20, prepareEmbedder: (v) => ({ phase: 'downloading', reason: 'download-started', variant: v ?? 'q8' }) },
  );
  assert('REST POST /prepare-embedder answers 202', prepareRoute.status === 202);
  assert('REST POST /prepare-embedder forwards the variant', JSON.parse(prepareRoute.body.toString()).variant === 'q4f16');
  const noPrepare = await routeRequest(
    { method: 'POST', pathname: '/prepare-embedder', query: new URLSearchParams(), headers: {}, body: {} },
    { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20 },
  );
  assert('REST POST /prepare-embedder reports 503 when unavailable', noPrepare.status === 503);

  // 13. Variant catalogue and cache readiness
  const variants = pluginModule.listEmbedVariants();
  assert('variant catalogue lists every pinned variant', variants.length >= 2);
  assert('smallest variant is cheaper than the default', variants.some((v) => !v.isDefault && v.totalBytes < variants.find((d) => d.isDefault).totalBytes));
  assert('every variant carries a label', variants.every((v) => typeof v.label === 'string' && v.label.length > 0));

  // The plugin's own route wiring must forward the variant. A dropped argument
  // here is invisible until a panel shows the wrong variant's cache, so it is
  // exercised through the mount path the harness actually uses.
  const wiredRoot = join(tmpdir(), `dsh-memory-wired-${process.pid}`);
  mkdirSync(join(wiredRoot, 'embeddinggemma-2-ONNX', 'onnx'), { recursive: true });
  for (const { asset } of pluginModule.embedAssetPaths('q4f16').assets) {
    const dest = join(wiredRoot, 'embeddinggemma-2-ONNX', asset.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, '');
    truncateSync(dest, asset.bytes);
  }
  let mountedHandler = null;
  const wiredCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    provide: () => {},
    inject: (deps, cb) => cb({ webServer: { register: (route) => { mountedHandler = route.handler; }, tapIndex: () => {} }, effect: (fn) => { fn(); return () => {}; } }),
    get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    systemPrompt: { section: () => {} }, tools: { register: () => {} }, on: () => {},
  };
  pluginModule.apply(wiredCtx, { inMemory: true, standalone: false, modelsPath: wiredRoot, apiAllowAnonymous: true });
  assert('deferred webServer mount registered a handler', typeof mountedHandler === 'function');
  const wired = await mountedHandler({ method: 'GET', pathname: '/status', query: new URLSearchParams('variant=q4f16'), headers: {} });
  const wiredBody = JSON.parse(wired.body.toString());
  assert('mounted route forwards the requested variant', wiredBody.preparation?.modelVariant === 'q4f16');
  assert('mounted route reads that variant cache as ready', wiredBody.preparation?.phase === 'ready');
  const otherVariant = await mountedHandler({ method: 'GET', pathname: '/status', query: new URLSearchParams('variant=q8'), headers: {} });
  assert('mounted route keeps other variants separate', JSON.parse(otherVariant.body.toString()).preparation?.phase === 'unprepared');
  rmSync(wiredRoot, { recursive: true, force: true });

  // A cache holding exactly the pinned sizes must read as ready, and asking to
  // prepare again must not start a second download.
  const fakeRoot = join(tmpdir(), `dsh-memory-cache-${process.pid}`);
  mkdirSync(join(fakeRoot, 'embeddinggemma-2-ONNX', 'onnx'), { recursive: true });
  for (const { asset } of pluginModule.embedAssetPaths('q8').assets) {
    const dest = join(fakeRoot, 'embeddinggemma-2-ONNX', asset.path);
    mkdirSync(dirname(dest), { recursive: true });
    // Sparse allocation: the size is what readiness checks, not the contents.
    writeFileSync(dest, '');
    truncateSync(dest, asset.bytes);
  }
  const cacheCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    provide: () => {}, inject: () => {}, get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    systemPrompt: { section: () => {} }, tools: { register: () => {} }, on: () => {},
  };
  pluginModule.apply(cacheCtx, { inMemory: true, standalone: false, modelsPath: fakeRoot, apiAllowAnonymous: true });
  const cachedStatus = pluginModule.memoryEmbedderStatus('q8');
  assert('a complete cache reads as ready', cachedStatus.phase === 'ready' && cachedStatus.modelCached === true);
  const cachedStart = pluginModule.startEmbedderPreparation('q8');
  assert('preparing again on a full cache does not re-download', cachedStart.phase === 'ready');
  rmSync(fakeRoot, { recursive: true, force: true });

  // 14. The real engine replaces the deterministic one only from a complete cache
  const emptyRoot = join(tmpdir(), `dsh-memory-empty-${process.pid}`);
  pluginModule.apply(cacheCtx, { inMemory: true, standalone: false, modelsPath: emptyRoot });
  assert('an empty cache leaves the deterministic embedder in place', pluginModule.buildEmbedderEngine('q8') === null);
  const seedRoot = join(tmpdir(), `dsh-memory-seed-${process.pid}`);
  mkdirSync(join(seedRoot, 'embeddinggemma-2-ONNX', 'onnx'), { recursive: true });
  for (const { asset } of pluginModule.embedAssetPaths('q8').assets) {
    const dest = join(seedRoot, 'embeddinggemma-2-ONNX', asset.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, '');
    truncateSync(dest, asset.bytes);
  }
  const engineService = pluginModule.apply(cacheCtx, { inMemory: true, standalone: false, modelsPath: seedRoot });
  assert('a cached model becomes the active embedder', engineService.service.embedder?.modelType === 'embeddinggemma-2');
  assert('engine construction stays lazy', engineService.service.embedder?.isInitialized === false);
  rmSync(seedRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });

  // 15. Ingestion across all three session-level and workspace entries
  const ingestModule = await import('./ingest.js');
  const inboxModule = await import('./inbox.js');
  assert('ingest module exposes the engine', typeof ingestModule.ingestText === 'function' && typeof ingestModule.ingestPaths === 'function');
  assert('inbox module exposes the upload path', typeof inboxModule.ingestUpload === 'function' && typeof inboxModule.defaultIngestFolder === 'function');

  const ingestRoot = join(tmpdir(), `dsh-memory-ingest-${process.pid}`);
  mkdirSync(join(ingestRoot, 'docs'), { recursive: true });
  writeFileSync(join(ingestRoot, 'docs', 'guide.md'), '# Guide\n\nMemory keeps facts and promises.\n');
  writeFileSync(join(ingestRoot, 'docs', 'blob.md'), Buffer.from([0x61, 0x00, 0x62]));

  const ingested = await ingestModule.ingestPaths(service, { paths: [join(ingestRoot, 'docs')], collection: 'reffed', root: ingestRoot });
  assert('workspace ingestion indexes a supported file', ingested.summary.ingested === 1);
  assert('workspace ingestion reports an unsupported file', ingested.summary.unsupported === 1);
  assert('ingestion records a relative source path', ingested.records.some((r) => r.status === 'ingested' && r.sourcePath === join('docs', 'guide.md')));

  const repeat = await ingestModule.ingestPaths(service, { paths: [join(ingestRoot, 'docs')], collection: 'reffed', root: ingestRoot });
  assert('a repeat run skips unchanged content', repeat.summary.skipped === 1 && repeat.summary.ingested === 0);

  const viaTool = await ingestModule.ingestText(service, {
    content: '# Uploaded\n\nAn uploaded handout about grappling.',
    collection: 'reffed',
    sourcePath: 'handout.md',
    origin: 'upload',
  });
  assert('a session-supplied document indexes', viaTool.status === 'ingested');
  assert('ingested reference is searchable', (await service.searchReference('grappling', { collection: 'reffed' })).results.length >= 1);

  const uploadRoot = join(tmpdir(), `dsh-memory-upload-${process.pid}`);
  const uploaded = await inboxModule.ingestUpload(service, {
    inboxFolder: uploadRoot, collection: 'inboxed', filename: '../../escape.md', content: '# Escaped\n\nBody.',
  });
  assert('an upload stays inside its inbox', uploaded.path.startsWith(uploadRoot));
  assert('an upload is indexed', uploaded.record.status === 'ingested');

  const uploadRoute = await routeRequest(
    { method: 'POST', pathname: '/corpus/upload', query: new URLSearchParams(), headers: {}, body: { filename: 'ui.md', content: '# UI\n\nBody from the control.', collection: 'ui' } },
    { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20, uploadDocument: (u) => inboxModule.ingestUpload(service, { ...u, inboxFolder: uploadRoot }) },
  );
  assert('REST upload answers 201', uploadRoute.status === 201);
  const sourcesRoute = await routeRequest(
    { method: 'GET', pathname: '/corpus/sources', query: new URLSearchParams(), headers: {} },
    { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20, listInboxFiles: () => inboxModule.listInbox(uploadRoot) },
  );
  assert('REST sources lists what was ingested', sourcesRoute.status === 200 && JSON.parse(sourcesRoute.body.toString()).sources.length >= 1);

  rmSync(ingestRoot, { recursive: true, force: true });
  rmSync(uploadRoot, { recursive: true, force: true });

  // 16. Vector provenance over the REST surface
  const vectorRoot = join(tmpdir(), `dsh-memory-vectors-${process.pid}`);
  const vectorService = new MemoryService({ storagePath: join(vectorRoot, 'v.db'), inMemory: true, defaultNamespace: 'global' });
  await vectorService.storeMemory({ content: 'The eastern gate holds twelve silver.', namespace: 'global', status: 'canon' });
  const ownModel = vectorService.activeModel();
  assert('a stored vector carries the active model', typeof ownModel === 'string' && ownModel.length > 0);

  const vectorOptions = {
    service: vectorService, enabled: true, allowAnonymous: true, maxSearchLimit: 20,
    embedderStatus: (v) => pluginModule.memoryEmbedderStatus(v),
    reembedVectors: (limit) => vectorService.reembedMissing({ limit }),
  };
  const cleanStatus = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} }, vectorOptions);
  const cleanVectors = JSON.parse(cleanStatus.body.toString()).vectors;
  assert('status reports the active encoder and a clean index', cleanVectors.activeModel === ownModel && cleanVectors.matches === true);

  // Pretend the row was embedded by another network.
  vectorService.storage.db.prepare("UPDATE memories SET embedding_model = 'other-net@384'").run();
  const staleStatus = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} }, vectorOptions);
  const staleVectors = JSON.parse(staleStatus.body.toString()).vectors;
  assert('a foreign vector is reported, not hidden', staleVectors.foreign.total === 1 && staleVectors.matches === false);

  const stillFound = await vectorService.searchMemories('eastern gate silver', { namespace: 'global' });
  assert('a foreign-vector row is still found by keywords', stillFound.results.length >= 1);

  const purgeRoute = await routeRequest({ method: 'POST', pathname: '/vectors/purge', query: new URLSearchParams(), headers: {}, body: {} }, vectorOptions);
  assert('purge drops the unusable vector', purgeRoute.status === 200 && JSON.parse(purgeRoute.body.toString()).purged.total === 1);
  assert('purge keeps the text', vectorService.listMemories({ namespace: 'global' }).length === 1);

  const reembedRoute = await routeRequest({ method: 'POST', pathname: '/vectors/reembed', query: new URLSearchParams(), headers: {}, body: { limit: 10 } }, vectorOptions);
  const reembedBody = JSON.parse(reembedRoute.body.toString());
  assert('re-embed regenerates the vector', reembedRoute.status === 200 && reembedBody.embedded === 1 && reembedBody.remaining === 0);
  assert('the index matches again', vectorService.vectorStatus().matches === true);

  const unwired = await routeRequest({ method: 'POST', pathname: '/vectors/reembed', query: new URLSearchParams(), headers: {}, body: {} }, { service, enabled: true, allowAnonymous: true, maxSearchLimit: 20 });
  assert('re-embed answers 503 when unwired', unwired.status === 503);

  vectorService.close();
  rmSync(vectorRoot, { recursive: true, force: true });

  // 17. The route refuses to serve without a token
  //
  // A plugin route inherits none of the harness's authentication and the web
  // server is reachable on the network, so "no token configured" must not mean
  // "open". These assertions pin that shut.
  const authOptions = { service, enabled: true, maxSearchLimit: 20, token: '' };
  const noToken = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} }, authOptions);
  assert('an unconfigured token refuses to serve', noToken.status === 503 && /no apiToken configured/.test(JSON.parse(noToken.body.toString()).error));

  const withToken = { ...authOptions, token: 'a-secret' };
  const noHeader = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} }, withToken);
  assert('a configured token demands a bearer header', noHeader.status === 401);
  const wrongHeader = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: { authorization: 'Bearer nope' } }, withToken);
  assert('a wrong bearer is refused', wrongHeader.status === 401);
  const rightHeader = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: { authorization: 'Bearer a-secret' } }, withToken);
  assert('the right bearer is served', rightHeader.status === 200);
  const anonymous = await routeRequest({ method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {} }, { ...authOptions, allowAnonymous: true });
  assert('anonymous access must be asked for by name', anonymous.status === 200);

  // 18. Defensive bounds
  const boundedSearch = await service.search('test', { limit: 100 });
  assert('search bounded at 20', boundedSearch.results.length <= 20);
  const listCore = service.listCoreMemories('test');
  assert('core list bounded at 100', listCore.length <= 100);

  console.log('---');
  console.log('Results:', results.passed, 'passed,', results.failed, 'failed');
  if (results.errors.length > 0) {
    console.log('Errors:', results.errors.join('; '));
  }
  service.close();
  return results.failed === 0;
}

verify()
  .then(ok => { console.log('Integration verification:', ok ? 'PASSED' : 'FAILED'); process.exit(ok ? 0 : 1); })
  .catch(err => { console.error('Verification error:', err); process.exit(1); });
