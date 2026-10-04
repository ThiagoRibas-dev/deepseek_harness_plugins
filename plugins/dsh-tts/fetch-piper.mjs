#!/usr/bin/env node
/**
 * Fetch one Piper voice and print everything needed to write a driver against it.
 *
 *   node fetch-piper.mjs                          # en_US-amy-medium
 *   node fetch-piper.mjs en_US-amy-low            # the fastest quality tier
 *   node fetch-piper.mjs en_GB-alan-medium --revision main
 *   node fetch-piper.mjs --inspect-only <model.onnx>
 *
 * Why this exists, and why it is not `piper.js` yet:
 *
 * Piper's ONNX contract is small but exact — the input tensor *names*, the interleave
 * rule for phoneme ids, the `scales` order, and the output layout all have to match
 * the published file. Writing that from memory is how this project previously shipped
 * a "verified" claim that was about the wrong seam. So this script fetches the real
 * artifact, prints its contract, and runs one probe synthesis through it; the driver
 * is then written against measured facts rather than recollection.
 *
 * It is deliberately standalone: no `@deepseek-ai/*` imports, so plain `node` can run
 * it from this directory. Once a voice is fetched and its hashes are recorded, the
 * plugin's own `download.js` can take over the fetch with a real pin.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { phonemize, loadOrt } from './kokoro.js'

/** The published Piper voice repository: public, ungated, plain HTTPS. */
const REPO = 'https://huggingface.co/rhasspy/piper-voices/resolve'

/** Where the plugin keeps models, matching `dataRoot: dshHomePath('tts')`. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Turn a voice name into the repository's directory layout.
 * `en_US-amy-medium` → `en/en_US/amy/medium/`.
 * @param voice - the voice identifier.
 * @returns the path components, or undefined when the name does not parse.
 */
function voiceParts(voice) {
  const match = /^([a-z]{2})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/.exec(voice)
  if (match === null) return undefined
  const [, family, region, name, quality] = match
  // The repository nests the locale as a single directory: `en/en_US/amy/medium/`.
  // (Getting this wrong is how the first run 404'd — the region alone is not a path.)
  const locale = `${family}_${region}`
  return { family, locale, name, quality, dir: `${family}/${locale}/${name}/${quality}/${voice}` }
}

/**
 * Download one file, hashing while it streams.
 * @returns byte count and sha256, or undefined when the server refused it.
 */
async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    console.error(`  ✗ ${response.status} ${response.statusText} for ${url}`)
    return undefined
  }
  const hash = createHash('sha256')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    hash.update(buffer)
    chunks.push(buffer)
    bytes += buffer.length
    process.stdout.write(`\r  ${(bytes / 1_048_576).toFixed(1)} MB …`)
  }
  process.stdout.write('\r')
  const body = Buffer.concat(chunks, bytes)
  // Written beside the target and renamed, so an interrupted fetch never leaves a
  // half file that a later run would treat as complete.
  const partial = `${dest}.part`
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(partial, body, { mode: 0o600 })
  renameSync(partial, dest)
  return { bytes, sha256: hash.digest('hex') }
}

/** Print the parts of the voice config that decide how the model must be driven. */
function reportConfig(config) {
  const map = config.phoneme_id_map ?? {}
  const symbols = Object.keys(map)
  console.log('\n  config')
  console.log(`    audio.sample_rate   ${config.audio?.sample_rate ?? '(absent)'}`)
  console.log(`    espeak.voice        ${config.espeak?.voice ?? '(absent)'}`)
  console.log(`    phoneme_type        ${config.phoneme_type ?? '(absent)'}`)
  console.log(`    num_symbols         ${config.num_symbols ?? symbols.length}`)
  console.log(`    num_speakers        ${config.num_speakers ?? 1}`)
  console.log(`    inference           ${JSON.stringify(config.inference ?? {})}`)
  console.log(`    id map size         ${symbols.length}`)
  // The three that decide the sequence construction: start, end, and the pad that
  // separates phones. Everything else is a phoneme.
  for (const special of ['^', '$', '_', ' ']) {
    const value = map[special]
    console.log(`    map[${JSON.stringify(special)}]${' '.repeat(Math.max(0, 12 - special.length))}${value === undefined ? '(absent)' : JSON.stringify(value)}`)
  }
  console.log(`    first symbols       ${symbols.slice(0, 24).join(' ')}`)
}

