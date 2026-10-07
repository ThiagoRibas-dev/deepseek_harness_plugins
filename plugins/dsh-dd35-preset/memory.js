/**
 * D&D 3.5e DM — turn memory.
 *
 * Two halves, one concern:
 *
 *   1. **Automatic capture.** A completed turn is written to
 *      `events/transcripts/NNNN_turn.md`, holding the exchange and the scene state
 *      at the end of the turn, and is folded into `events/memory_index.json`. No
 *      tool call is involved. The model's only job is `update_scene`.
 *   2. **Recall.** `grep_memories` searches the transcripts and returns ranked
 *      snippets, `fetch_memories` expands the ones the model picks, and
 *      `list_memories` returns the scene index.
 *
 * Capture point: `agent/turn-stopping` (serial, awaited, the last moment before
 * the turn boundary commits) takes the snapshot; `turn/end` with
 * `reason.kind === "completed"` commits it. Splitting the two is what keeps a
 * blocked or max-tokens turn out of the canonical record.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  bindWorkspaceFromSession, bounded, configure, loadState,
  readActiveCampaign, requireCampaign, requireState, saveState,
} from './state-store.js'
import {
  UNTITLED, clip, commitTurnToIndex, excerpt, firstMatchIndex, loadTranscripts,
  matchQuery, messagesOf, parseQuery, readMemoryIndex, renderMemoryIndex,
  resetMemoryCache, selectTurns, writeTranscript,
} from './memory-store.js'

/** Register a tool whose transcript paths bind to the calling session's workspace. */
const define = (tool) => defineTool({ ...tool, execute: bounded(tool.execute) })

export const name = 'dd35-memory'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// ---- capture -------------------------------------------------------------

/** Snapshots taken at `turn-stopping`, awaiting the `turn/end` verdict. */
const pending = new Map()
const committed = new Map()

const key = (sessionId, turn) => `${sessionId}:${turn}`

/** Only the campaign's own session writes memory — a subagent turn is not canon. */
function isMainSession(session) {
  return session?.header?.origin !== 'subagent'
}

/**
 * Genuine player input: a user-role message carrying the client-minted `rpcId`
 * that only the prompt path sets.
 *
 * The rpcId is the load-bearing part. `SessionCommandController.prompt()` mints
 * one from the request id for every prompt the Web client sends, while a
 * producer that injects model-facing content as a user-role message has none.
 * Keying on `kind === 'user'` alone was not enough: `dsh-context-pressure` used
 * exactly that kind for its pre-compaction notice, so the notice was captured as
 * the player's turn — written into the transcript as the player's own words. That plugin now declares `kind: 'context-pressure'`,
 * and this is the second line of defence against the next producer that reuses
 * `user` for a role reason.
 *
 * Known exception: ACP delivers real prompts as `{ kind: 'user' }` with no rpcId
 * (`acp/session.ts:293`). A session driven that way records no turns under this
 * predicate. ACP is not mounted in this profile; if it ever is, admit the
 * rpcId-less `user` shape here deliberately rather than widening the kind test.
 * @param message - one message from the session's derived history.
 * @returns whether the player typed it.
 */
export function isPlayerMessage(message) {
  return message?.role === 'user'
    && message?.source?.kind === 'user'
    && typeof message?.source?.rpcId === 'string'
    && message.source.rpcId.length > 0
}

/**
 * Assistant turns a connector authored itself rather than a model.
 *
 * A connector that must stand in for a reply which will never exist — the case
 * `dsh-meridian-antigravity` handles by committing a notice instead of leaving the
 * transcript on a tool result — delivers that notice as an ordinary assistant
 * message, and the turn completes normally. It is a system disclaimer, not
 * narration, so it must not enter the campaign record as the DM's words: it would
 * land in the transcript and in the scene index, and `grep_memories` and
 * `fetch_memories` would quote it back later as something the DM said.
 *
 * The entries are the connectors' own notice markers (`NOTICE_PREFIX` in
 * `dsh-meridian-antigravity/lib/failure.js`). Keep the two in step.
 */
const CONNECTOR_NOTICE_PREFIXES = ['[Meridian Antigravity]']

/**
 * @param text - one assistant turn's visible text.
 * @returns whether the turn carries a connector notice rather than only narration.
 *
 * A notice reaches this as either the whole turn or a block appended after a
 * reply the backend cut short, and `textOf` joins blocks with a newline — so the
 * marker is matched at the start of *any* line, not just the first. Matching it
 * anywhere would be wrong: prose that merely mentions the connector is narration.
 */
