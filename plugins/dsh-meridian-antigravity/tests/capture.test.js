/**
 * Offline tests for the opt-in request capture.
 *
 * The pure parts decide names and what to prune; the write itself is exercised
 * against a real temporary directory, because the failure that matters is the
 * one that must not fail the turn.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureFileName, filesToPrune, writeCapture } from '../lib/capture.js'

/** A fresh capture directory that is removed when the process exits. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ma-capture-'))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Directory entries, or none when the directory was never created. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

test('a capture name sorts by dispatch time', () => {
  const early = captureFileName(1791387614792, 'aaaa-bbbb')
  const late = captureFileName(1791388009339, 'cccc-dddd')
  assert.equal(early, '1791387614792-aaaa-bbbb.json')
  assert.ok(early < late, 'later dispatches must sort after earlier ones')
})

test('pruning keeps the newest captures and ignores foreign files', () => {
  const names = [
    '1791387614792-aaaa.json',
    'notes.txt',
    'report.json',
    '1791388009339-bbbb.json',
    '1791388054036-cccc.json',
    '.hidden',
  ]
  assert.deepEqual(filesToPrune(names, 3), [])
  assert.deepEqual(filesToPrune(names, 2), ['1791387614792-aaaa.json'])
  assert.deepEqual(filesToPrune(names, 1), ['1791387614792-aaaa.json', '1791388009339-bbbb.json'])
  // A cap that is missing or nonsense keeps nothing rather than deleting at random.
  const all = ['1791387614792-aaaa.json', '1791388009339-bbbb.json', '1791388054036-cccc.json']
  assert.deepEqual(filesToPrune(names, 0), all)
  assert.deepEqual(filesToPrune(names, undefined), all)
})

test('capture is a no-op when it is off, and writes the body when it is on', () => {
  const dir = join(tempDir(), 'bodies')
  const record = {
    time: 1791387614792,
    identity: 'aaaa-bbbb',
    logicalRequestHash: 'hash',
    session: 'session-test',
    model: 'gemini-3.8-flash-low',
    purpose: null,
    continuation: { results: 2, foreign: [] },
    bytes: 12,
    body: { model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: [] }] },
  }

  assert.equal(writeCapture({ captureRequestBodies: false, captureDir: dir }, record), undefined)
  assert.deepEqual(readdirSafe(dir), [], 'nothing may be written when capture is off')

  const file = writeCapture({ captureRequestBodies: true, captureDir: dir, captureMaxFiles: 50 }, record)
  assert.equal(file, join(dir, '1791387614792-aaaa-bbbb.json'))
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.identity, 'aaaa-bbbb')
  assert.equal(written.continuation.results, 2)
  assert.deepEqual(written.body.messages, [{ role: 'user', content: [] }])
})

test('the capture directory stays bounded', () => {
  const dir = tempDir()
  const connection = { captureRequestBodies: true, captureDir: dir, captureMaxFiles: 2 }
  for (const time of [1791387614792, 1791388009339, 1791388054036]) {
    writeCapture(connection, { time, identity: `id-${time}`, body: {} })
  }
  assert.deepEqual(readdirSafe(dir), [
    '1791388009339-id-1791388009339.json',
    '1791388054036-id-1791388054036.json',
  ])
})

test('a capture that cannot be written is reported, never thrown', () => {
  const dir = tempDir()
  const blocked = join(dir, 'not-a-directory')
  writeFileSync(blocked, 'x')
  const warnings = []
  const result = writeCapture(
    { captureRequestBodies: true, captureDir: blocked, captureMaxFiles: 2 },
    { time: 1, identity: 'id', body: {} },
    { warn: message => warnings.push(message) },
  )
  assert.equal(result, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /request capture failed/)
})
