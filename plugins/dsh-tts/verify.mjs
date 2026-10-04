#!/usr/bin/env node
/**
 * verify.mjs — the two gates around a restart, in one command each.
 *
 *   node verify.mjs pre                       # before restarting: the offline suites
 *   node verify.mjs live --label threads1     # after restarting: measure the live API
 *   node verify.mjs live --label threads2 --vs bench-threads1.json
 *
 * Why two phases at all: the suites can only check code — they cannot see whether the
 * running host actually loaded it, and synthesis speed only exists in a live process.
 * So `pre` answers "is this safe to restart?" and `live` answers "what did the change
 * do to the numbers?".
 *
 * `pre` runs `smoke.mjs` **first**, deliberately: it is the only suite that mounts the
 * plugin, so if the registry wiring is broken this fails before a restart takes TTS
 * down for the whole profile.
 *
 * `live` discovers its own credential by reading the page the host already serves —
 * `webServer.tapIndex` injects `window.__DSH_TTS__ = { prefix, token }` into the
 * document, which is exactly what the browser uses. Override with `--token` or
 * `DSH_TTS_TOKEN` when that page is not reachable.
 *
 * No dependencies, and it imports nothing from the bundle: it stays runnable even when
 * the plugin is the thing that is broken.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The suites, in the order they should run. `smoke.mjs` mounts the plugin. */
const SUITES = ['smoke.mjs', 'check.js', 'check-http.mjs', 'check-client.mjs']

/** The sentence every measurement uses, so runs stay comparable. */
const DEFAULT_TEXT = 'The gate is barred. Nothing breathes.'

const here = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const mode = argv.find((argument) => !argument.startsWith('--')) ?? 'pre'

/** Read `--name value`, or fall back. */
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

/**
 * Read a JSON response, failing with the status and the first line of the body.
 *
 * A non-JSON body used to surface as `Unexpected end of JSON input`, which sent one
 * debugging session looking at whether the host was running when the real problem was a
 * request to the wrong path. A rejection has to say what it was.
 * @param response - a fetch response whose body has not been read yet.
 * @returns the parsed body.
 */
async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const first = text.split('\n')[0].slice(0, 120)
    throw new Error(`${response.status} ${response.statusText} from ${response.url}`
      + `${first === '' ? ' (empty body)' : ` — ${first}`}`)
  }
}

// ---- pre -----------------------------------------------------------------

