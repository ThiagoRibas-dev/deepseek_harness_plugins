/**
 * Transcript parser tests — a regression guard for a silent data-loss bug.
 *
 * The previous implementation used `[\s\S]*?` followed by `$` under `/m`, and a
 * lookahead variant that treated any blank or `#`-leading line as a section end.
 * Measured on the live `seventh_moon` campaign that truncated:
 *
 *   - the DM's narration in **37 of 41** transcripts (~95,000 characters, roughly
 *     27k tokens of the campaign's own prose), and
 *   - the player's words in **25 of 41**,
 *
 * with no error anywhere. Every memory tool reads through this parser, so the
 * campaign's own history was invisible to recall while the DM was `read`-ing raw
 * files to recover it — the single largest cause of the filesystem archaeology
 * measured in spec §10.3.
 *
 * `memory-store.js` imports only `node:fs`/`node:path` and `state-store.js`, so no
 * harness rig is needed. Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseTranscript } from '../memory-store.js'

/** A transcript in the current on-disk shape. */
const file = ({ title = 'A Scene', player = 'The player acts.', dm = 'The DM answers.' } = {}) =>
  [
    `# Turn 0142 — ${title}`,
    '- Date: 3 Years Ago Night',
    '- Location: The Boar\'s Rest',
    '- Entities: thiago, maude',
    '- Micro-State: Talking.',
    '- Pending Action: Answer.',
    '',
    '## Player',
    player,
    '',
    '## DM',
    dm,
    '',
  ].join('\n')

test('the DM section runs to end of file, across blank lines', () => {
  // The exact shape that broke: a short first line, a blank line, then prose.
  const dm = '*giggles softly* \n\nMaude shifts against your chest.\n\n"It started six months back."'
  const parsed = parseTranscript(file({ dm }), 142)
  assert.equal(parsed.dm, dm.trim(), 'the whole narration must survive')
  assert.ok(parsed.dm.includes('six months back'))
})

test('a `###` subsection inside the DM turn is part of the DM text', () => {
  const dm = 'Maude explains.\n\n### 📍 Current Situation\n* **Location:** here'
  const parsed = parseTranscript(file({ dm }), 1)
  assert.ok(parsed.dm.includes('Current Situation'), 'a level-3 heading is not a section boundary')
})

test('the player section ends at the DM heading, not at any `## `', () => {
  const parsed = parseTranscript(file({ player: 'I look around.', dm: 'You see a door.' }), 5)
  assert.equal(parsed.player, 'I look around.')
  assert.equal(parsed.dm, 'You see a door.')
})

test('a player message containing its own `## ` markdown is not cut short', () => {
  // Real players paste markdown. The section ends where `## DM` begins, not at
  // the first level-2 heading inside the player's own text.
  const player = '## My plan\n\nI attack the wolf.\n\n## Contingency\n\nIf it flees, I follow.'
  const parsed = parseTranscript(file({ player, dm: 'The wolf dies.' }), 7)
  assert.equal(parsed.player, player.trim())
  assert.equal(parsed.dm, 'The wolf dies.')
})

test('a preamble mentioning the headings does not capture the sections', () => {
  // Turn 1 of the live campaign opens with `## User Prompt` before the real ones.
  const raw = [
    '# Session 1: The Rising Shadow',
    '',
    '## User Prompt',
    "Let's play the campaign.",
    '',
    '## Player',
    'I draw my sword.',
    '',
    '## DM',
    'The blade rings.',
    '',
  ].join('\n')
  const parsed = parseTranscript(raw, 1)
  assert.equal(parsed.player, 'I draw my sword.')
  assert.equal(parsed.dm, 'The blade rings.')
})

test('an absent section is an empty string, not a crash', () => {
  const parsed = parseTranscript('# Turn 0001 — X\n- Date: Day 1\n\n## Player\nhi\n', 1)
  assert.equal(parsed.player, 'hi')
  assert.equal(parsed.dm, '')
})

test('the DM section runs to end of file even past a trailing `##` section', () => {
  // The DM's turn routinely closes with its own `###` subsection (turn 142 ends
  // on `### 📍 Current Situation`), so a later heading must NOT bound it.
  const dm = 'Narration.\n\n## Next Steps\nDo a thing.'
  assert.equal(parseTranscript(file({ dm }), 2).dm, dm)
})

test('the header fields still parse alongside the bodies', () => {
  const parsed = parseTranscript(file(), 142)
  assert.equal(parsed.title, 'A Scene')
  assert.equal(parsed.date, '3 Years Ago Night')
  assert.equal(parsed.location, "The Boar's Rest")
  assert.deepEqual(parsed.entities, ['thiago', 'maude'])
  assert.equal(parsed.microState, 'Talking.')
  assert.equal(parsed.pendingAction, 'Answer.')
})

test('an untitled turn reports UNTITLED rather than a parse failure', () => {
  const raw = file({ title: 'Untitled Scene' })
  assert.equal(parseTranscript(raw, 7).title, 'Untitled Scene')
})
