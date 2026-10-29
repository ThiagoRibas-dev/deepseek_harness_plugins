/** Per-session: turns, errored turns, and how the surface ends. */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const dirs = readdirSync(ROOT).map((d) => join(ROOT, d, 'session.v4.jsonl.zstd'))
const rows = []
for (const f of dirs) {
  let text
  try { text = execFileSync('zstdcat', [f], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  const evs = []
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)) } catch {} }
  const meta = evs[0] ?? {}
  if (meta.agentPreset !== 'dd35') continue
  let errors = 0, lastReason = null, lastCode = null, dangling = 0
  const callIds = new Set(), resultIds = new Set()
  for (const e of evs) {
    const d = e.data ?? {}
    if (e.type === 'tool/call') callIds.add(d.callId)
    if (e.type === 'tool/result') resultIds.add(d.message?.source?.callId ?? d.callId)
    if (e.type === 'turn/end') {
      lastReason = d.reason?.kind ?? null
      lastCode = d.reason?.error?.code ?? null
      if (d.reason?.kind === 'error') errors += 1
    }
  }
  for (const c of callIds) if (!resultIds.has(c)) dangling += 1
  rows.push({ id: meta.id?.slice(-8), parent: Boolean(meta.parentSession), turns: evs.filter((e) => e.type === 'turn/end').length, errors, lastReason, lastCode, dangling, mtime: 0 })
}
rows.sort((a, b) => b.errors - a.errors || b.turns - a.turns)
console.log('dd35 sessions:', rows.length)
console.log('sessions with >=1 errored turn:', rows.filter((r) => r.errors > 0).length)
console.log()
console.log('id       fork turns err  lastReason            lastCode                    dangling')
for (const r of rows.slice(0, 12)) {
  console.log(`${r.id}  ${r.parent ? 'Y' : 'n'}   ${String(r.turns).padStart(3)}  ${String(r.errors).padStart(3)}  ${String(r.lastReason).padEnd(20)} ${String(r.lastCode).padEnd(26)} ${r.dangling}`)
}
