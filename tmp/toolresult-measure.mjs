/** How much of a real session's provider-bound history is tool output? Read-only. */
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const B = (s) => Buffer.byteLength(s ?? '', 'utf8')
const perTool = new Map()
const callNames = new Map()
let sessions = 0, results = 0, resultBytes = 0, historyBytes = 0, biggest = []
for (const dir of readdirSync(ROOT)) {
  let text
  try { text = execFileSync('zstdcat', [join(ROOT, dir, 'session.v4.jsonl.zstd')], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  try { if (JSON.parse(text.split('\n', 1)[0]).agentPreset !== 'dd35') continue } catch { continue }
  sessions += 1
  const localCall = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'tool/call') {
      const n = ev.data?.name ?? ev.data?.message?.name ?? '?'
      localCall.set(ev.data?.callId ?? ev.data?.id, n)
    }
    if (ev.type === 'assistant/message') {
      for (const b of (ev.data?.message?.content ?? [])) {
        historyBytes += B(b.text ?? '')
        if (b.type === 'tool-call') localCall.set(b.id, b.name)
      }
    }
    if (ev.type === 'user/message') for (const b of (ev.data?.message?.content ?? [])) historyBytes += B(b.text ?? '')
    if (ev.type === 'tool/result') {
      const msg = ev.data?.message ?? {}
      const size = (msg.content ?? []).reduce((a, b) => a + B(b.text), 0)
      results += 1; resultBytes += size
      const name = localCall.get(msg.toolCallId) ?? 'unknown'
      const e = perTool.get(name) ?? { n: 0, bytes: 0 }
      e.n += 1; e.bytes += size; perTool.set(name, e)
      biggest.push([size, name])
    }
  }
}
console.log(`dd35 sessions: ${sessions}`)
console.log(`tool/result events retained: ${results}`)
console.log(`their payload: ${resultBytes.toLocaleString()} B  (~${Math.round(resultBytes / 3.5).toLocaleString()} tokens)`)
console.log(`assistant+user text bytes: ${historyBytes.toLocaleString()}  (~${Math.round(historyBytes / 3.5).toLocaleString()} tokens)`)
console.log(`=> tool output is ${(100 * resultBytes / (resultBytes + historyBytes)).toFixed(1)}% of the provider-bound message bytes`)
console.log('\ntop tools by retained output:')
for (const [n, e] of [...perTool.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)) {
  console.log(`  ${String(e.n).padStart(5)}x  ${String(e.bytes).padStart(9)} B  ~${String(Math.round(e.bytes / 3.5)).padStart(7)} tok  avg ${Math.round(e.bytes / e.n)}B  ${n}`)
}
console.log('\nlargest single results:')
for (const [s, n] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 6)) console.log(`  ${String(s).padStart(7)} B  ${n}`)
