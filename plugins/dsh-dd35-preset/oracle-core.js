/**
 * D&D 3.5e DM — oracle logic, with no harness dependency.
 *
 * Spec: `docs/dd35-future-improvements.md` FI-18, FI-19, FI-20.
 *
 * This module is pure: it reads `tables.json` through `tables.js` and returns
 * plain data. It registers nothing and imports nothing from the harness, so the
 * prompt builder can consult it for the scene-change injection without pulling a
 * tool-registering module onto the assembly path — the same layering that keeps
 * `state-store.js` free of `state.js`'s tool definitions.
 *
 * The tool surface lives in `oracles.js`.
 */
import { rollD20, rollD100, randInt } from './dice.js'
import {
  DEFAULT_VECTOR_SET, VECTOR_TABLES, drawVector, rowAt, rowByRange, seededRandom, table,
} from './tables.js'

// Re-exported so the tool layer has one import site for oracle concepts, and so a
// test never needs to know which of the two files a constant lives in.
export { DEFAULT_VECTOR_SET, VECTOR_TABLES }

/**
 * The largest shift `ask_oracle` will apply.
 *
 * The matrix says "likely / unlikely", which is ±2 on a d20. The shipped tool
 * accepted ±20 while the model also chose the question, so the model could walk
 * the result to whatever it had already decided — an oracle that can be steered
 * to a predetermined answer is decoration, not a decision procedure.
 */
export const MAX_LIKELIHOOD = 2

/**
 * Canonical option sets, recovering the oracles the matrix specified but that
 * were never built (`get_random_dc`, `trigger_gm_move`, `roll_magic_effect`).
 *
 * **Draw mechanism, and why it is not uniform across the table.** Most of these
 * tables carry a printed range column, but measurement shows the ranges do not
 * cover their die:
 *
 *   | table | rows | die coverage |
 *   | :--- | ---: | ---: |
 *   | `monster_intentions` | 10 | 100 / 100 |
 *   | `boon_table` | 29 | 58 / 100 |
 *   | `bane_table` | 50 | 55 / 100 |
 *   | `monster_reactions` | 6 | 21 / 100 |
 *
 * and the ranges that exist are shuffled and overlapping, so lookup order decides
 * the result. A range lookup therefore either finds nothing (the shipped
 * `roll_monster_behavior` returns null on **79 of 100** mid-combat rolls) or
 * silently misweights the row it does find. Only `monster_intentions` is
 * complete, so it — and the `dc_difficulty` index — keep their printed ranges;
 * everything else draws a row uniformly, which is honest and cannot fail.
 */
export const PRESETS = Object.freeze({
  solo: {
    kind: 'ranged',
    table: 'oracle_table.csv',
    range: 'MinRoll',
    maxRange: 'MaxRoll',
    value: 'Nuance',
    die: 20,
    interrupts: true,
    detail: { outcome: 'Outcome' },
    description: 'Yes/no with nuance. A raw natural 1 or 20 is an interrupt, checked before any modifier.',
  },
  gm_move_pacing: {
    kind: 'uniform',
    table: 'gm_moves.csv',
    value: 'Pacing_Moves',
    description: 'A move that advances the action when the scene has stalled.',
  },
  gm_move_failure: {
    kind: 'uniform',
    table: 'gm_moves.csv',
    value: 'Failure_Moves',
    description: 'A move that pushes the story forward after the party fails.',
  },
  magic_boon: {
    kind: 'uniform',
    table: 'boon_table.csv',
    value: 'Name',
    detail: { effect: 'Description' },
    description: 'A random boon: a blessing, charm or reward.',
  },
  magic_bane: {
    kind: 'uniform',
    table: 'bane_table.csv',
    value: 'Name',
    detail: { effect: 'Description' },
    description: 'A random bane: a curse or misfortune.',
  },
  monster_tactic: {
    kind: 'ranged',
    table: 'monster_intentions.csv',
    range: 'Range',
    value: 'Tactic',
    die: 100,
    description: "A monster's opening behaviour at the start of an encounter.",
  },
  monster_reaction: {
    kind: 'uniform',
    table: 'monster_reactions.csv',
    value: 'Reaction',
    description: 'A shift in behaviour mid-combat.',
  },
  random_dc: {
    kind: 'dc',
    table: 'dc_difficulty.csv',
    die: 6,
    description: 'A Difficulty Class for an unexpected challenge. Pass level: low | mid | high.',
  },
})

const clamp = (value) => Math.max(-MAX_LIKELIHOOD, Math.min(MAX_LIKELIHOOD, value))

