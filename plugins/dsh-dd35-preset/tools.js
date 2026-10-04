/**
 * D&D 3.5e Solo DM — native toolset.
 *
 * Registers the 10 oracle/generation/dice tools directly on the harness tool
 * registry (no external MCP server, no child process). Data lives beside this
 * file in `tables.json`, generated from `rules/dm_aids/tables/*.csv`.
 */
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dd35-tools'
export const inject = ['tools']

const TABLES = JSON.parse(readFileSync(new URL('./tables.json', import.meta.url), 'utf8'))

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// ---- dice ----
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function rollD20() { return randInt(1, 20) }
function rollD100() { return randInt(1, 100) }
function rollGeneric(x, y, keepHighest, dropLowest) {
  if (x <= 0 || y <= 0) return { error: 'X and Y must be positive integers.' }
  const rolls = Array.from({ length: x }, () => randInt(1, y))
  let kept = rolls.slice()
  if (dropLowest > 0 && dropLowest < kept.length) {
    kept.sort((a, b) => a - b)
    kept = kept.slice(dropLowest)
  }
  if (keepHighest > 0 && keepHighest < kept.length) {
    kept.sort((a, b) => b - a)
    kept = kept.slice(0, keepHighest)
  }
  return {
    notation: `${x}d${y}`,
    raw_rolls: rolls,
    kept_rolls: kept,
    total: kept.reduce((a, b) => a + b, 0),
  }
}