/**
 * Build the id sequence the way Piper's own `phonemes_to_ids` does: start token,
 * then each phoneme followed by a pad, then the end token.
 *
 * Stated here as the *hypothesis under test* — the probe below is what decides
 * whether it is right, by producing audible samples or not.
 */
function phonemesToIds(phonemes, idMap) {
  const at = (symbol) => (Array.isArray(idMap[symbol]) ? idMap[symbol][0] : idMap[symbol])
  const ids = []
  const bos = at('^')
  const eos = at('$')
  const pad = at('_')
  if (bos !== undefined) ids.push(bos)
  for (const symbol of phonemes) {
    const id = at(symbol)
    if (id === undefined) continue
    ids.push(id)
    if (pad !== undefined) ids.push(pad)
  }
  if (eos !== undefined) ids.push(eos)
  return ids
}

/** Load the model and print its tensor contract. */
async function inspect(modelPath, configPath) {
  const ort = await loadOrt()
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1 })
  console.log('\n  onnx contract')
  console.log(`    inputs              ${JSON.stringify(session.inputNames)}`)
  console.log(`    outputs             ${JSON.stringify(session.outputNames)}`)
  for (const name of session.inputNames) {
    const meta = session.inputMetadata?.[name]
    if (meta !== undefined) console.log(`    ${name}: ${meta.type} ${JSON.stringify(meta.dimensions ?? meta.shape)}`)
  }
  for (const name of session.outputNames) {
    const meta = session.outputMetadata?.[name]
    if (meta !== undefined) console.log(`    ${name}: ${meta.type} ${JSON.stringify(meta.dimensions ?? meta.shape)}`)
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  reportConfig(config)

  // The probe: a real sentence, through the real phonemizer and the real graph.
  const sentence = 'The gate is barred. Nothing breathes.'
  // The plugin's phonemizer uses Kokoro's language convention: 'a' American, 'b' British.
  const espeakVoice = config.espeak?.voice ?? 'en-us'
  const language = espeakVoice.endsWith('-gb') ? 'b' : 'a'
  const phonemes = await phonemize(sentence, language)
  const idMap = config.phoneme_id_map ?? {}
  // Piper marks word boundaries with `_`, so the phonemizer's spaces become that.
  const words = phonemes.replace(/\s+/g, '_')
  const ids = phonemesToIds(words, idMap)
  console.log('\n  probe')
  console.log(`    espeak voice        ${espeakVoice} → language "${language}"`)
  console.log(`    text                ${JSON.stringify(sentence)}`)
  console.log(`    phonemes            ${phonemes}`)
  console.log(`    mapped symbols      ${ids.length} ids from ${words.length} symbols`)

  const { Tensor } = ort
  const feeds = {
    input: new Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
    input_lengths: new Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    // VITS scale order: noise, length (1/speed), noise width. Piper's own defaults.
    scales: new Tensor('float32', Float32Array.from([0.667, 1, 0.8]), [3]),
  }
  // A multi-speaker voice needs the speaker id; a single-speaker one rejects it.
  if ((config.num_speakers ?? 1) > 1) {
    feeds.sid = new Tensor('int64', BigInt64Array.from([0n]), [1])
    console.log('    speaker id          0 (multi-speaker model)')
  }

  let results
  const started = Date.now()
  try {
    results = await session.run(feeds)
  } catch (error) {
    console.log(`\n    run FAILED: ${error.message}`)
    console.log('    the tensor contract printed above is what the driver must be written')
    console.log('    against; this failure is the useful output — send it back.')
    return
  }
  const ms = Date.now() - started
  const output = results[session.outputNames[0]]
  const samples = Float32Array.from(output.data)
  let peak = 0
  let energy = 0
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample))
    energy += sample * sample
  }
  const rate = config.audio?.sample_rate ?? 22050
  console.log(`    output shape        ${JSON.stringify(output.dims ?? output.dimensions)}`)
  console.log(`    samples             ${samples.length} (${(samples.length / rate).toFixed(2)} s at ${rate} Hz)`)
  console.log(`    elapsed             ${ms} ms → RTF ${(ms / 1000 / (samples.length / rate)).toFixed(2)}`)
  console.log(`    peak / rms          ${peak.toFixed(4)} / ${Math.sqrt(energy / Math.max(1, samples.length)).toFixed(5)}`)
  console.log(peak > 0.01
    ? '    verdict             AUDIBLE — the id construction and scales are right'
    : '    verdict             SILENT — the id construction is wrong; send this output back')

  // A WAV beside the model, so the same run can be listened to.
  const { encodeWav } = await import('./kokoro.js')
  const wavPath = join(dirname(configPath), `${basename(modelPath, '.onnx')}-probe.wav`)
  writeFileSync(wavPath, Buffer.from(encodeWav(samples, rate)))
  console.log(`    wav                 ${wavPath}`)
}

