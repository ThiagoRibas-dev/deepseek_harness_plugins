/**
 * D&D 3.5e DM — turn memory.
 *
 * Two halves, one concern:
 *
 *   1. **Automatic capture.** A completed turn is written to
 *      `events/transcripts/NNNN_turn.md`, appended to `events/campaign_log.md`,
 *      and folded into `events/memory_index.json` — with no tool call and no
 *      model cooperation. The model's only job is `update_scene`.
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
  appendLogTurn, bindWorkspaceFromSession, bounded, configure, loadState,
  readActiveCampaign, requireCampaign, requireState, saveState,
} from './state-store.js'
import {
  UNTITLED, clip, commitTurnToIndex, excerpt, firstMatchIndex, loadTranscripts,
  matchQuery, parseQuery, readMemoryIndex, renderMemoryIndex, resetMemoryCache,
  selectTurns, writeTranscript,
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

/** Genuine player input: user role and the player's own producer kind. Injected context never qualifies. */
function isPlayerMessage(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Read the closing exchange out of a session's derived history.
 *
 * Walks back from the final assistant message so intervening injected context
 * (runtime-context snapshots, compaction summaries, goal notices) cannot be
 * mistaken for the player's words.
 */
function captureFrom(session) {
  const messages = session.deriveMessages()
  let assistantAt = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant' && textOf(messages[i])) { assistantAt = i; break }
  }
  if (assistantAt === -1) return null
  let playerAt = -1
  for (let i = assistantAt - 1; i >= 0; i -= 1) {
    if (isPlayerMessage(messages[i])) { playerAt = i; break }
  }
  return {
    player: playerAt === -1 ? null : { id: messages[playerAt].id, text: textOf(messages[playerAt]) },
    dm: textOf(messages[assistantAt]),
  }
}

/**
 * Commit one captured turn: transcript, campaign log, and index row.
 *
 * Every scene fact is read from `state.json` at write time, so the log keeps
 * getting micro-state, pending action, and location without the model passing
 * them in.
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
    playerInput: turn.player?.text ?? '',
    dmOutput: turn.dm,
  })

  appendLogTurn(id, {
    sceneTitle: title,
    dateTime: date ?? '',
    location: state.scene?.location,
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
      from_turn: { type: 'integer', description: 'With to_turn, list turn headers in this range instead of the scene index.' },
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
