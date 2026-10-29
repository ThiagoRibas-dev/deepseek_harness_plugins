/** Message-level order around the failing turn: role + block kinds. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
const from = Number(process.argv[3]), to = Number(process.argv[4])
let n = 0
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  const d = e.data ?? {}
  const turn = d.turn ?? e.turn
  if (turn < from || turn > to) continue
  if (e.type === 'turn/start') { console.log(`\n=== TURN ${turn} START`); continue }
  if (e.type === 'turn/end') { console.log(`=== TURN ${turn} END ${d.reason?.kind ?? ''} ${d.reason?.error?.code ?? ''}`); continue }
  if (e.type === 'step/start') { console.log(`  -- step ${d.step}`); continue }
  if (e.type === 'assistant/message' || e.type === 'user/message' || e.type === 'system/message') {
    const blocks = d.message?.content ?? []
    const kinds = blocks.map((b) => b.type === 'text' ? `text(${(b.text ?? '').length})` : b.type).join(' + ')
    console.log(`  ${String(++n).padStart(3)} ${e.type.padEnd(16)} src=${String(d.message?.source?.kind ?? '-').padEnd(16)} ${kinds}`)
  }
  if (e.type === 'tool/call') console.log(`      -> call ${d.name}`)
  if (e.type === 'tool/result') console.log(`      <- result ${(d.message?.content ?? []).map((b) => (b.text ?? '').length).join('')}B`)
}
