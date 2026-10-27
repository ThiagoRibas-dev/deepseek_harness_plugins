/**
 * Rotation state and member selection for the model-rotation connector.
 *
 * Selection is one pure-ish operation over an in-memory state map: no I/O, no
 * harness imports, and the clock/random source are injectable so the offline
 * suite can pin both. The adapter owns failure classification; this module only
 * records what it is told.
 *
 * State has three parts per pool:
 * - a round-robin cursor,
 * - per-member health (cooldown, consecutive failures, last use),
 * - a per-session pin used by the `turn` cadence.
 *
 * A cooled-down member is not removed: it is tried after every healthy member,
 * so a pool whose members are all cooling still attempts one request instead of
 * refusing locally.
 *
 * @module @local/dsh-model-rotation/rotation
 */

/** Failure codes that mark an endpoint unhealthy for a cooldown period. */
export const COOLING_CODES = Object.freeze(new Set([
  'AUTH',
  'MISSING_CREDENTIAL',
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'NETWORK',
  'EMPTY_RESPONSE',
  'PI_AI_ERROR',
  'UNKNOWN',
]))

/**
 * Whether one failure should cool its member down.
 * @param failure - normalized `{ code, status }` failure.
 * @returns whether the member is considered unhealthy after this failure.
 */
export function errorCools(failure) {
  const status = failure?.status
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) return true
  return COOLING_CODES.has(failure?.code)
}

/** Whether one failure is worth trying another member at all. */
export function errorWorthFailover(failure) {
  // Aborting is the caller's decision, and every other failure is either
  // endpoint-specific or worth asking another endpoint about. The adapter
  // refuses failover after output has been committed regardless.
  return failure?.code !== 'ABORTED' && failure?.code !== 'MANUAL_ABORT'
}

/** Highest number of per-session pins kept per pool before the oldest is dropped. */
const MAX_SESSION_PINS = 512

/**
 * Create a rotation engine.
 * @param options - optional `now` and `random` injections for deterministic tests.
 * @returns the engine API.
 */
