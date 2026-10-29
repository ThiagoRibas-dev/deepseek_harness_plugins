/** Inspect one session's event stream. Read-only. */
import { execFileSync } from 'node:child_process'
const FILE = process.argv[2]
const text = execFileSync('zstdcat', [FILE], { maxBuffer: 1 << 30 }).toString('utf8')
const evs = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try { evs.push(JSON.parse(line)) } catch {}
}
const counts = {}
for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1
console.log('=== event types ===')
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
console.log(`\ntotal events: ${evs.length}`)
const first = evs[0]
console.log('preset:', first?.agentPreset, '| origin:', first?.origin, '| cwd:', first?.cwd)
