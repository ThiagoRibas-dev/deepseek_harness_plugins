#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --unstable-webgpu
/**
 * bench-webgpu-deno.js — measure the iGPU through WebGPU, headless, with real timings.
 *
 * Why Deno rather than a browser: Chrome headless can *prove* WebGPU works, but the
 * standard way to get output out of a JS-driven page is virtual time, and virtual time
 * distorts `performance.now()` enough to make the numbers worthless. Deno ships WebGPU
 * (via wgpu), runs on the command line, and clocks normally.
 *
 * The chain being exercised: onnxruntime-web → WebGPU → wgpu → Vulkan → Mesa (ANV) →
 * Intel UHD 610. No browser, no Dawn binding to build, no Intel compute runtime (which
 * Debian 13 does not package).
 *
 * Inputs are synthetic but the tensor shapes are the real ones, so the kernels and the
 * work are the real ones — generating genuine ids would need the phonemizer and
 * tokenizer, which is not what this is measuring. The audio would be nonsense; nothing
 * here plays it.
 *
 * Usage, from the model directory (so the paths resolve):
 *   cd ~/.dsh/tts/models/kokoro/1939ad2a8e41
 *   deno run --allow-read --allow-net --unstable-webgpu bench-webgpu-deno.js
 *   deno run ... bench-webgpu-deno.js --models onnx/model_quantized.onnx,onnx/model_fp16.onnx
 *   deno run ... bench-webgpu-deno.js --runs 5 --tokens 346
 */

// The `/webgpu` entry specifically: the package's default build has no WebGPU provider,
// which is what produced "[webgpu] backend not found".
//
// Pinned to a version that was *checked* rather than assumed — `npm view onnxruntime-web
// version` says 1.30.0. The first attempt guessed 1.20.0, ten minor versions behind, and
// died on a LinkError between mismatched glue and wasm. The wasm binary is fetched at
// whatever version this import resolves to, so the halves agree either way; the pin exists
// only because Deno wants a manifest before resolving an unpinned bare specifier.
import * as ort from 'npm:onnxruntime-web@1.30.0/webgpu'

const args = Deno.args
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const MODELS = String(flag('models', [
  'onnx/model_q8f16.onnx',
  'onnx/model_quantized.onnx',
  'onnx/model_fp16.onnx',
].join(','))).split(',').map((part) => part.trim()).filter(Boolean)
const RUNS = Number(flag('runs', 3))
const TOKENS = Number(flag('tokens', 346))
const SHORT_TOKENS = 26
const SHORT_CALLS = 12
const SAMPLE_RATE = 24000

/** The same synthetic inputs the browser page uses: right shapes, meaningless values. */
function inputs(tokenCount) {
  const ids = new BigInt64Array(tokenCount)
  for (let i = 0; i < tokenCount; i += 1) ids[i] = BigInt(1 + (i * 37) % 170)
  const style = new Float32Array(256)
  for (let i = 0; i < 256; i += 1) style[i] = Math.sin(i / 7) * 0.4
  return { ids, style }
}

/** Time `session.run` alone, best of N. @returns {{ms: number, seconds: number}} */
async function timeRun(session, feeds, runs) {
  const warm = await session.run(feeds)
  const samples = (warm.waveform ?? Object.values(warm)[0]).data.length
  let best = Number.POSITIVE_INFINITY
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now()
    await session.run(feeds)
    best = Math.min(best, performance.now() - started)
  }
  return { ms: best, seconds: samples / SAMPLE_RATE }
}

