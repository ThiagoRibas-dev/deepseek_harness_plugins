/**
 * D&D 3.5e DM — reference and compendium lookups.
 *
 * Fast indexed lookups into the local SRD compendium and rules tree:
 *   - rules/ (180+ markdown files across combat, actions, magic, conditions, etc.)
 *   - compendium/monsters/ (970+ monsters categorized by CR)
 *   - compendium/spells/ (4,600+ spells indexed alphabetically and homebrew)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bounded, configure, workspace } from './state-store.js'

/** Register a tool whose reference paths bind to the calling session's workspace. */
const define = (tool) => defineTool({ ...tool, execute: bounded(tool.execute) })

export const name = 'dd35-reference'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function normalize(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function slugify(str) {
  return normalize(str).replace(/\s+/g, '-')
}

// ---- in-memory indexes (lazily populated) ---------------------------------

let rulesIndex = null
let monstersIndex = null
let spellsIndex = null
let classesIndex = null
let cacheRoot = null

/**
 * Drop every index when the bound workspace moves, so a session in another
 * folder never reads the previous folder's tree.
 */
function ensureRoot(root) {
  if (cacheRoot === root) return
  cacheRoot = root
  rulesIndex = null
  monstersIndex = null
  spellsIndex = null
  classesIndex = null
}

function getRulesIndex(root) {
  ensureRoot(root)
  if (rulesIndex) return rulesIndex
  const rulesDir = join(root, 'rules')
  const index = []
  if (!existsSync(rulesDir)) return index
  const categories = readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  for (const cat of categories) {
    const dir = join(rulesDir, cat)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const rawName = file.slice(0, -3)
      index.push({
        category: cat,
        file,
        rawName,
        normName: normalize(rawName),
        slug: slugify(rawName),
        path: join('rules', cat, file),
        absPath: join(dir, file),
      })
    }
  }
  rulesIndex = index
  return index
}

function getMonstersIndex(root) {
  ensureRoot(root)
  if (monstersIndex) return monstersIndex
  const monstersDir = join(root, 'compendium', 'monsters')
  const index = []
  if (!existsSync(monstersDir)) return index
  const crDirs = readdirSync(monstersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  for (const crDir of crDirs) {
    const dir = join(monstersDir, crDir)
    const crClean = crDir.replace(/^cr_/, '')
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const rawName = file.slice(0, -3)
      index.push({
        cr: crClean,
        crDir,
        file,
        name: rawName,
        normName: normalize(rawName),
        path: join('compendium', 'monsters', crDir, file),
        absPath: join(dir, file),
      })
    }
  }
  monstersIndex = index
  return index
}

function getSpellsIndex(root) {
  ensureRoot(root)
  if (spellsIndex) return spellsIndex
  const spellsDir = join(root, 'compendium', 'spells')
  const index = []
  if (!existsSync(spellsDir)) return index
  const letterDirs = readdirSync(spellsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  for (const letter of letterDirs) {
    const dir = join(spellsDir, letter)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const rawName = file.slice(0, -3)
      index.push({
        folder: letter,
        file,
        name: rawName,
        normName: normalize(rawName),
        path: join('compendium', 'spells', letter, file),
        absPath: join(dir, file),
      })
    }
  }
  spellsIndex = index
  return index
}

function getClassesIndex(root) {
  ensureRoot(root)
  if (classesIndex) return classesIndex
  const classesDir = join(root, 'compendium', 'classes')
  const index = []
  if (!existsSync(classesDir)) return index
  for (const file of readdirSync(classesDir)) {
    if (!file.endsWith('.md')) continue
    const rawName = file.slice(0, -3)
    index.push({
      file,
      name: rawName,
      normName: normalize(rawName),
      path: join('compendium', 'classes', file),
      absPath: join(classesDir, file),
    })
  }
  classesIndex = index
  return index
}

