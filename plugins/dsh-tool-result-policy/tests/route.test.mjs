/**
 * Tool-result retention tests — the settings route.
 *
 * `route.js` imports only `node:fs`/`node:path` and `policy.js`, so the whole
 * read/write surface is testable without a harness or an HTTP server: the
 * request/response pair is adapted by `createRouteHandler`, and these tests drive
 * `routeRequest` directly.
 *
 * Run with `node --test` from the bundle folder.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { PREFIX, routeRequest } from '../route.js'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A route pointed at a fresh policy path. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dd35-route-'))
  roots.push(root)
  const path = join(root, 'policy.json')
  let invalidated = 0
  const options = { path, listPresets: () => ['cordis', 'dd35'], invalidate: () => { invalidated += 1 } }
  return {
    path,
    options,
    invalidations: () => invalidated,
    get: () => routeRequest({ method: 'GET', pathname: PREFIX, body: undefined }, options),
    put: (body) => routeRequest({ method: 'PUT', pathname: PREFIX, body }, options),
  }
}

test('GET reports the path, the policy and the known presets', async () => {
  const { get } = harness()
  const response = await get()
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.deepEqual(body.knownPresets, ['cordis', 'dd35'])
  assert.equal(body.policy.defaults.stripTransientResults, false)
  assert.equal(body.problem, undefined)
})

test('GET on an absent file reports the defaults rather than an error', async () => {
  const { get, path } = harness()
  assert.equal(existsSync(path), false)
  const body = JSON.parse((await get()).body)
  assert.deepEqual(body.policy.presets, {})
})

test('PUT writes the file and echoes the normalised policy', async () => {
  const { put, path } = harness()
  const response = await put({ presets: { dd35: { stripTransientResults: true } } })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).policy.presets.dd35.stripTransientResults, true)
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.presets.dd35.stripTransientResults, true)
})

test('a write invalidates the reader cache, so the toggle is live', async () => {
  // Without this the next prune pass could read a same-millisecond stale copy.
  const { put, invalidations } = harness()
  await put({ defaults: { stripTransientResults: true } })
  assert.equal(invalidations(), 1)
})

test('a round trip is visible to the next read', async () => {
  const h = harness()
  await h.put({ presets: { dd35: { stripTransientResults: true } }, defaults: { stripTransientResults: false } })
  const body = JSON.parse((await h.get()).body)
  assert.equal(body.policy.presets.dd35.stripTransientResults, true)
})

test('a partial write is normalised, not rejected', async () => {
  const { put } = harness()
  const body = JSON.parse((await put({ presets: { dd35: {} } })).body)
  assert.equal(body.policy.presets.dd35.stripTransientResults, false)
  assert.equal(body.policy.defaults.stripTransientResults, false)
})

test('a non-object body is refused', async () => {
  const { put } = harness()
  for (const body of [undefined, null, 'text', 7]) {
    const response = await put(body)
    assert.equal(response.status, 400, `body ${JSON.stringify(body)} should be refused`)
  }
})

test('an unknown sub-path is 404 and a wrong method is 405', async () => {
  const { options } = harness()
  assert.equal((await routeRequest({ method: 'GET', pathname: `${PREFIX}/nope` }, options)).status, 404)
  assert.equal((await routeRequest({ method: 'DELETE', pathname: PREFIX }, options)).status, 405)
})

test('a trailing slash is accepted', async () => {
  const { options } = harness()
  assert.equal((await routeRequest({ method: 'GET', pathname: `${PREFIX}/` }, options)).status, 200)
})

test('every response is JSON and uncacheable', async () => {
  const { get, put } = harness()
  for (const response of [await get(), await put({})]) {
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
})

test('a write to an unwritable path reports the failure rather than throwing', async () => {
  // A file used as a directory: `mkdirSync`/`writeFileSync` fail deterministically,
  // without depending on a read-only mount that may not exist on the host.
  const root = mkdtempSync(join(tmpdir(), 'dd35-route-ro-'))
  roots.push(root)
  const blocker = join(root, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const options = { path: join(blocker, 'policy.json'), listPresets: () => [] }
  const response = await routeRequest(
    { method: 'PUT', pathname: PREFIX, body: { defaults: { stripTransientResults: true } } }, options)
  assert.equal(response.status, 500)
  assert.match(JSON.parse(response.body).error, /write-failed/)
})
