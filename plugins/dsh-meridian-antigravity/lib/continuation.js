/**
 * Diagnose a continuation that Meridian cannot accept.
 *
 * Meridian's continuation model assumes it issued the tool call whose result it
 * is receiving: it keeps a flat map of tool id to the run that delivered it
 * (`antigravityRuntime.ts:391`) and a persisted set of ids it has already
 * consumed, and it looks the request's trailing tool results up in both. Ids it
 * did not issue are in neither, so the request is not a continuation it can
 * recognise, and it answers 409 with a message that reads like a transcript
 * conflict.
 *
 * That happens when the model is changed while a tool batch is open: the batch
 * was issued by the previous provider, and the harness routes its continuation
 * to the newly selected one. The connector cannot prevent it, because by the
 * time the request arrives the routing decision has already been made. It can
 * explain it, which is what this module is for.
 *
 * Pure module: no harness imports, so it is unit-testable offline.
 *
 * @module @local/dsh-meridian-antigravity/lib/continuation
 */

/** Prefix Meridian puts on every tool id it issues (`antigravityRuntime.ts:246`). */
export const MERIDIAN_TOOL_ID_PREFIX = 'toolu_agy_'

/**
 * @param id - a tool id from a message.
 * @returns whether Meridian issued it.
 */
export function isMeridianToolId(id) {
  return typeof id === 'string' && id.startsWith(MERIDIAN_TOOL_ID_PREFIX)
}

/** Tool-call ids an assistant message requests. */
function callIds(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return []
  return message.content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'tool-call'
      && typeof block.id === 'string')
    .map(block => block.id)
}

/**
 * Which provider issued each call, read from the assistant message that made it.
 *
 * @param messages - harness-derived messages, in order.
 * @returns a map of tool id to `{ provider, model }`.
 */
function issuers(messages) {
  const found = new Map()
  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    const source = message.source
    if (source === null || typeof source !== 'object') continue
    for (const id of callIds(message)) {
      found.set(id, { provider: source.provider, model: source.model })
    }
  }
  return found
}

/**
 * Describe the tool results Meridian would examine for this request.
 *
 * Meridian only looks at the messages after the last assistant message, so the
 * analysis is limited to the same window. History before it is context and is
 * not looked up.
 *
 * @param messages - harness-derived messages, in order.
 * @returns `undefined` when the request is not a continuation, otherwise the
 *   counts and the foreign ids with their issuing provider when known.
 */
export function analyzeContinuation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  let lastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') { lastAssistant = index; break }
  }

  const trailing = messages.slice(lastAssistant + 1).filter(message => message?.role === 'tool')
  if (trailing.length === 0) return undefined

  const owners = issuers(messages)
  const foreign = []
  for (const message of trailing) {
    const id = message.toolCallId
    if (typeof id !== 'string' || isMeridianToolId(id)) continue
    const owner = owners.get(id)
    foreign.push({
      id,
      ...owner?.provider === undefined ? {} : { provider: owner.provider },
      ...owner?.model === undefined ? {} : { model: owner.model },
    })
  }

  return { results: trailing.length, foreign }
}

/**
 * A sentence explaining why the request cannot succeed, or `undefined` when the
 * analysis found nothing to explain.
 *
 * @param diagnosis - result of {@link analyzeContinuation}.
 * @returns an appended explanation, leading with a space.
 */
export function continuationHint(diagnosis) {
  if (diagnosis === undefined || diagnosis.foreign.length === 0) return undefined
  const providers = [...new Set(diagnosis.foreign.map(item => item.provider).filter(Boolean))]
  const issuer = providers.length > 0 ? providers.join(', ') : 'another provider'
  const ids = diagnosis.foreign.slice(0, 2).map(item => item.id).join(', ')
  const more = diagnosis.foreign.length > 2 ? `, +${diagnosis.foreign.length - 2} more` : ''
  return ` Diagnosis: this continuation answers ${diagnosis.foreign.length} tool call(s) issued by`
    + ` ${issuer}, not by meridian-antigravity, so Meridian cannot recognise the batch.`
    + ' A model change applied while a tool batch is open routes that batch\'s continuation to the new'
    + ' provider; Meridian can only continue a batch it delivered. Let the batch finish on the provider'
    + ` that issued it, or switch models when no tool call is awaiting a result. (ids: ${ids}${more})`
}