async function main() {
  const args = process.argv.slice(2)
  const inspectOnly = args.indexOf('--inspect-only')
  if (inspectOnly !== -1) {
    const modelPath = args[inspectOnly + 1]
    if (modelPath === undefined) {
      console.error('usage: fetch-piper.mjs --inspect-only <voice.onnx>')
      process.exit(2)
    }
    await inspect(modelPath, `${modelPath}.json`)
    return
  }

  const revisionIndex = args.indexOf('--revision')
  const revision = revisionIndex === -1 ? 'main' : args[revisionIndex + 1]
  const voice = args.find((arg) => !arg.startsWith('--') && arg !== revision) ?? 'en_US-amy-medium'
  const parts = voiceParts(voice)
  if (parts === undefined) {
    console.error(`"${voice}" does not look like a Piper voice name (e.g. en_US-amy-medium, en_US-amy-low).`)
    process.exit(2)
  }

  const root = join(DSH_HOME, 'tts', 'models', 'piper', parts.dir)
  const modelPath = join(root, `${voice}.onnx`)
  const configPath = join(root, `${voice}.onnx.json`)
  console.log(`voice      ${voice}  (${parts.quality} quality)`)
  console.log(`dest       ${root}`)
  console.log(`revision   ${revision}`)

  const pins = {}
  for (const [suffix, dest] of [['.onnx', modelPath], ['.onnx.json', configPath]]) {
    const url = `${REPO}/${revision}/${parts.dir}${suffix}`
    if (existsSync(dest)) {
      const bytes = statSync(dest).size
      const sha256 = createHash('sha256').update(readFileSync(dest)).digest('hex')
      console.log(`\n${suffix}\n  present, ${bytes} bytes\n  sha256 ${sha256}`)
      pins[suffix] = { bytes, sha256 }
      continue
    }
    console.log(`\n${suffix}\n  ${url}`)
    const result = await download(url, dest)
    if (result === undefined) {
      console.error('\n  That path may not exist for this voice. Browse the published tree:')
      console.error(`    https://huggingface.co/rhasspy/piper-voices/tree/${revision}/${parts.family}/${parts.locale}/${parts.name}`)
      console.error('  (qualities vary per voice: not every name ships a "high".)')
      process.exit(1)
    }
    console.log(`  ${result.bytes} bytes\n  sha256 ${result.sha256}`)
    pins[suffix] = result
  }

  await inspect(modelPath, configPath)

  console.log('\n  assets.json fragment (bytes and hashes recorded from this fetch)')
  console.log(JSON.stringify({
    piper: {
      revision,
      voices: {
        [voice]: {
          model: { path: `${voice}.onnx`, ...pins['.onnx'] },
          config: { path: `${voice}.onnx.json`, ...pins['.onnx.json'] },
        },
      },
    },
  }, null, 2))
}

await main()