export function createRotationEngine({ now = Date.now, random = Math.random } = {}) {
  /** @type {Map<string, {cursor: number, members: Map<string, any>, sessions: Map<string, any>}>} */
  const state = new Map()

  /** Read (or create) one pool's mutable state. */
  function poolState(poolKey) {
    let entry = state.get(poolKey)
    if (entry === undefined) {
      entry = { cursor: 0, members: new Map(), sessions: new Map() }
      state.set(poolKey, entry)
    }
    return entry
  }

  /** Read (or create) one member's health record. */
  function memberState(entry, memberKey) {
    let record = entry.members.get(memberKey)
    if (record === undefined) {
      record = {
        lastUsed: 0,
        lastSuccess: 0,
        failures: 0,
        cooldownUntil: 0,
        lastCode: undefined,
        lastMessage: undefined,
      }
      entry.members.set(memberKey, record)
    }
    return record
  }

  /** Drop the oldest session pins once the cap is crossed. */
  function trimSessions(entry) {
    if (entry.sessions.size <= MAX_SESSION_PINS) return
    const ordered = [...entry.sessions.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    for (let index = 0; index < ordered.length - MAX_SESSION_PINS; index += 1) {
      entry.sessions.delete(ordered[index][0])
    }
  }

  /** Fisher-Yates using the injected random source. */
  function shuffle(values) {
    const copy = [...values]
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1))
      const held = copy[index]
      copy[index] = copy[swap]
      copy[swap] = held
    }
    return copy
  }

  /**
   * Order the healthy members by the pool's strategy, starting at the cursor.
   * @param pool - resolved pool.
   * @param healthy - members not cooling down.
   * @param cursor - current round-robin cursor.
   * @returns the ordered members.
   */
  function strategyOrder(pool, healthy, cursor) {
    switch (pool.strategy) {
      case 'fill-first':
        return [...healthy]
      case 'least-recently-used': {
        const entry = poolState(pool.key)
        return [...healthy].sort((left, right) => {
          const leftUsed = entry.members.get(left.key)?.lastUsed ?? 0
          const rightUsed = entry.members.get(right.key)?.lastUsed ?? 0
          if (leftUsed !== rightUsed) return leftUsed - rightUsed
          return healthy.indexOf(left) - healthy.indexOf(right)
        })
      }
      case 'random':
        return shuffle(healthy)
      case 'round-robin':
      default: {
        const offset = healthy.length === 0 ? 0 : cursor % healthy.length
        return [...healthy.slice(offset), ...healthy.slice(0, offset)]
      }
    }
  }

  return {
    /**
     * Choose the order of members for one request. The first entry is the
     * primary; the rest are failover candidates in order.
     *
     * The operation advances the round-robin cursor when the cadence calls for
     * it (every request, or once per new turn), so a failover loop within one
     * request always walks the same ordered list.
     *
     * @param input - pool, session identity, and the current turn (when known).
     * @returns the ordered members plus whether the primary came from a turn pin.
     */
    plan({ pool, sessionId, turn }) {
      const entry = poolState(pool.key)
      const nowMs = now()
      const healthy = []
      const cooling = []
      for (const member of pool.members) {
        const record = entry.members.get(member.key)
        const until = record?.cooldownUntil ?? 0
        if (until > nowMs) cooling.push({ member, until })
        else healthy.push(member)
      }
      cooling.sort((left, right) => left.until - right.until)

      const sessionKey = sessionId === undefined ? undefined : String(sessionId)
      const session = sessionKey === undefined ? undefined : entry.sessions.get(sessionKey)
      const baseOrder = strategyOrder(pool, healthy, entry.cursor)
      let primary
      let pinned = false

      if (pool.cadence === 'turn' && baseOrder.length > 0) {
        const pinnedKey = session?.memberKey
        if (pinnedKey !== undefined
          && (turn === undefined || session?.turn === turn)
          && healthy.some(member => member.key === pinnedKey)) {
          primary = healthy.find(member => member.key === pinnedKey)
          pinned = true
        } else {
          primary = baseOrder[0]
          // A new turn (or the first request of a session) advances the
          // cursor exactly once; later steps of this turn reuse the pin.
          entry.cursor += 1
        }
      } else {
        primary = baseOrder[0]
        if (pool.cadence === 'request') entry.cursor += 1
      }

      const order = []
      if (primary !== undefined) order.push(primary)
      for (const member of baseOrder) {
        if (member.key !== primary?.key) order.push(member)
      }
      for (const cooled of cooling) order.push(cooled.member)

      if (sessionKey !== undefined && primary !== undefined) {
        entry.sessions.set(sessionKey, {
          turn,
          memberKey: primary.key,
          lastUsedAt: nowMs,
        })
        trimSessions(entry)
      }

      return {
        order,
        pinned,
        allCooling: healthy.length === 0 && order.length > 0,
        coolingCount: cooling.length,
      }
    },

    /**
     * Record that one member is about to answer a request.
     * @param input - pool and member identities.
     */
    begin({ pool, member }) {
      const entry = poolState(pool.key)
      memberState(entry, member.key).lastUsed = now()
    },

    /**
     * Record a successful request.
     * @param input - pool and member identities.
     */
    recordSuccess({ pool, member }) {
      const entry = poolState(pool.key)
      const record = memberState(entry, member.key)
      record.failures = 0
      record.cooldownUntil = 0
      record.lastSuccess = now()
      record.lastCode = undefined
      record.lastMessage = undefined
    },

    /**
     * Record one failed attempt and cool the member down when its failure
     * classifies as endpoint health rather than request shape.
     * @param input - pool, member, normalized failure, and the pool cooldown.
     */
    recordFailure({ pool, member, failure }) {
      const entry = poolState(pool.key)
      const record = memberState(entry, member.key)
      record.failures += 1
      record.lastCode = failure?.code
      record.lastMessage = failure?.message
      if (errorCools(failure) && pool.cooldownMs > 0) {
        record.cooldownUntil = now() + pool.cooldownMs
      }
      // A session pin is not cleared here: another session may legitimately be
      // pinned to the same member. `plan()` treats a cooling member as
      // unpinnable and chooses a new primary for that session.
    },

    /**
     * Forget one session's turn pin.
     * @param sessionId - session identity.
     */
    forgetSession(sessionId) {
      const key = String(sessionId)
      for (const entry of state.values()) entry.sessions.delete(key)
    },

    /**
     * Health snapshot for the session log's footer.
     * @param pools - currently configured pools, used to label records.
     * @returns one row per configured pool with member state.
     */
    snapshot(pools) {
      const nowMs = now()
      const rows = []
      for (const pool of pools.values()) {
        const entry = state.get(pool.key)
        const members = pool.members.map((member) => {
          const record = entry?.members.get(member.key)
          return {
            name: member.name,
            key: member.key,
            model: member.model,
            cooling: (record?.cooldownUntil ?? 0) > nowMs,
            cooldownRemainingMs: Math.max(0, (record?.cooldownUntil ?? 0) - nowMs),
            failures: record?.failures ?? 0,
            lastCode: record?.lastCode,
            lastMessage: record?.lastMessage,
            lastUsed: record?.lastUsed ?? 0,
            lastSuccess: record?.lastSuccess ?? 0,
          }
        })
        rows.push({ pool: pool.key, displayName: pool.displayName, members })
      }
      return rows
    },

    /** Drop every pool's state; used by tests between cases. */
    reset() {
      state.clear()
    },
  }
}
