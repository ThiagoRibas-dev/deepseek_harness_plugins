/** Sessions whose recent turns are all refusal notices. */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const rows = []
for (const d of readdirSync(ROOT)) {
  const f = join(ROOT, d, 'session.v4.jsonl.zstd')
  let text
  try { text = execFileSync('zstdcat', [f], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  const evs = []
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)) } catch {} }
  if (evs[0]?.agentPreset !== 'dd35') continue
  const turns = []
  for (const e of evs) {
    const x = e.data ?? {}
    if (e.type === 'turn/end') turns.push({ turn: x.turn, kind: x.reason?.kind, code: x.reason?.error?.code })
  }
  const notices = evs.filter((e) => e.type === 'assistant/message'
    && ((e.data?.message?.content ?? []).some((b) => b.type === 'text' && (b.text ?? '').startsWith('[Meridian Antigravity]')))).length
  const lastTurn = turns.at(-1)
  rows.push({ id: (evs[0].id ?? '').slice(-8), fork: Boolean(evs[0].parentSession), turns: turns.length, notices, lastKind: lastTurn?.kind, lastCode: lastTurn?.code ?? '' })
}
const stuck = rows.filter((r) => r.notices >= 3)
console.log('dd35 sessions:', rows.length, '| with >=3 notices:', stuck.length)
console.log()
console.log('id       fork turns notices lastCode')
for (const r of rows.sort((a, b) => b.notices - a.notices).slice(0, 14)) {
  console.log(`${r.id}  ${r.fork ? 'Y' : 'n'}   ${String(r.turns).padStart(3)}  ${String(r.notices).padStart(5)}   ${r.lastCode}`)
}
