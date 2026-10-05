/**
 * Build one Meridian Messages request body from a provider-neutral harness
 * request.
 *
 * This module is where the connector's promises about controls are kept. The
 * Antigravity backend rejects `temperature`, `top_p` and `top_k` before any
 * generation, treats `max_tokens` as advisory only, exposes reasoning effort as
 * a *slug* rather than a sampling parameter, and returns no reasoning channel.
 * So this serializer emits none of them, and it is the only place a body is
 * assembled.
 *
 * Continuation is an exact-match contract, and the harness transcript is the
 * source of truth, so the whole history is re-serialized on every request and
 * the tool result batch is returned whole rather than dripped.
 *
 * @module @local/dsh-meridian-antigravity/lib/serialize
 */

import { LlmError, offloadedImageText, projectOffloadedImages } from '@deepseek-ai/dsh-llm'
import { remapToolIds } from './compaction-ids.js'
import { analyzeContinuation } from './continuation.js'
import { effortOfSlug } from './config.js'

/** Meridian enforces at most four stop sequences of at most 1024 characters. */
const MAX_STOP_SEQUENCES = 4
const MAX_STOP_SEQUENCE_LENGTH = 1024

/** One image occurrence retained for this request, in request order. */
class RetainedImage {
  constructor(block, bytes) {
    this.block = block
    this.bytes = bytes
  }
}

/** The one notice kind whose older copies each say they are superseded. */
const RUNTIME_CONTEXT_KIND = 'runtime-context'

/**
 * Drop injected user-role notices the process cannot act on.
 *
 * DSH records harness state changes — a model switch, an approval-policy change,
 * a policy snapshot — as user-role messages, and appends them after the player's
 * own message. Meridian renders the conversation as one prompt and asks the
 * process to answer the latest user message, so a trailing notice is what gets
 * answered. Only messages whose `source.kind` is named in `ignoredKinds` are
 * candidates. `runtime-context` snapshots are additionally kept newest-first
 * when `keepLatestRuntimeContext` is set, because every one of them states that
 * it replaces the earlier snapshots. A player message, a tool result and every
 * other kind always survive.
 *
 * @param messages - the harness history, in order.
 * @param options - the resolved drop policy.
 * @returns the kept messages, plus the dropped ones in the order they appeared.
 */
export function filterNoticeMessages(messages, { ignoredKinds = [], keepLatestRuntimeContext = true } = {}) {
  const ignored = new Set(ignoredKinds)
  const newestSnapshot = keepLatestRuntimeContext
    ? messages.findLastIndex(message => message.role === 'user' && sourceKindOf(message) === RUNTIME_CONTEXT_KIND)
    : -1
  const kept = []
  const dropped = []
  messages.forEach((message, index) => {
    const isUser = message.role === 'user'
    const kind = sourceKindOf(message)
    const namedNotice = isUser && kind !== undefined && ignored.has(kind)
    const supersededSnapshot = isUser && keepLatestRuntimeContext
      && kind === RUNTIME_CONTEXT_KIND && index !== newestSnapshot
    if (namedNotice || supersededSnapshot) {
      dropped.push(message)
      return
    }
    kept.push(message)
  })
  return { messages: kept, dropped }
}

/** The producer kind recorded on a message, or undefined when it carries none. */
function sourceKindOf(message) {
  const kind = message?.source?.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined
}