async function main() {
  if (navigator.gpu === undefined) {
    console.log('navigator.gpu is missing. Run with --unstable-webgpu, or use a Deno version that ships WebGPU.')
    Deno.exit(1)
  }
  // The software device (llvmpipe) is also on this box, so ask for the fast one and then
  // print what actually came back — otherwise a CPU number could be reported as a GPU one.
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (adapter === null) {
    console.log('No WebGPU adapter came back, though Vulkan has a device. This is a wgpu/Mesa question, not ours.')
    Deno.exit(1)
  }
  const info = adapter.info ?? {}
  console.log(`adapter   ${info.vendor ?? '?'} | ${info.architecture ?? '?'} | ${info.description ?? info.device ?? '?'}`)
  if (/llvmpipe|swiftshader|software/i.test(JSON.stringify(info))) {
    console.log('WARNING    that adapter looks like a software rasteriser, so the number below is a CPU number.')
  }

  // The wasm runtime has to come from disk. Deno's default ESM loader refuses to import a
  // module over https — that is the ERR_UNSUPPORTED_ESM_URL_SCHEME failure — and ORT
  // loads its wasm glue as a module, so a CDN prefix is browser-correct and Deno-wrong.
  // The plugin's own node_modules already holds the files.
  // Both halves of ORT's wasm runtime must be the same build. The JS glue arrives from
  // Deno's npm cache for the version pinned in the import; taking the .wasm from the
  // plugin's node_modules instead is what produced the LinkError — `Import #80 "a" "Ba":
  // function import requires a callable` — because `pnpm add` had installed a different
  // version than the import asked for. Pin both to one version.
  // Everything from one local install, because of a Deno asymmetry: the ESM loader will not
  // import a module over https (the ERR_UNSUPPORTED_ESM_URL_SCHEME above), and fetch() will
  // not read file://. So the glue is resolved as a local module and the binary is read by
  // hand. `--node-modules-dir=auto` puts the same 1.30.0 on disk that the import resolved,
  // which is what makes the halves agree — the mismatch was the LinkError, not this shape.
  const distCandidates = [
    flag('dist', undefined),
    new URL('./node_modules/onnxruntime-web/dist/', import.meta.url).href,
    '/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-tts/node_modules/onnxruntime-web/dist/',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const distDir = distCandidates.find((candidate) => {
    try {
      Deno.statSync(candidate.startsWith('file://') ? new URL(candidate) : candidate)
      return true
    } catch {
      return false
    }
  })
  if (distDir === undefined) {
    console.log('No local onnxruntime-web dist found. Re-run with --node-modules-dir=auto, or pass --dist.')
    Deno.exit(1)
  }
  const distPath = distDir.endsWith('/') ? distDir : `${distDir}/`
  ort.env.wasm.wasmPaths = distPath.startsWith('file://') ? distPath : `file://${distPath}`
  // One thread, matching the Node benchmark's `intraOpNumThreads: 1`, and avoiding a
  // SharedArrayBuffer requirement a plain Deno process may not satisfy.
  ort.env.wasm.numThreads = 1
  const localDir = distPath.replace('file://', '')
  // Let ORT choose its own wasm sibling rather than guessing at the name. In 1.30 the
  // WebGPU path loads `ort-wasm-simd-threaded.asyncify.mjs` and its matching `.asyncify.wasm`
  // — not the `.jsep` pair — and handing it the wrong sibling instantiates and then fails
  // deep inside with `Cannot read properties of undefined`. Choosing is the runtime's job.
  //
  // The only thing in the way is Deno's fetch, which refuses file://: hence the shim. The
  // module import needs no such help, because Deno's ESM loader accepts file:// URLs — it
  // is https it refuses, which is what the CDN attempt ran into.
  const upstreamFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (!url.startsWith('file://')) return await upstreamFetch(input, init)
    try {
      const bytes = Deno.readFileSync(new URL(url))
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/wasm' } })
    } catch (error) {
      return new Response(String(error.message), { status: 404 })
    }
  }
  console.log(`ort ${ort.env.versions?.ort ?? '1.30.0'} — wasm chosen by the runtime from ${localDir}`)

  const { ids, style } = inputs(TOKENS)
  const longFeeds = {
    input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([1]), [1]),
  }
  const shortFeeds = []
  for (let call = 0; call < SHORT_CALLS; call += 1) {
    const short = inputs(SHORT_TOKENS)
    shortFeeds.push({
      input_ids: new ort.Tensor('int64', short.ids, [1, short.ids.length]),
      style: new ort.Tensor('float32', short.style, [1, 256]),
      speed: new ort.Tensor('float32', Float32Array.from([1]), [1]),
    })
  }
  console.log(`long      ${TOKENS} tokens, best of ${RUNS}`)
  console.log(`short     ${SHORT_CALLS} × ${SHORT_TOKENS} tokens, one run each (per-call overhead)\n`)

  for (const model of MODELS) {
    let bytes
    try {
      bytes = Deno.readFileSync(model)
    } catch (error) {
      console.log(`${model}: cannot read — ${error.message}`)
      continue
    }
    console.log(`${model}  ${(bytes.byteLength / 1048576).toFixed(0)} MB`)
    for (const provider of ['webgpu', 'wasm']) {
      try {
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
        })
        const long = await timeRun(session, longFeeds, RUNS)
        let shortMs = 0
        let shortSeconds = 0
        for (const feeds of shortFeeds) {
          const result = await timeRun(session, feeds, 1)
          shortMs += result.ms
          shortSeconds += result.seconds
        }
        const rtf = long.ms / 1000 / long.seconds
        const shortRtf = shortMs / 1000 / shortSeconds
        console.log(`  ${provider.padEnd(7)} long ${long.seconds.toFixed(1)} s audio in ${Math.round(long.ms)} ms`
          + `  RTF ${rtf.toFixed(2)}`)
        console.log(`  ${''.padEnd(7)} short ${shortSeconds.toFixed(1)} s audio in ${Math.round(shortMs)} ms`
          + `  RTF ${shortRtf.toFixed(2)}  per call ${Math.round(shortMs / SHORT_CALLS)} ms`
          + `  overhead ${Math.round(shortMs / SHORT_CALLS - (shortSeconds / SHORT_CALLS) * (long.ms / long.seconds))} ms`)
        // The bar, stated where the number appears: under ~0.7 makes Kokoro usable live.
        if (provider === 'webgpu' && shortRtf < 1) {
          console.log(`  → faster than real time${shortRtf < 0.7 ? ', and under the 0.7 that would make Kokoro usable live' : ''}`)
        }
      } catch (error) {
        console.log(`  ${provider.padEnd(7)} FAILED — ${error.message}`)
      }
    }
    console.log('')
  }
  console.log('Compare against onnxruntime-node on the CPU: 2.60–3.05 RTF, and Piper at 0.29.')
}

await main()
