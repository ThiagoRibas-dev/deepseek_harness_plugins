/** Print every errored turn with its code and a trimmed message. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
for (const l of text.split('\n')) {
  if (!l.trim()) continue
  let e; try { e = JSON.parse(l) } catch { continue }
  const d = e.data ?? {}
  if (e.type !== 'turn/end') continue
  const r = d.reason ?? {}
  if (r.kind === 'completed') continue
  console.log(`turn ${d.turn}  kind=${r.kind}  code=${r.error?.code ?? '-'}`)
  console.log(`   ${String(r.error?.message ?? '').slice(0, 400).replace(/\s+/g, ' ')}`)
  console.log()
}
