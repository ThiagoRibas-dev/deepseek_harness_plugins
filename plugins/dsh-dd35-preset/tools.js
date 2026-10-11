/**
 * D&D 3.5e Solo DM — native toolset.
 *
 * One tool remains here: the generic dice engine, which nothing else replaces.
 *
 * The oracle, generator and inspiration tools that used to live in this file have
 * moved to `oracles.js` (spec: `docs/dd35-future-improvements.md` FI-18, FI-19),
 * and the table read path they shared is now `tables.js`. The move was not
 * cosmetic — four of the retired generators called `randomRow()` once **per
 * field** on the same table, so a dungeon room's location, encounter, object and
 * exits each came from a different row and had nothing to do with one another.
 * `consult_oracle({ coherent: … })` draws one whole row instead.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { againstDc, rollPool } from './dice.js'

export const name = 'dd35-tools'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'roll_dice',
    description:
      'Roll a dice pool: x dice with y sides each, optionally keeping the highest and/or dropping the lowest, '
      + 'then add a modifier and optionally resolve against a DC. This is the single generic roll — use it for '
      + 'damage, random tables, and ad-hoc rulings. For a named saving throw, skill or ability check, or an '
      + 'opposed contest, use roll_check; for an attack, use roll_attack.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Number of dice.' },
      y: { type: 'integer', required: true, description: 'Number of sides on each die.' },
      modifier: { type: 'integer', description: 'Added to the kept total. Defaults to 0.' },
      dc: { type: 'integer', description: 'When given, also returns success and margin (total >= DC succeeds).' },
      kind: { type: 'string', description: 'Label for the roll, e.g. "4d6 drop lowest" or "fireball damage".' },
      note: { type: 'string', description: 'Free-text context echoed back.' },
      keep_highest: { type: 'integer', description: 'Keep only the N highest rolls.' },
      drop_lowest: { type: 'integer', description: 'Drop the N lowest rolls.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ x, y, modifier = 0, dc, kind, note, keep_highest = 0, drop_lowest = 0 }) {
      const pool = rollPool(x, y, { keepHighest: keep_highest, dropLowest: drop_lowest })
      if (pool.error !== undefined) return pool
      const total = pool.total + modifier
      const result = {
        kind: kind ?? pool.notation,
        notation: pool.notation,
        raw_rolls: pool.raw_rolls,
        kept_rolls: pool.kept_rolls,
        modifier,
        total,
      }
      if (note !== undefined) result.note = note
      // A natural 20 or 1 is only a critical when a single d20 came up.
      if (x === 1 && y === 20) {
        if (pool.kept_rolls[0] === 20) result.critical = 'success'
        else if (pool.kept_rolls[0] === 1) result.critical = 'failure'
      }
      if (dc !== undefined) Object.assign(result, againstDc(total, dc))
      return result
    },
  }))
}
