/** Timestamps of key events, to tell a live retry from an inherited error. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
const evs = []
for (const l of text.split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)) } catch {} }
const t0 = evs[0]?.createdAt
console.log('session createdAt:', t0, t0 ? new Date(t0).toISOString() : '')
for (const e of evs) {
  const d = e.data ?? {}
  if (e.type !== 'turn/end' && e.type !== 'assistant/attempt' && e.type !== 'model/selection') continue
  const at = e.time ?? d.time
  const code = d.reason?.error?.code ?? ''
  const kind = d.reason?.kind ?? ''
  console.log(`  ${e.type.padEnd(20)} t${d.turn ?? '-'} ${at ? new Date(at).toISOString() : '-'} ${kind} ${code}`)
}
