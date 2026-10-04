/**
 * The plugin's own settings: the values the settings pane and the top-bar controls
 * write, held in one small JSON file under the data root.
 *
 * ## Why a file rather than the harness `settings` service
 *
 * The harness does have a settings service, and the original design called for it.
 * What changed the decision is evidence: this bundle's previous attempt to use a
 * harness mechanism whose contract had been read but not *verified* — the session
 * projection for the per-chat preference — took two conversations with it, because
 * `Session.append()` cannot set the marker the persistence reader demands. The
 * `settings.update(entry, patch)` contract was never exercised here either.
 *
 * This store, by contrast, is the same shape as `preferences.json`, which is now
 * proven in production: read lazily, keep the last good value in memory, write with
 * `write-then-rename`, and degrade to a warning rather than an exception. A settings
 * pane that cannot save is a nuisance; a plugin that throws at mount is an outage.
 *
 * ## Precedence
 *
 * **The file wins over the config.** A value in the config (the shipped patch) is the
 * default the UI starts from; a value in this file is what the user actually chose.
 * That mirrors the profile-default-versus-override shape the per-chat preference
 * already uses, and it keeps deployment configuration and user preference separate
 * instead of fighting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The file, inside the plugin's data root, that holds the user's settings. */
export const SETTINGS_FILE = 'settings.json'

/** Written into the file so a future format change can be detected rather than guessed. */
export const SETTINGS_FORMAT_VERSION = 1

/**
 * The settings this store owns, and what a well-formed value looks like.
 *
 * Keys not listed here are refused by `set()`, so a typo in a caller cannot quietly
 * persist a setting nothing reads — the same reasoning as the Config schema's
 * pass-through note, applied on the write path where it can be enforced.
 */
export const SETTING_VALIDATORS = {
  /**
   * Which engine speaks. Deliberately just "a string": the list of engines lives in
   * `plugin.js`, and `providerId()` already clamps an unknown value to the default, so
   * a hand-edited file degrades instead of refusing to load.
   */
  provider: (value) => typeof value === 'string',
  voice: (value) => typeof value === 'string',
  /** Piper's voice, kept beside Kokoro's so switching engines does not forget either. */
  piperVoice: (value) => typeof value === 'string',
  toneEnabled: (value) => typeof value === 'boolean',
  /** ONNX intra-op threads, for both engines. Read when a model session is created. */
  threads: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 16,
  instructions: (value) => typeof value === 'string',
}

/**
 * A tiny durable key→value store for the plugin's own settings.
 *
 * @param options.file - absolute path of the JSON file.
 * @param options.logger - optional `{ warn }`; a failure is reported once, not per call.
 * @param options.validators - key → predicate; keys outside it are refused.
 * @returns a store with `get`, `all`, `set` and the resolved `file`.
 */
export function createSettingsStore({ file, logger, validators = SETTING_VALIDATORS } = {}) {
  /** `undefined` means "not loaded yet"; the file is read at most once per process. */
  let cache
  let warned = false

  const warn = (message) => {
    if (warned) return
    warned = true
    logger?.warn?.(`tts: ${message}`)
  }

  /** Read the file once, keeping only entries this build understands. */
  function load() {
    if (cache !== undefined) return cache
    cache = new Map()
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // Absent is the normal first-run state: the config defaults are in force.
      if (error?.code !== 'ENOENT') warn(`could not read ${file}: ${error.message}`)
      return cache
    }
    try {
      const stored = JSON.parse(text)?.settings
      if (stored !== null && typeof stored === 'object') {
        for (const [key, value] of Object.entries(stored)) {
          if (validators[key]?.(value) === true) cache.set(key, value)
        }
      }
    } catch (error) {
      warn(`${file} is not valid JSON and was ignored: ${error.message}`)
    }
    return cache
  }

  /** Mirror the map to disk atomically; return whether it landed. */
  function persist() {
    const payload = { version: SETTINGS_FORMAT_VERSION, settings: Object.fromEntries(load()) }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, file)
      return true
    } catch (error) {
      warn(`could not persist ${file}; the change holds for this process only: ${error.message}`)
      return false
    }
  }

  return {
    file,
    /** One setting, or `fallback` when the user has never changed it. */
    get: (key, fallback) => (load().has(key) ? load().get(key) : fallback),
    /** Every stored setting — the read side of the settings endpoint. */
    all: () => Object.fromEntries(load()),
    /**
     * Merge a patch and persist it.
     * @throws {Error} for a key this store does not own, or a malformed value.
     */
    set(patch) {
      const merged = load()
      for (const [key, value] of Object.entries(patch)) {
        const validator = validators[key]
        if (validator === undefined) throw new Error(`"${key}" is not a setting this plugin owns`)
        if (!validator(value)) throw new Error(`"${key}" has the wrong type`)
        merged.set(key, value)
      }
      persist()
      return Object.fromEntries(merged)
    },
    /** The resolved file path, for a status report. */
    get path() { return file },
  }
}

/** The settings file inside a data root, so callers agree on one path. */
export function settingsPath(dataRoot) {
  return join(dataRoot, SETTINGS_FILE)
}
