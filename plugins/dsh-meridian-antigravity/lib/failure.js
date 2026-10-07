/**
 * The Meridian failures that only their message text can tell apart.
 *
 * All three arrive through the same transports as ordinary failures. A blocked
 * generation is either a stream cut before `message_stop` or a 502 carrying the
 * policy text, and neither is distinguishable from a transport fault without
 * reading the detail. A spent tool batch is a 409 whose status Meridian also
 * uses for the genuine transcript conflict, so the code alone would either retry
 * a turn that cannot succeed or refuse one that can be repaired. A dropped agent
 * connection is a 502 that hides inside the generic server class.
 *
 * Pure module: no harness imports, so it is unit-testable offline.
 *
 * @module @local/dsh-meridian-antigravity/lib/failure
 */

/**
 * A generation the backend refused to produce.
 *
 * The CLI reports this as an interrupted stream carrying Google's policy text,
 * and Meridian's ledger records the same block as a plain HTTP 502, so without
 * this test it is classified `TRANSPORT` on one path and retryable `SERVER` on
 * the other. Retrying cannot help either way: the bytes are identical, so the
 * block is identical, and the retry only reaches Meridian's spent-batch refusal.
 *
 * The third alternation names the model output on purpose. `could not be
 * generated` alone also appears in ordinary gateway prose, and this test now
 * runs against whole HTTP error bodies rather than only stream details.
 */
const CONTENT_FILTER = /blocked by content safety filters|Prohibited Use policy|model output could not be generated/iu

/**
 * Meridian's own subscriber to the `agy` process falling behind and dropping.
 *
 * This is the connector's most frequent live failure — 22 occurrences in the
 * ledger, every one of them "subscriber fell behind updates, stalled for Ns".
 * It used to be indistinguishable from a genuine 5xx because both were `SERVER`,
 * which made it impossible to count. It keeps `SERVER`'s retryability; only the
 * code is new.
 */
const AGENT_INTERRUPTED = /connection to the agent was interrupted/iu

/**
 * Meridian's marker for a continuation whose batch it has already consumed.
 *
 * This is the *recoverable* half of the 409: the ids matched and the results were
 * accepted, so the only thing missing is the reply. Meridian's own text names the
 * remedy — "append the subsequent assistant response before continuing" — which
 * nothing can generate, because the generation is what was blocked.
 *
 * This regex is the only trigger for the notice `lib/transport.js` commits in
 * place of a missing reply, and that notice is what makes the next request an
 * ordinary call. If Meridian rewords "already consumed", the repair stops running
 * and nothing reports it: the conversation is simply left stuck again. Prefer
 * adding an alternation here to loosening the match.
 */
const SPENT_BATCH = /already consumed/iu

/**
 * @param detail - a stream-cut or error detail.
 * @returns whether the backend blocked the generation rather than failing to carry it.
 */
export function isContentFiltered(detail) {
  return CONTENT_FILTER.test(String(detail ?? ''))
}

/**
 * @param message - a provider error message.
 * @returns whether Meridian consumed the batch and is waiting for a reply.
 */
export function isSpentBatch(message) {
  return SPENT_BATCH.test(String(message ?? ''))
}

/**
 * @param detail - a stream-cut or HTTP error detail.
 * @returns whether Meridian lost its connection to the agent mid-request.
 */
export function isAgentInterrupted(detail) {
  return AGENT_INTERRUPTED.test(String(detail ?? ''))
}

/**
 * The text committed when a continuation is refused because the transcript
 * changed after Meridian delivered it.
 *
 * The harness rewrote a message the provider had already been given — a
 * tool-result prune or a compaction between a tool call and its result — so
 * Meridian refuses that continuation deterministically and would refuse it
 * again. Committing this closes the turn and lets the conversation continue.
 *
 * @param results - how many tool results the refused continuation carried, when known.
 * @returns the notice text.
 */
export function rewrittenContinuationNotice(results) {
  const batch = typeof results === 'number' && results > 0
    ? `This turn's batch of ${results} tool result${results === 1 ? '' : 's'} was delivered`
    : 'This turn\'s tool batch was delivered'
  return `${NOTICE_PREFIX} ${batch}, but the transcript changed after Meridian received it, so the`
    + ' continuation was refused. That happens when a message the provider had already been given is'
    + ' rewritten mid-turn — by the tool-result pruner or by a compaction — and Meridian pins a'
    + ' continuation to the history it already delivered. This notice closes the turn so the'
    + ' conversation can continue. Re-issue your last instruction; the work above is intact.'
}

/**
 * The prefix marking text this connector authored rather than a model.
 *
 * A notice arrives as an ordinary assistant message and completes its turn, so
 * anything that records turns has to distinguish it from narration.
 * `dsh-dd35-preset`'s turn capture treats a turn carrying this marker as
 * non-canon and matches the string. It occurs in two shapes: a notice that is the
 * whole turn, and a notice appended after a reply the backend cut short. A guard
 * must therefore look for the marker anywhere in the text, not only at the start.
 * Changing this string means changing that list too.
 */
export const NOTICE_PREFIX = '[Meridian Antigravity]'

/**
 * The text that stands in for a reply Meridian will never produce.
 *
 * Committing this as the assistant turn moves the trailing tool results behind an
 * assistant message, which is exactly what turns the next request back into an
 * ordinary call instead of a spent continuation. It says what happened and what
 * to do, because it is the only record the player gets for the lost turn.
 *
 * @param results - how many tool results Meridian consumed, when known.
 * @returns the notice text.
 */
export function spentBatchNotice(results) {
  const batch = typeof results === 'number' && results > 0
    ? `The batch of ${results} tool result${results === 1 ? '' : 's'} for this turn was consumed`
    : 'This turn\'s tool batch was consumed'
  return `${NOTICE_PREFIX} ${batch} by a generation the backend blocked and never completed, so no`
    + ' reply exists for it. This notice stands in for that missing reply so the conversation can'
    + ' continue. Nothing was lost and no tool ran twice — re-issue your last instruction.'
}

/**
 * The text appended to a reply the backend blocked *after* it had begun.
 *
 * A blocked generation can arrive late: the model produces and streams a whole
 * answer, and the filter fails the turn afterwards. That text was already
 * delivered, so it is kept and this notice is appended to it. It is written as a
 * separate block rather than continued from the model's last sentence, because
 * the cut can land mid-word.
 *
 * @param results - how many tool results Meridian consumed, when known.
 * @returns the notice text.
 */
export function blockedReplyNotice(results) {
  const batch = typeof results === 'number' && results > 0
    ? `The batch of ${results} tool result${results === 1 ? '' : 's'} for this turn was consumed`
    : 'This turn\'s tool batch was consumed'
  return `${NOTICE_PREFIX} ${batch} and the backend's content filter stopped the reply after it had`
    + ' already begun, so the text above may be incomplete and no further reply exists for it.'
    + ' This notice closes the turn so the conversation can continue. Nothing was lost and no tool'
    + ' ran twice — continue from the text above, or re-issue if it looks cut off.'
}
