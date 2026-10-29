/** Read-only: what the dd35 preset actually sends and which tools get called, from session logs. */
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const toolCalls = new Map()
let sessions = 0, steps = 0
const ctxSizes = [], sysSizes = [], toolCounts = []

for (const dir of readdirSync(ROOT)) {
  const f = join(ROOT, dir, 'session.v4.jsonl.zstd')
  let text
  try { text = execFileSync('zstdcat', [f], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  const first = text.split('\n', 1)[0]
  let meta; try { meta = JSON.parse(first) } catch { continue }
  if (meta.agentPreset !== 'dd35') continue
  sessions += 1

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'step/start') steps += 1
    // assistant tool calls
    if (ev.type === 'assistant/message') {
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? []
      for (const b of blocks) {
        if (b?.type === 'tool-call' || b?.type === 'tool_use') {
          const n = b.name ?? b.toolName ?? '?'
          toolCalls.set(n, (toolCalls.get(n) ?? 0) + 1)
        }
      }
    }
    if (ev.type === 'request/context') {
      const d = ev.data ?? {}
      if (Array.isArray(d.tools)) toolCounts.push(d.tools.length)
      // find system + total sizes in whatever shape is present
      const j = JSON.stringify(d)
      ctxSizes.push(Buffer.byteLength(j, 'utf8'))
    }
  }
}
const sum = (a) => a.reduce((x, y) => x + y, 0)
const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0
console.log('dd35 sessions:', sessions, '| step/start events:', steps)
console.log('\n=== tool calls observed ===')
const rows = [...toolCalls.entries()].sort((a, b) => b[1] - a[1])
console.log('distinct tools actually called:', rows.length)
for (const [n, c] of rows) console.log('  ' + String(c).padStart(5) + '  ' + n)
console.log('\ntotal tool calls:', sum([...toolCalls.values()]))
if (toolCounts.length) console.log('tools advertised per request: median', med(toolCounts), 'max', Math.max(...toolCounts))
