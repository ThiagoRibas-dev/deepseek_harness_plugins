import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GUARD_DEFAULTS,
  measureInputChars,
  resolveGuardConfig,
  summaryText,
  validateSummary,
} from '../lib/summary-quality.js'

/** The exact artifact that shadowed seqs 9-1849 in session-293cca94. */
const INCIDENT_SUMMARY = [{ type: 'text', text: "I can't answer in a 1-token limit.\n" }]

/** A plausible substantive summary, comfortably above the default floor. */
const GOOD_SUMMARY = [{
  type: 'text',
  text: 'The session implemented a Meridian Antigravity connector plus a D&D 3.5e preset and a local TTS bundle. '
    + 'Work covered the fail-closed health gate, the account model catalogue, the content-addressed idempotency '
    + 'ledger, the SSE translator that holds tool blocks until message_stop, and an offline conformance suite that '
    + 'needs no live service. Open items were the tool-result pruner rewriting history mid-continuation, the '
    + 'compaction summary accepting a one-line non-answer for a 1840-event span, and a retry policy that re-sends a '
    + 'continuation the provider had already consumed. The next step was to guard compaction without modifying '
    + 'harness source.',
}]

const guard = resolveGuardConfig({})

test('the incident summary is rejected by the substance floor', () => {
  const verdict = validateSummary(INCIDENT_SUMMARY, {}, guard)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /below the 400-character floor/)
})

test('a substantive summary is accepted', () => {
  const verdict = validateSummary(GOOD_SUMMARY, {}, guard)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.text, GOOD_SUMMARY[0].text)
})

test('an empty or text-free summary is rejected', () => {
  assert.equal(validateSummary([], {}, guard).ok, false)
  assert.equal(validateSummary(undefined, {}, guard).ok, false)
  assert.equal(validateSummary([{ type: 'image', source: {} }], {}, guard).ok, false)
  assert.match(validateSummary([], {}, guard).reason, /no text/)
})

test('text length is measured after trimming', () => {
  // 399 characters of content plus surrounding whitespace must not pass a 400 floor.
  const body = 'x'.repeat(399)
  assert.equal(validateSummary([{ type: 'text', text: `\n\n${body}\n\n` }], {}, guard).ok, false)
  assert.equal(validateSummary([{ type: 'text', text: 'x'.repeat(400) }], {}, guard).ok, true)
})

test('the floor is inclusive at exactly minSummaryChars', () => {
  const tight = resolveGuardConfig({ minSummaryChars: 10 })
  assert.equal(validateSummary([{ type: 'text', text: 'x'.repeat(9) }], {}, tight).ok, false)
  assert.equal(validateSummary([{ type: 'text', text: 'x'.repeat(10) }], {}, tight).ok, true)
})

test('a repeat of the rejected summary is refused, stopping retry convergence', () => {
  const first = validateSummary(INCIDENT_SUMMARY, {}, guard)
  const second = validateSummary(INCIDENT_SUMMARY, { rejectedText: first.text }, guard)
  assert.equal(second.ok, false)
  // The repeat rule is reachable only once the floor is relaxed.
  const loose = resolveGuardConfig({ minSummaryChars: 0 })
  const a = validateSummary(INCIDENT_SUMMARY, {}, loose)
  const b = validateSummary(INCIDENT_SUMMARY, { rejectedText: a.text }, loose)
  assert.equal(b.ok, false)
  assert.match(b.reason, /identical to the previously rejected summary/)
})

// The substance floor runs before the optional rules by design, so each test
// below relaxes the floor to reach the rule it exercises.
test('rejectPatterns match on substring when configured', () => {
  const patterned = resolveGuardConfig({ minSummaryChars: 0, rejectPatterns: ["I can't answer"] })
  const verdict = validateSummary(INCIDENT_SUMMARY, {}, patterned)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /matches rejected pattern/)
})

test('the relative floor is inert at zero and active when set', () => {
  const text = [{ type: 'text', text: 'y'.repeat(100) }]
  const inert = resolveGuardConfig({ minSummaryChars: 0 })
  assert.equal(validateSummary(text, { inputChars: 100_000 }, inert).ok, true)
  const strict = resolveGuardConfig({ minSummaryChars: 0, minRatio: 0.5 })
  const verdict = validateSummary(text, { inputChars: 100_000 }, strict)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /0.5 of the 100000-character input/)
})

test('resolveGuardConfig repairs malformed input with defaults', () => {
  const resolved = resolveGuardConfig({
    minSummaryChars: -1,
    minRatio: 'nope',
    rejectPatterns: ['ok', '', 42],
    maxDegenerateRetries: 1.5,
  })
  assert.equal(resolved.minSummaryChars, GUARD_DEFAULTS.minSummaryChars)
  assert.equal(resolved.minRatio, GUARD_DEFAULTS.minRatio)
  assert.deepEqual(resolved.rejectPatterns, ['ok'])
  assert.equal(resolved.maxDegenerateRetries, GUARD_DEFAULTS.maxDegenerateRetries)
  assert.equal(Object.isFrozen(resolved), true)
})

test('summaryText joins multiple text blocks and ignores non-text', () => {
  const text = summaryText([
    { type: 'text', text: 'alpha' },
    { type: 'tool-call', id: 'x' },
    { type: 'text', text: 'beta' },
  ])
  assert.equal(text, 'alpha\nbeta')
})

test('measureInputChars counts only text blocks', () => {
  const chars = measureInputChars({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'abc' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'x' }, { type: 'text', text: 'de' }] },
      { role: 'user', content: [] },
    ],
  })
  assert.equal(chars, 5)
  assert.equal(measureInputChars(undefined), 0)
})
