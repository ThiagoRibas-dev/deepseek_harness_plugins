import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULTS,
  classify,
  renderMessage,
  resolveConfig,
} from '../lib/pressure.js'

const settings = resolveConfig({})

test('the warn band sits below compaction\'s own trigger', () => {
  assert.equal(settings.warnRatio, 0.75)
  // compaction-basic's thresholdRatio defaults to 0.8; the nudge must precede it.
  assert.ok(settings.warnRatio < 0.8)
})

test('a first crossing warns, a second does not', () => {
  assert.equal(classify(0.8, false, settings), 'warn')
  assert.equal(classify(0.8, true, settings), 'none')
})

test('the threshold is inclusive at warnRatio', () => {
  assert.equal(classify(0.7499, false, settings), 'none')
  assert.equal(classify(0.75, false, settings), 'warn')
})

test('below warnRatio but above rearmRatio leaves the state alone', () => {
  // Still inside the episode: no new nudge, and no re-arm either.
  assert.equal(classify(0.7, true, settings), 'none')
  assert.equal(classify(0.7, false, settings), 'none')
})

test('dropping below rearmRatio re-arms only a warned session', () => {
  assert.equal(classify(0.5, true, settings), 'rearm')
  assert.equal(classify(0.5, false, settings), 'none')
  assert.equal(classify(0.59, true, settings), 'rearm')
  assert.equal(classify(0.6, true, settings), 'none')
})

test('a re-arm band at or above the warn band cannot cause per-step nudging', () => {
  const tight = resolveConfig({ warnRatio: 0.5, rearmRatio: 0.9 })
  assert.ok(tight.rearmRatio < tight.warnRatio)
  // One warn, then silence for the rest of the episode.
  assert.equal(classify(0.9, false, tight), 'warn')
  assert.equal(classify(0.9, true, tight), 'none')
  assert.equal(classify(0.95, true, tight), 'none')
})

test('a non-finite ratio never warns', () => {
  assert.equal(classify(Number.NaN, false, settings), 'none')
  assert.equal(classify(Number.POSITIVE_INFINITY, false, settings), 'none')
})

test('renderMessage fills known placeholders and leaves unknown ones', () => {
  assert.equal(
    renderMessage('at {percent}% of {window} ({used} used)', { percent: 75, window: 200000, used: 150000 }),
    'at 75% of 200000 (150000 used)',
  )
  assert.equal(renderMessage('{typo} here', { percent: 1 }), '{typo} here')
  assert.equal(renderMessage('no placeholders', {}), 'no placeholders')
})

test('the default message is generic and mentions no preset-specific tool', () => {
  const rendered = renderMessage(DEFAULTS.message, { percent: 75, used: 1, window: 2 })
  assert.match(rendered, /75%/)
  assert.doesNotMatch(rendered, /campaign|oracle|memory/i)
})

test('resolveConfig repairs malformed input', () => {
  assert.deepEqual(
    { warnRatio: resolveConfig({}).warnRatio, rearmRatio: resolveConfig({}).rearmRatio },
    { warnRatio: DEFAULTS.warnRatio, rearmRatio: DEFAULTS.rearmRatio },
  )
  const repaired = resolveConfig({ warnRatio: 5, rearmRatio: 'x', message: '   ' })
  assert.equal(repaired.warnRatio, DEFAULTS.warnRatio)
  assert.equal(repaired.rearmRatio, DEFAULTS.rearmRatio)
  assert.equal(repaired.message, DEFAULTS.message)
  assert.equal(Object.isFrozen(repaired), true)
})

test('a configured message is kept verbatim', () => {
  assert.equal(resolveConfig({ message: 'custom {percent}' }).message, 'custom {percent}')
})
