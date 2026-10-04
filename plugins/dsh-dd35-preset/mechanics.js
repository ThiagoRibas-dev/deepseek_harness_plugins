/**
 * D&D 3.5e DM — dice and combat mechanics.
 *
 * Full combat tracker over the session/entity state:
 *   - d20 resolution (checks, saves, skills, attacks with crit confirmation)
 *   - initiative (roll, sort, advance, re-order for delays/readies/refocus)
 *   - damage/healing with temp HP and automatic disabled/dying/dead status
 *   - conditions with round-based expiry, ticked at the end of each round
 *
 * All per-entity facts (hp, temp_hp, ac, conditions, position) live on the
 * entity sheet; session facts (round, order, index) live in state.json.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  bounded, configure, defaultEntity, loadAnyEntity, requireCampaign, requireState,
  saveEntity, saveState,
} from './state-store.js'

/** Register a tool whose campaign paths bind to the calling session's workspace. */
const define = (tool) => defineTool({ ...tool, execute: bounded(tool.execute) })

export const name = 'dd35-mechanics'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// ---- dice ----------------------------------------------------------------

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function rollD20() { return randInt(1, 20) }

/** Parse and roll a damage expression: "1d8+5", "2d6", "1d10-1", or a flat number. */
function rollExpression(expr) {
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

/** 3.5e hit-point condition at a given hp total. */
function hpStatus(hp) {
  if (hp <= -10) return ['dead']
  if (hp < 0) return ['dying', 'unconscious']
  if (hp === 0) return ['disabled']
  return []
}

const CONDITION_NAMES = ['disabled', 'dying', 'unconscious', 'dead']
const condName = (cond) => (typeof cond === 'string' ? cond : cond.name)

/** Drop stale hp-derived conditions and add the current ones. */
function syncHpConditions(sheet) {
  const status = hpStatus(sheet.hp ?? 0)
  const conditions = (sheet.conditions ?? []).filter((cond) => !CONDITION_NAMES.includes(condName(cond)))
  for (const name of status) conditions.push({ name, effect: '', expires_round: null })
  sheet.conditions = conditions
  return status
}

function requireSheet(cid, entityId) {
  const sheet = loadAnyEntity(cid, entityId)
  if (!sheet) throw new Error(`Unknown entity "${entityId}". Create it with create_entity or add_combatant.`)
  return sheet
}

function persist(cid, sheet) { saveEntity(cid, sheet.id, sheet.kind, sheet); return sheet }

/** Expire conditions whose round has arrived; returns what expired. */
function expireConditions(cid, state) {
  const round = state.initiative.round
  const ids = [...new Set([...(state.scene?.entities ?? []), ...state.initiative.order])]
  const expired = []
  for (const entityId of ids) {
    const sheet = loadAnyEntity(cid, entityId)
    if (!sheet || !Array.isArray(sheet.conditions) || sheet.conditions.length === 0) continue
    const kept = []
    for (const cond of sheet.conditions) {
      const expires = typeof cond === 'object' && cond !== null ? cond.expires_round : null
      if (expires !== null && expires !== undefined && expires <= round) {
        expired.push({ entity: sheet.name ?? entityId, condition: condName(cond) })
      } else {
        kept.push(cond)
      }
    }
    if (kept.length !== sheet.conditions.length) {
      sheet.conditions = kept
      persist(cid, sheet)
    }
  }
  return expired
}

/** Initiative totals in descending order, re-sorted from the entity sheets. */
function sortOrder(cid, order) {
  return [...new Set(order)].sort((a, b) => {
    const sa = loadAnyEntity(cid, a)
    const sb = loadAnyEntity(cid, b)
    return (sb?.initiative_total ?? 0) - (sa?.initiative_total ?? 0)
      || (sb?.initiative_bonus ?? 0) - (sa?.initiative_bonus ?? 0)
      || String(sa?.name ?? a).localeCompare(String(sb?.name ?? b))
  })
}

export function apply(ctx, config = {}) {
  configure(config)

  // ---- d20 resolution ----------------------------------------------------

  ctx.tools.register(define({
    name: 'roll_d20',
    description:
      'Roll a d20 with a modifier, optionally against a DC, and return roll/total/success/margin. Use for any '
      + 'ability check, caster-level check, percentile-free opposed check, or ad-hoc ruling. State the check and DC to the player.',
    parameters: {
      modifier: { type: 'integer', description: 'Total modifier added to the d20.' },
      dc: { type: 'integer', description: 'Difficulty class to beat (total >= DC succeeds).' },
      kind: { type: 'string', description: 'Label, e.g. "Reflex save" or "Spot".' },
      note: { type: 'string', description: 'Free-text context echoed back.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ modifier = 0, dc, kind, note }) {
      const roll = rollD20()
      const total = roll + modifier
      const result = { kind: kind ?? 'check', roll, modifier, total, note }
      if (dc !== undefined) {
        result.dc = dc
        result.success = total >= dc
        result.margin = total - dc
        result.critical = roll === 20 ? 'success' : roll === 1 ? 'failure' : undefined
      }
      return result
    },
  }))

  ctx.tools.register(define({
    name: 'roll_save',
    description: 'Roll a saving throw (d20 + save modifier) against a DC. Returns success/failure and margin.',
    parameters: {
      modifier: { type: 'integer', description: 'Total save modifier.' },
      dc: { type: 'integer', required: true, description: 'Save DC.' },
      save: { type: 'string', description: 'Fortitude | Reflex | Will.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ modifier = 0, dc, save }) {
      const roll = rollD20()
      const total = roll + modifier
      return { kind: 'save', save: save ?? '', roll, modifier, total, dc, success: total >= dc, margin: total - dc }
    },
  }))

  ctx.tools.register(define({
    name: 'roll_skill',
    description: 'Roll a skill check (d20 + skill modifier) against a DC. Returns success/failure and margin.',
    parameters: {
      modifier: { type: 'integer', description: 'Total skill modifier.' },
      dc: { type: 'integer', required: true, description: 'Check DC.' },
      skill: { type: 'string', description: 'Skill name, e.g. Spot or Tumble.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ modifier = 0, dc, skill }) {
      const roll = rollD20()
      const total = roll + modifier
      return { kind: 'skill', skill: skill ?? '', roll, modifier, total, dc, success: total >= dc, margin: total - dc }
    },
  }))

  ctx.tools.register(define({
    name: 'roll_opposed',
    description: 'Roll two opposed d20 checks and report the winner (re-rolls a tie once, per 3.5e opposed checks).',
    parameters: {
      a_name: { type: 'string', description: 'First contestant label.' },
      a_modifier: { type: 'integer', description: 'First contestant modifier.' },
      b_name: { type: 'string', description: 'Second contestant label.' },
      b_modifier: { type: 'integer', description: 'Second contestant modifier.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ a_name = 'A', a_modifier = 0, b_name = 'B', b_modifier = 0 }) {
      const roll = () => ({ a: rollD20() + a_modifier, b: rollD20() + b_modifier })
      let values = roll()
      while (values.a === values.b) values = roll()
      return {
        a: { name: a_name, total: values.a },
        b: { name: b_name, total: values.b },
        winner: values.a > values.b ? a_name : b_name,
      }
    },
  }))

  ctx.tools.register(define({
    name: 'roll_attack',
    description:
      'Resolve one attack: d20 + bonus vs AC, with automatic critical-threat confirmation and damage dice. '
      + 'Natural 20 always hits, natural 1 always misses. Pass attacker/target ids to auto-fill the bonus/AC from their '
      + 'sheets, and apply=true to subtract the damage from the target immediately.',
    parameters: {
      attacker: { type: 'string', description: 'Attacker entity id (fills the attack bonus from its sheet).' },
      target: { type: 'string', description: 'Target entity id (fills AC and receives damage when apply=true).' },
      bonus: { type: 'integer', description: 'Explicit total attack bonus (overrides the attacker sheet).' },
      target_ac: { type: 'integer', description: 'Explicit target AC (overrides the target sheet).' },
      damage: { type: 'string', description: 'Damage expression, e.g. "1d8+5" or "2d6".' },
      critical_range: { type: 'integer', description: 'Lowest natural roll that threatens a crit (default 20).' },
      critical_multiplier: { type: 'integer', description: 'Crit damage multiplier (default 2).' },
      apply: { type: 'boolean', description: 'Apply the damage to the target sheet when true.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ attacker, target, bonus, target_ac, damage, critical_range = 20, critical_multiplier = 2, apply = false, campaign }) {
      const cid = requireCampaign(campaign)
      const attackerSheet = attacker ? loadAnyEntity(cid, attacker) : null
      const targetSheet = target ? loadAnyEntity(cid, target) : null
      const attackBonus = bonus ?? attackerSheet?.attack_bonus ?? 0
      const ac = target_ac ?? targetSheet?.ac ?? undefined

      const roll = rollD20()
      const total = roll + attackBonus
      const natural20 = roll === 20
      const natural1 = roll === 1
      const threat = !natural1 && (natural20 || roll >= critical_range)
      const hit = !natural1 && (natural20 || (ac !== undefined && total >= ac))

      let critical = false
      let confirmRoll
      if (hit && threat && ac !== undefined) {
        confirmRoll = rollD20()
        critical = natural20 || confirmRoll + attackBonus >= ac
      }

      let damageResult
      if (hit && damage !== undefined) {
        const parsed = rollExpression(damage)
        damageResult = {
          expr: parsed.expr,
          rolls: parsed.rolls,
          total: critical ? parsed.dice * critical_multiplier + parsed.bonus : parsed.total,
        }
      }

      const result = {
        attacker: attackerSheet?.name ?? attacker ?? null,
        target: targetSheet?.name ?? target ?? null,
        roll, bonus: attackBonus, total, ...(ac === undefined ? {} : { target_ac: ac }),
        hit, critical, ...(confirmRoll === undefined ? {} : { confirm_roll: confirmRoll }),
        ...(damageResult === undefined ? {} : { damage: damageResult }),
      }

      if (apply && targetSheet && damageResult) {
        let remaining = damageResult.total
        if ((targetSheet.temp_hp ?? 0) > 0) {
          const absorbed = Math.min(targetSheet.temp_hp, remaining)
          targetSheet.temp_hp -= absorbed
          remaining -= absorbed
        }
        targetSheet.hp = (targetSheet.hp ?? 0) - remaining
        result.target_hp = targetSheet.hp
        result.target_status = syncHpConditions(targetSheet)
        persist(cid, targetSheet)
      }

      return result
    },
  }))

  // ---- initiative --------------------------------------------------------

  ctx.tools.register(define({
    name: 'init_combat',
    description:
      'Start combat: roll initiative for every listed combatant, sort the order, set round 1, and add them all to the '
      + 'scene. Entries may be existing entity ids or objects { entity_id, kind, name, hp, ac, initiative_bonus } that '
      + 'create a sheet on the fly. Follow with set_mode("encounter").',
    parameters: {
      combatants: { type: 'json', required: true, description: 'JSON array of entity ids and/or combatant objects.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ combatants, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      if (!Array.isArray(combatants) || combatants.length === 0) throw new Error('combatants must be a non-empty array')

      const setup = []
      for (const entry of combatants) {
        const spec = typeof entry === 'string' ? { entity_id: entry } : entry
        const entityId = spec.entity_id ?? spec.id
        if (!entityId) throw new Error('every combatant needs an entity_id')
        let sheet = loadAnyEntity(cid, entityId)
        if (!sheet) {
          sheet = defaultEntity(entityId, {
            kind: spec.kind ?? 'npc',
            name: spec.name ?? entityId,
            ...(spec.hp === undefined ? {} : { hp: spec.hp, max_hp: spec.max_hp ?? spec.hp }),
            ...(spec.ac === undefined ? {} : { ac: spec.ac }),
            ...(spec.initiative_bonus === undefined ? {} : { initiative_bonus: spec.initiative_bonus }),
          })
        }
        if (spec.hp !== undefined) sheet.hp = spec.hp
        if (spec.ac !== undefined) sheet.ac = spec.ac
        if (spec.initiative_bonus !== undefined) sheet.initiative_bonus = spec.initiative_bonus
        const roll = rollD20()
        sheet.initiative_roll = roll
        sheet.initiative_total = roll + (sheet.initiative_bonus ?? 0)
        persist(cid, sheet)
        setup.push({ id: entityId, name: sheet.name, kind: sheet.kind, roll, bonus: sheet.initiative_bonus ?? 0, initiative: sheet.initiative_total })
      }

      setup.sort((a, b) => b.initiative - a.initiative || b.bonus - a.bonus || a.name.localeCompare(b.name))
      state.initiative = { round: 1, order: setup.map((s) => s.id), index: 0, delayed: [], readied: [] }
      state.scene.entities = [...new Set([...(state.scene.entities ?? []), ...setup.map((s) => s.id)])]
      saveState(cid, state)

      return { round: 1, order: setup, current_turn: setup[0].id, index: 0 }
    },
  }))

  ctx.tools.register(define({
    name: 'next_turn',
    description:
      'Advance to the next combatant in initiative order. Wrapping past the last combatant starts a new round and '
      + 'expires timed conditions, returning what expired. Never skip an NPC turn — resolve each one.',
    parameters: { campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' } },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      const init = state.initiative
      if (!init?.order?.length) throw new Error('No active combat. Call init_combat first.')
      init.index += 1
      let expired = []
      let newRound = false
      if (init.index >= init.order.length) {
        init.round += 1
        init.index = 0
        newRound = true
        expired = expireConditions(cid, state)
      }
      saveState(cid, state)
      return { round: init.round, new_round: newRound, index: init.index, current_turn: init.order[init.index], order: init.order, expired }
    },
  }))

  ctx.tools.register(define({
    name: 'next_round',
    description: 'Jump straight to the start of the next combat round, expiring timed conditions and returning what expired.',
    parameters: { campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' } },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      const init = state.initiative
      if (!init?.order?.length) throw new Error('No active combat. Call init_combat first.')
      init.round += 1
      init.index = 0
      const expired = expireConditions(cid, state)
      saveState(cid, state)
      return { round: init.round, index: 0, current_turn: init.order[0], order: init.order, expired }
    },
  }))

  ctx.tools.register(define({
    name: 'adjust_initiative',
    description:
      'Change initiative order mid-combat: set a new total, add a delta, or shift a combatant by n places for delays, '
      + 'readied actions, refocus, or a DM re-order. Re-sorts and returns the new order.',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id whose initiative changes.' },
      new_total: { type: 'integer', description: 'Set the initiative total outright.' },
      delta: { type: 'integer', description: 'Add (or subtract, if negative) this much from the current total.' },
      delayed: { type: 'boolean', description: 'Mark or unmark the combatant as delaying.' },
      readied: { type: 'boolean', description: 'Mark or unmark the combatant as having readied an action.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, new_total, delta, delayed, readied, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      const init = state.initiative
      const sheet = requireSheet(cid, target)
      if (new_total !== undefined) sheet.initiative_total = new_total
      else if (delta !== undefined) sheet.initiative_total = (sheet.initiative_total ?? 0) + delta
      persist(cid, sheet)
      init.order = sortOrder(cid, [...init.order, target])
      if (delayed !== undefined) {
        init.delayed = delayed ? [...new Set([...init.delayed, target])] : init.delayed.filter((id) => id !== target)
      }
      if (readied !== undefined) {
        init.readied = readied ? [...new Set([...init.readied, target])] : init.readied.filter((id) => id !== target)
      }
      saveState(cid, state)
      return {
        order: init.order.map((id) => {
          const s = loadAnyEntity(cid, id)
          return { id, name: s?.name ?? id, initiative: s?.initiative_total ?? 0 }
        }),
        delayed: init.delayed,
        readied: init.readied,
      }
    },
  }))

  ctx.tools.register(define({
    name: 'end_combat',
    description: 'End combat: clear initiative order and return the mode to exploration.',
    parameters: { campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' } },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      state.initiative = { round: 0, order: [], index: 0, delayed: [], readied: [] }
      state.mode = 'exploration'
      saveState(cid, state)
      return { mode: state.mode, initiative: state.initiative }
    },
  }))

  // ---- hp, conditions, roster -------------------------------------------

  ctx.tools.register(define({
    name: 'apply_damage',
    description:
      'Subtract damage from a target: temporary HP absorbs first, then HP, and 3.5e status is applied automatically '
      + '(0 = disabled, -1..-9 = dying/unconscious, -10 = dead). Returns the new HP and status.',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id taking damage.' },
      amount: { type: 'integer', required: true, description: 'Damage dealt.' },
      type: { type: 'string', description: 'Damage type (fire, slashing, ...) for the record.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, amount, type, campaign }) {
      const cid = requireCampaign(campaign)
      requireState(cid)
      const sheet = requireSheet(cid, target)
      let remaining = amount
      if ((sheet.temp_hp ?? 0) > 0) {
        const absorbed = Math.min(sheet.temp_hp, remaining)
        sheet.temp_hp -= absorbed
        remaining -= absorbed
      }
      sheet.hp = (sheet.hp ?? 0) - remaining
      const status = syncHpConditions(sheet)
      persist(cid, sheet)
      return { target, name: sheet.name, damage: amount, type: type ?? null, hp: sheet.hp, max_hp: sheet.max_hp, temp_hp: sheet.temp_hp, status }
    },
  }))

  ctx.tools.register(define({
    name: 'heal',
    description: 'Restore hit points to a target (capped at max HP) and clear dying/dead status when HP returns above 0.',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id being healed.' },
      amount: { type: 'integer', required: true, description: 'Hit points restored.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, amount, campaign }) {
      const cid = requireCampaign(campaign)
      requireState(cid)
      const sheet = requireSheet(cid, target)
      const before = sheet.hp ?? 0
      sheet.hp = Math.min(sheet.max_hp ?? before, before + amount)
      const status = syncHpConditions(sheet)
      persist(cid, sheet)
      return { target, name: sheet.name, healed: sheet.hp - before, hp: sheet.hp, max_hp: sheet.max_hp, status }
    },
  }))

  ctx.tools.register(define({
    name: 'apply_condition',
    description:
      'Add or update a condition/buff on an entity, with an optional duration in rounds (expires automatically at the '
      + 'end of that round) or an absolute expiry round. Use for bless, prone, stunned, grappled, raging, etc.',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id.' },
      name: { type: 'string', required: true, description: 'Condition name, e.g. bless or prone.' },
      effect: { type: 'string', description: 'Mechanical effect text, e.g. "+1 attack, +1 saves vs fear".' },
      duration_rounds: { type: 'integer', description: 'Rounds from now until it expires.' },
      expires_round: { type: 'integer', description: 'Absolute round number it expires on.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, name, effect, duration_rounds, expires_round, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      const sheet = requireSheet(cid, target)
      const expires = expires_round ?? (duration_rounds === undefined ? null : (state.initiative?.round ?? 0) + duration_rounds)
      const conditions = (sheet.conditions ?? []).filter((cond) => condName(cond) !== name)
      conditions.push({ name, effect: effect ?? '', expires_round: expires })
      sheet.conditions = conditions
      persist(cid, sheet)
      return { target, name: sheet.name, conditions: sheet.conditions }
    },
  }))

  ctx.tools.register(define({
    name: 'remove_condition',
    description: 'Remove a condition/buff from an entity by name.',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id.' },
      name: { type: 'string', required: true, description: 'Condition name to remove.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, name, campaign }) {
      const cid = requireCampaign(campaign)
      requireState(cid)
      const sheet = requireSheet(cid, target)
      sheet.conditions = (sheet.conditions ?? []).filter((cond) => condName(cond) !== name)
      persist(cid, sheet)
      return { target, name: sheet.name, conditions: sheet.conditions }
    },
  }))

  ctx.tools.register(define({
    name: 'tick_conditions',
    description: 'Expire every condition whose round has arrived and report what expired. next_turn/next_round call this '
      + 'automatically at the end of a round; use it directly when time passes outside combat.',
    parameters: {
      target: { type: 'string', description: 'Limit ticking to one entity.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      if (target) {
        const sheet = requireSheet(cid, target)
        const round = state.initiative?.round ?? 0
        const kept = []
        const expired = []
        for (const cond of sheet.conditions ?? []) {
          const expires = typeof cond === 'object' && cond !== null ? cond.expires_round : null
          if (expires !== null && expires !== undefined && expires <= round) expired.push(condName(cond))
          else kept.push(cond)
        }
        sheet.conditions = kept
        persist(cid, sheet)
        return { round, expired }
      }
      return { round: state.initiative?.round ?? 0, expired: expireConditions(cid, state) }
    },
  }))

  ctx.tools.register(define({
    name: 'add_combatant',
    description:
      'Add a combatant to the scene (and optionally roll them into the initiative order). Creates the entity sheet when '
      + 'needed — use for summoned creatures, reinforcements, or NPCs that join mid-scene.',
    parameters: {
      entity_id: { type: 'string', required: true, description: 'Entity id.' },
      kind: { type: 'string', enum: ['pc', 'npc'], description: 'pc or npc. Defaults to npc.' },
      name: { type: 'string', description: 'Display name.' },
      hp: { type: 'integer', description: 'Hit points.' },
      ac: { type: 'integer', description: 'Armor class.' },
      initiative_bonus: { type: 'integer', description: 'Initiative modifier.' },
      sheet: { type: 'json', description: 'Extra sheet fields to merge.' },
      roll_initiative: { type: 'boolean', description: 'Roll and insert into the current initiative order.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ entity_id, kind = 'npc', name, hp, ac, initiative_bonus, sheet = {}, roll_initiative = false, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      let existing = loadAnyEntity(cid, entity_id)
      if (!existing) {
        existing = defaultEntity(entity_id, {
          kind,
          ...(name === undefined ? {} : { name }),
          ...(hp === undefined ? {} : { hp, max_hp: hp }),
          ...(ac === undefined ? {} : { ac }),
          ...(initiative_bonus === undefined ? {} : { initiative_bonus }),
        })
      }
      const merged = { ...existing, ...sheet }
      let initiative
      if (roll_initiative) {
        const roll = rollD20()
        merged.initiative_roll = roll
        merged.initiative_total = roll + (merged.initiative_bonus ?? 0)
        initiative = merged.initiative_total
      }
      persist(cid, merged)
      state.scene.entities = [...new Set([...(state.scene.entities ?? []), entity_id])]
      if (roll_initiative) state.initiative.order = sortOrder(cid, [...state.initiative.order, entity_id])
      saveState(cid, state)
      return { entity_id, sheet: merged, initiative, order: state.initiative.order }
    },
  }))

  ctx.tools.register(define({
    name: 'remove_combatant',
    description: 'Remove a combatant from the scene and the initiative order (the sheet is kept on disk).',
    parameters: {
      target: { type: 'string', required: true, description: 'Entity id to remove from the scene.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ target, campaign }) {
      const cid = requireCampaign(campaign)
      const state = requireState(cid)
      state.scene.entities = (state.scene.entities ?? []).filter((id) => id !== target)
      state.initiative.order = state.initiative.order.filter((id) => id !== target)
      state.initiative.delayed = state.initiative.delayed.filter((id) => id !== target)
      state.initiative.readied = state.initiative.readied.filter((id) => id !== target)
      if (state.initiative.index >= state.initiative.order.length) state.initiative.index = 0
      saveState(cid, state)
      return { removed: target, order: state.initiative.order, present: state.scene.entities }
    },
  }))
}
