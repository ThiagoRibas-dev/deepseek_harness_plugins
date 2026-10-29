/** What files does the DM read/bash during play? Read-only. */
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const paths = new Map(), bashCmds = []
for (const dir of readdirSync(ROOT)) {
  let text
  try { text = execFileSync('zstdcat', [join(ROOT, dir, 'session.v4.jsonl.zstd')], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  try { if (JSON.parse(text.split('\n', 1)[0]).agentPreset !== 'dd35') continue } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant/message') continue
    for (const b of (ev.data?.message?.content ?? ev.data?.content ?? [])) {
      if (b?.type !== 'tool-call' && b?.type !== 'tool_use') continue
      const args = b.args ?? b.input ?? {}
      if (b.name === 'read' && args.file_path) {
        // keep the tail (campaign-relative) to group by file
        const p = String(args.file_path).replace(/^.*?\/D&D35\//, '')
        paths.set(p, (paths.get(p) ?? 0) + 1)
      }
      if (b.name === 'bash' && args.command) bashCmds.push(String(args.command).slice(0, 110))
    }
  }
}
const tot = [...paths.values()].reduce((a, b) => a + b, 0)
console.log('=== read targets (top 22 of ' + paths.size + ' distinct, ' + tot + ' total reads) ===')
for (const [p, c] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log('  ' + String(c).padStart(5) + '  ' + p)
console.log('\n=== bash commands: shape (top 15 of ' + bashCmds.length + ') ===')
const norm = new Map()
for (const c of bashCmds) { const k = c.split(/\s+/).slice(0, 3).join(' '); norm.set(k, (norm.get(k) ?? 0) + 1) }
for (const [k, c] of [...norm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('  ' + String(c).padStart(5) + '  ' + k)
