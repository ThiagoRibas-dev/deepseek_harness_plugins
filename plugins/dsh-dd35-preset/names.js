/**
 * D&D 3.5e DM — name generation tools.
 *
 * Spec: `docs/dd35/handoff.md`.
 * Backed by pure generators in `names-core.js` and compiled data in `names-data.json`.
 *
 * Two tools:
 *   - `generate_character_name`: generates first/last names across 14 cultures and author styles.
 *   - `generate_place_name`: generates settlements, realms, ancestral holds, terrain/theme landmarks.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ANCESTRAL_CULTURES,
  CHARACTER_CULTURES,
  HOWARD_SUBCULTURES,
  PLACE_CATEGORIES,
  REALM_TYPES,
  TERRAINS,
  THEMES,
  generateCharacterName,
  generatePlaceName,
} from './names-core.js'

export const name = 'dd35-names'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Register the two name generation tools. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'generate_character_name',
    description:
      'Generate authentic character names for D&D 3.5e NPCs and PCs across 14 racial, historical, '
      + 'and fantasy author traditions (Tolkien, Le Guin, Donaldson, Howard, Martin). '
      + 'Supports gendered options, surname/clan toggle, Hyborian sub-cultures, deterministic seeding, '
      + 'and clamped batch generation (1 to 10 names).',
    parameters: {
      culture: {
        type: 'string',
        enum: CHARACTER_CULTURES,
        description: 'Cultural or stylistic tradition. Defaults to human_fantasy.',
      },
      gender: {
        type: 'string',
        enum: ['any', 'female', 'male'],
        description: 'Gender presentation for cultures with gendered name pools. Defaults to any.',
      },
      surname: {
        type: 'boolean',
        description: 'Whether to include a surname, clan name, or by-name where applicable. Defaults to true.',
      },
      subculture: {
        type: 'string',
        enum: HOWARD_SUBCULTURES,
        description: 'Hyborian nation/culture when culture is "howard".',
      },
      count: {
        type: 'integer',
        description: 'Number of names to generate (clamped between 1 and 10). Defaults to 1.',
      },
      seed: {
        type: 'integer',
        description: 'Optional integer seed for deterministic generation using Mulberry32 PRNG.',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ culture, gender, surname, subculture, count = 1, seed }) {
      return generateCharacterName({ culture, gender, surname, subculture, count, seed })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_place_name',
    description:
      'Generate evocative fantasy location names across settlements (medieval English roots), '
      + 'realms (good, evil, magical, generic), ancestral holds (dwarven, elven, halfling, orcish), '
      + 'terrain features (13 terrain types), and themed landmarks (14 atmospheric themes). '
      + 'Supports deterministic seeding and clamped batch generation (1 to 10 names).',
    parameters: {
      category: {
        type: 'string',
        enum: PLACE_CATEGORIES,
        description: 'Type of place: settlement, realm, ancestral, terrain, theme, or landmark. Defaults to settlement.',
      },
      terrain: {
        type: 'string',
        enum: TERRAINS,
        description: 'Terrain type for terrain-linked settlements, terrain features, or landmarks.',
      },
      theme: {
        type: 'string',
        enum: THEMES,
        description: 'Atmospheric theme for theme-based or modified place names.',
      },
      realm_type: {
        type: 'string',
        enum: REALM_TYPES,
        description: 'Flavor of realm when category is "realm" (generic, good, evil, magical). Defaults to generic.',
      },
      ancestral_culture: {
        type: 'string',
        enum: ANCESTRAL_CULTURES,
        description: 'Racial origin when category is "ancestral" (dwarf, elf, halfling, orc). Defaults to dwarf.',
      },
      count: {
        type: 'integer',
        description: 'Number of names to generate (clamped between 1 and 10). Defaults to 1.',
      },
      seed: {
        type: 'integer',
        description: 'Optional integer seed for deterministic generation using Mulberry32 PRNG.',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ category, terrain, theme, realm_type, ancestral_culture, count = 1, seed }) {
      return generatePlaceName({
        category,
        terrain,
        theme,
        realm_type,
        ancestral_culture,
        count,
        seed,
      })
    },
  }))
}

export {
  ANCESTRAL_CULTURES,
  CHARACTER_CULTURES,
  HOWARD_SUBCULTURES,
  PLACE_CATEGORIES,
  REALM_TYPES,
  TERRAINS,
  THEMES,
  generateCharacterName,
  generatePlaceName,
}
