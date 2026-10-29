/**
 * Passive-recall policy: which presets inject recalled memory.
 *
 * The passive layer is **off by default**. It changes what an agent sees on every
 * turn, and a profile-global bundle must not decide that for a preset its author
 * never considered. Enabling it is a deliberate act, recorded per preset.
 *
 * Preset rather than workspace, because the passive layer changes the *agent*: a
 * preset is the agent's identity, while a workspace is only a folder, and two
 * sessions in one folder can run different presets.
 *
 * The same file-per-profile approach as `dsh-tool-result-policy`: a JSON document
 * under `$DSH_HOME`, read through its mtime so a change lands without a restart.
 *
 * @module @local/dsh-memory/recall-policy
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the policy lives, absent an explicit path. */
export function defaultRecallPolicyPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'memory-recall.json');
}

/**
 * Read the policy, tolerating every way a hand-edited file can be wrong.
 *
 * A malformed policy must not take the plugin down: the fallback is the safe
 * state (recall off), because a broken file is not consent.
 *
 * @param {string} path
 * @returns {{ default: boolean, presets: Record<string, boolean>, problem: string|null }}
 */
export function readRecallPolicy(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // A missing file is the normal first-run state, not a problem to report.
    return { default: false, presets: {}, problem: error?.code === 'ENOENT' ? null : String(error?.message ?? error) };
  }
  try {
    const parsed = JSON.parse(raw);
    const presets = {};
    for (const [key, value] of Object.entries(parsed?.presets ?? {})) {
      if (typeof value === 'boolean') presets[key] = value;
    }
    return {
      default: parsed?.default === true,
      presets,
      problem: null,
    };
  } catch (error) {
    return { default: false, presets: {}, problem: `unreadable JSON: ${error?.message ?? error}` };
  }
}

/**
 * Whether one preset injects recalled memory.
 *
 * Precedence: the preset's own entry, then the file's `default`, then the
 * caller's fallback (the plugin config). A preset absent from the table is
 * therefore off on a fresh install, whatever the config says.
 *
 * @param {{ default: boolean, presets: Record<string, boolean> }} policy
 * @param {string|undefined} presetId `session.header.agentPreset`
 * @returns {boolean}
 */
export function recallEnabledFor(policy, presetId) {
  if (typeof presetId === 'string' && Object.prototype.hasOwnProperty.call(policy.presets, presetId)) {
    return policy.presets[presetId] === true;
  }
  return policy.default === true;
}

/**
 * A reader that re-reads only when the file changes.
 *
 * The hook runs on the first step of every turn, so this must not be a read per
 * turn; the mtime is the cheap check that also handles an edit made by hand.
 *
 * @param {string} path
 * @returns {() => { default: boolean, presets: Record<string, boolean>, problem: string|null }}
 */
export function createRecallPolicyReader(path) {
  let cached = null;
  let stamp = -1;
  return () => {
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (cached !== null && mtime === stamp) return cached;
    cached = readRecallPolicy(path);
    stamp = mtime;
    return cached;
  };
}

/**
 * Replace the policy document.
 *
 * A whole-file write, because the caller owns the table's shape and a partial
 * merge would leave stale preset entries nobody can see to remove.
 *
 * @param {string} path
 * @param {{ default?: boolean, presets?: Record<string, boolean> }} next
 * @returns {{ default: boolean, presets: Record<string, boolean> }}
 */
export function writeRecallPolicy(path, next) {
  const presets = {};
  for (const [key, value] of Object.entries(next?.presets ?? {})) {
    if (typeof value === 'boolean') presets[key] = value;
  }
  const document = { default: next?.default === true, presets };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return document;
}
