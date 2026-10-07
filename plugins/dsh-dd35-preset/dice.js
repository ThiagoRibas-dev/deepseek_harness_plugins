/**
 * D&D 3.5e DM — the single dice engine.
 *
 * Every roll in the preset goes through this module: the oracle tables, combat,
 * initiative, damage expressions, and the check/attack tools. Before it existed
 * the same arithmetic was written twice — `rollGeneric` in `tools.js` and
 * `rollExpression` in `mechanics.js` — which meant two definitions of "a d20
 * roll" and two places to fix a keep/drop bug.
 *
 * Pure functions over `Math.random` only: no `node:fs`, no harness imports, so
 * the engine is exercisable with no module rig (see `tests/roll.test.mjs`).
 */

/** Uniform integer in [min, max], inclusive. */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** One d20. */
export function rollD20() { return randInt(1, 20) }

/** One d100, for the roll-under behaviour tables. */
export function rollD100() { return randInt(1, 100) }

/**
 * Roll an XdY pool, optionally dropping the lowest and/or keeping the highest.
 *
 * Drop-then-keep, and `raw_rolls` always reports the order the dice came up in,
 * never the sorted one, so a caller can show the player what was rolled.
 * @param x - number of dice.
 * @param y - sides per die.
 * @param options - `keepHighest` and `dropLowest`, both 0 to keep everything.
 * @returns `{ notation, raw_rolls, kept_rolls, total }`, or `{ error }` for invalid input.
 */
export function rollPool(x, y, { keepHighest = 0, dropLowest = 0 } = {}) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) {
    return { error: 'X and Y must be positive integers.' }
  }
  const rawRolls = Array.from({ length: x }, () => randInt(1, y))
  let kept = rawRolls.slice()
  if (dropLowest > 0 && dropLowest < kept.length) {
    kept = kept.slice().sort((a, b) => a - b).slice(dropLowest)
  }
  if (keepHighest > 0 && keepHighest < kept.length) {
    kept = kept.slice().sort((a, b) => b - a).slice(0, keepHighest)
  }
  return {
    notation: `${x}d${y}`,
    raw_rolls: rawRolls,
    kept_rolls: kept,
    total: kept.reduce((sum, n) => sum + n, 0),
  }
}

/**
 * Parse and roll a damage expression: `"1d8+5"`, `"2d6"`, `"1d10-1"`, or a flat number.
 * @param expr - the expression to roll.
 * @returns `{ expr, rolls, dice, bonus, total }`.
 * @throws when the expression is not a dice expression or a number.
 */
export function rollExpression(expr) {
  const cleaned = String(expr).replace(/\s+/g, '')
  const match = cleaned.match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (match) {
    const count = match[1] === '' ? 1 : Number.parseInt(match[1], 10)
    const sides = Number.parseInt(match[2], 10)
    const bonus = match[3] ? Number.parseInt(match[3], 10) : 0
    const rolls = Array.from({ length: count }, () => randInt(1, sides))
    const dice = rolls.reduce((sum, n) => sum + n, 0)
    return { expr: cleaned, rolls, dice, bonus, total: dice + bonus }
  }
  const flat = Number.parseInt(cleaned, 10)
  if (!Number.isNaN(flat)) return { expr: cleaned, rolls: [], dice: 0, bonus: flat, total: flat }
  throw new Error(`Unsupported damage expression: ${expr}`)
}

/**
 * The success fields a roll total carries when resolved against a DC.
 * @returns `{ dc, success, margin }`, ready to spread onto a result object.
 */
export function againstDc(total, dc) {
  return { dc, success: total >= dc, margin: total - dc }
}
