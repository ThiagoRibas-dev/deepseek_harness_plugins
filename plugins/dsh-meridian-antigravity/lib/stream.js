/**
 * Meridian's Anthropic Messages event stream, translated into harness chunks.
 *
 * The one behavior that must not be lost here is the streaming policy the
 * contract prescribes: show text as it arrives, but **hold every `tool_use`
 * until `message_stop`**. Text that follows the first tool block stays held with
 * it, so event order survives. The harness executes tools from assembled
 * `block-end` chunks, so a tool block that is never emitted is a tool that never
 * runs — which is exactly what makes an interrupted stream safe.
 *
 * The translator also remembers precisely what it already showed, which is what
 * lets a replay of the saved answer resume instead of restarting.
 *
 * @module @local/dsh-meridian-antigravity/lib/stream
 */

import { replayDiverged, streamInterrupted } from './errors.js'

/** Decode one SSE byte stream into parsed `data:` payloads. */
export async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = dataOf(frame)
      if (data !== undefined) yield parseFrame(data)
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  const tail = dataOf(buffer)
  if (tail !== undefined) yield parseFrame(tail)
}

function parseFrame(data) {
  try {
    return JSON.parse(data)
  } catch (error) {
    throw streamInterrupted(`unparseable SSE payload (${errorMessage(error)})`)
  }
}

function dataOf(frame) {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  return data.length === 0 ? undefined : data
}

/** One content block buffered until `message_stop`. */
class HeldBlock {
  constructor(index, kind) {
    this.index = index
    this.kind = kind
    this.text = ''
    this.id = ''
    this.name = ''
    this.arguments = ''
  }
}

/**
 * Translate one assistant message's events, holding tools until the stream
 * reaches `message_stop`.
 */
export class MeridianTranslator {
  #messageId
  #holding = false
  #held = []
  #heldByIndex = new Map()
  /** Text shown per index, for the replay prefix check. */
  #streamed = new Map()
  #openTextIndex
  #lastShownIndex
  #usage
  #stopReason
  #finished = false
  #replayed = false
  #contentSeen = false

  /** Identity and progress of the response, for recovery decisions. */
  get state() {
    return {
      messageId: this.#messageId,
      holding: this.#holding,
      finished: this.#finished,
      streamedText: this.#shownText(),
    }
  }

  /** Whether an answer was already shown that a saved reply could extend. */
  get resumable() {
    return this.#messageId !== undefined || this.#holding || this.#streamed.size > 0
  }

  /**
   * Mark this response as a saved answer. A replayed answer is not new
   * subscription usage, so it contributes no usage chunk.
   */
  markReplayed(replayed) {
    this.#replayed = this.#replayed || replayed
  }

  /**
   * Feed one parsed SSE event.
   * @param event - decoded `data:` payload.
   * @returns the chunks to emit now; empty while output is held.
   */
  push(event) {
    switch (typeof event?.type === 'string' ? event.type : undefined) {
      case 'message_start': {
        if (typeof event.message?.id === 'string') this.#messageId = event.message.id
        this.#absorbUsage(event.message?.usage)
        return []
      }
      case 'content_block_start': return this.#startBlock(event)
      case 'content_block_delta': return this.#delta(event)
      case 'content_block_stop': return this.#stopBlock(event)
      case 'message_delta': {
        if (typeof event.delta?.stop_reason === 'string') this.#stopReason = event.delta.stop_reason
        this.#absorbUsage(event.usage)
        return []
      }
      case 'message_stop': return this.#complete()
      case 'ping': return []
      case 'error': throw streamInterrupted(event.error?.message ?? 'Meridian Antigravity reported an in-band stream error')
      default: return []
    }
  }

