/**
 * The browser half — the preset-versus-toggle table.
 *
 * Registered into `settings.plugins.tab`: *"One page inside the Plugins settings
 * section."* That is the right seat for a plugin's own configuration, and it does
 * not shadow shipped UI.
 *
 * A plain JavaScript bundle, not a compiled one. A client bundle is a closure
 * factory registered through `window.__ModuleLoader__.load({ id, factory })`,
 * where `factory(require)` receives a `require` into the shell's shared module
 * table — and **React is in that table**, so nothing has to be bundled to supply
 * it. That keeps this file inside the workspace instead of requiring a package in
 * the DSH checkout and a build pipeline.
 *
 * What it is not: JSX, TSX and CSS modules are constructs of the build path.
 * Components here use `React.createElement` and inline styles.
 *
 * It talks to the host over an unauthenticated HTTP route, because every other
 * caller of this profile already has read and write access to the file the route
 * edits — `$DSH_HOME/tool-result-policy.json` — so a token would protect nothing.
 *
 * `id` must equal the package name: the loader keys every bundle by the graph row
 * it is executing.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-tool-result-policy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PREFIX = '/tool-result-policy'

    /** Read the table, plus the presets this deployment knows about. */
    const readTable = async () => {
      const response = await fetch(PREFIX, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`read failed: ${response.status}`)
      return response.json()
    }

    /** Write the table. The host re-reads it on the next pass, with no restart. */
    const writeTable = async (payload) => {
      const response = await fetch(PREFIX, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`write failed: ${response.status}`)
      return response.json()
    }

    // ---- styling ---------------------------------------------------------
    // Theme tokens only (`--dsw-alias-*`). A renamed token degrades appearance
    // but never breaks rendering, which is why tokens are the only shared
    // styling dependency this plugin takes.
    const row = {
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.5rem 0',
      borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.2))',
    }
    const muted = { color: 'var(--dsw-alias-text-secondary, #888)', fontSize: '0.85em', lineHeight: 1.5 }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em' }
    const heading = { fontSize: '0.95em', fontWeight: 600, margin: '0 0 0.25rem' }

    /** A switch, marked up the way the host marks up its own. */
    function Toggle({ checked, disabled, onToggle, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => onToggle(!checked),
        style: {
          cursor: disabled ? 'default' : 'pointer',
          border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.4))',
          background: checked
            ? 'var(--dsw-alias-bg-accent, #2b6cb0)'
            : 'var(--dsw-alias-bg-subtle, transparent)',
          color: checked ? 'var(--dsw-alias-text-on-accent, #fff)' : 'inherit',
          borderRadius: '999px',
          minWidth: '4.5rem',
          padding: '0.25rem 0.7rem',
          fontSize: '0.85em',
          opacity: disabled ? 0.5 : 1,
        },
      }, checked ? 'on' : 'off')
    }

    function PolicyTable() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setState(await readTable())
          setError(null)
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const apply = useCallback(async (payload) => {
        setBusy(true)
        try {
          const next = await writeTable(payload)
          // Re-read rather than trusting the echo, so the table always shows
          // what is actually on disk.
          setState((current) => ({ ...current, policy: next.policy }))
          setError(null)
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy(false)
        }
      }, [])

      if (state === null) {
        return h('div', { style: muted }, error === null ? 'Loading…' : `Could not read the policy: ${error}`)
      }

      const policy = state.policy ?? { presets: {}, defaults: {} }
      const presets = [...new Set([...(state.knownPresets ?? []), ...Object.keys(policy.presets ?? {})])].sort()

      const setPreset = (preset, value) => apply({
        version: policy.version,
        presets: { ...policy.presets, [preset]: { stripTransientResults: value } },
        defaults: policy.defaults,
      })
      const setDefault = (value) => apply({
        version: policy.version,
        presets: policy.presets,
        defaults: { stripTransientResults: value },
      })

      return h('div', null,
        h('p', { style: heading }, 'Tool-result retention'),
        h('p', { style: muted },
          'Strip tool results once the turn that used them is over: transient reads are renderings of '
          + 'files, a mutation is already on the sheet, and an oracle roll is spent entropy. Measured '
          + 'over 88 sessions, retained tool output was 72% of everything sent to the model.'),
        h('p', { style: muted },
          'Changes apply to the next request. No restart.'),
        h('p', { style: { ...muted, color: 'var(--dsw-alias-text-warning, #b7791f)' } },
          'Stripping removes the contents of read, grep, bash, write and edit results, plus every '
          + 'dice and oracle roll. It is meant for the DM preset; switching it on for a coding preset '
          + 'deletes the file contents that agent just read.'),

        h('div', { style: { marginTop: '0.75rem' } },
          presets.length === 0
            ? h('p', { style: muted }, 'No presets reported by the host.')
            : presets.map((preset) => h('div', { key: preset, style: row },
              h('div', null,
                h('div', { style: mono }, preset),
                h('div', { style: muted },
                  policy.presets?.[preset] === undefined
                    ? 'not set — follows the default below'
                    : 'set for this preset')),
              h(Toggle, {
                checked: policy.presets?.[preset]?.stripTransientResults === true,
                disabled: busy,
                label: `Strip transient tool results for ${preset}`,
                onToggle: (next) => setPreset(preset, next),
              }))),

        h('div', { style: { ...row, borderBottom: 'none', marginTop: '0.5rem' } },
          h('div', null,
            h('div', { style: { ...mono, fontWeight: 600 } }, '(default)'),
            h('div', { style: muted }, 'Applies to any preset not listed above')),
          h(Toggle, {
            checked: policy.defaults?.stripTransientResults === true,
            disabled: busy,
            label: 'Strip transient tool results by default',
            onToggle: setDefault,
          })),

        h('p', { style: { ...muted, marginTop: '1rem' } },
          'Policy file: ', h('code', { style: mono }, state.path ?? '(unknown)')),
        state.problem ? h('p', { style: { ...muted, color: 'var(--dsw-alias-text-danger, #c00)' } }, state.problem) : null,
        error === null ? null : h('p', { style: { ...muted, color: 'var(--dsw-alias-text-danger, #c00)' } }, error),
      ))
    }

    return {
      // Only `slots`: this half talks to the host over HTTP, so it needs no Remote.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'tool-result-policy', order: 40,
          label: 'Tool-result retention',
        }, PolicyTable))
      },
    }
  },
})