/** Resolve one preset to a concrete outcome. */
export function resolvePreset(key, { likelihoodModifier = 0, level = 'mid', random = Math.random } = {}) {
  const preset = PRESETS[key]
  if (preset === undefined) {
    return { error: `unknown preset "${key}"`, known_presets: Object.keys(PRESETS) }
  }

  if (preset.kind === 'dc') {
    const column = level === 'low' ? 'Low Level' : level === 'high' ? 'High Level' : 'Mid Level'
    const roll = randInt(1, preset.die)
    const row = table(preset.table)[roll - 1]
    if (!row) return { error: `no ${preset.table} row for a d${preset.die} roll of ${roll}` }
    return { preset: key, roll, die: preset.die, level, dc: row[column] ?? null }
  }

  if (preset.kind === 'uniform') {
    const roll = randInt(1, 100)
    const row = rowAt(preset.table, random)
    if (row === null) return { error: `${preset.table} is empty` }
    const detail = {}
    for (const [label, column] of Object.entries(preset.detail ?? {})) detail[label] = row[column] ?? null
    return { preset: key, roll, result: row[preset.value] ?? null, ...detail }
  }

  // kind: 'ranged' — a table whose printed ranges fully cover its die.
  const modifier = clamp(likelihoodModifier)
  const raw = preset.die === 100 ? rollD100() : (preset.die === 20 ? rollD20() : randInt(1, preset.die))

  // Interrupts are read off the RAW roll, before the modifier — moving the odds
  // must not be able to move the interrupt, or "likely" would suppress a natural 1.
  if (preset.interrupts === true) {
    const isInterrupt = raw === 1 || raw === 20
    const interrupt = !isInterrupt ? null
      : raw === 1 ? 'Combat/Negative Interrupt' : 'Random Event/Positive Interrupt'
    // The table covers 1..20, so the shifted roll has to be clamped back into it.
    const lookup = Math.max(1, Math.min(preset.die, raw + modifier))
    const { row, matched } = rowByRange(preset.table, preset.range, lookup, preset.maxRange ?? null)
    if (!matched) return { error: `no ${preset.table} row covers a roll of ${lookup}` }
    return {
      preset: key,
      raw_roll: raw,
      modified_roll: lookup,
      likelihood_modifier: modifier,
      answer: row[preset.value] ?? null,
      is_interrupt: isInterrupt,
      interrupt_type: interrupt,
      ...(preset.detail ? { outcome: row[preset.detail.outcome] ?? null } : {}),
    }
  }

  const { row, matched } = rowByRange(preset.table, preset.range, raw, preset.maxRange ?? null)
  if (!matched) return { error: `no ${preset.table} row covers a roll of ${raw}` }
  const detail = {}
  for (const [label, column] of Object.entries(preset.detail ?? {})) detail[label] = row[column] ?? null
  return { preset: key, roll: raw, die: preset.die, result: row[preset.value] ?? null, ...detail }
}

/** Draw the default or requested vector set. */
export function consult({ vectors, tables, uprightOnly = false, random = Math.random }) {
  const requested = Array.isArray(tables) && tables.length > 0
    ? tables
    : (Number.isInteger(vectors) && vectors > 0
      ? [...Array(vectors).fill('keywords'), 'action', 'detail', 'topic', 'muse']
      : [...DEFAULT_VECTOR_SET])

  const refused = requested.filter((key) => key !== 'muse' && VECTOR_TABLES[key] === undefined)
  if (refused.length > 0) {
    return {
      error: `not a vector table: ${refused.join(', ')}`,
      vector_tables: Object.keys(VECTOR_TABLES),
      why: 'Multi-vector draws are only valid on single-vector tables. A coherent-row table '
        + '(plot_hook_generator, dungeon_crawler, hex_crawler, npc_generator) must be drawn once '
        + 'and read whole, or its columns stop relating to each other.',
    }
  }

  const drawn = []
  for (const key of requested) {
    const result = drawVector(key, { uprightOnly, random })
    if (result !== null && result.value !== null) drawn.push(result)
  }
  return { vectors: drawn }
}

/**
 * Coherent-row tables: the columns describe **one thing** and must be read
 * together. One roll, never more — drawing twice is what made the shipped
 * generators incoherent.
 */
export const COHERENT_TABLES = Object.freeze({
  plot_hook: 'plot_hook_generator.csv',
  dungeon_room: 'dungeon_crawler.csv',
  hex: 'hex_crawler.csv',
  npc: 'npc_generator.csv',
})

/** Columns that carry a die result rather than content, or nothing at all. */
const RESULT_COLUMN = /^(Roll|d20|d6|d12|Range|MinRoll|MaxRoll|Card_Value|D6_Roll|null|undefined|)$/

/**
 * Draw one whole row from a coherent-row table.
 *
 * Every content column of the chosen row is returned together, because they
 * belong together: `plot_hook_generator` row 3 is
 * *Recover something valuable / Guardians / Knowledge and secrets*. The shipped
 * `generate_plot_hook` drew each of those three fields from a **different** row,
 * so the objective, its adversary and its reward were unrelated to each other.
 */
export function drawCoherent(key) {
  const name = COHERENT_TABLES[key]
  if (name === undefined) {
    return { error: `not a coherent-row table: ${key}`, coherent_tables: Object.keys(COHERENT_TABLES) }
  }
  const row = rowAt(name)
  if (row === null) return { error: `${name} is empty` }
  const fields = {}
  let roll = null
  for (const [column, value] of Object.entries(row)) {
    if (RESULT_COLUMN.test(column)) { roll = value; continue }
    fields[column] = value
  }
  return { coherent: key, table: name, roll, fields }
}

/**
 * A deterministic consultation, for injection rather than for asking.
 *
 * The scene-change injector renders per *step*, so it cannot use `Math.random`:
 * the vectors would change on every step of the same scene. Seeding from the turn
 * number makes the draw stable within the turn, fresh across turns, and
 * reproducible from `(seed)` alone — nothing has to be persisted to reproduce it.
 *
 * The DM's own `consult_oracle` call stays genuinely random.
 */
export function consultOracle({ seed, vectors, tables, uprightOnly = false } = {}) {
  return consult({ vectors, tables, uprightOnly, random: seededRandom(seed ?? 0) })
}
