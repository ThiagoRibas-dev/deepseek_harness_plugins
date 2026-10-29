/**
 * Tool-call loop report for one harness session.
 *
 * Usage: node tmp/meridian/loop-report.mjs <session-id-or-suffix> [turns]
 *
 * Prints, per turn: steps, tool calls, wall time, and how many calls repeated a
 * signature already used in that turn. A healthy turn issues each signature a
 * handful of times; the looping turns measured on 2026-10-29 repeated one `read`
 * 34 times and one `grep` 37 times, which is the model re-asking for a result it
 * never received.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const needle = process.argv[2]
const showTurns = Number(process.argv[3] ?? 6)
if (!needle) {
  console.error('usage: node tmp/meridian/loop-report.mjs <session-id-or-suffix> [turns]')
  process.exit(2)
}

const root = '/root/.dsh/sessions'
const files = []
const walk = dir => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      const store = path.join(full, 'session.v4.jsonl.zstd')
      if (fs.existsSync(store)) files.push(store)
      else walk(full)
    }
  }
}
walk(root)

const targets = files.filter(file => file.includes(needle))
if (targets.length === 0) {
  console.error(`no session matching ${needle}`)
  process.exit(1)
}

for (const file of targets) {
  const events = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    .trim().split('\n').map(line => JSON.parse(line))
  const title = events.filter(e => e.type === 'session/title').at(-1)?.data?.title ?? '(untitled)'
  console.log(`\n${title}\n${file}\n`)

  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, start: event.time, end: undefined, steps: 0, calls: 0, repeats: 0, seen: new Map() }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'assistant/message') current.steps += 1
    if (event.type === 'tool/call') {
      current.calls += 1
      const signature = `${event.data.name} ${JSON.stringify(event.data.arguments)}`
      const count = (current.seen.get(signature) ?? 0) + 1
      current.seen.set(signature, count)
      if (count > 1) current.repeats += 1
    }
    if (event.type === 'turn/end') current.end = event.time
  }

  console.log('turn  steps  calls  repeats  wall(min)')
  for (const turn of turns.slice(-showTurns)) {
    const wall = turn.end === undefined ? NaN : (turn.end - turn.start) / 60_000
    console.log(
      `${String(turn.turn).padStart(4)}  ${String(turn.steps).padStart(5)}  ${String(turn.calls).padStart(5)}`
      + `  ${String(turn.repeats).padStart(7)}  ${wall.toFixed(1).padStart(9)}`,
    )
  }

  const repeated = turns.flatMap(turn => [...turn.seen.entries()].filter(([, count]) => count > 1))
  const worst = repeated
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
  if (worst.length > 0) {
    console.log('\nmost repeated signatures:')
    for (const entry of worst) console.log(`  ${String(entry.count).padStart(3)}x  ${entry.signature.replace(/\s+/g, ' ').slice(0, 110)}`)
  }
}
