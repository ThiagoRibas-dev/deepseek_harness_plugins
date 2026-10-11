/**
 * Freeze a volatile runtime-context contribution for the duration of a turn.
 *
 * The harness renders every registered context on **every step** and appends a
 * fresh user message whenever the joined text changed
 * (`packages/core/agent-loop/src/runtime-context.ts`,
 * `RuntimeContextProjection.project`). That is right for a fact that is stable
 * across a turn and wrong for one of ours: `update_scene` rewrites `state.json`
 * mid-turn, so the next step appended a new ~9 KB snapshot **between a tool call
 * and its result** — the one window Meridian's continuation contract watches.
 * The superseded snapshot is never replaced, so every copy is retained and
 * re-sent for the life of the session: 3 snapshots, 28 KB, in a single 2-turn
 * session (`4ba1929e`), and the file's own header already warns that
 * "every superseded snapshot is retained in session history".
 *
 * The fix is timing, not content. Render once per turn and keep that text until
 * the turn is captured. `state.last_turn` is written only by the turn-capture
 * path (`memory.js`), so it is a stable key for the whole of a turn and changes
 * exactly at the boundary. Nothing is lost: the mutation's own result carries
 * the new numbers, `get_state` answers mid-turn, and the next turn's block shows
 * the updated state.
 *
 * @module @local/dsh-dd35-preset/context-freeze
 */
import { campaignFilePath, resolveSessionCampaignIn, readJson } from './state-store.js'

/**
 * A per-session cache key that is stable for the whole of a turn.
 *
 * The campaign id is part of the key so switching campaigns cannot alias a
 * previous campaign's frozen text. A campaign with no captured turn yet keys on
 * `0`, which still freezes: the first turn's block is the one the DM is reading.
 *
 * @param assemble - the assembly context.
 * @returns `"<campaignId>:<turn>"`, or null when there is no campaign or the
 *   state is unreadable.
 */
export function campaignTurnKey(assemble) {
  try {
    const session = assemble?.agent?.session
    const root = session?.header?.cwd
    const id = resolveSessionCampaignIn(root, session).id
    if (id === null) return null
    const state = readJson(campaignFilePath(root, id, 'state.json'))
    const turn = Number.isFinite(state?.last_turn?.number) ? state.last_turn.number : 0
    return `${id}:${turn}`
  } catch {
    // `readJson` is a bare `JSON.parse(readFileSync(...))`, and this runs during
    // prompt assembly: a malformed state.json must contribute no key, not throw.
    // No key means no caching, which degrades to the previous per-step behaviour.
    return null
  }
}

/**
 * Wrap a context renderer so its text is produced at most once per turn.
 *
 * The cache is keyed by the **session object**, not by the assembly, because one
 * preset scope serves every session that selects it — a module-level variable
 * would leak one session's snapshot into another's.
 *
 * @param options - wiring.
 * @param options.keyOf - `(assemble) => string | null`; a cheap turn-stable key.
 * @param options.render - `(assemble) => string`; the expensive renderer.
 * @returns a context `text` provider.
 */
export function createTurnFrozenContext({ keyOf, render }) {
  if (typeof keyOf !== 'function') throw new TypeError('context-freeze: keyOf is required')
  if (typeof render !== 'function') throw new TypeError('context-freeze: render is required')

  const frozen = new WeakMap()

  return (assemble) => {
    const session = assemble?.agent?.session
    const key = keyOf(assemble)
    if (session != null && key !== null) {
      const hit = frozen.get(session)
      if (hit !== undefined && hit.key === key) return hit.text
    }
    const text = render(assemble)
    if (session != null && key !== null) frozen.set(session, { key, text })
    return text
  }
}
