/** Print the visible text of assistant/user messages for given turns. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
const want = new Set((process.argv[3] ?? '').split(',').map(Number))
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  const d = e.data ?? {}
  const turn = d.turn ?? e.turn
  if (!want.has(turn)) continue
  if (e.type !== 'assistant/message' && e.type !== 'user/message' && e.type !== 'system/message') continue
  const blocks = d.message?.content ?? d.content ?? []
  const body = blocks.map((b) => b.type === 'text' ? b.text : `<${b.type}:${b.name ?? ''}>`).join('\n')
  console.log(`--- ${e.type} turn=${turn} step=${d.step ?? '-'} src=${d.message?.source?.kind ?? '-'}`)
  console.log(body.slice(0, 700))
  console.log()
}
