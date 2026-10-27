/**
 * Live Host probe for the model-rotation bundle.
 *
 * This is not part of the offline suite (`node --test tests/*.test.js`). It
 * needs the running Harness installation because it installs that profile's
 * own module resolution, then imports `plugin.js`, applies it to a fake
 * context, and dispatches one stream whose members have no credentials. That
 * exercises the real adapter construction, failover, aggregate error, and
 * session log without a network request.
 *
 * Run from the Harness checkout:
 *
 *   node --import tsx/esm \
 *     /export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation/tests/live-probe.mjs
 *
 * Override `DSH_HARNESS_ROOT` or `DSH_PROFILE_DIR` for another installation.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS = process.env.DSH_HARNESS_ROOT ?? '/export/DownloadsSSD/AI/TEXT/deepseek-harness'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/root/.dsh/profiles/web'
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? '/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-model-rotation'

function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
}

const { createRuntimeResolution, loadProfileDirectory } = await import(
  pathToFileURL(join(HARNESS, 'packages/boot/app-boot/src/index.ts')).href
)
const { installRuntimeInterception } = await import(
  pathToFileURL(join(HARNESS, 'packages/boot/app-boot/src/profile-resolution/resolver.ts')).href
)
const { INSTALL_ANCHOR } = await import(
  pathToFileURL(join(HARNESS, 'apps/cli/src/profile-boot.ts')).href
)

const profile = loadProfileDirectory('dsh', PROFILE_DIR, INSTALL_ANCHOR, { userLayer: true })
const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile })
const interception = installRuntimeInterception(resolution)
const logDir = mkdtempSync(join(tmpdir(), 'model-rotation-probe-'))
process.env.DSH_MODEL_ROTATION_LOG_DIR = logDir
for (const ref of [
  'MODEL_ROTATION_PROBE_GATEWAY_A_API_KEY',
  'MODEL_ROTATION_PROBE_GATEWAY_B_API_KEY',
]) delete process.env[ref]

try {
  const mod = await import(pathToFileURL(join(PLUGIN, 'plugin.js')).href)
  check(typeof mod.apply === 'function', 'plugin.js exports apply')
  check(mod.Config !== undefined, 'plugin.js exports Config')

  const pools = {
    probe: {
      members: [
        { name: 'gateway-a', baseURL: 'https://a.invalid/v1', api: 'openai-completions', model: 'model-a' },
        { name: 'gateway-b', baseURL: 'https://b.invalid/v1', api: 'openai-completions', model: 'model-b' },
      ],
    },
  }
  const config = { provider: 'model-rotation', displayName: 'Model Rotation', apiToken: '', pools: { get: () => pools } }

  let registered
  const ctx = {
    fiber: { entry: { options: { id: 'model-rotation' } } },
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    on() { return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ effect: fn => fn(), settings: { configure: () => () => {} } })
      }
      if (services.includes('webServer')) {
        callback({ effect: fn => fn(), webServer: { register: () => () => {}, tapIndex: () => () => {} } })
      }
    },
    llm: {
      registerAdapter(providers, adapter) {
        registered = { providers, adapter }
        const handle = () => {}
        handle.replace = next => { registered.providers = next }
        return handle
      },
    },
  }

  await mod.apply(ctx, config)
  check(registered?.providers?.[0] === 'model-rotation', 'provider route registered')
  const models = await registered.adapter.listModels('model-rotation')
  check(models.length === 1 && models[0].id === 'probe', 'pool listed as a model')

  let failure
  try {
    for await (const chunk of registered.adapter.stream({
      provider: 'model-rotation',
      model: 'probe',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sessionId: 'live-probe',
    })) {
      console.log('unexpected chunk', chunk.type)
    }
  } catch (error) {
    failure = error
  }
  check(failure !== undefined, 'stream without credentials fails')
  check(failure.code === 'MISSING_CREDENTIAL', `aggregate code is MISSING_CREDENTIAL (got ${String(failure.code)})`)
  check(String(failure.message).includes('gateway-a') && String(failure.message).includes('gateway-b'), 'both members are named')

  const rows = readFileSync(join(logDir, 'live-probe.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  check(rows.some(row => row.k === 'start'), 'log has a start row')
  check(rows.some(row => row.k === 'failover'), 'log has a failover row')
  check(rows.some(row => row.k === 'end' && row.ok === false), 'log has a failed end row')
  console.log(`live probe OK — ${rows.length} log row(s) in ${logDir}`)
} finally {
  interception.dispose()
  rmSync(logDir, { recursive: true, force: true })
}
