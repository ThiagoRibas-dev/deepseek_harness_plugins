/**
 * D&D 3.5e DM — campaign prompt files.
 *
 * Two optional files in the **active campaign** directory
 * (`<workspace>/campaign/<id>/`), re-read on every request:
 *
 *   dm_persona.md  → a system-prompt section placed directly after the DM
 *                    persona prefix, so a campaign extends its DM's identity and
 *                    tone without editing the preset or restarting the harness.
 *   dm_notes.md    → a runtime-context snapshot: the DM's durable scratchpad,
 *                    maintained with the ordinary `read`/`write`/`edit` tools.
 *                    Delivered as a user-role snapshot rather than a prompt
 *                    section so writing notes never invalidates the cached
 *                    system-prompt prefix mid-session.
 *
 * Neither file costs a model call. Both providers run at assembly time and
 * resolve the campaign from the assembling agent's *own* session cwd, so a
 * different session, or a campaign switched with `set_active_campaign`, is
 * reflected on the very next request.
 *
 * Both bodies are contributed with `interpolate: false`. Campaign prose is
 * arbitrary text and must never be scanned for `{{variable}}` groups: an
 * unknown reference throws during render, and a campaign file could take a
 * session down simply by containing braces.
 *
 * Neither file is required. An absent campaign, absent file, or unreadable path
 * contributes an empty string, which drops the contribution entirely.
 */
import { readFileSync, statSync } from 'node:fs'
import { campaignFilePath, readActiveCampaignIn } from './state-store.js'

export const name = 'dd35-prompt'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

const DEFAULTS = {
  personaFile: 'dm_persona.md',
  notesFile: 'dm_notes.md',
  /** Byte budget per file before the contribution is truncated with a visible notice. */
  personaMaxBytes: 32768,
  notesMaxBytes: 16384,
  /** After DEPLOYMENT_PERSONA_PREFIX (0), before PLAN_POLICY (500). */
  personaOrder: 100,
  /** After the sandbox / approval / delegation contexts (110–120). */
  notesOrder: 200,
}

const PERSONA_HEADING = '## Campaign Persona'
const NOTES_HEADING = '## Campaign Notes'

/**
 * path → { stamp, text }, so an unchanged file is read once rather than on every
 * model request. Keyed by content identity (mtime + size); the process-wide map
 * is dropped when the preset unloads.
 */
const cache = new Map()
const CACHE_LIMIT = 64

function readCached(path) {
  let stamp
  try {
    const info = statSync(path)
    if (!info.isFile()) {
      cache.delete(path)
      return null
    }
    stamp = `${info.mtimeMs}:${info.size}`
  } catch {
    // Absent, unreadable, or a broken symlink: the assembly path treats it as absent.
    cache.delete(path)
    return null
  }
  const hit = cache.get(path)
  if (hit !== undefined && hit.stamp === stamp) return hit.text

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    cache.delete(path)
    return null
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(path, { stamp, text })
  return text
}

/** Trim to a UTF-8 byte budget, ending with a visible notice rather than a silent cut. */
function cap(text, maxBytes, label) {
  const notice = `\n\n[${label} truncated at ${maxBytes} bytes]`
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8'))
  let slice = text.slice(0, budget)
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > budget) slice = slice.slice(0, -1)
  return `${slice}${notice}`
}

/** The active campaign for one assembly, or null when the session has none. */
function activeCampaign(assemble) {
  const root = assemble?.agent?.session?.header?.cwd
  const id = readActiveCampaignIn(root)
  return id === null ? null : { root, id }
}

/** Resolve one campaign file: its workspace-relative path and its text (null when absent). */
function resolveFile(assemble, file) {
  const active = activeCampaign(assemble)
  if (active === null) return null
  return {
    rel: `campaign/${active.id}/${file}`,
    body: readCached(campaignFilePath(active.root, active.id, file)),
  }
}

/** The campaign's own persona, as a section directly after the DM persona prefix. */
function personaSection(assemble, opts) {
  const found = resolveFile(assemble, opts.personaFile)
  if (found === null || found.body === null) return ''
  const body = found.body.trim()
  if (body === '') return ''
  return [
    PERSONA_HEADING,
    `The campaign's own persona, from \`${found.rel}\`. It shapes how you present the world — campaign facts and house rules belong in your notes file instead.`,
    'Where it conflicts with the general DM persona above, it wins.',
    '',
    cap(body, opts.personaMaxBytes, opts.personaFile),
  ].join('\n')
}

/**
 * The DM's notes file. The guidance is unconditional while a campaign is active
 * — with no dedicated notes tool, this block is the only thing that tells the DM
 * the file exists and by which path to reach it.
 */
function notesContext(assemble, opts) {
  const found = resolveFile(assemble, opts.notesFile)
  if (found === null) return ''
  const lines = [
    NOTES_HEADING,
    `Your durable campaign scratchpad is \`${found.rel}\`, relative to your working directory. It is reloaded into context automatically on every request, so anything written there survives compaction and long absences.`,
    'Write down anything you may need to be reminded of. House rules are the primary use, but so are active quests, the intent behind a plot arc, a detail you want to bring up several sessions from now, rulings you have already given, and the names, faces, promises, threats and debts you would otherwise lose. The notes are yours — the player does not see them unless you narrate them.',
    'This file is the home for campaign-specific truth. Do not park it in AGENTS.md or any other workspace-global file: those are shared by every campaign in this folder, so what you store there leaks across campaigns.',
    'Do not record anything that changes from turn to turn. This includes the current scene, party location, turn order, hit points, and conditions. Those details are already retrieved fresh from get_state. Instead, write reminders, notes, and other facts that remain true across multiple turns and sessions.',
    `\`read\` \`${found.rel}\` before changing it. Use \`edit\` to append an entry; use \`write\` only when you mean to replace the whole file. Date entries against the in-game clock.`,
  ]
  if (found.body === null || found.body.trim() === '') {
    lines.push('', '_No notes yet — the file does not exist. Create it with `write` the first time the campaign gives you something worth keeping._')
  } else {
    lines.push('', '### Current notes', '', cap(found.body.trim(), opts.notesMaxBytes, opts.notesFile))
  }
  return lines.join('\n')
}

/** A positive integer config value, or the default. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Register the campaign persona section and notes context for this preset's scope.
 * @param ctx - the preset's agent scope; an unscoped mount would shadow other sessions.
 * @param config - optional file names, byte budgets, and section orders.
 */
export function apply(ctx, config = {}) {
  const opts = {
    ...DEFAULTS,
    ...config,
    personaMaxBytes: positiveInt(config.personaMaxBytes, DEFAULTS.personaMaxBytes),
    notesMaxBytes: positiveInt(config.notesMaxBytes, DEFAULTS.notesMaxBytes),
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dd35:dm-persona',
    order: opts.personaOrder,
    // Campaign prose is arbitrary; never scan it for {{variable}} references.
    interpolate: false,
    text: (assemble) => personaSection(assemble, opts),
  }), 'dd35-prompt.persona()')

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dd35:dm-notes',
    order: opts.notesOrder,
    text: (assemble) => notesContext(assemble, opts),
  }), 'dd35-prompt.notes()')

  ctx.effect(() => () => { cache.clear() }, 'dd35-prompt.cache()')
}