/** Text of a message's text blocks, joined. */
function textOfMessage(message) {
  return (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Keep the request valid when dropping left it ending on an assistant turn.
 *
 * Meridian requires the final message to be a user turn, and a turn can be
 * driven by a notice alone: changing the approval policy or the model starts
 * one. When those notices are the only trailing user input, the last one is
 * that turn's input and has to stay.
 *
 * @param wire - the converted wire messages, extended in place.
 * @param dropped - the messages the drop policy removed, in order.
 */
function restoreTrailingNotice(wire, dropped) {
  if (dropped.length === 0) return
  const trailing = wire.at(-1)
  if (trailing !== undefined && trailing.role === 'user') return
  const text = textOfMessage(dropped.at(-1))
  if (text.length > 0) wire.push({ role: 'user', content: [{ type: 'text', text }] })
}

/**
 * Serialize one complete request.
 *
 * @param options - the provider-neutral harness request.
 * @param connection - resolved adapter options.
 * @param images - request-ready bytes by durable attachment id.
 * @param imageAccess - optional execution-world path resolver for placeholders.
 * @param warn - one-shot diagnostic sink for stripped controls.
 * @param sessionKey - harness session id sent as Meridian's `meridian_session_key`,
 *   which is part of Meridian's execution contract and so keeps two sessions with
 *   identical history from being treated as one live conversation.
 * @returns the Messages body (without `stream`), the image occurrences and
 *   their encoded sizes so the caller can enforce the byte budget precisely, and
 *   for a compaction call the number of tool ids re-derived to break Meridian's
 *   association with a delivered run.
 */
export function serializeRequest({ options, connection, images, imageAccess, warn, sessionKey }) {
  if (options.model.length === 0) throw new LlmError('Meridian Antigravity needs a model slug', 'INVALID_REQUEST')

  // Read from the harness messages rather than the wire messages, because the
  // assistant message that issued a tool call carries its provider there. It
  // serves two purposes: gating the notice filter below, and explaining a
  // failure. See lib/continuation.js.
  const continuation = analyzeContinuation(options.messages)

  // Injected state notices are not model input: they describe harness state the
  // process cannot act on, and DSH appends them after the player's own message.
  //
  // Dropping a superseded runtime-context snapshot rewrites history, which is
  // only safe on the request that starts a turn. Meridian requires each tool
  // continuation's prefix to hash to the message list it delivered, and the
  // snapshot that was newest when that list went out stops being newest as soon
  // as the harness injects another one mid-turn. Filtering then removes it from
  // the prefix, the hashes diverge, and Meridian answers 409 "changed its
  // delivered history or tool batch" -- which is what happened on every long
  // tool loop where the runtime context refreshed. A continuation therefore
  // sends the history verbatim: the new snapshot is appended after the tool
  // results, where Meridian accepts it, and nothing before them moves.
  const { messages: history, dropped } = continuation === undefined
    ? filterNoticeMessages(options.messages, {
      ignoredKinds: connection.ignoredNoticeKinds,
      keepLatestRuntimeContext: connection.keepLatestRuntimeContext,
    })
    : { messages: options.messages, dropped: [] }
  const tools = resolveTools(options, connection)
  const effort = resolveEffort(options)
  const system = collectSystem(options)
  const retained = []
  const built = buildMessages({ options: { ...options, messages: history }, connection, images, imageAccess, retained })
  restoreTrailingNotice(built, dropped)
  const stop = resolveStop(options.stop)

  // A compaction call replays conversation messages, so it carries tool ids
  // Meridian handed out when it delivered those calls. Meridian looks a
  // request's tool results up by id, and any hit makes it demand that the
  // request be that run's exact tool continuation — which a replay is not, so
  // it is refused. The ids mean nothing to a summarisation, so they are
  // re-derived to break the association. Conversation traffic is untouched.
  const compaction = options.purpose === 'compaction'
  const remap = compaction ? remapToolIds(built) : undefined
  const messages = remap === undefined ? built : remap.messages

  const body = {
    model: options.model,
    max_tokens: resolveMaxTokens(options, connection),
    messages,
    // Meridian's execution contract includes the session key, so sending it is
    // what keeps two sessions with identical history from being matched to one
    // live CLI conversation.
    ...sessionKey === undefined || sessionKey.length === 0 ? {} : { meridian_session_key: sessionKey },
    ...system.length === 0 ? {} : { system },
    // A summarisation has nothing to call, and advertising the conversation's
    // tools invites the summarising model to call one instead of writing the
    // summary.
    ...tools === undefined || compaction ? {} : { tools },
    ...stop === undefined ? {} : { stop_sequences: stop },
    // The slug already selects the effort; only an explicitly configured
    // deployment sends the matching override, and only when it matches.
    ...effort === undefined || !connection.sendEffortOverride ? {} : { output_config: { effort } },
  }

  if (options.temperature !== undefined) {
    warn?.('Meridian Antigravity does not accept temperature; the request was sent without it. Remove the sampling control from the composition or model card.')
  }
  if (options.reasoningEffort !== undefined && effort === undefined) {
    warn?.(`Meridian Antigravity ignores reasoning effort ${JSON.stringify(String(options.reasoningEffort))}: this slug takes no effort override. Select the effort by slug instead.`)
  }

  return { body, retained, compactionRemapped: remap?.remapped, continuation }
}

/** Output instruction. Meridian copies this into the prompt; it is not a cap. */
function resolveMaxTokens(options, connection) {
  const value = options.maxTokens ?? connection.defaultMaxTokens
  if (!Number.isInteger(value) || value < 1) {
    throw new LlmError(`Meridian Antigravity needs a positive integer max_tokens (got ${value})`, 'INVALID_REQUEST')
  }
  return value
}

/**
 * Resolve the slug's effort label and refuse a client control that contradicts
 * it. Changing effort while a tool call is pending is rejected by Meridian, so a
 * mismatch is refused here rather than negotiated on the wire.
 */
function resolveEffort(options) {
  const slugEffort = effortOfSlug(options.model)
  const requested = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  if (requested === undefined) return slugEffort
  if (slugEffort === undefined) {
    throw new LlmError(
      `Meridian Antigravity model ${JSON.stringify(options.model)} takes no reasoning effort override;`
      + ' select a slug that names the effort instead',
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (requested !== slugEffort) {
    throw new LlmError(
      `Meridian Antigravity reasoning effort ${JSON.stringify(requested)} does not match the effort encoded in`
      + ` model ${JSON.stringify(options.model)} (${slugEffort}); omit the override or select the matching slug`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return slugEffort
}

function resolveTools(options, connection) {
  const advertised = options.tools
  if (advertised === undefined || advertised.length === 0) return undefined
  // A helper turn that only produces a title needs no tools, and the contract
  // asks helper turns to advertise none unless they truly need them.
  if (options.purpose === 'session-title' && connection.stripToolsForSessionTitle) return undefined
  if (advertised.some(tool => tool.deferLoading === true)) {
    throw new LlmError(
      'Meridian Antigravity cannot represent deferred tool loading: a tool that is not advertised in this request'
      + ' is invisible to the process already waiting, and Meridian receives the full tool list on every call',
      'UNSUPPORTED_CONTENT',
    )
  }
  return advertised.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

function resolveStop(stop) {
  if (stop === undefined || stop.length === 0) return undefined
  const kept = stop
    .filter(sequence => typeof sequence === 'string' && sequence.length > 0)
    .slice(0, MAX_STOP_SEQUENCES)
    .map(sequence => sequence.slice(0, MAX_STOP_SEQUENCE_LENGTH))
  return kept.length === 0 ? undefined : kept
}

/**
 * Resolve the effective system prompt.
 *
 * Two shapes reach an adapter. A loop-built request carries no top-level
 * `system` at all — the loop invariant requires `options.system === undefined`,
 * and the assembled system prompt is surface node 0 inside `messages`. A
 * one-shot caller such as session-title generation sets `options.system`
 * directly and may carry no system message. Both are honored.
 *
 * Only the **latest** system snapshot becomes the top-level prompt, because a
 * harness system-prompt update replaces the previous snapshot rather than
 * appending to it; concatenating every snapshot would send the prompt twice.
 *
 * Tool-addition and tool-removal markers are harness bookkeeping rather than
 * model input: Meridian receives the complete tool definition set on every
 * request, so their effect is already expressed by the `tools` array.
 */
function collectSystem(options) {
  const parts = []
  if (typeof options.system === 'string' && options.system.length > 0) parts.push(options.system)
  const latest = latestSystemText(options.messages)
  if (latest !== undefined) parts.push(latest)
  return parts.join('\n\n')
}

/** Text of the most recent non-empty system or developer message. */
function latestSystemText(messages) {
  let latest
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'developer') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.length > 0) latest = text
  }
  return latest
}

/**
 * Build the wire message list.
 *
 * Anthropic requires tool results to lead the user turn that carries them and
 * forbids two adjacent same-role turns, so consecutive turns are merged and
 * tool results are hoisted. The complete delivered batch is returned in one
 * request because Meridian rejects a partial, reordered, or drip-fed batch.
 */
function buildMessages({ options, connection, images, imageAccess, retained }) {
  const history = projectOffloadedImages(
    options.messages,
    ref => offloadedImageText(ref, imageAccess?.(ref)),
  )
  const wire = []
  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'tool') {
      const content = toolResultContent(message, images, retained)
      pushWire(wire, 'user', content, true)
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content.flatMap((block) => {
        if (block.type === 'text') return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
        if (block.type === 'tool-call') {
          return [{ type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) }]
        }
        // The backend has no reasoning channel and never returns one; a durable
        // reasoning block from another route is not model input here.
        return []
      })
      if (content.length > 0) pushWire(wire, 'assistant', content, false)
      continue
    }
    const content = message.content.flatMap((block) => {
      if (block.type === 'text') return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
      if (block.type !== 'image') {
        throw new LlmError(
          `Meridian Antigravity cannot represent ${block.type} content in a user turn`,
          'UNSUPPORTED_CONTENT',
        )
      }
      return [imageContent(block, connection, images, retained)]
    })
    if (content.length > 0) pushWire(wire, 'user', content, false)
  }
  return wire
}

/** Append merging into the previous turn when the role matches. */
function pushWire(wire, role, content, hoistToolResults) {
  const previous = wire.at(-1)
  if (previous !== undefined && previous.role === role) {
    previous.content.push(...content)
  } else {
    wire.push({ role, content: [...content] })
  }
  if (!hoistToolResults) return
  const target = wire.at(-1)
  const results = target.content.filter(block => block.type === 'tool_result')
  if (results.length === target.content.length) return
  target.content = [...results, ...target.content.filter(block => block.type !== 'tool_result')]
}

/**
 * A tool result must be an array of blocks, never a bare string: the contract
 * allows an image inside a tool result only as an array member, and Meridian
 * wraps the array as `meridian_client_result` so CLI timing metadata never
 * reaches the model as file content.
 */
function toolResultContent(message, images, retained) {
  const content = message.content.flatMap((block) => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type !== 'image') {
      throw new LlmError(
        `Meridian Antigravity cannot represent ${block.type} content in a tool result`,
        'UNSUPPORTED_CONTENT',
      )
    }
    return [imageContent(block, undefined, images, retained)]
  })
  return [{
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content,
    ...message.isError === true ? { is_error: true } : {},
  }]
}

