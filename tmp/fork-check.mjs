/** What distinguishes the fork's failing turns from the parent's working ones. */
import { execFileSync } from 'node:child_process'
function load(p) {
  const t = execFileSync('zstdcat', [p], { maxBuffer: 1 << 30 }).toString('utf8')
  const evs = []
  for (const l of t.split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)) } catch {} }
  return evs
}
const B = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
for (const [name, file] of [
  ['PARENT', 'session-63c97e22-7036-4328-ac13-a8373ad19e29'],
  ['FORK  ', 'session-e72bd3ce-5cc9-4560-86ca-c70dd3ebed4f'],
]) {
  const evs = load(`${B}/${file}/session.v4.jsonl.zstd`)
  console.log(`===== ${name} =====`)
  // model used per turn
  const models = new Map()
  for (const e of evs) {
    const d = e.data ?? {}
    if (e.type === 'assistant/message') {
      const m = d.message?.source?.model ?? '-'
      const p = d.message?.source?.provider ?? '-'
      models.set(`${p}/${m}`, (models.get(`${p}/${m}`) ?? 0) + 1)
    }
  }
  console.log('  providers/models:', JSON.stringify([...models.entries()]))
  // model/selection events
  for (const e of evs) if (e.type === 'model/selection') console.log('  model/selection:', JSON.stringify(e.data).slice(0, 160))
  // tool ids on the LAST turn's calls, and on the first turn's
  const byTurn = new Map()
  for (const e of evs) {
    const d = e.data ?? {}
    if (e.type === 'tool/call') {
      if (!byTurn.has(d.turn)) byTurn.set(d.turn, [])
      byTurn.get(d.turn).push(`${d.name}:${String(d.callId).slice(0, 12)}`)
    }
  }
  const turns = [...byTurn.keys()].sort((a, b) => a - b)
  console.log('  first-turn call ids:', (byTurn.get(turns[0]) ?? []).slice(0, 2).join(' '))
  console.log('  last-turn  call ids:', (byTurn.get(turns.at(-1)) ?? []).slice(0, 2).join(' '))
  console.log('  request/header configs:')
  for (const e of evs) {
    const d = e.data ?? {}
    if (e.type !== 'request/header') continue
    console.log('    ', JSON.stringify({ provider: d.config?.provider, model: d.config?.model, turn: d.turn }).slice(0, 140))
  }
  console.log()
}
