/**
 * D&D 3.5e DM — pure name generation subsystem.
 *
 * Backed by compiled static data from 12 reference corpora (`names-data.json`).
 * Pure module with zero runtime filesystem I/O: loads static data synchronously
 * at module initialization.
 *
 * Deterministic PRNG seeding via Mulberry32 algorithm with fallback to Math.random.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DATA = require('./names-data.json')

export const CHARACTER_CULTURES = Object.freeze([
  'dwarf',
  'elf',
  'halfling',
  'human_fantasy',
  'old_english',
  'medieval_english',
  'celtic',
  'nordic',
  'sanskrit',
  'tolkien',
  'le_guin',
  'donaldson',
  'howard',
  'martin',
])

export const PLACE_CATEGORIES = Object.freeze([
  'settlement',
  'realm',
  'ancestral',
  'terrain',
  'theme',
  'landmark',
])

export const TERRAINS = Object.freeze([
  'arctic',
  'coastal',
  'desert',
  'forest',
  'hill',
  'jungle',
  'lake',
  'mountain',
  'ocean',
  'plains',
  'river',
  'road',
  'swamp',
])

export const THEMES = Object.freeze([
  'beautiful',
  'civilized',
  'cultured',
  'dangerous',
  'haunted',
  'historical',
  'infernal',
  'magical',
  'militaristic',
  'monstrous',
  'oppressed',
  'poor',
  'religious',
  'rich',
  'safe',
  'underworld',
])

export const REALM_TYPES = Object.freeze([
  'generic',
  'good',
  'evil',
  'magical',
])

export const ANCESTRAL_CULTURES = Object.freeze([
  'dwarf',
  'elf',
  'halfling',
  'orc',
])

export const HOWARD_SUBCULTURES = Object.freeze([
  'keshan',
  'turan',
  'zingara',
  'shem',
  'nordheim',
  'cimmerian',
  'aquilonian',
  'stygian',
])

/**
 * 32-bit Mulberry32 PRNG.
 * @param {number|string} seed
 * @returns {() => number} Float in [0, 1)
 */
