/**
 * D&D 3.5e DM — the decaying-DC tension tick.
 *
 * Two halves, one concern: an event the DM did not choose but must honour.
 *
 *   1. **Roll at the boundary.** `agent/turn-stopping` fires before the turn is
 *      committed, so the tick is evaluated against the state as the turn ended
 *      and written to `state.json` before the next request assembles.
 *   2. **Render once, next turn.** The pending event is delivered as a
 *      runtime-context snapshot for exactly one turn, then dropped.
 *
 * Why the turn boundary and not the assembly path. The DCs decay by "turns since
 * this tier last fired", which is history, not a function of the turn number. A
 * pure renderer would have to reconstruct that history or decay from the turn
 * count alone, which resets the pressure on every restart. Writing at
 * `turn-stopping` costs one turn of latency and buys a state that survives a
 * reload; the event still lands in the very next scene, which is the same thing
 * a table DM does when they roll at the end of a turn.
 *
 * The tag vocabulary is the one `persona.prefix` already tells the DM to honour
 * (`[SURPRISE EVENT]`, `[ENCOUNTER EVENT]`, `[WORLD_EVENT]`). Before this module
 * nothing emitted them, so that instruction named a signal that could not arrive.
 *
 * Liveness: a roll failure must never fail a turn. Every path here is wrapped and
 * logged, and an unreadable campaign contributes no snapshot rather than throwing
 * on the assembly path.
 */
import { campaignFilePath, bindWorkspaceFromSession, loadState, readJson, resolveSessionCampaign, resolveSessionCampaignIn, saveState } from './state-store.js'
import { campaignTurnKey, createTurnFrozenContext } from './context-freeze.js'
import { evaluateTensionTick } from './oracle-core.js'

export const name = 'dd35-tension'

/** The context registry this row contributes to. */
export const inject = ['systemPrompt']

export const PENDING_HEADING = '## Pending Event'

const DEFAULTS = {
  /** Byte budget for the one-line snapshot. Generous; the line is capped at 400 chars upstream. */
  maxBytes: 1024,
  /** Before `dd35:scene-state` (300), so the event reads ahead of the room description. */
  order: 290,
}

/** Trim to a UTF-8 byte budget with a visible notice rather than a silent cut. */
function cap(text, maxBytes, label) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const notice = `\n\n[${label} truncated at ${maxBytes} bytes]`
  const budget = maxBytes - Buffer.byteLength(notice, 'utf8')
  if (budget <= 0) return notice.trimStart()
  let slice = text.slice(0, budget)
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > budget) slice = slice.slice(0, -1)
  return `${slice}${notice}`
}

/**
 * Roll the tick for the turn that is ending and persist the result.
 *
 * Nothing is rolled for a campaign that has never captured a turn: there is no
 * scene for an event to interrupt, and a `setup`-phase campaign should not open
 * with a surprise the player has not agreed to the framing of.
 *
 * @param ctx - the preset's agent scope, for logging.
 * @param session - the session whose turn is ending.
 * @returns the event that was scheduled, or null.
 */
export function rollTick(ctx, session) {
  if (session === null || session === undefined) return null
  bindWorkspaceFromSession(session)
  const id = resolveSessionCampaign().id
  if (!id) return null
  const state = loadState(id)
  if (state === null || !state.last_turn) return null

  const { tiers, event } = evaluateTensionTick(state, state.last_turn.number)
  state.tension = {
    tiers,
    // `after_turn` is the turn that just ended, so the renderer can show this for
    // exactly one turn and never replay it.
    pending: event === null ? null : { ...event, after_turn: state.last_turn.number },
  }
  saveState(id, state)
  if (event !== null) ctx.logger.debug(`dd35-tension: ${event.tag} scheduled after turn ${state.last_turn.number}`)
  return event
}

/**
 * The runtime-context snapshot for the current turn.
 *
 * @param assemble - the assembly context.
 * @param opts - `{ maxBytes }`.
 * @returns the pending event as a heading plus one line, or `''` on a quiet turn.
 */
export function tensionContext(assemble, opts = DEFAULTS) {
  try {
    const session = assemble?.agent?.session
    const root = session?.header?.cwd
    const id = resolveSessionCampaignIn(root, session).id
    if (id === null) return ''
    const state = readJson(campaignFilePath(root, id, 'state.json'))
    const pending = state?.tension?.pending
    if (!pending || typeof pending.line !== 'string' || pending.line === '') return ''
    const lastTurn = Number.isFinite(state?.last_turn?.number) ? state.last_turn.number : 0
    // Rolled at the end of `after_turn`, so it belongs to the turn right after it.
    if (lastTurn !== pending.after_turn + 1) return ''
    return cap(`${PENDING_HEADING}\n${pending.line}`, opts.maxBytes ?? DEFAULTS.maxBytes, 'pending event')
  } catch {
    // Prompt assembly runs on the request's error path: a malformed state file
    // contributes nothing rather than aborting the session.
    return ''
  }
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      rollTick(ctx, agent?.session)
    } catch (error) {
      ctx.logger.warn(`dd35-tension: could not roll the tension tick: ${error.message}`)
    }
  })

  // Frozen per turn for the same reason the scene snapshot is: `update_scene` and
  // `apply_damage` rewrite `state.json` between a tool call and its result, and a
  // context that re-renders on every step appends a fresh user message in exactly
  // that window. See `context-freeze.js`.
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dd35:tension',
    order: opts.order,
    text: createTurnFrozenContext({
      keyOf: campaignTurnKey,
      render: (assemble) => tensionContext(assemble, opts),
    }),
  }), 'dd35-tension.context()')
}
