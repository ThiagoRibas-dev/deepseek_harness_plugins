/** Walk a session in order, printing turn/step boundaries and tool pairing. */
import { execFileSync } from 'node:child_process'
const text = execFileSync('zstdcat', [process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8')
const evs = []
for (const line of text.split('\n')) { if (!line.trim()) continue; try { evs.push(JSON.parse(line)) } catch {} }

for (const e of evs) {
  const d = e.data ?? {}
  switch (e.type) {
    case 'turn/start': console.log(`\nTURN ${d.turn ?? e.turn} START`); break
    case 'turn/end': console.log(`TURN ${d.turn ?? e.turn} END reason=${JSON.stringify(d.reason)}`); break
    case 'step/start': console.log(`  step ${d.step ?? e.step} start`); break
    case 'step/end': console.log(`  step ${d.step ?? e.step} end`); break
    case 'tool/call': console.log(`    CALL  ${d.callId?.slice(-8)} ${d.name} (t${d.turn}s${d.step})`); break
    case 'tool/result': {
      const id = d.message?.source?.callId ?? d.callId
      const txt = (d.message?.content ?? []).map((b) => b.text ?? '').join('')
      console.log(`    RESULT ${String(id).slice(-8)} (t${d.turn}s${d.step}) ${txt.length}B err=${d.message?.isError ?? false}`)
      break
    }
    case 'compaction/prune': console.log(`    !! PRUNE ${JSON.stringify(d).slice(0, 140)}`); break
    case 'assistant/message': {
      const blocks = d.message?.content ?? []
      const kinds = blocks.map((b) => b.type).join(',')
      console.log(`  ASSISTANT (t${d.turn}s${d.step}) [${kinds}]`)
      break
    }
    case 'user/message': console.log(`  USER (t${d.turn}s${d.step})`); break
    case 'agent/inbox/spliced': console.log(`  INBOX SPLICED (t${d.turn}s${d.step})`); break
    case 'assistant/attempt': console.log(`  ATTEMPT ${JSON.stringify(d).slice(0, 120)}`); break
    case 'session/end-seed': console.log('  SESSION END-SEED'); break
  }
}