// ---- table helpers (mirror data_loader.py) ----
function table(name) { return TABLES[name] ?? [] }
function randomRow(name) {
  const rows = table(name)
  return rows[Math.floor(Math.random() * rows.length)]
}
function parseRange(value) {
  const str = String(value).trim()
  if (str.includes('-')) {
    const [a, b] = str.split('-').map((part) => parseInt(part.trim(), 10))
    return [a, b]
  }
  const v = parseInt(str, 10)
  return [v, v]
}
function lookupByRange(name, column, roll) {
  for (const row of table(name)) {
    const value = row[column]
    if (value === undefined) continue
    try {
      const [min, max] = parseRange(value)
      if (min <= roll && roll <= max) return row
    } catch { /* skip malformed row */ }
  }
  return null
}
function lookupByMinMax(name, minCol, maxCol, roll) {
  for (const row of table(name)) {
    const min = parseInt(row[minCol], 10)
    const max = parseInt(row[maxCol], 10)
    if (!Number.isNaN(min) && !Number.isNaN(max) && min <= roll && roll <= max) return row
  }
  return null
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'roll_solo_oracle',
    description:
      'Rolls on the Solo Oracle table to answer a Yes/No question for solo play. '
      + 'It automatically checks for Alternate Oracle Interrupts (a raw d20 roll of 1 or 20) '
      + 'before applying the likelihood modifier.',
    parameters: {
      question: { type: 'string', required: true, description: 'The Yes/No question to answer.' },
      likelihood_modifier: { type: 'integer', description: 'Shift the d20 result up (likely) or down (unlikely). Defaults to 0.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ question, likelihood_modifier = 0 }) {
      const rawRoll = rollD20()
      const isInterrupt = rawRoll === 1 || rawRoll === 20
      const interruptType = !isInterrupt ? null
        : rawRoll === 1 ? 'Combat/Negative Interrupt' : 'Random Event/Positive Interrupt'
      const modifiedRoll = rawRoll + likelihood_modifier
      const lookupVal = Math.max(1, Math.min(20, modifiedRoll))
      const row = lookupByMinMax('oracle_table.csv', 'MinRoll', 'MaxRoll', lookupVal)
      if (!row) return { error: `Failed to lookup Oracle result for roll ${lookupVal}` }
      return {
        question,
        raw_roll: rawRoll,
        modified_roll: modifiedRoll,
        answer: row['Nuance'],
        is_interrupt: isInterrupt,
        interrupt_type: interruptType,
        outcome_desc: row['Outcome'],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'draw_muse_prompt',
    description: 'Draws abstract word prompts from the Tarot-like muse tables.',
    parameters: {
      upright_only: { type: 'boolean', description: 'Draw both words from the upright table only. Defaults to false.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ upright_only = false }) {
      const roll1 = rollD20()
      const roll2 = rollD20()
      const file1 = 'muse_upright.csv'
      const file2 = upright_only ? 'muse_upright.csv' : 'muse_inverted.csv'
      const row1 = lookupByRange(file1, 'd20', roll1)
      const row2 = lookupByRange(file2, 'd20', roll2)
      const c1 = `Col${randInt(1, 4)}`
      const c2 = `Col${randInt(1, 4)}`
      return {
        word_1: row1 ? row1[c1] : 'Error',
        word_2: row2 ? row2[c2] : 'Error',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_plot_hook',
    description: 'Generates a random plot hook by rolling Objective, Adversary, and Reward.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return {
        objective: randomRow('plot_hook_generator.csv')['Objective'] ?? '',
        adversary: randomRow('plot_hook_generator.csv')['Adversaries'] ?? '',
        reward: randomRow('plot_hook_generator.csv')['Rewards'] ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_npc',
    description: 'Generates a random NPC with Identity, Goal, and Notable Feature.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return {
        identity: randomRow('npc_generator.csv')['Identity'] ?? '',
        goal: randomRow('npc_generator.csv')['Goal'] ?? '',
        notable_feature: randomRow('npc_generator.csv')['Notable_Feature'] ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'explore_dungeon_room',
    description: 'Generates a random dungeon room (location, encounter, object, exits).',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return {
        location: randomRow('dungeon_crawler.csv')['Location'] ?? '',
        encounter: randomRow('dungeon_crawler.csv')['Encounter'] ?? '',
        object: randomRow('dungeon_crawler.csv')['Object'] ?? '',
        exits: randomRow('dungeon_crawler.csv')['Total_Exits'] ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'explore_hex',
    description: 'Generates a random wilderness hex (terrain, contents, event).',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return {
        terrain: randomRow('hex_crawler.csv')['Terrain'] ?? '',
        contents: randomRow('hex_crawler.csv')['Contents'] ?? '',
        event: randomRow('hex_crawler.csv')['Event'] ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'draw_focus',
    description: "Draws a focus word. focus_type should be 'Action', 'Detail', or 'Topic'.",
    parameters: {
      focus_type: { type: 'string', required: true, enum: ['Action', 'Detail', 'Topic'], description: 'The focus table to draw from.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ focus_type }) {
      const col = `${focus_type[0].toUpperCase()}${focus_type.slice(1)}_Focus`
      return { focus_type, word: randomRow('focus_tables.csv')[col] ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'draw_keyword',
    description: 'Draws a random keyword from the 800-word vocabulary table.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      return { keyword: randomRow('keywords_table.csv')['Keyword'] ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_monster_ai',
    description:
      "Rolls for monster behavior. phase must be 'tactic' (initial encounter) or 'reaction' (mid-combat shift).",
    parameters: {
      phase: { type: 'string', required: true, enum: ['tactic', 'reaction'], description: 'Which monster table to roll on.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ phase }) {
      const roll = rollD100()
      const lower = phase.toLowerCase()
      const row = lower === 'tactic'
        ? lookupByRange('monster_intentions.csv', 'Range', roll)
        : lookupByRange('monster_reactions.csv', 'Range', roll)
      const key = lower === 'tactic' ? 'Tactic' : 'Reaction'
      if (!row) return { error: `Failed to lookup ${phase} for roll ${roll}` }
      return { phase, roll, action: row[key] ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roll_dice',
    description:
      'Rolls an arbitrary XdY dice pool with optional modifiers. '
      + 'x: number of dice; y: number of sides per die; '
      + 'keep_highest: keep only the N highest rolls (0 = keep all); '
      + 'drop_lowest: drop the N lowest rolls (0 = drop none).',
    parameters: {
      x: { type: 'integer', required: true, description: 'Number of dice.' },
      y: { type: 'integer', required: true, description: 'Number of sides on each die.' },
      keep_highest: { type: 'integer', description: 'Keep only the N highest rolls.' },
      drop_lowest: { type: 'integer', description: 'Drop the N lowest rolls.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ x, y, keep_highest = 0, drop_lowest = 0 }) {
      return rollGeneric(x, y, keep_highest, drop_lowest)
    },
  }))
}
