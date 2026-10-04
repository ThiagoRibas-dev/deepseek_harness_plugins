#!/usr/bin/env node
/**
 * bench-inference.mjs — download every graph, measure them all on this machine, print
 * the results.
 *
 * One command, start to finish: fetch → verify → measure → report. Nothing is measured
 * before every requested graph is present and hash-checked, so a partial download can
 * never produce a partial table that looks complete.
 *
 * ## Why this exists
 *
 * The graph this plugin ships was chosen from published numbers. The first two
 * measurements taken here contradicted them — fp32 beat q8 despite being 3.5× larger,
 * because this CPU has no AVX2 and the integer kernels are emulated. A choice like that
 * belongs to the machine that runs it, so this measures instead of assuming.
 *
 * ## What it sweeps
 *
 *   types     q8f16, q8, uint8, uint8f16, fp16, fp32   (every type above q4; there is no
 *             fp8 graph in the repository, and WebGPU has no fp8 type either)
 *   provider  cpu (onnxruntime-node) and webgpu (onnxruntime-web), the second if this
 *             Node can reach a GPU at all
 *   shapes    one long passage in a single call, and twelve short sentences as separate
 *             calls — because a reply is spoken as many short utterances, and that shape
 *             exposes per-call dispatch overhead the long one hides
 *
 * ## What it does not measure
 *
 * Phonemization and tokenization (timed once, reported for scale, never inside a timing),
 * the browser, or audio quality. A WAV from the final run is written with `--save-wav`
 * so "faster" can be checked against "still sounds right".
 *
 * ## Usage
 *
 *   node bench-inference.mjs                       # the full sweep, ~960 MB of downloads
 *   node bench-inference.mjs --variants q8,fp16    # a subset
 *   node bench-inference.mjs --eps cpu             # skip the GPU attempt
 *   node bench-inference.mjs --threads 2           # ONNX intra-op threads
 *   node bench-inference.mjs --no-download         # only graphs already on disk
 *   node bench-inference.mjs --json results.json --save-wav
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_TOKENS, SAMPLE_RATE, encodeWav, loadOrt, loadVocab, loadVoice, phonemize,
  synthesize, tokenize,
} from './kokoro.js'
import { cachePath, ensureAsset, isPinned } from './download.js'

const here = dirname(fileURLToPath(import.meta.url))
const ASSETS = JSON.parse(readFileSync(join(here, 'assets.json'), 'utf8'))
const argv = process.argv.slice(2)

/** Read `--name value`, or the fallback. */
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const has = (name) => argv.includes(`--${name}`)
const mb = (bytes) => `${(bytes / 1_048_576).toFixed(0)} MB`

const DATA_ROOT = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ROOT = join(DATA_ROOT, 'tts', 'models', 'kokoro', ASSETS.revision.slice(0, 12))
const VOICE = String(flag('voice', 'af_heart'))

/** Every variant above q4, which is the set this sweep is for. */
const DEFAULT_VARIANTS = 'q8f16,q8,uint8,uint8f16,fp16,fp32'

/** The manifest's variants, keyed, with their labels and notes. */
const VARIANTS = new Map(
  Object.entries(ASSETS.variants ?? {})
    .filter(([key]) => !key.startsWith('$'))
    .map(([key, spec]) => [key, { key, ...spec }]),
)

/**
 * A passage of the kind a DM writes: long enough to be one call, short enough to stay
 * under the graph's token ceiling. That ceiling is load-bearing — `tokenize` truncates
 * silently at 510 tokens, so an over-long passage would produce a short waveform and a
 * flattering number.
 */
/**
 * Narrative sentences. The long input is assembled from these plus the short set until it
 * reaches a token budget, rather than being a fixed literal. A first version was a fixed
 * five-sentence passage that landed on exactly 512 tokens: the guard refused it correctly,
 * but a benchmark that cannot run is no benchmark.
 */
const PASSAGE_SENTENCES = [
  'The gate is barred. Nothing breathes behind it, and the hinges have not been oiled in a season.',
  'Rain gathers in the arrow slits and runs in dark threads down the quarried stone, past the banners that were hung there in a drier year.',
  'Somewhere beyond the wall a dog is barking at nothing, or at something it will not name, and then it stops.',
  'Remi puts his hand flat on the timber. He says the wood is warm, which is the sort of thing he says when he wants you to look at his face instead of the door.',
  'The wind comes around the tower and takes the smell of the river with it: silt, and smoke, and something underneath both that you decide not to think about yet.',
]

/** Twelve distinct short utterances — distinct so no runtime can cache a repeat. */
const SHORT_TEXTS = [
  'The gate is barred.',
  'Nothing breathes.',
  'Remi puts his hand on the timber.',
  'The hinges are cold.',
  'Rain runs down the stone.',
  'The dog stops barking.',
  'You hear the river.',
  'The banner is faded.',
  'He will not meet your eye.',
  'Something is behind the door.',
  'The wind turns.',
  'Count to three.',
]

