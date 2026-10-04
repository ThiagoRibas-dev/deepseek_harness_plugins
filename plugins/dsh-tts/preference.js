/**
 * The per-chat auto-speak preference, owned by this plugin.
 *
 * ## Why this is no longer a session projection
 *
 * It was one, and it destroyed session history. The old implementation did:
 *
 *     session.append('tts/preference', { auto })      // ← DO NOT DO THIS AGAIN
 *
 * `'tts/preference'` is outside the harness's generated `KNOWN_SESSION_EVENT_TYPES`,
 * and the JSONL persistence **read** path refuses any stored row of an unknown type
 * unless its envelope carries the `ignorable` marker:
 *
 *     session "<id>" contains event type "tts/preference" (seq 6669) unknown to this
 *     harness and not marked ignorable; refusing to interpret the log — it was
 *     likely written by a newer harness
 *
 * That refusal is correct — an unknown *required* event may change how the rest of
 * the log is reconstructed, so the reader fails closed. The trap is on the write
 * side, and it is not obvious:
 *
 *   - `Session.append()` **cannot set `ignorable`**. Its only option object is
 *     surface metadata (`surfaceOp`, `sourceEventSeqs`). The marker is reachable
 *     exclusively through the seed/restore/import paths — `Session.create`,
 *     `Session.fromRestore`, the JSONL decoder — never through an append.
 *   - `@deepseek-ai/dsh-session`'s `known-event-types.ts` names the marker as *"the
 *     compatibility mechanism"* for downstream plugins. As of the harness this
 *     bundle runs against, no downstream writer can reach it.
 *   - So an out-of-repo plugin **cannot legally append a custom durable event at
 *     all**. The append-side validator that accepts one (`Session.append` only
 *     inspects known surface types and `request/header`) is not the seam that
 *     decides; the persistence reader is.
 *
 * The failure is invisible when it happens and only appears on the *next load*, as
 * a session whose entire history is unreadable. Two sessions were lost to it before
 * it was understood. The stored rows can be repaired in place by adding the marker
 * they should always have carried — but the write path here is fixed, so that is
 * recovery, not prevention; the first affected conversation was archived instead.
 * See `docs/dsh/global-plugins.md`, "The session-projection route poisoned the log",
 * and `docs/dsh/session-05161aa9-report.md`.
 *
 * **Rule for anything added here later: never call `session.append()` with a type
 * the harness does not ship.** Treat an unknown event type as unavailable, because
 * it is. A per-chat preference is not worth a conversation transcript.
 *
 * ## What replaced it, and what was given up
 *
 * A JSON file under the plugin's own `dataRoot`, keyed by session id. The service
 * surface is unchanged (`service.preference`, `service.setChatAuto`), so
 * `plugin.js`, `route.js` and the browser half are untouched — the client has always
 * read and written through `GET/POST {prefix}/preference` rather than a projection
 * wire view.
 *
 * The one semantic loss: a **forked** chat no longer carries its own setting. A fork
 * gets a new session id and inherits the profile default again. That is coherent on
 * its own terms — a new conversation starts from the default — and the property was
 * not actually available, since the only mechanism that provided it bricks the log.
 *
 * The module deliberately imports nothing from `@deepseek-ai/*`: those resolve under
 * the Host's plugin loader but not under plain `node`, and this unit has to stay
 * testable offline. That is also why the store is a plain file rather than a
 * harness storage domain.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The file, inside the plugin's data root, that holds every chat's override. */
export const PREFERENCE_FILE = 'preferences.json'

/** Written into the file so a future format change can be detected rather than guessed. */
export const PREFERENCE_FORMAT_VERSION = 1

/**
 * A tiny durable map of `sessionId → boolean`, kept in memory and mirrored to disk.
 *
 * State first, file second, on purpose: a write failure must not take the choice
 * away for the rest of the process, and a corrupt file must not stop the plugin from
 * starting. Both degrade to a warning, because a preference is not worth an error
 * path into `apply()`.
 *
 * @param options.file - absolute path of the JSON file.
 * @param options.logger - optional `{ warn }`; a failure is reported once, not per call.
 * @returns a store with `read`, `write`, `snapshot` and the resolved `file`.
 */
export function createPreferenceStore({ file, logger } = {}) {
  /** `undefined` means "not loaded yet"; the file is read at most once per process. */
  let cache
  let warned = false

  const warn = (message) => {
    if (warned) return
    warned = true
    logger?.warn?.(`tts: ${message}`)
  }

  /** Read the file once, keeping only well-formed entries. */
  function load() {
    if (cache !== undefined) return cache
    cache = new Map()
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // A missing file is the normal first-run state, not a problem worth reporting.
      if (error?.code !== 'ENOENT') warn(`could not read ${file}: ${error.message}`)
      return cache
    }
    try {
      const sessions = JSON.parse(text)?.sessions
      if (sessions !== null && typeof sessions === 'object') {
        for (const [id, auto] of Object.entries(sessions)) {
          if (typeof auto === 'boolean') cache.set(id, auto)
        }
      }
    } catch (error) {
      warn(`${file} is not valid JSON and was ignored: ${error.message}`)
    }
    return cache
  }

  /** Mirror the map to disk atomically; return whether it landed. */
  function persist() {
    const payload = { version: PREFERENCE_FORMAT_VERSION, sessions: Object.fromEntries(load()) }
    try {
      mkdirSync(dirname(file), { recursive: true })
      // Write-then-rename, so a crash mid-write cannot leave a half-file that the
      // next load would report as corrupt.
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, file)
      return true
    } catch (error) {
      warn(`could not persist ${file}; the choice holds for this process only: ${error.message}`)
      return false
    }
  }

  return {
    file,
    /** The stored override for one chat, or `null` for "inherit the profile default". */
    read: (id) => (typeof id === 'string' ? load().get(id) ?? null : null),
    /** Record one chat's choice; `null` deletes the override. */
    write(id, auto) {
      if (typeof id !== 'string' || id === '') throw new Error('a session id is required')
      if (auto === null) load().delete(id)
      else if (typeof auto === 'boolean') load().set(id, auto)
      else throw new Error('auto must be true, false or null')
      persist()
      return load().get(id) ?? null
    },
    /** Every stored override — diagnostics only. */
    snapshot: () => Object.fromEntries(load()),
  }
}

/**
 * Hang the two service methods off the plugin: resolve one chat's preference, and
 * record a change.
 *
 * @param ctx - the plugin context; only `logger` is used.
 * @param service - the TTS service object to extend.
 * @param options.profileDefault - live getter for the value a chat inherits.
 * @param options.dataRoot - the plugin's data root; the file lands beside the models.
 * @param options.file - explicit path, for tests.
 * @returns whether the store attached (always true; kept so callers read uniformly).
 */
export function attachPreference(ctx, service, { profileDefault = () => false, dataRoot, file } = {}) {
  const store = createPreferenceStore({
    file: file ?? join(dataRoot ?? process.cwd(), PREFERENCE_FILE),
    logger: ctx?.logger,
  })

  service.preference = (session) => {
    const auto = store.read(session?.id)
    return { auto, effective: auto ?? profileDefault() }
  }

  service.setChatAuto = (session, auto) => {
    if (session?.id === undefined) throw new Error('setChatAuto needs a live session')
    store.write(session.id, auto)
    return service.preference(session)
  }

  return true
}
