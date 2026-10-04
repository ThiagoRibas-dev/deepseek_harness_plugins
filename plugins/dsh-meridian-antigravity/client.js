/**
 * Browser half: the Models-page card for the Meridian Antigravity route.
 *
 * The shipped Models page hand-codes editors for `llm-deepseek` and `llm-pi-ai`
 * only; every other adapter namespace renders a read-only hint and disables
 * Apply. This module supplies the missing editor by registering into the keyed
 * slot `settings.models.provider-card` under this plugin's settings namespace,
 * which is what the section dispatches for every card of the family.
 *
 * It is a plain JavaScript bundle rather than a compiled one: a client bundle is
 * a closure factory registered through `window.__ModuleLoader__.load`, and the
 * shell's shared module table already holds React, so nothing is bundled to
 * supply it. JSX and CSS modules are build-path constructs, so components here
 * use `React.createElement` and inline styles.
 *
 * Styling reads only `--dsw-alias-*` theme tokens, so the card follows light and
 * dark themes beside the host's own controls. No Harness Client package is
 * imported: those change without notice and a throwing import would blank the
 * slot entry.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-meridian-antigravity',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** This plugin's loader entry id, which is also its settings namespace. */
    const NS = 'llm-meridian-antigravity'

    /** Scalar fields the card edits, in display order. */
    const TEXT_FIELDS = [
      ['baseURL', 'Meridian origin', 'http://openmediavault:3457'],
      ['apiKeyEnv', 'Credential reference', 'ANTIGRAVITY_API_KEY'],
      ['displayName', 'Display name', 'Meridian Antigravity'],
      ['expectedCliVersion', 'Pinned agy version', '1.2.7'],
      ['expectedBackend', 'Expected backend', 'antigravity'],
    ]

    const NUMBER_FIELDS = [
      ['maxConcurrentTurns', 'Local concurrency limit'],
      ['defaultContextWindow', 'Context budget (tokens)'],
      ['defaultMaxTokens', 'max_tokens instruction'],
      ['maxRequestBytes', 'Request byte cap'],
      ['healthTtlMs', 'Health cache (ms)'],
      ['catalogueTtlMs', 'Catalogue cache (ms)'],
    ]

    const BOOLEAN_FIELDS = [
      ['requireHealthGate', 'Refuse to serve a wrong backend or CLI pin'],
      ['sendEffortOverride', 'Send a matching output_config.effort beside the slug'],
      ['stripToolsForSessionTitle', 'Advertise no tools to session-title helper turns'],
    ]

    const styles = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        marginTop: 10,
        display: 'grid',
        gap: 10,
      },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      badge: base => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        ...base,
      }),
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      field: { display: 'grid', gap: 4, minWidth: 0 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        font: 'inherit',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '6px 12px',
        fontSize: 12,
        borderRadius: 6,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        font: 'inherit',
      },
      primary: {
        padding: '6px 12px',
        fontSize: 12,
        borderRadius: 6,
        cursor: 'pointer',
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        font: 'inherit',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
      },
      list: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 },
      chip: {
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      bad: { color: 'var(--dsw-alias-state-error-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
    }

    /** Subscribe to this plugin's settings form. */
    function useForm(ctx) {
      const form = ctx.configForms.get(NS)
      const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
      useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      return [form, snapshot]
    }

    function TextField({ label, value, placeholder, onCommit }) {
      const [draft, setDraft] = useState(value ?? '')
      useEffect(() => { setDraft(value ?? '') }, [value])
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        h('input', {
          style: styles.input,
          value: draft,
          placeholder,
          onChange: event => setDraft(event.target.value),
          onBlur: () => { if ((value ?? '') !== draft) onCommit(draft) },
          onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
        }))
    }

    function NumberField({ label, value, onCommit }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        h('input', {
          style: styles.input,
          type: 'number',
          value: value === undefined ? '' : String(value),
          onChange: event => {
            const next = Number(event.target.value)
            if (Number.isFinite(next) && next > 0) onCommit(next)
          },
        }))
    }

    function ToggleField({ label, value, onCommit }) {
      return h('label', { style: styles.row },
        h('input', { type: 'checkbox', checked: value === true, onChange: event => onCommit(event.target.checked) }),
        h('span', null, label))
    }

    /** The card body: connection fields, the key, and the live catalogue. */
    function MeridianCard(props) {
      const ctx = props.ctx
      const [form, snapshot] = useForm(ctx)
      const value = snapshot.value ?? {}
      const base = snapshot.base ?? {}
      const effective = field => value[field] !== undefined ? value[field] : base[field]

      const [keyDraft, setKeyDraft] = useState('')
      const [keyState, setKeyState] = useState(props.keyConfigured ? 'configured' : 'missing')
      const [notice, setNotice] = useState(undefined)
      const [models, setModels] = useState(undefined)
      const [busy, setBusy] = useState(false)

      const overridden = useMemo(() => new Set(Object.keys(snapshot.user ?? {})), [snapshot.user])

      const write = useCallback(async (field, next) => {
        setNotice(undefined)
        try {
          const accepted = await form.set(field, next)
          if (!accepted) setNotice('The Host refused that value; check the field against the schema.')
        } catch (error) {
          setNotice(`Write failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, [form])

      const saveKey = useCallback(async () => {
        const ref = effective('apiKeyEnv')
        if (typeof ref !== 'string' || ref.length === 0) {
          setNotice('Set the credential reference first.')
          return
        }
        if (keyDraft.length === 0) {
          setNotice('Type the local Meridian shared secret first.')
          return
        }
        setBusy(true)
        setNotice(undefined)
        try {
          const answer = await ctx.remote.credentials.set(ref, keyDraft)
          if (answer.ok) {
            setKeyDraft('')
            setKeyState('configured')
          } else {
            setNotice(`Credential refused: ${answer.error?.message ?? 'unknown error'}`)
          }
        } catch (error) {
          setNotice(`Credential write failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }, [ctx, effective, keyDraft])

      const clearKey = useCallback(async () => {
        const ref = effective('apiKeyEnv')
        if (typeof ref !== 'string' || ref.length === 0) return
        setBusy(true)
        setNotice(undefined)
        try {
          const answer = await ctx.remote.credentials.unset(ref)
          if (answer.ok) setKeyState('missing')
          else setNotice(`Credential removal refused: ${answer.error?.message ?? 'unknown error'}`)
        } finally {
          setBusy(false)
        }
      }, [ctx, effective])

      const fetchModels = useCallback(async () => {
        setBusy(true)
        setNotice(undefined)
        try {
          const answer = await ctx.remote.llm.discoverModels(NS, {
            baseURL: effective('baseURL'),
            api: 'anthropic-messages',
          })
          if (answer.ok) {
            setModels(answer.value)
            if (answer.value.length === 0) setNotice('The account advertised no models.')
          } else {
            setNotice(`Discovery refused: ${answer.error?.message ?? 'unknown error'}`)
          }
        } catch (error) {
          setNotice(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }, [ctx, effective])

      const status = h('div', { style: styles.head },
        h('span', { style: styles.title }, 'Meridian Antigravity connector'),
        h('span', { style: { ...styles.badge(), ...(props.provider.active ? styles.ok : styles.bad) } },
          props.provider.active ? 'route registered' : 'route inactive'),
        h('span', { style: { ...styles.badge(), ...(keyState === 'configured' ? styles.ok : styles.warn) } },
          keyState === 'configured' ? 'key configured' : 'no key stored'),
        h('span', { style: styles.badge() }, `route ${props.provider.provider}`))

      const readOnly = snapshot.status !== 'ready' || snapshot.writable === false
      const disabled = readOnly || busy

      return h('div', { style: styles.card },
        status,
        h('div', { style: styles.hint },
          'Speaks Anthropic Messages to a local Meridian bridge over a signed-in agy CLI. It gates on '
          + 'GET /health (backend and pinned CLI version), reads the account catalogue from GET /v1/models, '
          + 'never sends sampling, thinking or structured-output controls, and holds tool calls until '
          + 'message_stop. Stored in cordis.patch.yml; these fields write the same layer.'),
        h('div', { style: styles.grid },
          ...TEXT_FIELDS.map(([field, label, placeholder]) => h(TextField, {
            key: field,
            label: overridden.has(field) ? `${label} •` : label,
            value: effective(field),
            placeholder,
            onCommit: next => void write(field, next),
          })),
          ...NUMBER_FIELDS.map(([field, label]) => h(NumberField, {
            key: field,
            label: overridden.has(field) ? `${label} •` : label,
            value: effective(field),
            onCommit: next => void write(field, next),
          }))),
        h('div', { style: { display: 'grid', gap: 6 } },
          ...BOOLEAN_FIELDS.map(([field, label]) => h(ToggleField, {
            key: field,
            label,
            value: effective(field),
            onCommit: next => void write(field, next),
          }))),
        h('div', { style: styles.grid },
          h('label', { style: styles.field },
            h('span', { style: styles.label }, 'Store the shared secret'),
            h('input', {
              style: styles.input,
              type: 'password',
              value: keyDraft,
              placeholder: 'local Meridian key, never a Google key',
              disabled,
              onChange: event => setKeyDraft(event.target.value),
            })),
          h('div', { style: styles.actions },
            h('button', { style: styles.primary, disabled, onClick: () => void saveKey() }, 'Save key'),
            h('button', { style: styles.button, disabled, onClick: () => void clearKey() }, 'Clear key'))),
        h('div', { style: styles.actions },
          h('button', { style: styles.button, disabled, onClick: () => void fetchModels() },
            busy ? 'Working…' : 'Fetch account models'),
          h('span', { style: styles.mono }, `settings namespace: ${NS}`)),
        models === undefined
          ? null
          : h('div', null,
            h('div', { style: styles.label }, `${models.length} model(s) advertised by the signed-in account`),
            h('div', { style: styles.list }, ...models.map(model =>
              h('span', { key: model.id, style: styles.chip }, model.id)))),
        notice === undefined ? null : h('div', { style: { ...styles.hint, ...styles.bad } }, notice),
        readOnly
          ? h('div', { style: styles.hint }, 'This namespace is not writable from here; edit cordis.patch.yml.')
          : null)
    }

    return {
      // `remote` and each declared sub-proxy are both required: reading
      // `ctx.remote.credentials` reads `ctx.remote` first, and that read is
      // refused unless `remote` itself is injected. `configForms` owns the
      // revision-fenced write queue.
      inject: ['slots', 'configForms', 'remote', 'remote.credentials', 'remote.llm'],
      apply(ctx) {
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: NS,
          order: 10,
        }, props => h(MeridianCard, { ...props, ctx })))
      },
      // Exported for the offline suite, which exercises the factory contract and
      // the card's first render without a browser.
      __components: { MeridianCard, styles, NS, TEXT_FIELDS, NUMBER_FIELDS, BOOLEAN_FIELDS },
    }
  },
})