/**
 * Inline base64 image block.
 *
 * Meridian writes the bytes into that turn's private workspace and replaces the
 * block with an instruction to view that exact path. A public https URL is the
 * only alternative and cannot address the harness host or the LAN, so images are
 * always inlined. `image/jpg` is never produced: the harness attachment media
 * type union is already `image/png|jpeg|webp|gif`.
 */
function imageContent(block, connection, images, retained) {
  const version = images?.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `Meridian Antigravity request image ${block.attachment.attachmentId} was not resolved to bytes`,
      'INVALID_REQUEST',
    )
  }
  const base64 = Buffer.from(version.data).toString('base64')
  retained.push(new RetainedImage(block, Buffer.byteLength(base64)))
  return {
    type: 'image',
    source: { type: 'base64', media_type: version.mediaType, data: base64 },
  }
}

/** Historical arguments that Messages cannot represent use an empty input. */
function parseToolInput(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/**
 * Enforce Meridian's 8 MiB request cap before the bytes leave the harness.
 *
 * When images are what overflow the budget this throws `IMAGE_OFFLOAD_REQUIRED`
 * with the number of oldest occurrences that must go, which is the one failure
 * `dsh-compaction-image-offload` knows how to repair by recording an offload
 * decision and retrying the step. Without that integration the alternative
 * would be a raw 413 or a silent truncation, and truncating a tool call or a
 * schema result locally is exactly what the contract forbids.
 *
 * @param serialized - the result of {@link serializeRequest}.
 * @param connection - resolved adapter options.
 * @returns the measured request size in bytes.
 */
export function enforceRequestBudget(serialized, connection) {
  const size = Buffer.byteLength(JSON.stringify(serialized.body))
  if (size <= connection.maxRequestBytes) return size
  const retained = serialized.retained
  if (retained.length === 0) {
    throw new LlmError(
      `Meridian Antigravity request is ${size} bytes, over the ${connection.maxRequestBytes}-byte cap, and carries no image to offload`,
      'INVALID_REQUEST',
    )
  }
  const excess = size - connection.maxRequestBytes
  let reclaimed = 0
  let count = 0
  for (const image of retained) {
    if (reclaimed >= excess) break
    reclaimed += image.bytes
    count += 1
  }
  count = Math.min(Math.max(count, 1), retained.length)
  throw new LlmError(
    `Meridian Antigravity request is ${size} bytes, over the ${connection.maxRequestBytes}-byte cap;`
    + ` ${count} of ${retained.length} retained image occurrence(s) must be offloaded`,
    'IMAGE_OFFLOAD_REQUIRED',
    { offloadImages: count },
  )
}
