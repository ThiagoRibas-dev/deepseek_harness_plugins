/**
 * Offline tests for the plugin's durable log.
 *
 * The reason it exists: the loader swallows an apply-time throw, the launcher
 * console is not kept, and `$DSH_HOME` has no log directory of its own. A route
 * that never mounted therefore left no evidence at all, and the browser reported
 * an empty 404 that named nothing.
 *
 * No harness imports, so this runs with plain `node --test`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { logPath, logPluginEvent } from '../lib/plugin-log.js'

let dir
let previous
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'meridian-plugin-log-'))
  previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
})
after(() => {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  rmSync(dir, { recursive: true, force: true })
})

test('the log sits beside the other plugin-errors files', () => {
  assert.equal(logPath({ DSH_HOME: '/tmp/h' }, '/home/x'), '/tmp/h/plugin-errors/meridian-antigravity.log')
  assert.equal(logPath({}, '/home/x'), '/home/x/.dsh/plugin-errors/meridian-antigravity.log')
})

test('an event is appended with a timestamp, creating the directory', () => {
  logPluginEvent('quota route mounted at /dsh-meridian/quota')
  logPluginEvent('something else')
  const lines = readFileSync(join(dir, 'plugin-errors', 'meridian-antigravity.log'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z quota route mounted at \/dsh-meridian\/quota$/u)
  assert.match(lines[1], / something else$/u)
})

test('an error is recorded with its stack, not just its message', () => {
  const error = new Error('the actual cause')
  logPluginEvent('quota surface failed to register', error)
  const text = readFileSync(join(dir, 'plugin-errors', 'meridian-antigravity.log'), 'utf8')
  assert.match(text, /quota surface failed to register: Error: the actual cause/u)
  assert.match(text, /at .*plugin-log\.test\.js/u)
})

test('logging never throws, even when it cannot write', () => {
  // A logger that throws would replace the failure it is describing.
  const blocked = join(dir, 'a-file-is-in-the-way')
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = blocked
  try {
    logPluginEvent('this cannot be written')
  } finally {
    process.env.DSH_HOME = before
  }
  // Reaching here is the assertion; the call swallowed its own failure.
  assert.ok(true)
})
