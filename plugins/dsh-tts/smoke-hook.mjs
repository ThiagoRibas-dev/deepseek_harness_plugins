/**
 * Resolution hook for the plugin smoke test.
 *
 * `plugin.js` imports two `@deepseek-ai/*` packages that the Host's plugin loader
 * resolves for `file://` plugins but plain `node` cannot resolve from here. The
 * obvious workaround — a stub under `dsh-tts/node_modules` — is unsafe: Node
 * resolves a symlinked bundle from its real path, so that stub would shadow the
 * Host's real packages and break the live plugin.
 *
 * A loader hook avoids `node_modules` entirely, so nothing the Host resolves can
 * be affected.
 */
const STUBS = {
  '@deepseek-ai/dsh-tools': './smoke-stub.js',
  '@deepseek-ai/schemastery': './schemastery-stub.js',
}

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier]
  if (stub !== undefined) return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