  #startBlock(event) {
    const index = requireIndex(event.index)
    const block = event.content_block ?? {}
    if (block.type === 'tool_use') {
      this.#holding = true
      this.#openTextIndex = undefined
      const held = new HeldBlock(index, 'tool')
      if (typeof block.id === 'string') held.id = block.id
      if (typeof block.name === 'string') held.name = block.name
      this.#held.push(held)
      this.#heldByIndex.set(index, held)
      return []
    }
    if (block.type === 'text') {
      // Text after the first tool block is held with it so event order survives.
      if (this.#holding) {
        const held = new HeldBlock(index, 'text')
        this.#held.push(held)
        this.#heldByIndex.set(index, held)
        return []
      }
      this.#openTextIndex = index
      this.#streamed.set(index, '')
      this.#lastShownIndex = index
      return [{ type: 'block-start', index, blockType: 'text' }]
    }
    // This backend exposes no reasoning transcript, so a thinking block is not a
    // channel the harness may build. Hold the slot to keep indices aligned, and
    // emit nothing for it.
    if (this.#holding) {
      const held = new HeldBlock(index, 'ignored')
      this.#held.push(held)
      this.#heldByIndex.set(index, held)
    }
    return []
  }

  #delta(event) {
    const index = requireIndex(event.index)
    const delta = event.delta ?? {}
    if (delta.type === 'input_json_delta') {
      const held = this.#heldByIndex.get(index)
      if (held !== undefined) held.arguments += typeof delta.partial_json === 'string' ? delta.partial_json : ''
      return []
    }
    // No reasoning channel exists on this backend, and a signature is never used.
    if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') return []
    if (delta.type !== 'text_delta') return []
    const text = typeof delta.text === 'string' ? delta.text : ''
    if (text.length === 0) return []
    if (this.#holding) {
      const held = this.#heldByIndex.get(index)
      if (held !== undefined) held.text += text
      return []
    }
    this.#streamed.set(index, `${this.#streamed.get(index) ?? ''}${text}`)
    this.#lastShownIndex = index
    this.#contentSeen = true
    return [{ type: 'text-delta', index, text }]
  }

  #stopBlock(event) {
    const index = requireIndex(event.index)
    if (this.#holding || this.#openTextIndex !== index) return []
    this.#openTextIndex = undefined
    return [{ type: 'block-end', index, block: { type: 'text', text: this.#streamed.get(index) ?? '' } }]
  }

  #complete() {
    this.#finished = true
    return this.#flush()
  }

  /**
   * Close a response the backend cut short, appending a connector note.
   *
   * A blocked generation has no saved answer to recover, and a withheld tool must
   * not be emitted: the model asked for it, but it was never delivered, so it must
   * not run. Ending the assistant turn here is what leaves the transcript in a
   * state the next request can continue from, instead of a spent continuation.
   *
   * Text already shown is closed as its own block rather than discarded, since on
   * a blocked turn it is often most of an answer. The note opens a fresh block at
   * the next index, so a reply cut mid-word does not run into it.
   *
   * No usage is reported. The only usage this stream carried is the partial figure
   * from `message_start`; the terminal totals arrive in `message_delta`, which a
   * cut stream never reaches.
   *
   * @param text - the note to append, authored by the connector.
   * @returns the chunks that close the turn with a normal stop.
   */
  closeWith(text) {
    const chunks = []
    if (this.#openTextIndex !== undefined) {
      const open = this.#openTextIndex
      chunks.push({ type: 'block-end', index: open, block: { type: 'text', text: this.#streamed.get(open) ?? '' } })
      this.#openTextIndex = undefined
    }
    const index = (this.#lastShownIndex ?? -1) + 1
    this.#streamed.set(index, text)
    this.#lastShownIndex = index
    this.#contentSeen = true
    chunks.push({ type: 'block-start', index, blockType: 'text' })
    chunks.push({ type: 'text-delta', index, text })
    chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
    // Held blocks are dropped on purpose: emitting one would execute a tool for a
    // turn whose reply can never be completed.
    this.#held = []
    this.#heldByIndex = new Map()
    this.#holding = false
    this.#finished = true
    chunks.push({ type: 'finish', reason: { kind: 'stop' } })
    return chunks
  }

  /** Emit every held block in stream order, then usage and the terminal finish. */
  #flush() {
    const chunks = []
    for (const held of this.#held) {
      if (held.kind === 'ignored') continue
      if (held.kind === 'text') {
        if (held.text.length > 0) this.#contentSeen = true
        chunks.push({ type: 'block-start', index: held.index, blockType: 'text' })
        if (held.text.length > 0) chunks.push({ type: 'text-delta', index: held.index, text: held.text })
        chunks.push({ type: 'block-end', index: held.index, block: { type: 'text', text: held.text } })
        continue
      }
      this.#contentSeen = true
      chunks.push({ type: 'block-start', index: held.index, blockType: 'tool-call' })
      chunks.push({
        type: 'tool-call-delta',
        index: held.index,
        id: held.id,
        name: held.name,
        argumentsDelta: held.arguments,
      })
      chunks.push({
        type: 'block-end',
        index: held.index,
        block: { type: 'tool-call', id: held.id, name: held.name, arguments: held.arguments },
      })
    }
    this.#held = []
    this.#heldByIndex = new Map()
    this.#holding = false
    if (this.#usage !== undefined && !this.#replayed) chunks.push({ type: 'usage', usage: this.#usage })
    chunks.push(this.#terminalFinish())
    return chunks
  }

  /**
   * The single terminal finish chunk.
   *
   * The harness treats a missing finish as `stop`, and a `stop` with assembled
   * tool calls executes them, so a stream that produced no content at all is
   * reported as the retryable `EMPTY_RESPONSE` error instead of a silent empty
   * success.
   */
  #terminalFinish() {
    const reason = finishReasonOf(this.#stopReason)
    if (reason.kind === 'stop' && !this.#contentSeen) {
      return {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Meridian Antigravity returned a terminal stop with no content',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
    }
    return { type: 'finish', reason }
  }

  #absorbUsage(usage) {
    if (usage === undefined || usage === null) return
    const input = numberOr(usage.input_tokens, 0)
    const output = numberOr(usage.output_tokens, 0)
    const cacheRead = numberOr(usage.cache_read_input_tokens, 0)
    const cacheWrite = numberOr(usage.cache_creation_input_tokens, 0)
    // Usage accumulates from per-step CLI usage for this HTTP response. A cache
    // read stays a separate field and is never subtracted from input twice.
    this.#usage = {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
      ...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
    }
  }

  #shownText() {
    return [...this.#streamed.values()].join('')
  }

  /**
   * Resume from a saved non-streaming answer after an interrupted stream.
   *
   * Only the missing suffix and the withheld blocks are emitted, and the answer
   * must extend exactly what was already shown: splicing a different answer into
   * visible output would be worse than failing.
   *
   * @param message - the saved Messages response object.
   * @returns the chunks that complete the response.
   */
  resume(message) {
    if (this.#messageId !== undefined && typeof message.id === 'string' && message.id !== this.#messageId) {
      throw replayDiverged(`saved answer ${message.id} is not the streamed message ${this.#messageId}`)
    }
    if (typeof message.id === 'string') this.#messageId = message.id
    const blocks = Array.isArray(message.content) ? message.content : []
    const chunks = []
    let startAt
    if (this.#holding) {
      startAt = this.#held.length === 0 ? blocks.length : this.#held[0].index
    } else if (this.#openTextIndex !== undefined) {
      const openIndex = this.#openTextIndex
      const shown = this.#streamed.get(openIndex) ?? ''
      const saved = typeof blocks[openIndex]?.text === 'string' ? blocks[openIndex].text : ''
      if (!saved.startsWith(shown)) {
        throw replayDiverged(`saved text does not start with the ${shown.length} character(s) already shown`)
      }
      chunks.push({ type: 'text-delta', index: openIndex, text: saved.slice(shown.length) })
      chunks.push({ type: 'block-end', index: openIndex, block: { type: 'text', text: saved } })
      startAt = openIndex + 1
    } else {
      startAt = (this.#lastShownIndex ?? -1) + 1
    }
    this.#held = []
    this.#heldByIndex = new Map()
    this.#holding = false
    this.#openTextIndex = undefined
    for (let index = Math.max(startAt, 0); index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block?.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text.length > 0) this.#contentSeen = true
        chunks.push({ type: 'block-start', index, blockType: 'text' })
        if (text.length > 0) chunks.push({ type: 'text-delta', index, text })
        chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
        continue
      }
      if (block?.type !== 'tool_use') continue
      this.#contentSeen = true
      const argumentsJson = JSON.stringify(block.input ?? {})
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
      chunks.push({ type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson })
      chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } })
    }
    this.#absorbUsage(message.usage)
    if (this.#usage !== undefined && !this.#replayed) chunks.push({ type: 'usage', usage: this.#usage })
    if (typeof message.stop_reason === 'string') this.#stopReason = message.stop_reason
    chunks.push(this.#terminalFinish())
    this.#finished = true
    return chunks
  }
}

/** Map Meridian's stop reason onto the harness finish vocabulary. */
export function finishReasonOf(stopReason) {
  switch (stopReason) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

function requireIndex(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw streamInterrupted(`content block index was ${JSON.stringify(value)}`)
  }
  return value
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