export function apply(ctx, config = {}) {
  configure(config)
  // Reset caches so a reload or a different workspace re-indexes.
  rulesIndex = null
  monstersIndex = null
  spellsIndex = null
  classesIndex = null

  ctx.tools.register(define({
    name: 'lookup_rule',
    description:
      'Look up a D&D 3.5e rule, action, combat condition, or mechanic from the rules/ compendium. '
      + 'Returns the verbatim rule text and summary. Use when adjudicating grapple, attacks of opportunity, cover, concealment, etc.',
    parameters: {
      query: { type: 'string', required: true, description: 'Rule name or topic (e.g. \"grapple\", \"attacks-of-opportunity\", \"blinded\").' },
      category: { type: 'string', description: 'Optional category: actions, combat, conditions, magic, environment, skills, basics.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ query, category }) {
      const root = workspace()
      const index = getRulesIndex(root)
      const qNorm = normalize(query)
      const qSlug = slugify(query)

      const matches = index.filter((entry) => {
        if (category && entry.category.toLowerCase() !== category.toLowerCase()) return false
        return (
          entry.slug === qSlug
          || entry.normName === qNorm
          || entry.slug.includes(qSlug)
          || entry.normName.includes(qNorm)
        )
      })

      if (matches.length === 0) {
        return {
          found: false,
          query,
          category: category ?? null,
          message: `No rules found matching "${query}". Check categories with list_reference_categories.`,
        }
      }

      // Exact match prioritised
      const exact = matches.find((m) => m.slug === qSlug || m.normName === qNorm) || matches[0]

      if (matches.length === 1 || exact.slug === qSlug || exact.normName === qNorm) {
        const content = readFileSync(exact.absPath, 'utf8')
        return {
          found: true,
          title: exact.rawName,
          category: exact.category,
          path: exact.path,
          content,
          other_matches: matches.length > 1 ? matches.slice(1, 6).map((m) => `${m.category}/${m.rawName}`) : [],
        }
      }

      return {
        found: true,
        query,
        count: matches.length,
        candidates: matches.slice(0, 10).map((m) => ({
          title: m.rawName,
          category: m.category,
          path: m.path,
        })),
        hint: 'Call lookup_rule with the exact title or category to view the full text.',
      }
    },
  }))

  ctx.tools.register(define({
    name: 'get_monster',
    description:
      'Look up a monster or NPC stat block by name or list monsters by Challenge Rating (CR) from compendium/monsters/.',
    parameters: {
      name: { type: 'string', description: 'Monster name (e.g. \"Ankheg\", \"Goblin\", \"Bat\").' },
      cr: { type: 'string', description: 'Filter or list by Challenge Rating (e.g. \"1\", \"3\", \"under_1\").' },
      limit: { type: 'integer', description: 'Max results when listing by CR (defaults to 20).' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ name: monsterName, cr, limit = 20 }) {
      const root = workspace()
      const index = getMonstersIndex(root)

      if (monsterName) {
        const qNorm = normalize(monsterName)
        const matches = index.filter((entry) => {
          if (cr && entry.cr !== String(cr).replace(/^cr_/, '')) return false
          return entry.normName === qNorm || entry.normName.includes(qNorm)
        })

        if (matches.length === 0) {
          return { found: false, name: monsterName, cr: cr ?? null, message: `No monster found matching "${monsterName}".` }
        }

        const exact = matches.find((m) => m.normName === qNorm) || matches[0]
        if (matches.length === 1 || exact.normName === qNorm) {
          const content = readFileSync(exact.absPath, 'utf8')
          return {
            found: true,
            name: exact.name,
            cr: exact.cr,
            path: exact.path,
            content,
            other_matches: matches.length > 1 ? matches.slice(1, 6).map((m) => `${m.name} (CR ${m.cr})`) : [],
          }
        }

        return {
          found: true,
          name: monsterName,
          count: matches.length,
          candidates: matches.slice(0, limit).map((m) => ({ name: m.name, cr: m.cr, path: m.path })),
        }
      }

      if (cr) {
        const cleanCr = String(cr).replace(/^cr_/, '')
        const list = index.filter((entry) => entry.cr === cleanCr)
        return {
          cr: cleanCr,
          total: list.length,
          monsters: list.slice(0, limit).map((m) => ({ name: m.name, path: m.path })),
        }
      }

      throw new Error('Provide at least one of "name" or "cr".')
    },
  }))

  ctx.tools.register(define({
    name: 'get_spell',
    description:
      'Look up a spell by name from compendium/spells/ (4,600+ D&D 3.5e spells). Returns components, school, casting time, and full rules text.',
    parameters: {
      name: { type: 'string', required: true, description: 'Spell name (e.g. \"Magic Missile\", \"Feeblemind\", \"Fireball\").' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ name: spellName }) {
      const root = workspace()
      const index = getSpellsIndex(root)
      const qNorm = normalize(spellName)

      const matches = index.filter((entry) => entry.normName === qNorm || entry.normName.includes(qNorm))

      if (matches.length === 0) {
        return { found: false, name: spellName, message: `No spell found matching "${spellName}".` }
      }

      const exact = matches.find((m) => m.normName === qNorm) || matches[0]
      if (matches.length === 1 || exact.normName === qNorm) {
        const content = readFileSync(exact.absPath, 'utf8')
        return {
          found: true,
          name: exact.name,
          folder: exact.folder,
          path: exact.path,
          content,
          other_matches: matches.length > 1 ? matches.slice(1, 6).map((m) => m.name) : [],
        }
      }

      return {
        found: true,
        name: spellName,
        count: matches.length,
        candidates: matches.slice(0, 10).map((m) => ({ name: m.name, path: m.path })),
      }
    },
  }))

  ctx.tools.register(define({
    name: 'get_class',
    description:
      'Look up a core character class from compendium/classes/: progression table, hit die, base attack/save progression, '
      + 'class skills, proficiencies, and class features.',
    parameters: {
      name: { type: 'string', required: true, description: 'Class name (e.g. "wizard", "fighter", "rogue", "cleric").' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ name: className }) {
      const root = workspace()
      const index = getClassesIndex(root)
      const qNorm = normalize(className)
      const matches = index.filter((entry) => entry.normName === qNorm || entry.normName.includes(qNorm))

      if (matches.length === 0) {
        return {
          found: false,
          name: className,
          available: index.map((c) => c.name),
          message: `Class "${className}" not found.`,
        }
      }

      const exact = matches.find((m) => m.normName === qNorm) || matches[0]
      return {
        found: true,
        class: exact.name,
        path: exact.path,
        content: readFileSync(exact.absPath, 'utf8'),
      }
    },
  }))

  ctx.tools.register(define({
    name: 'search_reference',
    description:
      'Search across all reference materials (rules, monsters, spells, classes) for a keyword or phrase.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search term or keyword.' },
      type: { type: 'string', enum: ['all', 'rules', 'monsters', 'spells', 'classes'], description: 'Narrow search scope (default: all).' },
      limit: { type: 'integer', description: 'Max results per section (default: 5).' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ query, type = 'all', limit = 5 }) {
      const root = workspace()
      const qNorm = normalize(query)
      const result = { query }

      if (type === 'all' || type === 'rules') {
        const rIndex = getRulesIndex(root)
        result.rules = rIndex
          .filter((m) => m.normName.includes(qNorm) || m.slug.includes(slugify(query)))
          .slice(0, limit)
          .map((m) => ({ title: m.rawName, category: m.category, path: m.path }))
      }

      if (type === 'all' || type === 'monsters') {
        const mIndex = getMonstersIndex(root)
        result.monsters = mIndex
          .filter((m) => m.normName.includes(qNorm))
          .slice(0, limit)
          .map((m) => ({ name: m.name, cr: m.cr, path: m.path }))
      }

      if (type === 'all' || type === 'spells') {
        const sIndex = getSpellsIndex(root)
        result.spells = sIndex
          .filter((m) => m.normName.includes(qNorm))
          .slice(0, limit)
          .map((m) => ({ name: m.name, path: m.path }))
      }

      if (type === 'all' || type === 'classes') {
        const cIndex = getClassesIndex(root)
        result.classes = cIndex
          .filter((m) => m.normName.includes(qNorm))
          .slice(0, limit)
          .map((m) => ({ name: m.name, path: m.path }))
      }

      return result
    },
  }))

  ctx.tools.register(define({
    name: 'list_reference_categories',
    description: 'List all available rule categories, monster CR folders, and the class list.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute() {
      const root = workspace()
      const rIndex = getRulesIndex(root)
      const mIndex = getMonstersIndex(root)

      const ruleCategories = [...new Set(rIndex.map((r) => r.category))].sort()
      const monsterCrs = [...new Set(mIndex.map((m) => m.cr))].sort((a, b) => {
        const na = Number.parseFloat(a), nb = Number.parseFloat(b)
        if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b)
        return na - nb
      })

      return {
        rule_categories: ruleCategories,
        total_rules: rIndex.length,
        monster_crs: monsterCrs,
        total_monsters: mIndex.length,
        total_spells: getSpellsIndex(root).length,
        classes: getClassesIndex(root).map((c) => c.name),
      }
    },
  }))
}