export function isConnectorNotice(text) {
  return String(text ?? '')
    .split('\n')
    .some((line) => CONNECTOR_NOTICE_PREFIXES.some((prefix) => line.trimStart().startsWith(prefix)))
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Injected notice kinds that ask the model to do work rather than telling it
 * something.
 *
 * A notice of one of these kinds is a task. Whatever the model says while
 * carrying it out is about the notice, not about the player, so it must not be
 * recorded as the DM's reply.
 *
 * `context-pressure` is the one observed doing this. It lands mid-turn at the
 * pre-step boundary and asks the model to write a resumption note; in
 * `seventh_moon` turn 137 the model answered the player's action, then the
 * notice arrived, and the model closed the turn with an OOC status report about
 * the file it had written — which became the recorded reply, while the real one
 * was discarded.
 *
 * Add a kind here when a new producer starts asking for work. Reporting kinds
 * (`runtime-context`, `skill-catalog`, `tool-jobs`, `subagent-settled`) do not
 * belong: the model keeps working normally after them, and its last message is
 * still the reply.
 */
const WORK_REQUESTING_NOTICE_KINDS = new Set(['context-pressure'])

/**
 * Read the closing exchange out of a session's derived history.
 *
 * Anchored on the player's message and read forward, so injected context
 * (runtime-context snapshots, compaction summaries, goal notices) between the
 * prompt and the reply cannot be mistaken for the player's words or for the
 * reply.
 */
function captureFrom(session) {
  const messages = session.deriveMessages()
  let playerAt = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isPlayerMessage(messages[i])) { playerAt = i; break }
  }
  if (playerAt === -1) return { player: null, dm: null }
  const replyAt = replyIndex(messages, playerAt)
  if (replyAt === -1) return null
  return {
    player: { id: messages[playerAt].id, text: textOf(messages[playerAt]) },
    dm: textOf(messages[replyAt]),
  }
}

/**
 * Index of the assistant message that answers the player at `playerAt`.
 *
 * Usually the turn's last assistant message with text, because a model narrates
 * after its tool calls. The exception is a work-requesting notice injected after
 * the model has already answered: the model then keeps working, and its closing
 * message describes that work. The search therefore stops at the first such
 * notice, and the text before it is the reply.
 *
 * A notice that arrives before the model has produced any text is part of the
 * working phase, not a boundary: the model has not answered yet, and its next
 * text is the answer. Both cases are in the corpus, so the guard is the
 * presence of earlier text rather than the notice alone.
 */
function replyIndex(messages, playerAt) {
  let last = -1
  for (let i = playerAt + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (last !== -1 && isWorkRequestingNotice(message)) return last
    if (message.role === 'assistant' && textOf(message)) last = i
  }
  return last
}

/** A user-role message from a producer that asks the model to act. */
function isWorkRequestingNotice(message) {
  return message?.role === 'user' && WORK_REQUESTING_NOTICE_KINDS.has(message.source?.kind)
}

/**
 * Commit one captured turn: transcript and index row.
 *
 * Every scene fact is read from `state.json` at write time and written into the
 * transcript header, so the record keeps micro-state, pending action, entities and
 * location without the model passing them in. `state.json` holds only the current
 * values, so the transcript is the only place that history is kept.
 */
function commitTurn(id, turn) {
  const state = requireState(id)
  const title = state.scene?.title?.trim() || UNTITLED
  const date = `${state.clock?.date ?? ''} ${state.clock?.time ?? ''}`.trim() || null
  const number = (loadTranscripts(id).turns.at(-1)?.number ?? 0) + 1

  const file = writeTranscript(id, {
    number,
    title,
    date,
    location: state.scene?.location || null,
    entities: state.scene?.entities,
    microState: state.scene?.micro_state,
    pendingAction: state.scene?.pending_action,
    playerInput: turn.player?.text ?? '',
    dmOutput: turn.dm,
  })

  commitTurnToIndex(id, { turn: number, title, date })

  state.last_turn = {
    number,
    title,
    at: new Date().toISOString(),
    player_message_id: turn.player?.id ?? null,
  }
  saveState(id, state)
  return { file, number }
}

