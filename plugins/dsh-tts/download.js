/**
 * Pinned asset download: fetch, verify, and cache.
 *
 * Semantics ported from the harness's SenseVoice provider, because they are the
 * right ones and cheap to copy:
 *
 *   - verify an existing file by SIZE first (cheap) then SHA-256 (accurate)
 *   - download into a uniquely-named `.part` file, hashing while streaming
 *   - abort the moment a byte overrun proves the source is wrong
 *   - publish with an atomic rename, so a crash never leaves a half file in place
 *   - the partial file is mode 0o600
 *
 * Nothing here knows about Kokoro; it takes a pinned asset descriptor and a
 * destination path.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Raised when a download fails, carrying a reason the UI can turn into advice. */
export class AssetError extends Error {
  constructor(message, { reason = 'unknown', resource, source, status, code } = {}) {
    super(message)
    this.name = 'AssetError'
    this.download = { reason, resource, source, status, code }
  }
}

/** Map a thrown fetch/stream error onto the small set of reasons the UI speaks. */
export function classify(error, { resource, source }) {
  if (error instanceof AssetError) return error
  const code = error?.code ?? error?.cause?.code
  const reason = code === 'ENOSPC' ? 'storage'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns'
    : code === 'ETIMEDOUT' || error?.name === 'TimeoutError' ? 'timeout'
    : code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ? 'certificate'
    : code === 'ECONNREFUSED' || code === 'ECONNRESET' || error?.name === 'TypeError' ? 'network'
    : 'unknown'
  return new AssetError(error?.message ?? String(error), { reason, resource, source, code })
}

async function sha256Of(path, signal) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
  return digest.digest('hex')
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

/**
 * Whether the file at `path` is already the pinned asset.
 *
 * Size is checked before hashing: a mismatch is the common case for an
 * interrupted download, and it costs one stat instead of a full read.
 */
export async function isPinned(path, asset, signal) {
  if (!await exists(path)) return false
  const info = await stat(path)
  if (!info.isFile() || info.size !== asset.bytes) return false
  return await sha256Of(path, signal) === asset.sha256
}

/**
 * Ensure one pinned asset is present and correct at `dest`.
 *
 * @returns the destination path.
 * @throws {AssetError} with a `download.reason` the UI can explain.
 */
export async function ensureAsset({ url, asset, dest, signal, onProgress, origin }) {
  const label = { resource: asset.path ?? dest, source: origin ?? url }
  if (await isPinned(dest, asset, signal)) {
    onProgress?.({ phase: 'done', completedBytes: asset.bytes, totalBytes: asset.bytes, cached: true })
    return dest
  }

  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.${randomUUID()}.part`
  let response
  try {
    response = await fetch(url, { signal, redirect: 'follow' })
  } catch (error) {
    throw classify(error, label)
  }
  if (!response.ok) {
    throw new AssetError(`HTTP ${response.status} for ${url}`, { ...label, reason: 'http', status: response.status })
  }
  if (response.body === null) {
    throw new AssetError(`empty response body for ${url}`, { ...label, reason: 'network' })
  }

  const totalBytes = Number(response.headers.get('content-length')) || asset.bytes
  let completedBytes = 0
  const digest = createHash('sha256')

  const count = new Transform({
    transform(chunk, _encoding, callback) {
      completedBytes += chunk.length
      // An overrun is proof the source is not the pinned artifact. Fail now
      // rather than hashing another 90 MB to reach the same conclusion.
      if (completedBytes > asset.bytes) {
        callback(new AssetError(`byte count exceeded ${asset.bytes}`, { ...label, reason: 'integrity' }))
        return
      }
      digest.update(chunk)
      onProgress?.({ phase: 'downloading', completedBytes, totalBytes })
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(part, { mode: 0o600 }), { signal })
  } catch (error) {
    await rm(part, { force: true })
    throw classify(error, label)
  }

  if (completedBytes !== asset.bytes) {
    await rm(part, { force: true })
    throw new AssetError(`expected ${asset.bytes} bytes, received ${completedBytes}`, { ...label, reason: 'integrity' })
  }
  const actual = digest.digest('hex')
  if (actual !== asset.sha256) {
    await rm(part, { force: true })
    throw new AssetError(`sha256 mismatch: expected ${asset.sha256}, got ${actual}`, { ...label, reason: 'integrity' })
  }

  await rename(part, dest)
  onProgress?.({ phase: 'done', completedBytes, totalBytes: asset.bytes, cached: false })
  return dest
}

/** Resolve an asset path against a cache root, preserving its `onnx/…` or `voices/…` shape. */
export function cachePath(root, path) { return join(root, path) }
