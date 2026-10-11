/**
 * D&D 3.5e DM — the oracle tools.
 *
 * Spec: `docs/dd35-future-improvements.md` FI-18, FI-19.
 *
 * Two tools, because they answer two different questions:
 *
 *   - **`ask_oracle`** — one random choice, from options the DM supplies or from a
 *     canonical preset. Returns what came up and does not narrate.
 *   - **`consult_oracle`** — inspiration. Either several *independent* vectors,
 *     or one whole row of a table whose columns belong together.
 *
 * The logic lives in `oracle-core.js`; this file is only the tool surface.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randInt } from './dice.js'
import {
  COHERENT_TABLES, MAX_LIKELIHOOD, PRESETS, VECTOR_TABLES, consult, consultOracle,
  drawCoherent, resolvePreset,
} from './oracle-core.js'

export const name = 'dd35-oracles'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const clamp = (value) => Math.max(-MAX_LIKELIHOOD, Math.min(MAX_LIKELIHOOD, value))

/** Register the two oracle tools. */
export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'ask_oracle',
    description:
      'Ask the oracle one random question and get one answer. Two ways to use it. '
      + 'Pass `options` when you can enumerate the possible outcomes yourself — '
      + '["the guard helps", "refuses", "calls for backup"] — and it picks one at random, flat. '
      + 'Pass `preset` for a canonical table: solo (yes/no with nuance and interrupts), '
      + 'gm_move_pacing, gm_move_failure, magic_boon, magic_bane, random_dc, monster_tactic, monster_reaction. '
      + 'The roll is always returned raw, and `likelihood_modifier` is capped at ±2 — enough for '
      + '"likely" or "unlikely", not enough to steer the result to a predetermined answer. '
      + 'This tool does not narrate; interpreting the answer is yours.',
    parameters: {
      question: { type: 'string', description: 'What is being asked. Recorded with the result.' },
      options: { type: 'json', description: 'JSON array of possible outcomes, chosen from uniformly at random.' },
      preset: { type: 'string', enum: Object.keys(PRESETS), description: 'A canonical option set instead of your own.' },
      likelihood_modifier: { type: 'integer', description: `Shift the roll for a solo question, "likely" (+) or "unlikely" (-). Capped at ±${MAX_LIKELIHOOD}.` },
      level: { type: 'string', enum: ['low', 'mid', 'high'], description: 'Party level category, for preset "random_dc". Defaults to mid.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ question, options, preset, likelihood_modifier = 0, level }) {
      if (Array.isArray(options) && options.length > 0) {
        const clamped = clamp(likelihood_modifier)
        const roll = randInt(1, options.length)
        return {
          ...(question === undefined ? {} : { question }),
          options: options.length,
          roll,
          ...(clamped === 0 ? {} : { likelihood_modifier: clamped, note: 'options are drawn uniformly; the modifier applies to preset rolls only' }),
          answer: options[roll - 1],
          odds: `1 in ${options.length}`,
        }
      }
      if (typeof preset === 'string') {
        return { ...(question === undefined ? {} : { question }), ...resolvePreset(preset, { likelihoodModifier: likelihood_modifier, level }) }
      }
      return {
        error: 'ask_oracle needs either `options` (your own list) or `preset` (a canonical table).',
        known_presets: Object.keys(PRESETS),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'consult_oracle',
    description:
      'Draw inspiration. Two modes, and the distinction matters. '
      + '**Vectors** (default): pulls several deliberately UNRELATED words — a few keywords, an '
      + 'action/detail/topic trio, a muse word — and reconciling them into what happens next is your job. '
      + '**Coherent** (`coherent`): rolls ONE row of a table whose columns describe a single thing, so a plot hook '
      + 'arrives with its objective, adversary and reward all belonging to each other. Use it to generate a whole '
      + 'plot hook, dungeon room, hex or incidental NPC in one roll. '
      + 'Returns drawn values and nothing else; it does not narrate.',
    parameters: {
      coherent: { type: 'string', enum: Object.keys(COHERENT_TABLES), description: 'Draw one whole row from a table whose columns belong together.' },
      vectors: { type: 'integer', description: 'How many keywords to draw. Defaults to 3.' },
      tables: { type: 'json', description: `JSON array restricting the draw, from: ${Object.keys(VECTOR_TABLES).join(', ')}, muse.` },
      upright_only: { type: 'boolean', description: 'Draw the muse word from the upright table only.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ coherent, vectors, tables, upright_only = false }) {
      if (typeof coherent === 'string') return drawCoherent(coherent)
      return consult({ vectors, tables, uprightOnly: upright_only })
    },
  }))
}

export {
  COHERENT_TABLES, MAX_LIKELIHOOD, PRESETS, VECTOR_TABLES, consult, consultOracle,
  drawCoherent, resolvePreset,
}
