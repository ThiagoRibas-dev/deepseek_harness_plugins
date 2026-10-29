/**
 * Pair captures with the CLI's own record of the prompt, to measure the ratio
 * between the body we send and the prompt Meridian builds.
 *
 * Usage: node tmp/meridian/prompt-ratio.mjs [limit]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CAPTURES = '/root/.dsh/meridian-capture'
const BRAINS = '/root/.gemini/antigravity-cli/brain'
const limit = Number(process.argv[2] ?? 6)

// Collect every text leaf, including those nested in a tool_result block, so a
// body that ends on a tool result still yields a fingerprint.
const textOf = block => {
  if (typeof block === 'string') return block
  if (Array.isArray(block)) return block.map(textOf).join('\n')
  if (block === null || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  return textOf(block.content) + (block.type === 'tool_result' ? '' : '')
}

const captures = fs.readdirSync(CAPTURES)
  .map(name => JSON.parse(fs.readFileSync(path.join(CAPTURES, name), 'utf8')))
  .filter(capture => Array.isArray(capture?.body?.messages) && Number.isFinite(capture.bytes))
  .sort((a, b) => b.time - a.time)
  .slice(0, limit)

// Index the transcripts once: longest prompt text per brain, keyed by a fingerprint
// taken from a distinctive tail of that prompt.
const fingerprints = []
for (const dir of fs.readdirSync(BRAINS)) {
  const file = path.join(BRAINS, dir, '.system_generated/logs/transcript_full.jsonl')
  if (!fs.existsSync(file)) continue
  let best = ''
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('<USER_REQUEST>')) continue
    try {
      const record = JSON.parse(line)
      if (record.type !== 'USER_INPUT' || typeof record.content !== 'string') continue
      if (record.content.length > best.length) best = record.content
    } catch {}
  }
  if (best.length === 0) continue
  fingerprints.push({ dir: dir.slice(0, 8), length: best.length, tail: best.slice(-140_000) })
}

console.log(`captures: ${captures.length}   brains with a prompt: ${fingerprints.length}`)
console.log('body bytes | prompt chars | ratio | evidence')
for (const capture of captures) {
  // Walk back for the newest message that carries text; the prompt keeps the
  // newest history at its end, so a long distinctive tail is the best fingerprint.
  let needle = ''
  for (let index = capture.body.messages.length - 1; index >= 0 && needle.length < 140; index -= 1) {
    const text = textOf(capture.body.messages[index]).replace(/\s+/g, ' ').trim()
    if (text.length >= 160) needle = text.slice(-140)
  }
  // A needle that appears in more than one transcript identifies nothing.
  const hits = needle === '' ? [] : fingerprints.filter(entry => entry.tail.includes(needle))
  const match = hits.length === 1 ? hits[0] : undefined
  if (match === undefined) {
    console.log(`${String(capture.bytes).padStart(10)} | ${'—'.padStart(12)} | ${'—'.padStart(5)} | ${hits.length === 0 ? 'no transcript' : 'ambiguous (' + hits.length + ')'}`)
    continue
  }
  const ratio = (match.length / capture.bytes).toFixed(3)
  console.log(`${String(capture.bytes).padStart(10)} | ${String(match.length).padStart(12)} | ${ratio.padStart(5)} | brain ${match.dir}`)
}
