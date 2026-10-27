/**
 * Raw request-body overrides for one member.
 *
 * Applied by the member provider inside pi-ai's `onPayload` hook, after the
 * protocol has built the complete body and before it is sent. It can add a
 * field, replace one, or remove one; headers, auth, URL, and streaming remain
 * pi-ai's business. A rename is a set of the new key plus an unset of the old
 * one.
 *
 * This module is pure so the offline suite can exercise the transform.
 *
 * @module @local/dsh-model-rotation/body
 */

/** Whether one override object carries any work. */
export function hasBodyOverrides(overrides) {
  if (overrides === undefined || overrides === null) return false
  const set = overrides.set
  const unset = overrides.unset
  const hasSet = typeof set === 'object' && set !== null && !Array.isArray(set) && Object.keys(set).length > 0
  const hasUnset = Array.isArray(unset) && unset.length > 0
  return hasSet || hasUnset
}

/**
 * Apply one member's overrides to a body object.
 *
 * The input is never mutated. Non-object payloads are returned unchanged,
 * because a protocol that does not build a JSON object owns its own body shape.
 *
 * @param payload - the body built by the protocol.
 * @param overrides - `{ set?: object, unset?: string[] }`.
 * @returns the effective body.
 */
export function applyBodyOverrides(payload, overrides) {
  if (!hasBodyOverrides(overrides)) return payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const next = { ...payload }
  const set = overrides.set
  if (typeof set === 'object' && set !== null && !Array.isArray(set)) {
    for (const [key, value] of Object.entries(set)) {
      if (key.length > 0) next[key] = value
    }
  }
  if (Array.isArray(overrides.unset)) {
    for (const key of overrides.unset) {
      if (typeof key === 'string' && key.length > 0) delete next[key]
    }
  }
  return next
}