/** Where a variant's graph lives, and whether it is already correctly on disk. */
async function locate(spec) {
  const dest = cachePath(ROOT, spec.path)
  if (existsSync(dest) && await isPinned(dest, spec)) return { path: dest, present: true }
  return { path: dest, present: false }
}

/** Fetch every graph first, so measurement never starts on a half-full set. */
async function downloadAll(specs) {
  console.log('1. DOWNLOAD')
  let already = 0
  let fetched = 0
  for (const spec of specs) {
    const { path, present } = await locate(spec)
    if (present) {
      already += 1
      console.log(`   have    ${spec.key.padEnd(9)} ${mb(spec.bytes).padStart(7)}  verified`)
      continue
    }
    if (has('no-download')) {
      console.log(`   MISSING ${spec.key.padEnd(9)} ${mb(spec.bytes).padStart(7)}  (--no-download was given)`)
      continue
    }
    console.log(`   fetch   ${spec.key.padEnd(9)} ${mb(spec.bytes).padStart(7)}  ${spec.path}`)
    // The small shared files first: cheap, and a failure there costs seconds, not minutes.
    for (const [file, meta] of Object.entries(ASSETS.files)) {
      const fileDest = cachePath(ROOT, file)
      if (existsSync(fileDest) && await isPinned(fileDest, { ...meta, path: file })) continue
      await ensureAsset({ url: ASSETS.baseUrl + file, asset: { ...meta, path: file }, dest: fileDest })
    }
    await ensureAsset({
      url: ASSETS.baseUrl + spec.path,
      asset: { ...spec, path: spec.path },
      dest: path,
      onProgress: ({ completedBytes }) => {
        process.stdout.write(`\r           ${(completedBytes / 1_048_576).toFixed(0)} / ${mb(spec.bytes)}`)
      },
    })
    process.stdout.write('\r')
    fetched += 1
    // Re-verify what landed, rather than trusting that it did.
    if (!await isPinned(path, spec)) {
      throw new Error(`${spec.key} failed verification after download — refusing to measure it`)
    }
    console.log(`   ok      ${spec.key.padEnd(9)} ${mb(spec.bytes).padStart(7)}  sha256 verified`)
  }
  console.log(`   ${already} already present, ${fetched} fetched\n`)
}

/** Time `session.run` alone, best of N. */
async function timeRun(session, { ids, voice, runs }) {
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < runs; index += 1) {
    const started = Date.now()
    await synthesize(session, { inputIds: ids, voice, speed: 1 })
    best = Math.min(best, Date.now() - started)
  }
  return best
}

/** Audio length for one input, measured outside every timer. */
async function secondsOf(session, { ids, voice }) {
  const samples = await synthesize(session, { inputIds: ids, voice, speed: 1 })
  return samples.length / SAMPLE_RATE
}

/** Measure one variant on one provider, in both shapes. */
async function measure(session, { voice, longIds, shortIds, runs }) {
  const longSeconds = await secondsOf(session, { ids: longIds, voice })
  const longMs = await timeRun(session, { ids: longIds, voice, runs })

  let shortMs = 0
  let shortSeconds = 0
  for (const ids of shortIds) {
    shortMs += await timeRun(session, { ids, voice, runs: 1 })
    shortSeconds += await secondsOf(session, { ids, voice })
  }
  const calls = shortIds.length
  const shortAvgMs = shortMs / calls
  const shortAvgSeconds = shortSeconds / calls

  return {
    longMs,
    longSeconds,
    longRtf: longMs / 1000 / longSeconds,
    shortMs,
    shortSeconds,
    shortCalls: calls,
    shortAvgMs,
    shortAvgSeconds,
    shortRtf: shortMs / 1000 / shortSeconds,
    // Positive means a short call costs more than its share of the long call's rate:
    // the dispatch and setup overhead only the many-calls shape exposes.
    overheadMs: shortAvgMs - shortAvgSeconds * (longMs / longSeconds),
  }
}

/**
 * Try to load a WebGPU-capable ONNX Runtime.
 *
 * Node has no WebGPU of its own, so this may legitimately fail. The point is to report
 * which piece is missing rather than assume either way.
 */
async function loadWebGpuRuntime() {
  const problems = []
  for (const specifier of ['onnxruntime-web/webgpu', 'onnxruntime-web']) {
    try {
      const namespace = await import(specifier)
      const ort = namespace?.InferenceSession === undefined ? namespace?.default : namespace
      if (typeof ort?.InferenceSession?.create !== 'function') {
        problems.push(`${specifier}: loaded, but exposes no InferenceSession`)
        continue
      }
      if (globalThis.navigator?.gpu === undefined) {
        problems.push(`${specifier}: loaded, but Node provides no navigator.gpu`)
        continue
      }
      return { ort, specifier }
    } catch (error) {
      problems.push(`${specifier}: ${error.message}`)
    }
  }
  return { problems }
}

