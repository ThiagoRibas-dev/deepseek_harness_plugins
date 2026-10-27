/**
 * Rewrite durable assistant messages for one member dispatch.
 *
 * The session records the *pool* as the provider (`model-rotation`) and the
 * *pool key* as the model, because that is what the user selected. The pi-ai
 * adapter that actually answers is registered under an internal member key
 * (`mr.<pool>.<member>`), and its replay validation requires the stored
 * envelope's provider/model to equal the assistant message source. So a request
 * for a member must translate the source of every assistant message this
 * connector produced back to the member that produced it.
 *
 * This is what makes replay work at all through a rotating route. When the
 * producing member’s wire protocol differs from the target member’s, the stored
 * native metadata (thinking signatures, thought signatures) is not portable, so
 * it is dropped and the message degrades to provider-neutral content — the same
 * fallback the pi-ai adapter applies to foreign history.
 *
 * @module @local/dsh-model-rotation/replay
 */

/** Internal member-key prefix used by `lib/profiles.js`. */
export const MEMBER_KEY_PREFIX = 'mr.'

/** Whether a provider key names a rotation member. */
function isMemberKey(value) {
  return typeof value === 'string' && value.startsWith(MEMBER_KEY_PREFIX)
}

/** Read the versioned pi-ai replay response half without trusting its shape. */
function replayResponse(replayState) {
  if (typeof replayState !== 'object' || replayState === null) return undefined
  const response = replayState.response
  if (typeof response !== 'object' || response === null) return undefined
  if (response.kind !== 'pi-ai' || response.version !== 2) return undefined
  for (const key of ['api', 'provider', 'model']) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return undefined
  }
  return response
}

/**
 * Prepare one request's messages for a member dispatch.
 *
 * @param messages - the request's messages, possibly deep-frozen.
 * @param input - route the user selected, target member, and replay mode.
 * @returns the messages to dispatch plus counts for the log/diagnostics.
 */
export function prepareMessagesForMember(messages, { route, member, mode = 'auto' }) {
  let rewritten = 0
  let neutralized = 0
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const source = message.source
    if (source?.kind !== 'model' || source.provider !== route) return message
    const state = source.replayState
    if (state === undefined) return message
    const response = replayResponse(state)
    // A state this connector did not write belongs to whatever provider the
    // session used before. Leave it alone: the pi-ai adapter degrades it.
    if (response === undefined || !isMemberKey(response.provider)) return message
    const portable = mode !== 'neutral' && (mode === 'preserve' || response.api === member.api)
    if (!portable) {
      neutralized += 1
      return {
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      }
    }
    rewritten += 1
    return {
      ...message,
      source: {
        kind: 'model',
        provider: response.provider,
        model: response.model,
        replayState: state,
      },
    }
  })
  const changed = rewritten + neutralized > 0
  return {
    messages: changed ? next : messages,
    rewritten,
    neutralized,
  }
}
