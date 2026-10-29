/** Exact text of the repair notice and the following DM reply, with endings. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
const seen = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  const d = e.data ?? {}
  if (e.type !== 'assistant/message') continue
  const t = (d.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  if (d.turn === 4 && t.length > 0) seen.push({ turn: d.turn, step: d.step, len: t.length, text: t })
}
for (const m of seen) {
  console.log(`--- turn ${m.turn} step ${m.step}: ${m.len} chars`)
  console.log('HEAD:', JSON.stringify(m.text.slice(0, 120)))
  console.log('TAIL:', JSON.stringify(m.text.slice(-160)))
  console.log()
}
