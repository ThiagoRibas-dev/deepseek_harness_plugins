/**
 * Client half of the Model Rotation bundle.
 *
 * Two surfaces:
 * - `settings.section` — pools and members, including the API-key writes that
 *   keep secrets out of the settings document.
 * - `sidebar.right.pane.tab` — the per-session request log, polled from the
 *   Host's read-only HTTP prefix.
 *
 * Plain JavaScript: no JSX, no CSS modules, no Harness Client package imports.
 * React comes from the shell module table. Only theme tokens are used for
 * color, border, and surface values.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-rotation',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const TAB_ID = '@local/dsh-model-rotation'
    const TAB_KIND = 'model-rotation'
    const DEFAULT_IDENTITY = {
      prefix: '/api/model-rotation',
      token: '',
      settingsNs: 'model-rotation',
      provider: 'model-rotation',
      displayName: 'Model Rotation',
    }

    const PROTOCOLS = [
      { value: 'openai-completions', label: 'OpenAI Chat Completions' },
      { value: 'openai-responses', label: 'OpenAI Responses' },
      { value: 'anthropic-messages', label: 'Anthropic Messages' },
    ]
    const STRATEGIES = [
      { value: 'round-robin', label: 'Round-robin (spread calls)' },
      { value: 'least-recently-used', label: 'Least recently used' },
      { value: 'fill-first', label: 'Fill first (stay on one)' },
      { value: 'random', label: 'Random' },
    ]
    const CADENCES = [
      { value: 'request', label: 'Every model call' },
      { value: 'turn', label: 'Once per user turn' },
    ]
    const REPLAYS = [
      { value: 'auto', label: 'Auto (same protocol only)' },
      { value: 'preserve', label: 'Always preserve' },
      { value: 'neutral', label: 'Always neutral' },
    ]
    const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
    const OUTPUT_TOKEN_FIELDS = [
      { value: '', label: 'Auto (pi-ai detection)' },
      { value: 'max_tokens', label: 'max_tokens (Gemini)' },
      { value: 'max_completion_tokens', label: 'max_completion_tokens (OpenAI)' },
    ]
    const SEND_STORE = [
      { value: '', label: 'Auto' },
      { value: 'false', label: 'Never' },
      { value: 'true', label: 'Always' },
    ]
    const USAGE_IN_STREAM = [
      { value: '', label: 'Auto' },
      { value: 'true', label: 'Include usage' },
      { value: 'false', label: 'Omit usage' },
    ]
    const STRICT_TOOLS = [
      { value: '', label: 'Auto' },
      { value: 'false', label: 'Off' },
      { value: 'true', label: 'On' },
    ]
    /**
     * Named compatibility presets. Add one row here to offer another provider;
     * the select applies its switches to the member draft, and the four selects
     * below remain editable afterwards.
     */
    const COMPAT_PRESETS = [
      {
        id: 'defaults',
        label: 'Defaults (all switches Auto)',
        compat: {
          maxTokensField: '',
          supportsStore: '',
          supportsUsageInStreaming: '',
          supportsStrictMode: '',
        },
      },
      {
        id: 'gemini-openai',
        label: 'Gemini (OpenAI-compatible)',
        compat: {
          maxTokensField: 'max_tokens',
          supportsStore: 'false',
          supportsUsageInStreaming: '',
          supportsStrictMode: 'false',
        },
      },
    ]

    /** Page-injected host identity, with defaults that fail closed. */
    function identity() {
      return { ...DEFAULT_IDENTITY, ...(window.__DSH_MODEL_ROTATION__ ?? {}) }
    }

    // ---- styles -------------------------------------------------------------
    const ui = {
      page: {
        padding: '18px 22px 28px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      },
      h1: { margin: '0 0 4px', fontSize: 18, fontWeight: 600 },
      lead: { margin: '0 0 14px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        marginBottom: 12,
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '9px 12px',
        borderBottom: '1px solid var(--dsw-alias-separator-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      cardBody: { padding: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 },
      label: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        padding: '5px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxSizing: 'border-box',
        width: '100%',
      },
      textarea: {
        padding: '5px 8px',
        fontSize: 11,
        fontFamily: 'ui-monospace, monospace',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 46,
        resize: 'vertical',
      },
      button: {
        padding: '4px 11px',
        fontSize: 12,
        fontFamily: 'inherit',
        borderRadius: 4,
        cursor: 'pointer',
        background: 'var(--dsw-alias-button-elevated-fill)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      primaryButton: {
        padding: '5px 14px',
        fontSize: 12,
        fontFamily: 'inherit',
        borderRadius: 4,
        cursor: 'pointer',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        border: '1px solid transparent',
      },
      dangerButton: {
        padding: '4px 11px',
        fontSize: 12,
        fontFamily: 'inherit',
        borderRadius: 4,
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      disabled: { opacity: 0.55, cursor: 'not-allowed' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      notice: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 12,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10,
        lineHeight: '16px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      code: { fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      member: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        padding: 10,
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      bar: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        padding: '7px 10px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      logRow: {
        borderTop: '1px solid var(--dsw-alias-separator-primary)',
        padding: '8px 12px',
        cursor: 'pointer',
      },
      logHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      logMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' },
    }

    // ---- small building blocks ---------------------------------------------
    function Button({ children, onClick, kind = 'default', disabled = false, title, style }) {
      const base = kind === 'primary' ? ui.primaryButton : kind === 'danger' ? ui.dangerButton : ui.button
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        style: { ...base, ...(disabled ? ui.disabled : {}), ...style },
      }, children)
    }

    function TextInput({ value, onChange, placeholder, type = 'text', disabled = false, style }) {
      return h('input', {
        type,
        value: value ?? '',
        placeholder,
        disabled,
        spellCheck: false,
        autoComplete: type === 'password' ? 'new-password' : 'off',
        onChange: event => onChange(event.target.value),
        style: { ...ui.input, ...style },
      })
    }

    function Select({ value, onChange, options, disabled = false }) {
      return h('select', {
        value,
        disabled,
        onChange: event => onChange(event.target.value),
        style: { ...ui.input, ...(disabled ? ui.disabled : {}) },
      }, options.map(option => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function Checkbox({ checked, onChange, label, disabled = false }) {
      return h('label', { style: { ...ui.label, flexDirection: 'row', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--dsw-alias-label-primary)' } },
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          onChange: event => onChange(event.target.checked),
        }),
        label)
    }

    function Field({ label, hint, children }) {
      return h('label', { style: ui.label },
        h('span', null, label),
        children,
        hint === undefined ? null : h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, hint))
    }

    function Badge({ children, tone = 'default' }) {
      const color = tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-secondary)'
      return h('span', { style: { ...ui.badge, color } }, children)
    }

    // ---- pure helpers ------------------------------------------------------
    function isHttpUrl(value) {
      try {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      } catch {
        return false
      }
    }

    function slug(value) {
      return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    }

    function deriveKeyRef(poolId, memberName) {
      const raw = `MODEL_ROTATION_${slug(poolId)}_${slug(memberName)}_API_KEY`
      return raw.length <= 128 ? raw : `${raw.slice(0, 120)}_${raw.length}`
    }

    function asObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    }

    function positiveInteger(value) {
      if (value === undefined || value === null || value === '') return undefined
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
    }

    function nonNegativeInteger(value) {
      if (value === undefined || value === null || value === '') return 0
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
    }

    /** Select value for one compatibility switch: '' means auto. */
    function compatValue(compat, key) {
      if (key === 'maxTokensField') {
        return typeof compat.maxTokensField === 'string' ? compat.maxTokensField : ''
      }
      return typeof compat[key] === 'boolean' ? String(compat[key]) : ''
    }

    /** Split a comma/newline list of field names. */
    function splitList(text) {
      return String(text ?? '').split(/[\n,]+/).map(value => value.trim()).filter(value => value.length > 0)
    }

    function memberDraft(raw) {
      const member = asObject(raw)
      const headers = asObject(member.headers)
      const compat = asObject(member.compat)
      const body = asObject(member.body)
      const bodySet = asObject(body.set)
      return {
        name: typeof member.name === 'string' ? member.name : '',
        baseURL: typeof member.baseURL === 'string' ? member.baseURL : '',
        api: typeof member.api === 'string' ? member.api : 'openai-completions',
        model: typeof member.model === 'string' ? member.model : '',
        apiKeyEnv: typeof member.apiKeyEnv === 'string' ? member.apiKeyEnv : '',
        contextWindow: member.contextWindow === undefined ? '' : String(member.contextWindow),
        maxTokens: member.maxTokens === undefined ? '' : String(member.maxTokens),
        headersText: Object.keys(headers).length === 0 ? '' : JSON.stringify(headers, null, 2),
        temperature: member.temperature === undefined ? '' : String(member.temperature),
        compat: {
          maxTokensField: compatValue(compat, 'maxTokensField'),
          supportsStore: compatValue(compat, 'supportsStore'),
          supportsUsageInStreaming: compatValue(compat, 'supportsUsageInStreaming'),
          supportsStrictMode: compatValue(compat, 'supportsStrictMode'),
        },
        bodySetText: Object.keys(bodySet).length === 0 ? '' : JSON.stringify(bodySet, null, 2),
        bodyUnsetText: Array.isArray(body.unset) ? body.unset.join(', ') : '',
      }
    }

    function poolDraft(raw) {
      const pool = asObject(raw)
      const members = Array.isArray(pool.members) ? pool.members.map(memberDraft) : []
      return {
        displayName: typeof pool.displayName === 'string' ? pool.displayName : '',
        strategy: typeof pool.strategy === 'string' ? pool.strategy : 'round-robin',
        cadence: typeof pool.cadence === 'string' ? pool.cadence : 'request',
        failover: pool.failover !== false,
        maxAttempts: pool.maxAttempts === undefined ? '' : String(pool.maxAttempts),
        cooldownMs: pool.cooldownMs === undefined ? '60000' : String(pool.cooldownMs),
        replay: typeof pool.replay === 'string' ? pool.replay : 'auto',
        contextWindow: pool.contextWindow === undefined ? '' : String(pool.contextWindow),
        maxTokens: pool.maxTokens === undefined ? '' : String(pool.maxTokens),
        input: Array.isArray(pool.input) && pool.input.length > 0 ? [...pool.input] : ['text'],
        captureRequestBodies: pool.captureRequestBodies === true,
        members,
      }
    }

    function normalizePools(value) {
      const pools = asObject(value)
      const next = {}
      for (const [id, raw] of Object.entries(pools)) next[id] = poolDraft(raw)
      return next
    }

    /** Validate one pool draft and return the first problem, or undefined. */
    function validatePool(poolId, draft) {
      if (!ID_PATTERN.test(poolId)) {
        return 'Pool/model id must start with a letter or digit and contain only letters, digits, dot, dash, or underscore.'
      }
      if (draft.members.length === 0) return 'Add at least one member.'
      const names = new Set()
      for (let index = 0; index < draft.members.length; index += 1) {
        const member = draft.members[index]
        const where = `Member ${index + 1}`
        if (member.name.trim().length === 0) return `${where}: member id is required.`
        if (!ID_PATTERN.test(member.name.trim())) {
          return `${where}: member id must start with a letter or digit and contain only letters, digits, dot, dash, or underscore.`
        }
        if (names.has(member.name.trim())) return `${where}: member id "${member.name.trim()}" is used twice.`
        names.add(member.name.trim())
        if (!isHttpUrl(member.baseURL.trim())) return `${where}: base URL must be an http(s) URL.`
        if (member.model.trim().length === 0) return `${where}: model id is required.`
        if (!PROTOCOLS.some(protocol => protocol.value === member.api)) return `${where}: choose a protocol.`
        if (Number.isNaN(positiveInteger(member.contextWindow))) return `${where}: context window must be a positive integer.`
        if (Number.isNaN(positiveInteger(member.maxTokens))) return `${where}: max tokens must be a positive integer.`
        if (member.headersText.trim().length > 0) {
          let parsed
          try {
            parsed = JSON.parse(member.headersText)
          } catch {
            return `${where}: headers must be valid JSON.`
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return `${where}: headers must be a JSON object of string values.`
          }
          for (const [header, value] of Object.entries(parsed)) {
            if (typeof value !== 'string') return `${where}: header "${header}" must be a string.`
          }
        }
        if (String(member.temperature ?? '').trim().length > 0) {
          const temperature = Number(member.temperature)
          if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
            return `${where}: temperature must be a number from 0 through 2.`
          }
        }
        const compat = asObject(member.compat)
        if (compat.maxTokensField !== undefined && compat.maxTokensField !== ''
          && compat.maxTokensField !== 'max_tokens' && compat.maxTokensField !== 'max_completion_tokens') {
          return `${where}: choose a valid output token field.`
        }
        for (const key of ['supportsStore', 'supportsUsageInStreaming', 'supportsStrictMode']) {
          if (compat[key] !== undefined && compat[key] !== '' && compat[key] !== 'true' && compat[key] !== 'false') {
            return `${where}: choose a valid ${key} value.`
          }
        }
        if (String(member.bodySetText ?? '').trim().length > 0) {
          let parsed
          try {
            parsed = JSON.parse(member.bodySetText)
          } catch {
            return `${where}: body fields to set must be valid JSON.`
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return `${where}: body fields to set must be a JSON object.`
          }
        }
      }
      if (!STRATEGIES.some(strategy => strategy.value === draft.strategy)) return 'Choose a strategy.'
      if (!CADENCES.some(cadence => cadence.value === draft.cadence)) return 'Choose a rotation cadence.'
      if (!REPLAYS.some(replay => replay.value === draft.replay)) return 'Choose a replay mode.'
      const cooldown = nonNegativeInteger(draft.cooldownMs)
      if (Number.isNaN(cooldown)) return 'Cooldown must be a non-negative integer of milliseconds.'
      if (Number.isNaN(positiveInteger(draft.contextWindow))) return 'Pool context window must be a positive integer.'
      if (Number.isNaN(positiveInteger(draft.maxTokens))) return 'Pool max tokens must be a positive integer.'
      if (draft.maxAttempts !== '') {
        const attempts = positiveInteger(draft.maxAttempts)
        if (Number.isNaN(attempts) || attempts > 16) return 'Max attempts must be an integer from 1 through 16.'
      }
      if (draft.input.length === 0) return 'Choose at least one input modality.'
      return undefined
    }

    /** Build the settings value for one pool, omitting unset defaults. */
    function poolToSettings(poolId, draft) {
      const cooldownMs = nonNegativeInteger(draft.cooldownMs)
      const maxAttempts = positiveInteger(draft.maxAttempts)
      const contextWindow = positiveInteger(draft.contextWindow)
      const maxTokens = positiveInteger(draft.maxTokens)
      const value = {
        members: draft.members.map((member) => {
          const headersText = member.headersText.trim()
          const bodySetText = String(member.bodySetText ?? '').trim()
          const bodyUnset = splitList(member.bodyUnsetText)
          const memberContext = positiveInteger(member.contextWindow)
          const memberMaxTokens = positiveInteger(member.maxTokens)
          const temperature = String(member.temperature ?? '').trim().length === 0 ? undefined : Number(member.temperature)
          const compatSource = asObject(member.compat)
          const compat = {}
          if (compatSource.maxTokensField) compat.maxTokensField = compatSource.maxTokensField
          for (const key of ['supportsStore', 'supportsUsageInStreaming', 'supportsStrictMode']) {
            if (compatSource[key] === 'true' || compatSource[key] === 'false') compat[key] = compatSource[key] === 'true'
          }
          const body = bodySetText.length === 0 && bodyUnset.length === 0
            ? undefined
            : {
              ...bodySetText.length === 0 ? {} : { set: JSON.parse(bodySetText) },
              ...bodyUnset.length === 0 ? {} : { unset: bodyUnset },
            }
          return {
            name: member.name.trim(),
            baseURL: member.baseURL.trim(),
            api: member.api,
            model: member.model.trim(),
            ...member.apiKeyEnv.trim().length === 0 ? {} : { apiKeyEnv: member.apiKeyEnv.trim() },
            ...memberContext === undefined ? {} : { contextWindow: memberContext },
            ...memberMaxTokens === undefined ? {} : { maxTokens: memberMaxTokens },
            ...headersText.length === 0 ? {} : { headers: JSON.parse(headersText) },
            ...temperature === undefined ? {} : { temperature },
            ...Object.keys(compat).length === 0 ? {} : { compat },
            ...body === undefined ? {} : { body },
          }
        }),
        strategy: draft.strategy,
        cadence: draft.cadence,
        failover: draft.failover,
        cooldownMs: Number.isNaN(cooldownMs) ? 60000 : cooldownMs,
        replay: draft.replay,
        input: draft.input.length === 0 ? ['text'] : draft.input,
        ...draft.displayName.trim().length === 0 ? {} : { displayName: draft.displayName.trim() },
        ...maxAttempts === undefined ? {} : { maxAttempts },
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        captureRequestBodies: draft.captureRequestBodies === true,
      }
      return { id: poolId, value }
    }

    /** Collect the credential references a set of drafts will use. */
    function referencesOf(pools, keys) {
      const refs = new Set()
      for (const [poolId, pool] of Object.entries(pools)) {
        for (let index = 0; index < pool.members.length; index += 1) {
          const member = pool.members[index]
          const typed = (keys[`${poolId}::${index}`] ?? '').trim()
          if (member.apiKeyEnv.trim().length > 0) refs.add(member.apiKeyEnv.trim())
          else if (typed.length > 0 || member.name.trim().length > 0) refs.add(deriveKeyRef(poolId, member.name.trim()))
        }
      }
      return [...refs]
    }

    // ---- settings page -----------------------------------------------------
    /**
     * Draft state for the settings page, created once in `apply`.
     *
     * The settings shell renders a section through a slot entry with its own
     * error boundary, and it may remount an entry when the ledger changes. A
     * form whose draft lives in component state loses every keystroke in that
     * case (observed live). This store outlives the component: reopening the
     * section, or a remount, reads the same draft. It also keeps the host
     * calls off React's prop identity, so no effect depends on a function
     * created during render.
     */
    function createRotationSettingsStore(ops, settingsNs) {
      let state = {
        status: 'idle',
        ns: undefined,
        error: '',
        notice: '',
        pools: {},
        selected: null,
        keys: {},
        creds: {},
        busy: false,
        adding: false,
        newId: '',
        confirmDelete: null,
      }
      const listeners = new Set()
      let loading = false
      let generation = 0

      const getSnapshot = () => state
      const set = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      async function loadCredentials(pools, keys) {
        const refs = referencesOf(pools, keys)
        if (refs.length === 0) { set({ creds: {} }); return }
        try {
          const response = await ops.describeCredentials(refs)
          set({ creds: response.ok ? asObject(response.value) : {} })
        } catch {
          set({ creds: {} })
        }
      }

      async function load() {
        if (loading) return
        loading = true
        const ticket = ++generation
        // A refresh after a save keeps the form visible; only a first load
        // shows the loading line.
        set({ status: state.status === 'ready' ? 'ready' : 'loading', error: '' })
        try {
          const response = await ops.describeSettings()
          if (ticket !== generation) return
          if (!response.ok) {
            set({ status: 'error', error: response.error.message })
            return
          }
          const view = asObject(response.value)
          const namespaces = Array.isArray(view.namespaces) ? view.namespaces : []
          const ns = namespaces.find(entry => entry?.ns === settingsNs)
          if (ns === undefined) {
            set({
              status: 'error',
              error: `The "${settingsNs}" settings namespace is not registered. The bundle may not be active in this profile.`,
            })
            return
          }
          const pools = normalizePools(ns.value?.pools)
          set({
            status: 'ready',
            ns,
            pools,
            selected: state.selected !== null && pools[state.selected] !== undefined
              ? state.selected
              : Object.keys(pools)[0] ?? null,
          })
          await loadCredentials(pools, state.keys)
        } catch (failure) {
          if (ticket === generation) {
            set({
              status: state.ns === undefined ? 'error' : 'ready',
              error: String(failure?.message ?? failure),
            })
          }
        } finally {
          loading = false
        }
      }

      return {
        getSnapshot,
        subscribe,
        load,

        select(poolId) {
          set({ selected: poolId, confirmDelete: null, error: '', notice: '' })
        },
        setAdding(adding) {
          set({ adding, error: '' })
        },
        setNewId(newId) {
          set({ newId })
        },
        setConfirmDelete(confirmDelete) {
          set({ confirmDelete })
        },
        updatePool(poolId, patch) {
          if (state.pools[poolId] === undefined) return
          set({ pools: { ...state.pools, [poolId]: { ...state.pools[poolId], ...patch } }, notice: '' })
        },
        updateMember(poolId, index, patch) {
          const pool = state.pools[poolId]
          if (pool === undefined) return
          const members = pool.members.map((member, at) => at === index ? { ...member, ...patch } : member)
          set({ pools: { ...state.pools, [poolId]: { ...pool, members } }, notice: '' })
        },
        addMember(poolId) {
          const pool = state.pools[poolId]
          if (pool === undefined) return
          set({
            pools: {
              ...state.pools,
              [poolId]: {
                ...pool,
                members: [...pool.members, {
                  name: `member-${pool.members.length + 1}`,
                  baseURL: '',
                  api: 'openai-completions',
                  model: '',
                  apiKeyEnv: '',
                  contextWindow: '',
                  maxTokens: '',
                  headersText: '',
                  temperature: '',
                  compat: {
                    maxTokensField: '',
                    supportsStore: '',
                    supportsUsageInStreaming: '',
                    supportsStrictMode: '',
                  },
                  bodySetText: '',
                  bodyUnsetText: '',
                }],
              },
            },
            notice: '',
          })
        },
        removeMember(poolId, index) {
          const pool = state.pools[poolId]
          if (pool === undefined) return
          const keys = {}
          for (const [key, value] of Object.entries(state.keys)) {
            const [owner, at] = key.split('::')
            if (owner !== poolId) { keys[key] = value; continue }
            const numeric = Number(at)
            if (numeric === index) continue
            keys[`${owner}::${numeric > index ? numeric - 1 : numeric}`] = value
          }
          set({
            pools: { ...state.pools, [poolId]: { ...pool, members: pool.members.filter((_, at) => at !== index) } },
            keys,
          })
        },
        setKey(poolId, index, value) {
          set({ keys: { ...state.keys, [`${poolId}::${index}`]: value } })
        },
        createPool() {
          const poolId = state.newId.trim()
          if (poolId.length === 0) { set({ error: 'Enter a model id for the new pool.' }); return }
          if (!ID_PATTERN.test(poolId)) {
            set({ error: 'Pool/model id must start with a letter or digit and contain only letters, digits, dot, dash, or underscore.' })
            return
          }
          if (state.pools[poolId] !== undefined) { set({ error: `Pool "${poolId}" already exists.` }); return }
          set({
            pools: {
              ...state.pools,
              [poolId]: {
                displayName: '',
                strategy: 'round-robin',
                cadence: 'request',
                failover: true,
                maxAttempts: '',
                cooldownMs: '60000',
                replay: 'auto',
                contextWindow: '',
                maxTokens: '',
                input: ['text'],
                members: [{
                  name: 'primary',
                  baseURL: '',
                  api: 'openai-completions',
                  model: '',
                  apiKeyEnv: '',
                  contextWindow: '',
                  maxTokens: '',
                  headersText: '',
                  temperature: '',
                  compat: {
                    maxTokensField: '',
                    supportsStore: '',
                    supportsUsageInStreaming: '',
                    supportsStrictMode: '',
                  },
                  bodySetText: '',
                  bodyUnsetText: '',
                }],
              },
            },
            selected: poolId,
            adding: false,
            newId: '',
            error: '',
            notice: '',
          })
        },
        revertPool(poolId) {
          const raw = asObject(state.ns?.value?.pools)?.[poolId]
          if (raw === undefined) return
          set({ pools: { ...state.pools, [poolId]: poolDraft(raw) }, error: '', notice: '' })
        },
        async savePool(poolId) {
          const draft = state.pools[poolId]
          if (draft === undefined) return
          const problem = validatePool(poolId, draft)
          if (problem !== undefined) { set({ error: problem, notice: '' }); return }
          set({ busy: true, error: '', notice: '' })
          try {
            // Keys first: a failed key write must not leave a pool that looks
            // configured but has no credential behind it.
            for (let index = 0; index < draft.members.length; index += 1) {
              const typed = (state.keys[`${poolId}::${index}`] ?? '').trim()
              if (typed.length === 0) continue
              const member = draft.members[index]
              const ref = member.apiKeyEnv.trim().length > 0
                ? member.apiKeyEnv.trim()
                : deriveKeyRef(poolId, member.name.trim())
              const stored = await ops.setCredential(ref, typed)
              if (!stored.ok) throw new Error(stored.error.message)
            }
            const built = poolToSettings(poolId, draft)
            const response = await ops.mutateSettings([{
              op: 'set',
              path: ['pools', poolId],
              value: built.value,
            }], state.ns?.revision)
            if (!response.ok) {
              if (response.error.code === 'settings/conflict') {
                await load()
                throw new Error('Another tab changed these settings. The current values were reloaded; reapply your edit.')
              }
              throw new Error(response.error.message)
            }
            const keys = { ...state.keys }
            for (const key of Object.keys(keys)) if (key.startsWith(`${poolId}::`)) delete keys[key]
            set({ keys })
            await load()
            set({ notice: `Saved pool "${poolId}".` })
          } catch (failure) {
            set({ error: String(failure?.message ?? failure) })
          } finally {
            set({ busy: false })
          }
        },
        async removePool(poolId) {
          set({ busy: true, error: '', notice: '' })
          try {
            const response = await ops.mutateSettings([{
              op: 'unset',
              path: ['pools', poolId],
            }], state.ns?.revision)
            if (!response.ok) throw new Error(response.error.message)
            set({ selected: null, confirmDelete: null })
            await load()
            set({ notice: `Removed pool "${poolId}". Stored keys were left in place.` })
          } catch (failure) {
            set({ error: String(failure?.message ?? failure) })
          } finally {
            set({ busy: false })
          }
        },
        async clearKey(ref) {
          set({ error: '', notice: '' })
          try {
            const response = await ops.unsetCredential(ref)
            if (!response.ok) { set({ error: response.error.message }); return }
            await loadCredentials(state.pools, state.keys)
            set({ notice: `Removed the stored credential ${ref}.` })
          } catch (failure) {
            set({ error: String(failure?.message ?? failure) })
          }
        },
      }
    }

    /**
     * Keep a render fault inside this section. The shell's slot boundary
     * abdicates a crashed entry for the rest of the page's life; this boundary
     * keeps the section registered and shows the fault with a retry.
     */
    class SettingsErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('model-rotation: settings render failed', error, info)
      }

      render() {
        if (this.state.error === undefined) return this.props.children
        return h('div', { style: ui.page },
          h('h1', { style: ui.h1 }, 'Model Rotation'),
          h('div', { style: { ...ui.bar, ...ui.error } },
            'The Model Rotation form failed to render. Your draft is held in this tab; retrying re-renders the same state.'),
          h('pre', {
            style: { ...ui.textarea, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' },
          }, String(this.state.error?.stack ?? this.state.error).slice(0, 4000)),
          h(Button, { onClick: () => this.setState({ error: undefined }) }, 'Retry render'))
      }
    }

    function RotationSettings({ store }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const id = identity()

      useEffect(() => {
        if (store.getSnapshot().status === 'idle') void store.load()
      }, [store])

      const { pools, selected, keys, creds, busy, error, notice, adding, newId, confirmDelete } = state
      const poolIds = Object.keys(pools).sort()
      const selectedDraft = selected === null ? undefined : pools[selected]

      const header = h('div', null,
        h('h1', { style: ui.h1 }, 'Model Rotation'),
        h('p', { style: ui.lead },
          'One pool is one selectable model. Its members are endpoints that serve that model; rotation spreads calls across them and fails over before any output. ',
          h('span', { style: ui.code }, `Provider: ${id.provider}`),
          ` · ${poolIds.length} pool${poolIds.length === 1 ? '' : 's'}`),
      )

      if (state.status === 'loading' && state.ns === undefined) {
        return h('div', { style: ui.page }, header, h('div', { style: ui.muted }, 'Loading settings…'))
      }
      if (state.status === 'error' && state.ns === undefined) {
        return h('div', { style: ui.page }, header,
          h('div', { style: ui.error }, state.error),
          h('div', { style: { marginTop: 10 } }, h(Button, { onClick: () => void store.load() }, 'Retry')))
      }

      const bars = []
      if (error !== '') bars.push(h('div', { key: 'error', style: { ...ui.bar, ...ui.error } }, error))
      if (notice !== '') bars.push(h('div', { key: 'notice', style: { ...ui.bar, ...ui.notice } }, notice))

      const poolTabs = h('div', { style: { ...ui.row, marginBottom: 12 } },
        poolIds.map(poolId => h('button', {
          key: poolId,
          type: 'button',
          onClick: () => store.select(poolId),
          style: {
            ...ui.chip,
            ...(poolId === selected
              ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' }
              : {}),
          },
        }, poolId)),
        adding
          ? h('span', { style: { ...ui.row, gap: 6 } },
            h('input', {
              autoFocus: true,
              value: newId,
              placeholder: 'model id',
              onChange: event => store.setNewId(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') store.createPool() },
              style: { ...ui.input, width: 160 },
            }),
            h(Button, { kind: 'primary', onClick: () => store.createPool() }, 'Create'),
            h(Button, { onClick: () => store.setAdding(false) }, 'Cancel'))
          : h(Button, { onClick: () => store.setAdding(true) }, '+ New pool'),
      )

      if (selectedDraft === undefined) {
        return h('div', { style: ui.page }, header, bars, poolTabs,
          h('div', { style: { ...ui.card, ...ui.cardBody, ...ui.muted } },
            poolIds.length === 0
              ? 'No pools yet. Create one, add at least one member, then select it in the composer’s model picker.'
              : 'Select a pool above.'))
      }

      const pool = selectedDraft
      const editor = h('div', { style: ui.card },
        h('div', { style: ui.cardHead },
          h('div', { style: ui.row },
            h('span', { style: { fontWeight: 600 } }, pool.displayName.trim() || selected),
            h('span', { style: { ...ui.code, color: 'var(--dsw-alias-label-secondary)' } }, `model: ${selected}`)),
          h('div', { style: ui.row },
            confirmDelete === selected
              ? h(Button, {
                kind: 'danger',
                onClick: () => void store.removePool(selected),
                disabled: busy,
              }, 'Confirm delete')
              : h(Button, {
                kind: 'danger',
                onClick: () => store.setConfirmDelete(selected),
                disabled: busy,
              }, 'Delete pool'),
            h(Button, { kind: 'primary', onClick: () => void store.savePool(selected), disabled: busy }, busy ? 'Saving…' : 'Save pool'),
            h(Button, { onClick: () => store.revertPool(selected), disabled: busy }, 'Revert'))),
        h('div', { style: ui.cardBody },
          h('div', { style: ui.grid },
            h(Field, { label: 'Display name' },
              h(TextInput, { value: pool.displayName, placeholder: selected, onChange: value => store.updatePool(selected, { displayName: value }) })),
            h(Field, { label: 'Strategy' },
              h(Select, { value: pool.strategy, options: STRATEGIES, onChange: value => store.updatePool(selected, { strategy: value }) })),
            h(Field, { label: 'Rotate' },
              h(Select, { value: pool.cadence, options: CADENCES, onChange: value => store.updatePool(selected, { cadence: value }) })),
            h(Field, { label: 'Replay across members' },
              h(Select, { value: pool.replay, options: REPLAYS, onChange: value => store.updatePool(selected, { replay: value }) })),
            h(Field, { label: 'Max attempts', hint: 'Default: members, capped at 3' },
              h(TextInput, { value: pool.maxAttempts, placeholder: '3', onChange: value => store.updatePool(selected, { maxAttempts: value }) })),
            h(Field, { label: 'Cooldown (ms)', hint: 'Skipped member health window' },
              h(TextInput, { value: pool.cooldownMs, placeholder: '60000', onChange: value => store.updatePool(selected, { cooldownMs: value }) })),
            h(Field, { label: 'Context window', hint: 'Default: smallest member' },
              h(TextInput, { value: pool.contextWindow, placeholder: '262144', onChange: value => store.updatePool(selected, { contextWindow: value }) })),
            h(Field, { label: 'Max output tokens', hint: 'Default: smallest member' },
              h(TextInput, { value: pool.maxTokens, placeholder: '32768', onChange: value => store.updatePool(selected, { maxTokens: value }) })),
          ),
          h('div', { style: { ...ui.row, margin: '10px 0 4px' } },
            h(Checkbox, {
              checked: pool.failover,
              onChange: value => store.updatePool(selected, { failover: value }),
              label: 'Try another member before any output',
            }),
            h(Checkbox, {
              checked: pool.input.includes('image'),
              onChange: value => store.updatePool(selected, {
                input: value ? ['text', 'image'] : ['text'],
              }),
              label: 'Advertise image input',
            }),
            h(Checkbox, {
              checked: pool.captureRequestBodies,
              onChange: value => store.updatePool(selected, { captureRequestBodies: value }),
              label: 'Capture request bodies (sensitive)',
            })),
          pool.captureRequestBodies
            ? h('div', { style: { ...ui.muted, marginBottom: 4 } },
              'Captured bodies include the conversation and tool schemas. They are capped at 32 KB and kept in the session log; use this only while diagnosing a provider.')
            : null,

          h('div', { style: { marginTop: 14, marginBottom: 8, fontWeight: 600 } }, 'Members'),
          pool.members.map((member, index) => {
            const ref = member.apiKeyEnv.trim().length > 0
              ? member.apiKeyEnv.trim()
              : deriveKeyRef(selected, member.name.trim())
            const stored = creds[ref]?.configured === true
            const keyId = `${selected}::${index}`
            return h('div', { key: `${selected}-${index}`, style: ui.member },
              h('div', { style: { ...ui.cardHead, padding: '0 0 8px', borderBottom: 'none', background: 'transparent' } },
                h('div', { style: ui.row },
                  h('span', { style: { fontWeight: 600 } }, `Member ${index + 1}`),
                  h(Badge, { tone: stored ? 'ok' : 'warn' }, stored ? 'key stored' : 'no key stored')),
                h(Button, { kind: 'danger', onClick: () => store.removeMember(selected, index), disabled: busy }, 'Remove')),
              h('div', { style: ui.grid },
                h(Field, { label: 'Member id', hint: 'Used in logs and the key name' },
                  h(TextInput, { value: member.name, placeholder: 'gateway-a', onChange: value => store.updateMember(selected, index, { name: value }) })),
                h(Field, { label: 'Base URL' },
                  h(TextInput, { value: member.baseURL, placeholder: 'https://gateway.example/v1', onChange: value => store.updateMember(selected, index, { baseURL: value }) })),
                h(Field, { label: 'Protocol' },
                  h(Select, { value: member.api, options: PROTOCOLS, onChange: value => store.updateMember(selected, index, { api: value }) })),
                h(Field, { label: 'Model id' },
                  h(TextInput, { value: member.model, placeholder: 'model-name', onChange: value => store.updateMember(selected, index, { model: value }) })),
                h(Field, { label: stored ? 'Replace API key' : 'API key', hint: `Stored as ${ref}` },
                  h(TextInput, {
                    type: 'password',
                    value: keys[keyId] ?? '',
                    placeholder: stored ? 'Enter a new key to replace' : 'Enter API key',
                    onChange: value => store.setKey(selected, index, value),
                  })),
                h(Field, { label: 'Context window', hint: 'Default 262144' },
                  h(TextInput, { value: member.contextWindow, placeholder: '262144', onChange: value => store.updateMember(selected, index, { contextWindow: value }) })),
                h(Field, { label: 'Max output tokens', hint: 'Default 32768' },
                  h(TextInput, { value: member.maxTokens, placeholder: '32768', onChange: value => store.updateMember(selected, index, { maxTokens: value }) })),
              ),
              h('div', { style: { marginTop: 8 } },
                h(Field, { label: 'Extra headers (JSON, optional)', hint: 'HTTP headers only; they cannot change body fields.' },
                  h('textarea', {
                    value: member.headersText,
                    placeholder: '{}',
                    onChange: event => store.updateMember(selected, index, { headersText: event.target.value }),
                    style: ui.textarea,
                    spellCheck: false,
                  }))),

              h('div', { style: { ...ui.row, marginTop: 12, marginBottom: 6 } },
                h('span', { style: { fontWeight: 600, fontSize: 12 } }, 'Provider compatibility'),
                h('div', { style: { width: 300, marginLeft: 'auto' } },
                  h(Select, {
                    value: '',
                    options: [
                      { value: '', label: 'Apply a compatibility preset…' },
                      ...COMPAT_PRESETS.map(preset => ({ value: preset.id, label: preset.label })),
                    ],
                    onChange: (value) => {
                      if (value === '') return
                      const preset = COMPAT_PRESETS.find(candidate => candidate.id === value)
                      if (preset === undefined) return
                      store.updateMember(selected, index, { compat: { ...preset.compat } })
                    },
                  }))),
              h('div', { style: ui.grid },
                h(Field, { label: 'Output token field', hint: 'The body field carrying the output cap' },
                  h(Select, {
                    value: member.compat.maxTokensField,
                    options: OUTPUT_TOKEN_FIELDS,
                    onChange: value => store.updateMember(selected, index, { compat: { ...member.compat, maxTokensField: value } }),
                  })),
                h(Field, { label: 'Send store', hint: 'Some gateways reject an unknown store field' },
                  h(Select, {
                    value: member.compat.supportsStore,
                    options: SEND_STORE,
                    onChange: value => store.updateMember(selected, index, { compat: { ...member.compat, supportsStore: value } }),
                  })),
                h(Field, { label: 'Streaming usage' },
                  h(Select, {
                    value: member.compat.supportsUsageInStreaming,
                    options: USAGE_IN_STREAM,
                    onChange: value => store.updateMember(selected, index, { compat: { ...member.compat, supportsUsageInStreaming: value } }),
                  })),
                h(Field, { label: 'Strict tool schemas' },
                  h(Select, {
                    value: member.compat.supportsStrictMode,
                    options: STRICT_TOOLS,
                    onChange: value => store.updateMember(selected, index, { compat: { ...member.compat, supportsStrictMode: value } }),
                  })),
                h(Field, { label: 'Temperature', hint: 'Optional; omitted when empty' },
                  h(TextInput, { value: member.temperature, placeholder: 'provider default', onChange: value => store.updateMember(selected, index, { temperature: value }) })),
              ),

              h('div', { style: { ...ui.row, marginTop: 12, marginBottom: 4 } },
                h('span', { style: { fontWeight: 600, fontSize: 12 } }, 'Body overrides'),
                h('span', { style: ui.muted }, 'Applied to the JSON body just before send; headers and auth are untouched.')),
              h('div', { style: ui.grid },
                h(Field, { label: 'Set or replace fields (JSON object)', hint: 'e.g. {"max_tokens": 64000}' },
                  h('textarea', {
                    value: member.bodySetText,
                    placeholder: '{}',
                    onChange: event => store.updateMember(selected, index, { bodySetText: event.target.value }),
                    style: ui.textarea,
                    spellCheck: false,
                  })),
                h(Field, { label: 'Remove fields', hint: 'Comma or newline separated; rename = set new + remove old' },
                  h(TextInput, {
                    value: member.bodyUnsetText,
                    placeholder: 'max_completion_tokens, store',
                    onChange: value => store.updateMember(selected, index, { bodyUnsetText: value }),
                  })),
              ),

              h('div', { style: { ...ui.row, marginTop: 6 } },
                stored
                  ? h(Button, { kind: 'danger', onClick: () => void store.clearKey(ref), disabled: busy }, 'Clear stored key')
                  : null,
                member.apiKeyEnv.trim().length > 0
                  ? h('span', { style: ui.muted }, `custom reference: ${member.apiKeyEnv.trim()}`)
                  : null))
          }),
          h('div', { style: { ...ui.row, marginTop: 2 } },
            h(Button, { onClick: () => store.addMember(selected), disabled: busy }, '+ Add member')),

          h('div', { style: { ...ui.row, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-separator-primary)' } },
            h(Button, { kind: 'primary', onClick: () => void store.savePool(selected), disabled: busy }, busy ? 'Saving…' : 'Save pool'),
            h(Button, { onClick: () => store.revertPool(selected), disabled: busy }, 'Revert'),
            h('span', { style: ui.muted }, 'Keys are written to the credentials service; never to settings.'))),
      )

      return h('div', { style: ui.page }, header, bars, poolTabs, editor)
    }

    // ---- per-session log tab ----------------------------------------------
    async function fetchJson(path) {
      const id = identity()
      const response = await fetch(id.prefix + path, {
        headers: id.token.length === 0 ? {} : { authorization: `Bearer ${id.token}` },
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error ?? `model rotation request failed: ${response.status}`)
      }
      return payload
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms < 1000) return `${Math.round(ms)} ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
      return `${Math.round(ms / 60000)} min`
    }

    /** Format a captured body for display; fall back to the stored text. */
    function prettyBody(text) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        return String(text)
      }
    }

    function formatTime(value) {
      if (typeof value !== 'number') return '—'
      try {
        return new Date(value).toLocaleTimeString()
      } catch {
        return '—'
      }
    }

    function outcomeTone(outcome) {
      if (outcome === 'ok') return 'ok'
      if (outcome === 'error') return 'error'
      if (outcome === 'aborted') return 'warn'
      return 'default'
    }

    function RotationTab(props) {
      const sessionId = props.sessionId
      const [log, setLog] = useState({ status: 'loading', groups: [], error: '', path: '', truncated: false })
      const [health, setHealth] = useState([])
      const [errorsOnly, setErrorsOnly] = useState(false)
      const [expanded, setExpanded] = useState({})
      const [manual, setManual] = useState(0)
      const active = useRef(false)

      const load = useCallback(async () => {
        if (active.current || document.hidden) return
        active.current = true
        try {
          if (sessionId === undefined || sessionId === null) {
            setLog({ status: 'empty', groups: [], error: '', path: '', truncated: false })
            return
          }
          const [payload, healthPayload] = await Promise.all([
            fetchJson(`/log?sessionId=${encodeURIComponent(String(sessionId))}&limit=200`),
            fetchJson('/health').catch(() => null),
          ])
          setLog({
            status: 'ready',
            groups: Array.isArray(payload.groups) ? payload.groups : [],
            error: '',
            path: typeof payload.path === 'string' ? payload.path : '',
            truncated: payload.truncated === true,
          })
          if (healthPayload !== null && Array.isArray(healthPayload.pools)) setHealth(healthPayload.pools)
        } catch (failure) {
          setLog(current => ({
            ...current,
            status: current.groups.length === 0 ? 'error' : 'ready',
            error: String(failure?.message ?? failure),
          }))
        } finally {
          active.current = false
        }
      }, [sessionId])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 2500)
        return () => clearInterval(timer)
      }, [load, manual])

      const visible = useMemo(() => {
        const groups = [...log.groups].reverse()
        return errorsOnly ? groups.filter(group => group.outcome !== 'ok') : groups
      }, [log.groups, errorsOnly])

      const total = log.groups.length
      const failures = log.groups.filter(group => group.outcome === 'error').length

      const header = h('div', { style: { padding: '9px 12px', borderBottom: '1px solid var(--dsw-alias-separator-primary)' } },
        h('div', { style: ui.row },
          h('span', { style: { fontWeight: 600, fontSize: 12 } }, 'Model Rotation'),
          h('span', { style: ui.muted }, `${total} request${total === 1 ? '' : 's'}${failures > 0 ? ` · ${failures} failed` : ''}`),
          h('span', { style: { flex: 1 } }),
          h(Checkbox, { checked: errorsOnly, onChange: setErrorsOnly, label: 'Errors only' }),
          h(Button, { onClick: () => { setManual(value => value + 1); void load() } }, 'Refresh')),
        log.error === ''
          ? null
          : h('div', { style: { ...ui.error, marginTop: 6 } }, log.error))

      if (log.status === 'loading' && total === 0) {
        return h('div', { style: { ...ui.page, padding: 0 } }, header, h('div', { style: { ...ui.muted, padding: 12 } }, 'Reading this session’s requests…'))
      }
      if (log.status === 'error' && total === 0) {
        return h('div', { style: { ...ui.page, padding: 0 } }, header,
          h('div', { style: { padding: 12, ...ui.muted } },
            h('div', null, 'The Host log surface did not answer. If the plugin was just installed, reload the page so the tab receives its token.'),
            h('div', { style: { ...ui.error, marginTop: 6 } }, log.error)))
      }

      const rows = visible.map((group) => {
        const open = expanded[group.id] === true
        const head = h('div', { style: ui.logHead },
          h('span', { style: ui.logMeta }, formatTime(group.t)),
          h('span', { style: { ...ui.code, color: 'var(--dsw-alias-label-secondary)' } },
            `#${group.request ?? '?'}${group.turn === undefined ? '' : ` · turn ${group.turn}${group.step === undefined ? '' : `/${group.step}`}`}`),
          h('span', { style: { fontWeight: 600 } }, String(group.pool ?? '?')),
          h('span', { style: ui.logMeta }, '→'),
          h('span', null, String(group.member ?? '?')),
          h('span', { style: { ...ui.code, color: 'var(--dsw-alias-label-secondary)' } }, String(group.memberModel ?? '')),
          h('span', { style: { flex: 1 } }),
          h(Badge, { tone: outcomeTone(group.outcome) },
            group.outcome === 'ok'
              ? 'ok'
              : group.outcome === 'pending'
                ? 'in flight'
                : `${group.outcome}${group.code === undefined ? '' : ` ${group.code}`}`),
          h('span', { style: ui.logMeta }, formatDuration(group.ms)))
        const messageLine = group.message === undefined || group.message === '' || open
          ? null
          : h('div', { style: { ...ui.error, marginTop: 4, fontSize: 11 } }, String(group.message).slice(0, 240))
        const attemptRows = (group.attempts ?? []).map((attempt, index) => h('div', {
          key: `${group.id}-${index}`,
          style: { ...ui.muted, marginTop: 3 },
        },
        `${attempt.member ?? '?'} (${attempt.memberModel ?? '?'}) · ${attempt.code ?? '?'}`
        + `${attempt.status === undefined ? '' : ` ${attempt.status}`} · ${formatDuration(attempt.ms)}`
        + `${attempt.message === undefined ? '' : ` — ${String(attempt.message).slice(0, 400)}`}`))
        const detail = !open ? null : h('div', { style: { marginTop: 8, fontSize: 11 } },
          h('div', { style: ui.muted },
            `purpose ${group.purpose ?? 'chat'} · cadence ${group.cadence ?? '?'} · strategy ${group.strategy ?? '?'}`
            + `${group.allCooling ? ' · all members were cooling' : ''}`
            + `${group.committed ? ' · output had been committed' : ''}`),
          attemptRows.length === 0 ? null : h('div', { style: { marginTop: 6 } }, attemptRows),
          group.message === undefined
            ? null
            : h('div', { style: { ...ui.error, marginTop: 6 } }, String(group.message).slice(0, 800)),
          typeof group.requestBody !== 'string'
            ? null
            : h('div', { style: { marginTop: 8 } },
              h('div', { style: { ...ui.muted, marginBottom: 4 } }, 'Request body (captured before send)'),
              h('pre', {
                style: {
                  ...ui.textarea,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 360,
                  overflow: 'auto',
                  margin: 0,
                  fontSize: 10,
                },
              }, prettyBody(group.requestBody))))
        return h('div', {
          key: group.id,
          style: ui.logRow,
          onClick: () => setExpanded(current => ({ ...current, [group.id]: !open })),
        }, head, messageLine, detail)
      })
      const body = visible.length === 0
        ? h('div', { style: { padding: 12, ...ui.muted } },
          total === 0
            ? 'No routed model calls in this session yet. Select a Model Rotation model in the composer to start.'
            : 'No requests match the current filter.')
        : h('div', null, rows)

      const healthPools = health.map((pool) => {
        const chips = (pool.members ?? []).map((member) => {
          const label = `${member.name}${member.cooling
            ? ` · cooling ${Math.ceil((member.cooldownRemainingMs ?? 0) / 1000)}s`
            : member.failures > 0
              ? ` · ${member.failures} failure(s)`
              : ' · ok'}`
          return h('span', {
            key: member.key ?? member.name,
            style: {
              ...ui.badge,
              color: member.cooling
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-label-secondary)',
            },
            title: member.lastMessage ?? '',
          }, label)
        })
        return h('div', { key: pool.pool, style: { ...ui.row, marginTop: 3 } },
          h('span', { style: { fontSize: 11, fontWeight: 600 } }, String(pool.pool)),
          chips)
      })
      const healthFooter = health.length === 0
        ? null
        : h('div', { style: { borderTop: '1px solid var(--dsw-alias-separator-primary)', padding: '8px 12px' } },
          h('div', { style: { ...ui.muted, marginBottom: 4 } }, 'Member health'),
          healthPools)

      const pathLine = log.path === ''
        ? null
        : h('div', { style: { borderTop: '1px solid var(--dsw-alias-separator-primary)', padding: '6px 12px', ...ui.muted } },
          `log: ${log.path}${log.truncated ? ' (older entries omitted)' : ''}`)

      return h('div', { style: { height: '100%', overflowY: 'auto', color: 'var(--dsw-alias-label-primary)', fontSize: 12 } },
        header, body, healthFooter, pathLine)
    }

    /** Tab chip label. */
    function RotationTabTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, 'Rotation')
    }

    return {
      inject: [
        'slots',
        'sidebarRight',
        'sidebarRightTabs',
        'remote',
        'remote.settings',
        'remote.credentials',
      ],
      apply(ctx) {
        // Created once per client plugin instance, not per render: a slot
        // remount must not discard the draft or re-run the host read.
        const store = createRotationSettingsStore({
          describeSettings: () => ctx.remote.settings.describe(),
          mutateSettings: (operations, revision) => ctx.remote.settings.mutate(identity().settingsNs, operations, revision),
          describeCredentials: refs => ctx.remote.credentials.describe(refs),
          setCredential: (ref, value) => ctx.remote.credentials.set(ref, value),
          unsetCredential: ref => ctx.remote.credentials.unset(ref),
        }, identity().settingsNs)
        const SettingsPage = () => h(SettingsErrorBoundary, null, h(RotationSettings, { store }))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-rotation',
          order: 12,
          label: 'Model Rotation',
        }, SettingsPage))

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => 'Rotation',
          keepMounted: true,
          guide: [{
            id: TAB_ID,
            order: 35,
            title: () => 'Rotation',
            description: () => 'Model rotation requests and member health for this session',
          }],
        }), 'model-rotation.tab-type')

        const Tab = props => h(RotationTab, props)
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, Tab))
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
        }, RotationTabTitle))
      },
      __components: {
        RotationSettings,
        RotationTab,
        createRotationSettingsStore,
        SettingsErrorBoundary,
        RotationTabTitle,
        normalizePools,
        poolDraft,
        poolToSettings,
        validatePool,
        deriveKeyRef,
      },
    }
  },
})