/** Capture is best-effort by design: a memory write must never fail a turn. */
function capture(ctx, session, turn) {
  try {
    bindWorkspaceFromSession(session)
    const id = readActiveCampaign()
    if (!id) return
    const captured = captureFrom(session)
    if (!captured?.dm) return
    // A turn with no fresh player input (an agent-initiated continuation) is
    // not a new exchange, so there is nothing to record.
    if (!captured.player) return
    // A connector notice is not fiction. The turn completed, but the DM produced
    // nothing, so this is not canon for the same reason an errored turn is not.
    if (isConnectorNotice(captured.dm)) {
      ctx.logger.debug(`dd35-memory: turn ${turn} produced only a connector notice; not recording it`)
      return
    }
    const state = loadState(id)
    // Same player message as last time means this turn carried no new input.
    if (captured.player.id !== undefined && state?.last_turn?.player_message_id === captured.player.id) return
    const result = commitTurn(id, captured)
    ctx.logger.debug(`dd35-memory: recorded turn ${result.number} → ${result.file}`)
  } catch (error) {
    ctx.logger.warn(`dd35-memory: could not record turn ${turn}: ${error.message}`)
  }
}

export function apply(ctx, config = {}) {
  configure(config)
  resetMemoryCache()
  pending.clear()
  committed.clear()

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const session = agent?.session
    if (!isMainSession(session)) return
    pending.set(key(session.id, turn), { session, turn, at: Date.now() })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (!isMainSession(session)) return
    const turn = event.data.turn
    const pendingKey = key(session.id, turn)
    const stash = pending.get(pendingKey)
    pending.delete(pendingKey)
    // An aborted, errored, blocked, or truncated turn is not canon.
    if (event.data.reason?.kind !== 'completed') return
    if (committed.has(pendingKey)) return
    committed.set(pendingKey, true)
    if (committed.size > 512) committed.clear()
    capture(ctx, stash?.session ?? session, turn)
  })

  // Per-fibre state; dropped when the preset unmounts so a reload never serves
  // a stale cache or a half-finished turn.
  ctx.effect(() => () => {
    pending.clear()
    committed.clear()
    resetMemoryCache()
  })

  registerTools(ctx)
}

// ---- recall --------------------------------------------------------------

