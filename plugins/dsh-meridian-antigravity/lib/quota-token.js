/**
 * The token the browser half presents to the quota route.
 *
 * It has to outlive a plugin apply. The connector sits in the profile's `hmr`
 * watch root, so editing any file in it reloads the plugin — and minting a fresh
 * `randomUUID()` per apply rotates the token out from under the page already
 * holding it. Every poll then answers 403 with `{"error":"forbidden"}`, and the
 * composer strip reads "Quota route refused: forbidden" until someone manually
 * refreshes. That is the failure mode the TTS bundle documents for its own route
 * ("a rotated token needs a page refresh"), and the fix is the same shape: take
 * the token from config, and persist a minted one so it also works unconfigured.
 *
 * No harness imports, so this runs under plain `node --test`.
 *
 * @module @local/dsh-meridian-antigravity/lib/quota-token
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where a minted token is kept when the config does not supply one. */
export function quotaTokenPath(env = process.env, home = homedir()) {
  const base = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(home, '.dsh')
  return join(base, 'meridian-quota-token')
}

/**
 * Resolve the quota token, minting and keeping one when necessary.
 *
 * @param options - `configured` (the config value, may be empty), `file` (where a
 *   minted token is kept) and `logger` (warned at if it cannot be persisted).
 * @returns the token to register the route with and inject into the page.
 */
export function resolveQuotaToken({ configured = '', file, logger } = {}) {
  if (typeof configured === 'string' && configured.length > 0) return configured

  // Resolved here rather than as a parameter default, because a default applies
  // only to `undefined`. A caller passing a Cordis context instead of an options
  // object hands over a `file` of some other type, and reading that as a path
  // either throws or -- far worse -- treats the contents of that file as the
  // token. Anything that is not a usable path falls back.
  const target = typeof file === 'string' && file.length > 0 ? file : quotaTokenPath()

  try {
    const kept = readFileSync(target, 'utf8').trim()
    if (kept.length > 0) return kept
  } catch {
    // Never minted, or unreadable: fall through and mint one.
  }

  const minted = randomUUID()
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${minted}\n`, { mode: 0o600 })
  } catch (error) {
    // Without persistence the token rotates on every reload, which is the bug this
    // function exists to prevent. Say so rather than failing quietly.
    logger?.warn?.(
      `meridian-antigravity: cannot persist the quota token at ${target} (${String(error?.message ?? error)});`
      + ' it will change on every reload and the browser half will need a refresh',
    )
  }
  return minted
}