/** Run one suite and summarise its output. */
function runSuite(file) {
  const result = spawnSync(process.execPath, [file], { cwd: here, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const passed = /(\d+) checks passed/.exec(output)
  const failed = /(\d+) failed, (\d+) passed/.exec(output)
  return {
    file,
    code: result.status,
    passed: Number(passed?.[1] ?? failed?.[2] ?? 0),
    failed: Number(failed?.[1] ?? 0),
    failures: output.split('\n').filter((line) => line.trim().startsWith('✗')).map((line) => line.trim()),
    // A suite that says nothing at all is not a pass: it crashed on load.
    output: output.trim(),
  }
}

function pre() {
  console.log('OFFLINE GATES — run before restarting the harness\n')
  const results = SUITES.map(runSuite)
  let bad = 0
  for (const result of results) {
    const verdict = result.code === 0 && result.output !== '' ? 'ok    ' : 'FAILED'
    if (verdict === 'FAILED') bad += 1
    console.log(`${verdict}  ${result.file.padEnd(17)} ${String(result.passed).padStart(4)} passed${result.failed > 0 ? `, ${result.failed} failed` : ''}`)
    for (const failure of result.failures) console.log(`          ${failure}`)
    if (result.output === '') console.log(`          no output — the suite did not run (exit ${result.code})`)
  }
  const total = results.reduce((sum, result) => sum + result.passed, 0)
  console.log(`\n${results.length} suites · ${total} checks passed · ${bad} failing`)
  if (bad > 0) {
    console.log('\nDo NOT restart with a failing suite: `smoke.mjs` failing means the plugin')
    console.log('would not mount, which takes text-to-speech down for the whole profile.')
    process.exitCode = 1
    return
  }
  console.log('\nSafe to restart. Then:  node verify.mjs live --label <name>')
}

// ---- live ----------------------------------------------------------------

/** Ask the host whether the API is on, without spending the credential. */
async function health(base) {
  let response
  try {
    response = await fetch(`${base}/health`)
  } catch (error) {
    // Unreachable and reachable-but-wrong are different failures, and they used to print
    // identically, which sent this script's first real run looking in the wrong place.
    throw new Error(`cannot reach ${base} — is \`dsh web\` running? (${error.message})`)
  }
  return await readJson(response)
}

/**
 * Find the token the way the browser does: read it out of the served page.
 * @returns the credential, or undefined when the page cannot be read.
 */
async function discover(base) {
  try {
    const response = await fetch(base)
    if (!response.ok) return undefined
    const body = await response.text()
    const match = /window\.__DSH_TTS__\s*=\s*(\{[^<]*\})/.exec(body)
    if (match === null) return undefined
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

/** POST a setting patch. */
async function setSetting(base, token, patch) {
  const response = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${body.error ?? response.status}: ${body.message ?? 'settings refused'}`)
  return body
}

/**
 * One synthesis, timed by the host's own headers.
 * @returns the numbers the route reports, or a failure the caller can print.
 */
async function probe(base, token, text) {
  const response = await fetch(`${base}/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, response_format: 'wav' }),
  })
  // Read the body even though it is discarded: an unread WAV keeps the socket open.
  const wav = await response.arrayBuffer()
  if (!response.ok) {
    const body = new TextDecoder().decode(wav)
    return { error: body.slice(0, 300) }
  }
  const seconds = Number(response.headers.get('x-audio-seconds'))
  const inferredMs = Number(response.headers.get('x-inferred-ms'))
  return {
    seconds,
    inferredMs,
    segments: Number(response.headers.get('x-segments')),
    rtf: seconds > 0 ? inferredMs / 1000 / seconds : Number.NaN,
    bytes: wav.byteLength,
    wav: Buffer.from(wav),
  }
}

/** Best of N, because the first call after a restart pays for the model load. */
function summarise(samples) {
  const usable = samples.filter((sample) => sample.error === undefined)
  if (usable.length === 0) return { error: samples[0]?.error ?? 'no successful probe' }
  const best = usable.reduce((a, b) => (b.inferredMs < a.inferredMs ? b : a))
  return {
    seconds: best.seconds,
    inferredMs: best.inferredMs,
    segments: best.segments,
    rtf: best.rtf,
    samples: usable.map((sample) => Math.round(sample.inferredMs)),
    wav: best.wav,
  }
}