function registerTools(ctx) {
  ctx.tools.register(define({
    name: 'grep_memories',
    description:
      'Search the campaign\'s turn memory — the verbatim transcript of every completed turn — and get ranked snippets '
      + 'with stable ids. Use this to recall anything older than the current context: an NPC\'s name, a promise, a threat, '
      + 'a wound. Query syntax: bare terms must all match; "quoted phrases" match exactly; /regex/ for power use; '
      + 'prefix any clause with - to exclude it. Follow up with fetch_memories for the hits worth reading in full.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query: terms, "phrases", /regex/, -negation.' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      role: { type: 'string', enum: ['dm', 'player'], description: 'Restrict to the DM\'s narration or the player\'s words.' },
      from_turn: { type: 'integer', description: 'Only search turns at or after this number.' },
      to_turn: { type: 'integer', description: 'Only search turns at or before this number.' },
      context: { type: 'integer', description: 'Neighbouring messages to include in each snippet. Defaults to 1.' },
      limit: { type: 'integer', description: 'Maximum hits to return. Defaults to 20.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ query, campaign, role, from_turn, to_turn, context = 1, limit = 20 }) {
      const id = requireCampaign(campaign)
      const parsed = parseQuery(query)
      if (parsed.error && parsed.clauses.length === 0) {
        return { query, error: parsed.error, total_hits: 0, returned: 0, hits: [] }
      }
      const { messages } = loadTranscripts(id)
      const pool = role === undefined ? messages : messages.filter((message) => message.role === role)
      const total = messages.at(-1)?.turn ?? 0

      const scored = []
      for (const message of pool) {
        if (from_turn !== undefined && message.turn < from_turn) continue
        if (to_turn !== undefined && message.turn > to_turn) continue
        const match = matchQuery(message.text, parsed.clauses)
        if (!match) continue
        // Recency-weighted term frequency: an identical hit late in the
        // campaign outranks an early one, because it is likelier to be the
        // one the model actually means.
        const recency = total > 1 ? (message.turn - 1) / (total - 1) : 1
        scored.push({ message, score: match.hits * (1 + recency) })
      }
      scored.sort((a, b) => b.score - a.score || b.message.turn - a.message.turn)
      // `|| 1` guards the all-negated query, where every score is 0.
      const best = scored[0]?.score || 1
      const hits = scored.slice(0, limit).map(({ message, score }) => {
        const at = firstMatchIndex(message.text, parsed.clauses)
        return {
          id: message.id,
          turn: message.turn,
          role: message.role,
          title: message.title,
          date: message.date,
          snippet: snippetFor(messages, message, parsed.clauses, at, context),
          score: Math.round((score / best) * 100) / 100,
        }
      })
      return {
        query,
        campaign: id,
        ...(parsed.error ? { warning: parsed.error } : {}),
        total_hits: scored.length,
        returned: hits.length,
        hits,
      }
    },
  }))

  ctx.tools.register(define({
    name: 'fetch_memories',
    description:
      'Read the full text of memory hits returned by grep_memories, plus the neighbouring turns. '
      + 'Use this once you have picked the snippets that matter.',
    parameters: {
      ids: { type: 'json', required: true, description: 'JSON array of ids from grep_memories, e.g. ["0012:dm"].' },
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      context: { type: 'integer', description: 'Turns either side to include. Defaults to 1.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ ids, campaign, context = 1 }) {
      const id = requireCampaign(campaign)
      const { messages } = loadTranscripts(id)
      const byId = new Map(messages.map((message) => [message.id, message]))
      const found = []
      const missing = []
      for (const wanted of Array.isArray(ids) ? ids : [ids]) {
        const message = byId.get(String(wanted))
        if (message) found.push(message)
        else missing.push(String(wanted))
      }
      found.sort((a, b) => a.turn - b.turn)
      const expanded = found.map((message) => ({
        id: message.id,
        turn: message.turn,
        role: message.role,
        title: message.title,
        date: message.date,
        text: message.text,
        nearby: nearbyFrom(messages, message, context),
      }))
      return {
        campaign: id,
        returned: expanded.length,
        ...(missing.length > 0 ? { unknown_ids: missing } : {}),
        memories: expanded,
      }
    },
  }))

  ctx.tools.register(define({
    name: 'list_memories',
    description:
      'Call with no arguments for the campaign\'s memory index: how many turns are stored, the in-game date span, and '
      + 'a scene-by-scene map of which turn ranges belong to which scene. That map is how you know what there is to '
      + 'search and which turn ranges to search. Pass from_turn/to_turn for a bounded listing of turn headers.',
    parameters: {
      campaign: { type: 'string', description: 'Campaign identifier; defaults to the active campaign.' },
      from_turn: { type: 'integer', description: 'With to_turn, list turn headers and their fetch_memories ids in this range instead of the scene index.' },
      to_turn: { type: 'integer', description: 'End of the turn range.' },
      limit: { type: 'integer', description: 'Maximum turns to list in a bounded range. Defaults to 40.' },
      rebuild: { type: 'boolean', description: 'Rebuild the index from the transcripts before returning it.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    execute({ campaign, from_turn, to_turn, limit = 40, rebuild = false }) {
      const id = requireCampaign(campaign)
      const index = readMemoryIndex(id, { rebuild })
      if (from_turn === undefined && to_turn === undefined) {
        return { campaign: id, index: renderMemoryIndex(index), raw: index }
      }
      const turns = selectTurns(loadTranscripts(id).turns, from_turn, to_turn)
      return {
        campaign: id,
        from_turn: from_turn ?? turns[0]?.number ?? null,
        to_turn: to_turn ?? turns.at(-1)?.number ?? null,
        returned: Math.min(turns.length, limit),
        total_turns: turns.length,
        turns: turns.slice(0, limit).map((turn) => ({
          turn: turn.number,
          title: turn.title,
          date: turn.date,
          // Hand these straight to fetch_memories: without them, reading a named
          // turn means synthesising the id shape and hoping the padding is right.
          ids: messagesOf(turn).map((message) => message.id),
          opening: clip(turn.dm, 160),
        })),
      }
    },
  }))
}

/** Neighbouring turns' messages, for the context an id alone does not carry. */
function nearbyFrom(messages, message, context) {
  if (!context || context < 1) return []
  const out = []
  for (const other of messages) {
    if (other.id === message.id) continue
    if (Math.abs(other.turn - message.turn) > context || other.turn === message.turn) continue
    out.push({ id: other.id, turn: other.turn, role: other.role, text: clip(other.text, 400) })
  }
  return out
}

/** The matched message, trimmed around the first match, with its neighbours clipped above and below. */
function snippetFor(messages, message, clauses, at, context) {
  const lines = []
  const before = nearbyFrom(messages, message, context).filter((m) => m.turn < message.turn)
  const after = nearbyFrom(messages, message, context).filter((m) => m.turn > message.turn)
  for (const neighbour of before) lines.push(`[${neighbour.id}] ${clip(neighbour.text, 120)}`)
  lines.push(`[${message.id}] ${excerpt(message.text, at, 200)}`)
  for (const neighbour of after) lines.push(`[${neighbour.id}] ${clip(neighbour.text, 120)}`)
  return lines.join('\n')
}
