/**
 * Tool-result retention policy — the decision, and the strip rule.
 *
 * Spec: `docs/dsh-tool-result-policy.md`.
 *
 * Measured over 88 real `dd35` sessions, **72% of provider-bound message bytes
 * were retained tool output** — 4,479 `tool/result` events carrying ~3.03 M
 * tokens, against 1.18 M tokens of actual conversation. `read` alone accounted
 * for 1,775 k tokens across 1,134 calls, and `get_state`/`update_scene` retained
 * ~163 k tokens of state that is fully re-readable from `state.json` at any time.
 *
 * The rule this module encodes: **no tool result needs to outlive the turn that
 * produced it.** A transient read is a rendering of data that lives in files; a
 * mutation's effect is persisted to the sheet; and an oracle roll is per-turn
 * entropy whose only job is to steer the turn being narrated. Once narrated, the
 * direction has been chosen and the number is spent.
 *
 * This file is deliberately free of harness imports so it can be unit-tested and
 * reasoned about on its own; `index.js` does the service wiring.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

/** Bumped when the file's shape changes; an older file is read leniently. */
export const POLICY_VERSION = 1

/**
 * Tools whose results are **stripped** once the turn is over.
 *
 * Grouped by why, because the reason is the reviewable part — a tool added to the
 * wrong group is a bug that only shows up as lost context much later.
 */
export const STRIPPED_TOOLS = Object.freeze([
  // Transient reads: renderings of durable state. `get_state` and `update_scene`
  // are the two biggest offenders by retention in the measured corpus.
  'read', 'glob', 'grep', 'bash',
  'get_state', 'update_scene', 'route_turn',
  'list_memories', 'list_campaigns', 'list_agents', 'list_subagents',
  'get_entity', 'get_monster', 'get_spell', 'get_class', 'lookup_rule',
  'dd35_doctor', 'dd35_context_index',
  'skill', 'job_output', 'job_list', 'tts_status',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',

  // Entropy: spent the moment the turn is narrated. Not persisted anywhere, and
  // deliberately not preserved — the roll's job was to steer a turn that is now
  // written.
  'roll_dice', 'roll_check', 'roll_save', 'roll_attack', 'roll_solo_oracle',
  'ask_oracle', 'consult_oracle',
  'draw_keyword', 'draw_focus', 'draw_muse_prompt', 'roll_monster_behavior',
  'generate_plot_hook', 'generate_npc', 'explore_dungeon_room', 'explore_hex',

  // Mutations: the effect is on the sheet, so the echo is a duplicate.
  'apply_damage', 'heal', 'apply_condition', 'remove_condition', 'tick_conditions',
  'create_entity', 'update_entity', 'create_campaign', 'set_active_campaign',
  'set_mode', 'adjust_initiative', 'init_combat', 'next_turn', 'next_round',
  'add_combatant', 'remove_combatant', 'end_combat',
  'write', 'edit',
])

const STRIP_SET = new Set(STRIPPED_TOOLS)

/**
 * Whether one tool's result may be replaced by the elision marker.
 *
 * **An unknown tool is kept.** A policy written today cannot know what a plugin
 * installed tomorrow returns, and destroying a result nothing has classified is
 * the one mistake this function must not make. The asymmetry is deliberate.
 */
export function shouldStrip(toolName) {
  return typeof toolName === 'string' && STRIP_SET.has(toolName)
}

/** The one line that replaces a stripped result. */
export function elisionMarker(toolName, chars) {
  const size = Number.isFinite(chars) ? `${chars} B` : 'size unknown'
  return `[tool result elided: ${toolName} — ${size}. Re-run the tool if the content is needed again.]`
}

/** True when a result has already been replaced, so a second pass is free. */
export function isElided(text) {
  return typeof text === 'string' && text.startsWith('[tool result elided: ')
}

export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  presets: {},
  defaults: { stripTransientResults: false },
})

/**
 * Read and normalise a policy file.
 *
 * Never throws: an absent, unreadable or malformed file yields the defaults with
 * `problem` set, because this runs on the request path and a broken preference
 * file must not be able to stop a session.
 *
 * @returns `{ policy, problem }` — `problem` is null when the file was usable.
 */
export function readPolicyFile(path) {
  try {
    if (typeof path !== 'string' || path.length === 0) return { policy: DEFAULT_POLICY, problem: null }
    if (!existsSync(path)) return { policy: DEFAULT_POLICY, problem: null }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { policy: normalisePolicy(raw), problem: null }
  } catch (error) {
    return { policy: DEFAULT_POLICY, problem: `unreadable policy file: ${error.message}` }
  }
}

/** Coerce whatever was on disk into the shape the pruner expects. */
export function normalisePolicy(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const presets = {}
  for (const [key, value] of Object.entries(source.presets ?? {})) {
    if (value !== null && typeof value === 'object') {
      presets[key] = { stripTransientResults: value.stripTransientResults === true }
    }
  }
  return {
    version: Number.isInteger(source.version) ? source.version : POLICY_VERSION,
    presets,
    defaults: {
      stripTransientResults: source.defaults?.stripTransientResults === true
        || DEFAULT_POLICY.defaults.stripTransientResults,
    },
  }
}

/**
 * The decision for one session's preset.
 *
 * Resolution is `presets[agentPreset]` → `defaults` → the bundle's own configured
 * default. A preset absent from the table therefore follows `defaults` rather
 * than being silently affected, which is what makes a new preset opt-in.
 *
 * @param policy - a normalised policy.
 * @param agentPreset - `session.header.agentPreset`, or undefined.
 * @param fallback - the bundle's configured default.
 */
export function resolvePolicy(policy, agentPreset, fallback = false) {
  if (typeof agentPreset === 'string' && policy?.presets?.[agentPreset] !== undefined) {
    return { stripTransientResults: policy.presets[agentPreset].stripTransientResults, source: 'preset' }
  }
  if (policy?.defaults !== undefined) {
    return { stripTransientResults: policy.defaults.stripTransientResults, source: 'defaults' }
  }
  return { stripTransientResults: fallback === true, source: 'config' }
}

/**
 * A policy reader that re-reads the file only when it has changed.
 *
 * Keyed on path + mtime + size, the idiom `scene-state.js` uses for campaign
 * files. A hand-edit or a settings-page write is therefore observed on the next
 * prune pass with no restart — which is the whole point of keeping the table out
 * of `cordis.patch.yml`.
 */
export function createPolicyCache() {
  let cached = { path: null, stamp: null, policy: DEFAULT_POLICY, problem: null }
  return {
    read(path) {
      let stamp = null
      try {
        const info = statSync(path)
        stamp = `${info.mtimeMs}:${info.size}`
      } catch {
        // Absent or unreadable: fall through to defaults, and do not cache the
        // miss, so creating the file takes effect immediately.
        return { policy: DEFAULT_POLICY, problem: null }
      }
      if (cached.path === path && cached.stamp === stamp) return cached
      const result = readPolicyFile(path)
      cached = { path, stamp, policy: result.policy, problem: result.problem }
      return cached
    },
    reset() { cached = { path: null, stamp: null, policy: DEFAULT_POLICY, problem: null } },
  }
}