async function live() {
  // `--url` may be an origin, an origin plus the mount point, or the harness's own URL
  // with `?token=…` on it — the form `systemctl status` prints. All three are normalised
  // here: the harness's token belongs to the harness's page, not to these routes (they
  // authenticate with the plugin's own token), so it is accepted and dropped rather than
  // forwarded. Getting this wrong made a wrong path look like an unreachable host.
  const target = new URL(String(flag('url', 'http://127.0.0.1:3080')))
  const mount = String(flag('prefix', target.pathname.replace(/\/$/, '') || '/v1/audio')).replace(/\/$/, '')
  const base = `${target.origin}${mount}`
  const text = String(flag('text', DEFAULT_TEXT))
  const runs = Number(flag('runs', 3))
  const label = String(flag('label', 'run'))
  const versus = flag('vs', undefined)

  const state = await health(base)
  if (state.enabled !== true) {
    console.log(`The TTS API is not enabled (enabled: ${state.enabled}).`)
    console.log('Turn on `apiEnabled` in the plugin settings, then run this again.')
    process.exitCode = 1
    return
  }

  let token = flag('token', process.env.DSH_TTS_TOKEN)
  if (typeof token !== 'string' || token === '') {
    // Credential discovery reads the page the host serves, which lives at the *origin* —
    // not at the mount point — and that page may itself want the harness token, so it is
    // passed through here even though the API routes below neither need nor forward it.
    const harnessToken = target.searchParams.get('token')
    const discovered = await discover(harnessToken === null
      ? target.origin
      : `${target.origin}/?token=${encodeURIComponent(harnessToken)}`)
    token = discovered?.token
    if (typeof token === 'string' && token !== '') {
      console.log(`credential discovered from the served page (prefix ${discovered.prefix ?? '/v1/audio'})`)
    }
  }
  if (typeof token !== 'string' || token === '') {
    console.log('No credential. Either export DSH_TTS_TOKEN, pass --token, or open the GUI and run:')
    console.log('  copy(window.__DSH_TTS__.token)')
    process.exitCode = 1
    return
  }

  const status = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${token}` } })).json()
  const threads = status.threads ?? 1
  console.log(`\nLIVE BENCHMARK — ${base}`)
  console.log(`  text      ${JSON.stringify(text)}`)
  console.log(`  threads   ${threads}   (read at model load; a change needs a restart)`)
  console.log(`  runs      ${runs} measured per engine, plus one warm-up\n`)

  const results = {}
  for (const provider of ['kokoro', 'piper']) {
    try {
      await setSetting(base, token, { provider })
    } catch (error) {
      console.log(`${provider.padEnd(7)} skipped — ${error.message}`)
      continue
    }
    const active = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${token}` } })).json()
    if (active.provider !== provider) {
      console.log(`${provider.padEnd(7)} skipped — the host still reports "${active.provider}"`)
      continue
    }
    const samples = []
    // Warm-up first: this call loads the graph and (on Piper) reads the voice file.
    const warm = await probe(base, token, text)
    if (warm.error !== undefined) {
      console.log(`${provider.padEnd(7)} FAILED — ${warm.error}`)
      results[provider] = { error: warm.error }
      continue
    }
    for (let index = 0; index < runs; index += 1) samples.push(await probe(base, token, text))
    const summary = summarise(samples)
    if (flag('save-wav', false) !== false && summary.wav !== undefined) {
      const path = join(here, `bench-${label}-${provider}.wav`)
      writeFileSync(path, summary.wav)
      console.log(`          wav → ${path}`)
    }
    const { wav: _discarded, ...numbers } = summary
    results[provider] = { ...numbers, voice: active.voice, phase: active.phase }
    console.log(`${provider.padEnd(7)} voice ${String(active.voice ?? '?').padEnd(18)}`
      + ` ${summary.seconds.toFixed(2)} s audio`
      + ` · ${Math.round(summary.inferredMs)} ms`
      + ` · RTF ${summary.rtf.toFixed(2)}`
      + ` · ${summary.segments} segment(s)`
      + ` · samples [${summary.samples.join(', ')}]`)
  }

  const record = { label, when: new Date().toISOString(), base, text, threads, results }
  const path = join(here, `bench-${label}.json`)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\nsaved ${path}`)

  const previous = typeof versus === 'string' && existsSync(versus) ? versus
    : existsSync(join(here, `bench-${versus ?? ''}.json`)) ? join(here, `bench-${versus}.json`) : undefined
  if (previous !== undefined) {
    const before = JSON.parse(readFileSync(previous, 'utf8'))
    console.log(`\nCOMPARISON — ${before.label} (threads ${before.threads}) → ${label} (threads ${threads})`)
    for (const provider of Object.keys(results)) {
      const a = before.results?.[provider]
      const b = results[provider]
      if (a?.inferredMs === undefined || b?.inferredMs === undefined) continue
      const speedup = a.inferredMs / b.inferredMs
      console.log(`  ${provider.padEnd(7)} ${Math.round(a.inferredMs)} ms → ${Math.round(b.inferredMs)} ms`
        + `  (${speedup >= 1 ? `${speedup.toFixed(2)}× faster` : `${(1 / speedup).toFixed(2)}× slower`})`
        + `  RTF ${a.rtf.toFixed(2)} → ${b.rtf.toFixed(2)}`)
    }
  } else if (versus !== undefined) {
    console.log(`\n(no baseline at ${versus} to compare against — this run is now one)`)
  }
}

// ---- entry ---------------------------------------------------------------

if (mode === 'pre') pre()
else if (mode === 'live') await live()
else {
  console.log('usage:')
  console.log('  node verify.mjs pre                                  # offline suites, before a restart')
  console.log('  node verify.mjs live --label threads2                # measure, after a restart')
  console.log('  node verify.mjs live --label threads2 --vs bench-threads1.json')
  console.log('')
  console.log('options for live: --url, --token, --text, --runs, --save-wav')
}
