#!/usr/bin/env node
/**
 * Read the Meridian request captures for one session and say what the connector
 * actually put on the wire.
 *
 * Usage: node tmp/meridian/wire-report.mjs [session-id-suffix]
 *   With no argument, the session with the newest capture.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '/root/.dsh/meridian-capture'

/**
 * The recovery retry is the only body that carries this placeholder, so its
 * presence marks a dispatch Meridian refused and the connector re-sent. A new
 * turn that follows a continuation is also +2 messages with `cont=null`, which is
 * why the message count cannot be used for this.
 */
const PLACEHOLDER = 'Recovering from transcript conflict.'
const NOTICE_PREFIX = '[model changed:'

const blocksOf = message => (Array.isArray(message?.content) ? message.content : [])
const textsOf = message => blocksOf(message).filter(b => b?.type === 'text').map(b => String(b.text ?? ''))
const carriesPlaceholder = record => record.body.messages.some(
  message => textsOf(message).some(text => text.trim() === PLACEHOLDER),
)

/** Indices of messages whose text begins with the injected notice marker. */
const noticeAt = (record) => {
  const found = []
  record.body.messages.forEach((message, index) => {
    if (textsOf(message).some(text => text.startsWith(NOTICE_PREFIX))) found.push(index)
  })
  return found
}

const conversationTag = (key) => {
  if (typeof key !== 'string') return '(none)'
  const at = key.indexOf('#')
  return at === -1 ? 'pinned' : key.slice(at)
}

const clock = time => new Date(time).toISOString().slice(11, 19)

const all = readdirSync(DIR)
  .map(name => JSON.parse(readFileSync(join(DIR, name), 'utf8')))
  .filter(record => Array.isArray(record?.body?.messages))

if (all.length === 0) {
  console.error('no captures in', DIR)
  process.exit(1)
}

const suffix = process.argv[2]
const target = suffix === undefined
  ? all.reduce((newest, record) => (record.time > newest.time ? record : newest), all[0]).session
  : all.find(record => record.session.endsWith(suffix))?.session

if (target === undefined) {
  console.error('no capture for a session ending in', suffix)
  process.exit(1)
}

const rows = all.filter(record => record.session === target).sort((a, b) => a.time - b.time)

console.log(`session ${target}`)
console.log(`captures ${rows.length}\n`)
console.log('  time      msgs cont  conversation notice  kind  last')
for (const record of rows) {
  const notices = noticeAt(record)
  console.log(
    `  ${clock(record.time)} ${String(record.body.messages.length).padStart(5)}`
    + ` ${String(record.continuation === null ? '-' : record.continuation.results).padStart(4)}`
    + `  ${conversationTag(record.body.meridian_session_key).padEnd(12)}`
    + ` ${String(notices.length === 0 ? 'no' : `YES@${notices.join(',')}`).padEnd(6)}`
    + `  ${carriesPlaceholder(record) ? 'retry' : '     '}`
    + ` ${record.body.messages.at(-1)?.role ?? '?'}`,
  )
}

const retries = rows.filter(carriesPlaceholder)
const keys = new Set(rows.map(record => record.body.meridian_session_key))
const exposed = rows.filter(record => noticeAt(record).length > 0)
const nonUserTail = rows.filter(record => record.body.messages.at(-1)?.role !== 'user')

console.log('\nsummary')
console.log(`  dispatches                ${rows.length}`)
console.log(`  recovery retries          ${retries.length}${retries.length === 0 ? '' : ` at ${retries.map(r => clock(r.time)).join(', ')}`}`)
console.log(`  distinct conversations    ${keys.size} (${[...keys].map(conversationTag).join(', ')})`)
console.log(`  bodies with a notice      ${exposed.length}${exposed.length === 0 ? '' : ` at ${exposed.map(r => clock(r.time)).join(', ')}`}`)
console.log(`  bodies not ending in user ${nonUserTail.length}`)

const verdict = []
if (retries.length > 0) verdict.push(`${retries.length} refusal(s) recovered by a retry — read those bodies before believing a cause`)
if (exposed.length > 0) verdict.push('a notice reached the wire — the filter did not drop it')
if (nonUserTail.length > 0) verdict.push('a body ended on a non-user turn — Meridian may reject it')
console.log(verdict.length === 0
  ? '\n  no refusal, no notice, every body ends on a user turn'
  : `\n  ${verdict.join('\n  ')}`)