/** A fixed-width table, because comparing rows is the point. */
function table(headers, rows) {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => String(row[column] ?? '').length),
  ))
  const line = (cells) => cells.map((cell, column) => String(cell ?? '').padStart(widths[column])).join('  ')
  console.log(`\n   ${line(headers)}`)
  console.log(`   ${widths.map((width) => '-'.repeat(width)).join('  ')}`)
  for (const row of rows) console.log(`   ${line(row)}`)
}

async function main() {
  const wantedKeys = String(flag('variants', DEFAULT_VARIANTS))
    .split(',').map((part) => part.trim()).filter(Boolean)
  const eps = String(flag('eps', 'cpu,webgpu')).split(',').map((part) => part.trim()).filter(Boolean)
  const runs = Number(flag('runs', 3))
  const threads = Number(flag('threads', 1))

  const wanted = []
  for (const key of wantedKeys) {
    const spec = VARIANTS.get(key)
    if (spec === undefined) {
      console.log(`No variant "${key}" in assets.json. Known: ${[...VARIANTS.keys()].join(', ')}`)
      process.exitCode = 1
      return
    }
    wanted.push(spec)
  }

  const totalBytes = wanted.reduce((sum, spec) => sum + spec.bytes, 0)
  console.log('KOKORO INFERENCE BENCHMARK')
  console.log(`  data root     ${ROOT}`)
  console.log(`  voice         ${VOICE}`)
  console.log(`  types         ${wanted.map((spec) => spec.key).join(', ')}`)
  console.log(`  providers     ${eps.join(', ')}`)
  console.log(`  cpu threads   ${threads}`)
  console.log(`  runs          best of ${runs} per measurement`)
  console.log(`  if downloaded ${mb(totalBytes)} total across ${wanted.length} graphs\n`)

  // ---- 1. everything on disk and verified, before any measurement ---------
  let all
  try {
    await downloadAll(wanted)
    all = (await Promise.all(wanted.map(locate))).every((entry) => entry.present)
  } catch (error) {
    console.log(`\nDownload failed: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (!all) {
    console.log('Some graphs are still missing, so the sweep would be incomplete. Stopping.')
    process.exitCode = 1
    return
  }

  // ---- 2. the shared inputs, tokenized once ------------------------------
  const voiceFile = cachePath(ROOT, `voices/${VOICE}.bin`)
  if (!existsSync(voiceFile)) {
    console.log(`No voice file at ${voiceFile}. Prepare Kokoro once through the plugin first.`)
    process.exitCode = 1
    return
  }
  const voice = loadVoice(voiceFile)
  const vocab = loadVocab(cachePath(ROOT, 'tokenizer.json'))

  console.log('2. INPUTS')
  // Assemble the long input to a token budget instead of trusting a fixed passage to fit.
  // The graph truncates silently at its ceiling, so the shape of this input decides
  // whether the number means anything — and building it sentence by sentence means it
  // cannot drift into truncation when the tokenizer or the text changes.
  const LONG_TOKEN_BUDGET = 460
  const pool = [...PASSAGE_SENTENCES, ...SHORT_TEXTS]
  let longText = ''
  let longIds = []
  for (const sentence of pool) {
    const candidate = longText === '' ? sentence : `${longText} ${sentence}`
    const ids = tokenize(await phonemize(candidate, 'a'), vocab)
    if (ids.length > LONG_TOKEN_BUDGET) break
    longText = candidate
    longIds = ids
  }
  if (longIds.length >= MAX_TOKENS) {
    console.log(`   assembled ${longIds.length} tokens, at or over the graph's ${MAX_TOKENS} ceiling.`)
    console.log('   Stopping rather than measuring a truncated waveform.')
    process.exitCode = 1
    return
  }
  const shortIds = []
  for (const text of SHORT_TEXTS) shortIds.push(tokenize(await phonemize(text, 'a'), vocab))
  console.log(`   long    ${longText.split(' ').length} words → ${longIds.length} tokens`
    + `  (budget ${LONG_TOKEN_BUDGET}, graph ceiling ${MAX_TOKENS})`)
  console.log(`   short   ${shortIds.length} utterances, ${shortIds.reduce((sum, ids) => sum + ids.length, 0)} tokens total`)
  const phonemizeStarted = Date.now()
  await phonemize(longText, 'a')
  console.log(`   phonemize ~${Date.now() - phonemizeStarted} ms per passage, excluded from every timing\n`)

  // ---- 3. measure --------------------------------------------------------
  console.log('3. MEASURE')
  const rows = []
  const failures = []

  if (eps.includes('cpu')) {
    const ort = await loadOrt()
    for (const spec of wanted) {
      try {
        const { path } = await locate(spec)
        const session = await ort.InferenceSession.create(path, { intraOpNumThreads: threads })
        const result = await measure(session, { voice, longIds, shortIds, runs })
        rows.push({ provider: 'cpu', variant: spec.key, bytes: spec.bytes, ...result })
        console.log(`   cpu/${spec.key} done`)
        await session.release?.()
      } catch (error) {
        failures.push(`cpu/${spec.key}: ${error.message}`)
      }
    }
  }

  if (eps.includes('webgpu')) {
    const loaded = await loadWebGpuRuntime()
    if (loaded.problems !== undefined) {
      for (const problem of loaded.problems) failures.push(`webgpu: ${problem}`)
      failures.push('webgpu: Node needs a WebGPU implementation of its own (Dawn or WGPU); '
        + 'a browser tab has navigator.gpu, this process does not')
    } else {
      console.log(`   webgpu via ${loaded.specifier}`)
      for (const spec of wanted) {
        try {
          const { path } = await locate(spec)
          // onnxruntime-web takes the bytes, not a path.
          const session = await loaded.ort.InferenceSession.create(readFileSync(path), {
            executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
          })
          const result = await measure(session, { voice, longIds, shortIds, runs })
          rows.push({ provider: 'webgpu', variant: spec.key, bytes: spec.bytes, ...result })
          console.log(`   webgpu/${spec.key} done`)
        } catch (error) {
          failures.push(`webgpu/${spec.key}: ${error.message}`)
        }
      }
    }
  }

  // ---- 4. results --------------------------------------------------------
  console.log('\n4. RESULTS')
  if (rows.length === 0) {
    console.log('   nothing measured')
  } else {
    table(
      ['provider', 'type', 'size', 'long audio', 'long ms', 'long RTF', 'short RTF', 'per call', 'overhead'],
      rows.map((row) => [
        row.provider,
        row.variant,
        mb(row.bytes),
        `${row.longSeconds.toFixed(1)} s`,
        Math.round(row.longMs),
        row.longRtf.toFixed(2),
        row.shortRtf.toFixed(2),
        `${Math.round(row.shortAvgMs)} ms`,
        `${row.overheadMs >= 0 ? '+' : ''}${Math.round(row.overheadMs)} ms`,
      ]),
    )

    const bestLong = rows.reduce((a, b) => (b.longRtf < a.longRtf ? b : a))
    const bestShort = rows.reduce((a, b) => (b.shortRtf < a.shortRtf ? b : a))
    console.log(`\n   fastest, one long call   ${bestLong.provider}/${bestLong.variant}  RTF ${bestLong.longRtf.toFixed(2)}`)
    console.log(`   fastest, twelve calls    ${bestShort.provider}/${bestShort.variant}  RTF ${bestShort.shortRtf.toFixed(2)}`)
    if (bestLong.variant !== bestShort.variant) {
      console.log('   The winner differs by shape. A reply is spoken as many short calls, so the')
      console.log('   second line is the one that matches real use — and the reason both are here.')
    }
    const realtime = rows.filter((row) => row.shortRtf < 1).map((row) => `${row.provider}/${row.variant}`)
    console.log(realtime.length === 0
      ? '   None of these is faster than real time on this machine in the short-call shape.'
      : `   Faster than real time on short calls: ${realtime.join(', ')}`)
  }

  if (failures.length > 0) {
    console.log('\n   NOT MEASURED')
    for (const failure of failures) console.log(`   ${failure}`)
  }

  const out = String(flag('json', 'bench-inference-results.json'))
  if (out !== 'false') {
    const path = join(here, out)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      when: new Date().toISOString(),
      voice: VOICE,
      threads,
      runs,
      longChars: longText.length,
      longTokens: longIds.length,
      shortCalls: shortIds.length,
      rows,
      failures,
    }, null, 2)}\n`)
    console.log(`\n   results written to ${path}`)
  }

  if (has('save-wav') && rows.length > 0) {
    const last = rows.at(-1)
    const ort = await loadOrt()
    const spec = VARIANTS.get(last.variant)
    const session = await ort.InferenceSession.create(cachePath(ROOT, spec.path), { intraOpNumThreads: threads })
    const samples = await synthesize(session, { inputIds: longIds, voice, speed: 1 })
    const path = join(here, `bench-${last.provider}-${last.variant}.wav`)
    writeFileSync(path, Buffer.from(encodeWav(samples, SAMPLE_RATE)))
    console.log(`   wav from the last measured graph: ${path}`)
  }
}

await main()
