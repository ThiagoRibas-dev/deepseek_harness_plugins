/**
 * Minimal stand-in for schemastery's builder chain, used only by smoke.mjs.
 *
 * The suite checks module wiring, not schema semantics — those are validated
 * separately against the real library, which is why nothing here validates
 * anything. Every property access and every call returns another link in the
 * chain, so `z.number().min(0).max(1).default(0).volatile()` is inert rather
 * than a type error.
 */
function schema() {
  return new Proxy(() => schema(), {
    get: (_target, property) => (property === 'then' || typeof property === 'symbol' ? undefined : schema()),
    apply: () => schema(),
  })
}

export default new Proxy({}, { get: () => schema() })