export function mulberry32(seed) {
  let state = (Number(seed) >>> 0) + 0x9e3779b9
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Clamp count strictly between 1 and 10.
 * @param {any} count
 * @returns {number}
 */
export function clampCount(count) {
  const parsed = Number.parseInt(count, 10)
  if (Number.isNaN(parsed)) return 1
  return Math.min(Math.max(parsed, 1), 10)
}

function pick(arr, rng) {
  if (!Array.isArray(arr) || arr.length === 0) return ''
  return arr[Math.floor(rng() * arr.length)]
}

function capitalize(str) {
  if (!str || typeof str !== 'string') return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Helper to resolve gender pool selection.
 */
function pickByGender(gender, obj, rng) {
  if (!obj) return ''
  const g = (gender || 'any').toLowerCase()
  if (g === 'female' && Array.isArray(obj.female) && obj.female.length > 0) {
    return pick(obj.female, rng)
  }
  if (g === 'male' && Array.isArray(obj.male) && obj.male.length > 0) {
    return pick(obj.male, rng)
  }
  // 'any' or fallback
  const hasFemale = Array.isArray(obj.female) && obj.female.length > 0
  const hasMale = Array.isArray(obj.male) && obj.male.length > 0
  if (hasFemale && hasMale) {
    return rng() < 0.5 ? pick(obj.female, rng) : pick(obj.male, rng)
  }
  if (hasFemale) return pick(obj.female, rng)
  if (hasMale) return pick(obj.male, rng)
  return ''
}

/**
 * Expand fantasy compound surname template.
 */
function generateFantasySurname(rng) {
  const hf = DATA.characters.human_fantasy
  const forms = hf.surname_forms
  const elements = hf.elements
  const form = pick(forms, rng) || '[NATURE] [Color]'

  const naturePool = [...elements.nature.element, ...elements.nature.environment, ...elements.nature.forest]
  const poetryPool = [...elements.poetry.destiny, ...elements.poetry.emotion, ...elements.poetry.cycle]
  const mundanePool = [...elements.mundane.weapon, ...elements.mundane.place, ...elements.mundane.farm]
  const creaturePool = [...elements.creature.monster, ...elements.creature.person, ...elements.creature.animal]
  const moralityPool = [...elements.morality.sinister, ...elements.morality.holy, ...elements.morality.color]
  const actor1Pool = [...elements.actor1.hurter, ...elements.actor1.doer, ...elements.actor1.feeler]
  const actor2Pool = [...elements.actor2.mover, ...elements.actor2.relater, ...elements.actor2.exister]
  const medievalPool = [...DATA.characters.human_historical.surnames_trade, ...DATA.characters.human_historical.surnames_locality]
  const colorPool = DATA.places.misc.colors

  const resolved = form
    .replace(/\[NATURE\]/g, () => pick(naturePool, rng))
    .replace(/\[POETRY\]/g, () => pick(poetryPool, rng))
    .replace(/\[MUNDANE\]/g, () => pick(mundanePool, rng))
    .replace(/\[CREATURE\]/g, () => pick(creaturePool, rng))
    .replace(/\[MORALITY\]/g, () => pick(moralityPool, rng))
    .replace(/\[Actor 1\]/g, () => pick(actor1Pool, rng))
    .replace(/\[Actor 2\]/g, () => pick(actor2Pool, rng))
    .replace(/\[Hurter\]/g, () => pick(elements.actor1.hurter, rng))
    .replace(/\[Animal\]/g, () => pick(elements.creature.animal, rng))
    .replace(/\[Color\]/g, () => pick(colorPool, rng))
    .replace(/\[MEDIEVAL\]/g, () => pick(medievalPool, rng))
    .trim()

  // If compound consists of two words with a space, join without space for a cohesive fantasy surname unless medieval
  const parts = resolved.split(/\s+/).filter(Boolean)
  if (parts.length === 2 && !form.includes('[MEDIEVAL]')) {
    return capitalize(parts[0]) + capitalize(parts[1].toLowerCase())
  }
  return parts.map(capitalize).join(' ')
}

/**
 * Generate a single character name.
 */
function generateOneCharacterName(culture, gender, surname, subculture, rng) {
  const chars = DATA.characters

  switch (culture) {
    case 'dwarf': {
      const d = chars.dwarf
      const firstName = rng() < 0.5
        ? pick(d.canon_first, rng)
        : pick(d.syllabic.start, rng) + pick(d.syllabic.end, rng)

      if (surname === false) return firstName

      const roll = rng()
      let lastName = ''
      if (roll < 0.45) {
        lastName = pick(d.clan_compounds.start, rng) + pick(d.clan_compounds.end, rng)
      } else if (roll < 0.75) {
        lastName = pick(d.clan_names, rng)
      } else {
        const byName = pick(d.by_names, rng)
        lastName = byName.startsWith('The ') ? byName : byName
      }
      return `${firstName} ${lastName}`
    }

    case 'elf': {
      const e = chars.elf
      const pre = pick(e.prefixes, rng)
      const mid = rng() < 0.5 ? pick(e.centers, rng) : ''
      const suf = pick(e.suffixes, rng)
      const firstName = `${pre}${mid}${suf}`

      if (surname === false) return firstName

      // Elven house name / by-name
      const housePre = pick(e.prefixes, rng)
      const houseSuf = pick(e.suffixes, rng)
      return `${firstName} ${housePre}${houseSuf}`
    }

    case 'halfling': {
      const h = chars.halfling
      const firstName = pickByGender(gender, h, rng)

      if (surname === false) return firstName

      const lastName = rng() < 0.5
        ? pick(h.surnames, rng)
        : pick(h.surname_compounds.start, rng) + pick(h.surname_compounds.end, rng)

      return `${firstName} ${lastName}`
    }

    case 'human_fantasy':
    case 'fantasy': {
      const hf = chars.human_fantasy
      const firstName = pick(hf.first_names, rng)

      if (surname === false) return firstName

      const lastName = generateFantasySurname(rng)
      return `${firstName} ${lastName}`
    }

    case 'old_english': {
      const oe = chars.human_historical.old_english
      const start = pick(oe.starts, rng)
      const end = pick(oe.ends, rng)
      const firstName = start.charAt(0).toUpperCase() + start.slice(1).toLowerCase() + end.toLowerCase()

      if (surname === false) return firstName

      const lastName = rng() < 0.5
        ? pick(chars.human_historical.surnames_locality, rng)
        : pick(chars.human_historical.surnames_trade, rng)

      return `${firstName} ${lastName}`
    }

    case 'medieval_english': {
      const me = chars.human_historical.medieval_english
      const firstName = pickByGender(gender, me, rng)

      if (surname === false) return firstName

      const lastName = rng() < 0.5
        ? pick(chars.human_historical.surnames_trade, rng)
        : pick(chars.human_historical.surnames_locality, rng)

      return `${firstName} ${lastName}`
    }

    case 'celtic': {
      const c = chars.human_historical.celtic
      const firstName = pickByGender(gender, c, rng)

      if (surname === false) return firstName

      const maleRoot = pick(c.male, rng)
      const prefix = rng() < 0.6 ? 'Mac' : "O'"
      return `${firstName} ${prefix}${maleRoot}`
    }

    case 'nordic': {
      const n = chars.human_historical.nordic
      const firstName = pickByGender(gender, n, rng)

      if (surname === false) return firstName

      const father = pick(n.male, rng)
      const g = (gender || 'any').toLowerCase()
      const suffix = (g === 'female' || (g === 'any' && rng() < 0.5)) ? 'sdottir' : 'sson'
      return `${firstName} ${father}${suffix}`
    }

    case 'sanskrit': {
      const s = chars.human_historical.sanskrit
      const firstName = pickByGender(gender, s, rng)

      if (surname === false) return firstName

      const secondName = pickByGender(gender, s, rng)
      return `${firstName} ${secondName}`
    }

    case 'tolkien': {
      const t = chars.authors.tolkien
      return pickByGender(gender, t, rng)
    }

    case 'le_guin': {
      return pick(chars.authors.le_guin, rng)
    }

    case 'donaldson': {
      return pick(chars.authors.donaldson, rng)
    }

    case 'howard': {
      const hw = chars.authors.howard
      let sub = subculture && HOWARD_SUBCULTURES.includes(subculture.toLowerCase())
        ? subculture.toLowerCase()
        : pick(HOWARD_SUBCULTURES, rng)

      const target = hw[sub]
      if (!target) return pick(chars.human_fantasy.first_names, rng)

      if (Array.isArray(target)) {
        return pick(target, rng)
      }
      return pickByGender(gender, target, rng)
    }

    case 'martin': {
      const m = chars.authors.martin
      // Graceful fallback: Martin Westeros dataset contains 0 female entries
      const g = (gender || 'any').toLowerCase()
      if (g === 'female' && m.female.length > 0) {
        return pick(m.female, rng)
      }
      return pick(m.male, rng)
    }

    default: {
      return pick(chars.human_fantasy.first_names, rng)
    }
  }
}

/**
 * Generate character names with determinism and count clamping.
 * @param {object} [options]
 * @returns {object}
 */
export function generateCharacterName(options = {}) {
  const {
    culture: rawCulture = 'human_fantasy',
    gender = 'any',
    surname = true,
    subculture,
    count = 1,
    seed,
  } = options

  const culture = String(rawCulture).toLowerCase() === 'fantasy' ? 'human_fantasy' : String(rawCulture).toLowerCase()
  const clampedCount = clampCount(count)
  const rng = (seed !== undefined && seed !== null) ? mulberry32(seed) : Math.random

  const names = []
  for (let i = 0; i < clampedCount; i++) {
    names.push(generateOneCharacterName(culture, gender, surname, subculture, rng))
  }

  const result = {
    culture,
    gender,
    count: names.length,
    names,
  }
  if (seed !== undefined && seed !== null) {
    result.seed = Number(seed)
  }
  return result
}

/**
 * Generate a single place name.
 */
function generateOnePlaceName(category, terrain, theme, realmType, ancestralCulture, rng) {
  const places = DATA.places

  switch (category) {
    case 'settlement': {
      const english = places.settlements_english
      let terrKey = (terrain || '').toLowerCase()
      if (terrKey === 'coastal') terrKey = 'coast'

      const pool = (terrKey && english[terrKey]) ? english[terrKey] : (rng() < 0.5 ? english.general : pick(Object.values(english), rng))
      const prefix = pick(pool.prefixes || english.general.prefixes, rng)
      const suffix = pick(pool.suffixes || english.general.suffixes, rng)
      let name = `${prefix}${suffix}`

      // 15% chance of directional prefix or modifier
      if (rng() < 0.15) {
        const mod = pick(['North', 'South', 'East', 'West', 'Upper', 'Lower', 'Great', 'Little', 'Old', 'New'], rng)
        name = `${mod} ${name}`
      }
      return name
    }

    case 'realm': {
      const r = places.realms
      const rKey = (realmType && r[realmType.toLowerCase()]) ? realmType.toLowerCase() : 'generic'
      const pool = r[rKey]
      const prefix = pick(pool.prefixes, rng)
      const center = rng() < 0.4 ? pick(pool.centers, rng) : ''
      const suffix = pick(pool.suffixes, rng)
      const base = `${prefix}${center}${suffix}`

      const roll = rng()
      if (roll < 0.15) return `Kingdom of ${base}`
      if (roll < 0.3) return `Realm of ${base}`
      return base
    }

    case 'ancestral': {
      const anc = places.ancestral
      const aKey = (ancestralCulture && anc[ancestralCulture.toLowerCase()]) ? ancestralCulture.toLowerCase() : 'dwarf'
      const pool = anc[aKey]
      const prefix = pick(pool.prefixes, rng)
      const suffix = pick(pool.suffixes, rng)
      if (pool.centers && rng() < 0.4) {
        const center = pick(pool.centers, rng)
        return `${prefix}${center}${suffix}`
      }
      return `${prefix}${suffix}`
    }

    case 'terrain': {
      const terrs = places.terrains
      let terrKey = (terrain || '').toLowerCase()
      if (!terrs[terrKey]) {
        terrKey = pick(TERRAINS, rng)
      }
      const tData = terrs[terrKey]
      const placesPool = tData.places && tData.places.length > 0 ? tData.places : tData.regions
      const placeTerm = pick(placesPool, rng)
      const themeKey = (theme && places.themes[theme.toLowerCase()]) ? theme.toLowerCase() : pick(THEMES, rng)
      const themeModifier = pick(places.themes[themeKey], rng) || 'Great'

      const roll = rng()
      if (roll < 0.4) {
        return `${themeModifier} ${placeTerm}`
      }
      if (roll < 0.75) {
        return `${placeTerm} of ${themeModifier}`
      }
      const color = pick(places.misc.colors, rng)
      return `The ${color} ${placeTerm}`
    }

    case 'theme': {
      const themes = places.themes
      const tKey = (theme && themes[theme.toLowerCase()]) ? theme.toLowerCase() : pick(THEMES, rng)
      const themeWord = pick(themes[tKey], rng) || 'Ancient'
      const randomTerrain = pick(TERRAINS, rng)
      const tData = places.terrains[randomTerrain]
      const placeTerm = pick(tData.places || tData.regions, rng) || 'Sanctuary'

      const roll = rng()
      if (roll < 0.5) return `${themeWord} ${placeTerm}`
      return `${placeTerm} of ${themeWord}`
    }

    case 'landmark': {
      const randomTerrain = (terrain && DATA.places.terrains[terrain.toLowerCase()])
        ? terrain.toLowerCase()
        : pick(TERRAINS, rng)
      const tData = DATA.places.terrains[randomTerrain]
      const placeTerm = pick(tData.places || tData.regions, rng) || 'Spur'

      const roll = rng()
      if (roll < 0.35) {
        const shape = pick(DATA.places.misc.shapes, rng)
        return `The ${shape} ${placeTerm}`
      }
      if (roll < 0.7) {
        const color = pick(DATA.places.misc.colors, rng)
        return `The ${color} ${placeTerm}`
      }
      const themeKey = pick(THEMES, rng)
      const mod = pick(DATA.places.themes[themeKey], rng)
      return `${mod} ${placeTerm}`
    }

    default: {
      return generateOnePlaceName('settlement', terrain, theme, realmType, ancestralCulture, rng)
    }
  }
}

/**
 * Generate fantasy place names with determinism and count clamping.
 * @param {object} [options]
 * @returns {object}
 */
export function generatePlaceName(options = {}) {
  const {
    category: rawCategory,
    type: rawType,
    terrain,
    theme,
    realm_type: realmType,
    ancestral_culture: ancestralCulture,
    count = 1,
    seed,
  } = options

  const categoryInput = rawCategory || rawType || 'settlement'
  const category = PLACE_CATEGORIES.includes(String(categoryInput).toLowerCase())
    ? String(categoryInput).toLowerCase()
    : 'settlement'

  const clampedCount = clampCount(count)
  const rng = (seed !== undefined && seed !== null) ? mulberry32(seed) : Math.random

  const names = []
  for (let i = 0; i < clampedCount; i++) {
    names.push(generateOnePlaceName(category, terrain, theme, realmType, ancestralCulture, rng))
  }

  const result = {
    category,
    count: names.length,
    names,
  }
  if (terrain) result.terrain = terrain
  if (theme) result.theme = theme
  if (realmType) result.realm_type = realmType
  if (ancestralCulture) result.ancestral_culture = ancestralCulture
  if (seed !== undefined && seed !== null) {
    result.seed = Number(seed)
  }
  return result
}
