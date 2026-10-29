/** Read-only: tool usage, file reads, and real context sizes from dd35 session logs. */
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const ROOT = '/root/.dsh/sessions/--export-DownloadsSSD-Projects-Writing-TTRPG-D~0026D35--'
const calls = new Map(), reads = new Map(), bash = [], usage = []
for (const dir of readdirSync(ROOT)) {
  let text
  try { text = execFileSync('zstdcat', [join(ROOT, dir, 'session.v4.jsonl.zstd')], { maxBuffer: 1 << 30 }).toString('utf8') } catch { continue }
  try { if (JSON.parse(text.split('\n', 1)[0]).agentPreset !== 'dd35') continue } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'assistant/message') {
      if (ev.data?.usage?.inputTokens) usage.push(ev.data.usage)
      for (const b of (ev.data?.message?.content ?? [])) {
        if (b?.type !== 'tool-call') continue
        calls.set(b.name, (calls.get(b.name) ?? 0) + 1)
        let a = {}; try { a = JSON.parse(b.arguments ?? '{}') } catch {}
        if (b.name === 'read' && a.file_path) {
          const p = String(a.file_path).replace(/^.*?\/D&D35\//, '')
          reads.set(p, (reads.get(p) ?? 0) + 1)
        }
        if (b.name === 'bash' && a.command) bash.push(String(a.command).slice(0, 100))
      }
    }
  }
}
const PRESET = ['roll_solo_oracle','draw_muse_prompt','generate_plot_hook','generate_npc','explore_dungeon_room','explore_hex','draw_focus','draw_keyword','roll_monster_behavior','roll_dice','roll_check','roll_attack','init_combat','next_turn','next_round','adjust_initiative','end_combat','apply_damage','heal','apply_condition','remove_condition','tick_conditions','add_combatant','remove_combatant','get_state','set_mode','update_scene','route_turn','create_campaign','create_entity','list_campaigns','set_active_campaign','get_entity','update_entity','grep_memories','fetch_memories','list_memories','lookup_rule','get_monster','get_spell','get_class','get_monster_ai','roll_save']
let presetCalls = 0, otherCalls = 0
console.log('=== PRESET tools: called vs never called ===')
const used = [], unused = []
for (const t of PRESET) { const c = calls.get(t) ?? 0; presetCalls += c; (c ? used : unused).push([t, c]) }
used.sort((a, b) => b[1] - a[1])
console.log('USED (' + used.length + ' of ' + PRESET.length + '):')
for (const [t, c] of used) console.log('  ' + String(c).padStart(5) + '  ' + t)
console.log('NEVER CALLED (' + unused.length + '):')
console.log('  ' + unused.map(([t]) => t).join(', '))
console.log('\n=== non-preset tools (harness built-ins) ===')
for (const [t, c] of [...calls.entries()].filter(([t]) => !PRESET.includes(t)).sort((a, b) => b[1] - a[1])) { otherCalls += c; console.log('  ' + String(c).padStart(5) + '  ' + t) }
console.log('\npreset calls:', presetCalls, '| non-preset calls:', otherCalls)
console.log('\n=== read targets (top 20 of ' + reads.size + ') ===')
for (const [p, c] of [...reads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log('  ' + String(c).padStart(5) + '  ' + p)
if (usage.length) {
  const inp = usage.map((u) => u.inputTokens).sort((a, b) => a - b)
  const cr = usage.map((u) => u.cacheReadTokens ?? 0)
  console.log('\n=== context size per inference (n=' + usage.length + ') ===')
  console.log('  input tokens: median', inp[Math.floor(inp.length / 2)], '| p90', inp[Math.floor(inp.length * 0.9)], '| max', inp.at(-1))
  console.log('  cache-read tokens: median', cr.sort((a, b) => a - b)[Math.floor(cr.length / 2)])
}

// ---- schema cost (static: what the tool definitions cost on every request) ----
{
  const files = ['tools.js', 'mechanics.js', 'state.js', 'memory.js', 'reference.js']
  let total = 0, n = 0
  for (const f of files) {
    const src = readFileSync(join('plugins/dsh-dd35-preset', f), 'utf8')
    for (const part of src.split(/ctx\.tools\.register/).slice(1)) {
      const nm = part.match(/name:\s*'([^']+)'/); if (!nm) continue
      n += 1
      const desc = part.match(/description:\s*\n?\s*'([\s\S]*?)',\n/)
      const ps = part.indexOf('parameters:'); const pe = part.indexOf('output:', ps)
      const pb = ps >= 0 ? part.slice(ps, pe > ps ? pe : ps + 1200) : ''
      total += Buffer.byteLength(nm[1] + (desc ? desc[1] : '') + pb, 'utf8')
    }
  }
  console.log(`\n=== advertised tool schemas (static) ===`)
  console.log(`  tools: ${n} | ~${total} B | ~${Math.round(total / 3.5)} tokens per request`)
}
