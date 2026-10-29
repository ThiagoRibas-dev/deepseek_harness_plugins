/**
 * Client plugin: Core Memories Web UI tab.
 *
 * Registers under `settings.plugins.tab` so it appears as a settings panel
 * alongside other profile plugins. It reads/writes through the memory REST
 * surface (`/api/memory/core`) rather than through a typed Remote.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    /**
     * Identity the host injects into the page.
     *
     * The route authenticates itself — a plugin route inherits none of the
     * harness's own authentication — so the token arrives with the document, which
     * is only ever served to an already-authenticated browser.
     */
    const identity = () => window.__DSH_MEMORY__ ?? { prefix: '/api/memory', token: '' }

    const request = async (path, options = {}) => {
      const { prefix, token } = identity()
      const response = await fetch(prefix + path, {
        ...options,
        headers: {
          ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      })
      if (!response.ok) {
        let message = `Memory request failed: ${response.status}`
        try {
          const payload = await response.json()
          if (payload?.message) message = payload.message
        } catch { /* ignore */ }
        throw new Error(message)
      }
      return response
    }

    const call = async (path, options) => {
      const response = await request(path, options)
      return (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null
    }

    /**
     * Shared style vocabulary.
     *
     * Every value here is a token the harness actually defines. The first version
     * invented names (`--dsw-alias-surface-subtle`, `--dsw-alias-text-muted`), so
     * each `var()` fell through to a light fallback and the panel rendered as pale
     * cards behind dark form controls.
     *
     * Form controls carry explicit `background`, `color`, and `border`: without
     * them the user agent draws its own theme, which is what made the inputs look
     * like a different application from the pane.
     */
    const ui = {
      panel: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        marginBottom: 8,
      },
      panelHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid var(--dsw-alias-separator-primary)',
        fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
      },
      panelBody: { padding: 10 },
      count: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' },
      input: {
        padding: '4px 8px', fontSize: 12, borderRadius: 4,
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        minWidth: 0,
      },
      button: {
        padding: '3px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
        background: 'var(--dsw-alias-button-elevated-fill)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      primaryButton: {
        padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        border: '1px solid transparent',
      },
      dangerButton: {
        padding: '3px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
        background: 'transparent',
        color: 'var(--dsw-alias-label-error)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      muted: { color: 'var(--dsw-alias-label-tertiary)' },
      caption: { fontSize: 11, color: 'var(--dsw-alias-label-caption)' },
      error: { fontSize: 11, color: 'var(--dsw-alias-label-error)' },
      empty: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      name: {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
    }

    /** A panel with a header line, the shape every section in the tab uses. */
    /** One corpus hit: where it came from, then an excerpt. */
    function HitRow({ hit, first }) {
      const text = String(hit.content ?? '')
      const excerpt = text.length > 220 ? `${text.slice(0, 220)}…` : text
      return h('div', {
        style: {
          borderTop: first ? 'none' : '1px solid var(--dsw-alias-separator-primary)',
          paddingTop: first ? 0 : 6,
          marginTop: first ? 0 : 6,
        },
      },
        h('div', { style: { ...ui.mono, ...ui.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          hit.source_path ?? hit.title ?? hit.id ?? ''),
        h('div', { style: { marginTop: 2 } }, excerpt))
    }


    function Panel({ title, count, actions, children }) {
      return h('div', { style: ui.panel },
        h('div', { style: ui.panelHead },
          h('span', null, title, count === undefined ? null : h('span', { style: { ...ui.count, marginLeft: 6 } }, String(count))),
          actions ?? null),
        h('div', { style: ui.panelBody }, children))
    }

    /** One core memory row: read, edit in place, delete. */
    function MemoryRow({ memory, onRefresh }) {
      const [editing, setEditing] = useState(false)
      const [directive, setDirective] = useState(String(memory.directive || ''))
      const [priority, setPriority] = useState(memory.priority ?? 0)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          await call('/core', {
            method: 'POST',
            body: JSON.stringify({ action: 'set', key: memory.key, directive, priority, namespace: memory.namespace || 'global' }),
          })
          await onRefresh()
          setEditing(false)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const removeMemory = async () => {
        setBusy(true)
        setError('')
        try {
          await call('/core', {
            method: 'DELETE',
            body: JSON.stringify({ key: memory.key, namespace: memory.namespace || 'global' }),
          })
          await onRefresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (editing) {
        return h('div', { style: { borderTop: '1px solid var(--dsw-alias-separator-primary)', padding: '8px 0' } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, memory.key),
          h('textarea', {
            value: directive,
            onChange: (e) => setDirective(e.target.value),
            rows: 3,
            style: { ...ui.input, width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 54 },
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('label', { style: ui.caption }, 'Priority',
              h('input', {
                type: 'number', value: priority,
                onChange: (e) => setPriority(Number(e.target.value) || 0),
                style: { ...ui.input, width: 64, marginLeft: 4 },
              })),
            h('button', { onClick: save, disabled: busy, style: { ...ui.primaryButton, ...(busy ? ui.disabled : {}) } }, busy ? 'Saving…' : 'Save'),
            h('button', { onClick: () => { setEditing(false); setDirective(String(memory.directive || '')); setPriority(memory.priority ?? 0); setError('') }, disabled: busy, style: ui.button }, 'Cancel'),
            error === '' ? null : h('span', { style: ui.error }, error)))
      }

      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-separator-primary)', padding: '8px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: { fontWeight: 600 } }, memory.key),
          h('span', { style: ui.caption }, `priority ${memory.priority ?? 0}`),
          memory.updated_at ? h('span', { style: ui.caption }, String(memory.updated_at).slice(0, 10)) : null),
        h('div', { style: { ...ui.mono, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-secondary)' } }, String(memory.directive || '')),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
          h('button', { onClick: () => setEditing(true), style: ui.button }, 'Edit'),
          h('button', { onClick: removeMemory, disabled: busy, style: { ...ui.dangerButton, ...(busy ? ui.disabled : {}) } }, busy ? 'Deleting…' : 'Delete'),
          error === '' ? null : h('span', { style: ui.error }, error)))
    }

    /** Main settings panel component. */
    function CoreMemoriesPanel() {
      const [memories, setMemories] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [newKey, setNewKey] = useState('')
      const [newDirective, setNewDirective] = useState('')
      const [newPriority, setNewPriority] = useState(0)
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const data = await call('/core')
          setMemories((data && Array.isArray(data.memories)) ? data.memories : [])
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const addMemory = async () => {
        if (!newKey.trim() || !newDirective.trim()) return
        setBusy(true)
        setError('')
        try {
          await call('/core', {
            method: 'POST',
            body: JSON.stringify({ action: 'set', key: newKey.trim(), directive: newDirective.trim(), priority: Number(newPriority) || 0, namespace: 'global' }),
          })
          setNewKey(''); setNewDirective(''); setNewPriority(0)
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const headerStyle = { fontWeight: 600, fontSize: 16, marginBottom: 12, color: 'var(--dsw-alias-label-primary)' }
      const muted = { color: 'var(--dsw-alias-label-tertiary)' }
      const cardStyle = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: 12, background: 'var(--dsw-alias-bg-layer-2)' }
      const inputStyle = { padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, width: '100%', boxSizing: 'border-box', marginBottom: 6 }

      return h('div', null,
        h('div', { style: { ...headerStyle, marginTop: 8 } }, 'Core Memories'),
        h('p', { style: { ...muted, fontSize: 12, marginBottom: 12 } }, 'Persistent directives injected into the system prompt (Tier 1). Changes apply to every session immediately.'),
        loading ? h('div', { style: { ...muted, fontSize: 12 } }, 'Loading memories…') : null,
        error ? h('div', { style: { color: 'var(--dsw-alias-label-error)', fontSize: 12, marginBottom: 8 } }, error) : null,
        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 8 } }, 'Add new core memory'),
          h('input', {
            type: 'text',
            placeholder: 'Memory key (e.g. user_name)',
            value: newKey,
            onChange: (e) => setNewKey(e.target.value),
            style: inputStyle,
          }),
          h('textarea', {
            placeholder: 'Directive / instruction text',
            value: newDirective,
            onChange: (e) => setNewDirective(e.target.value),
            rows: 3,
            style: { ...inputStyle, resize: 'vertical', minHeight: 48 },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
            h('label', { style: { fontSize: 11 } }, 'Priority: '),
            h('input', { type: 'number', value: newPriority, onChange: (e) => setNewPriority(Number(e.target.value) || 0), style: { width: 60, padding: '2px 4px', fontSize: 12, borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2)' } }),
            h('button', {
              onClick: addMemory,
              disabled: busy || !newKey.trim() || !newDirective.trim(),
              style: { padding: '4px 12px', fontSize: 12, cursor: (busy || !newKey.trim() || !newDirective.trim()) ? 'default' : 'pointer', background: 'var(--dsw-alias-button-primary-fill)', color: '#fff', border: 'none', borderRadius: 4 },
            }, busy ? 'Adding…' : 'Add Memory')),
        ),
        memories.length === 0 && !loading ? h('div', { style: { ...muted, fontSize: 12, marginTop: 8, padding: 8, border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 4 } }, 'No core memories yet. Add one above.') : null,
        memories.map((m) => h(MemoryRow, { key: String(m.id || m.key), memory: m, onRefresh: refresh })),
        h(RecallPolicyCard),
        h(PrepareEmbedderCard),
        h(VectorHealthCard),
        h(DocumentUploadCard),
      )
    }

    /**
     * Vector provenance.
     *
     * Reports which encoder produced the stored vectors and offers the two
     * remedies — re-embed, or drop the unusable vectors — without ever choosing
     * for the reader. Re-embedding a corpus is minutes of CPU, so it stays a
     * button.
     */
    function VectorHealthCard() {
      const [vectors, setVectors] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')

      const refresh = useCallback(async () => {
        try {
          const data = await call('/status')
          setVectors(data?.vectors ?? null)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const act = async (label, path) => {
        setBusy(label)
        setError('')
        setNote('')
        try {
          const result = await call(path, { method: 'POST', body: JSON.stringify({ limit: 200 }) })
          if (path.endsWith('reembed')) {
            setNote(`Re-embedded ${result.embedded ?? 0} item(s); ${result.remaining ?? 0} left.`)
          } else {
            setNote(`Dropped ${result.purged?.total ?? 0} unusable vector(s); the text is untouched.`)
          }
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      if (vectors === null) return null

      const cardStyle = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: 12, background: 'var(--dsw-alias-bg-layer-2)', marginTop: 8 }
      const muted = { color: 'var(--dsw-alias-label-tertiary)' }
      const danger = { color: 'var(--dsw-alias-label-error)' }
      const foreign = vectors.foreign?.total ?? 0
      const missing = vectors.missing?.total ?? 0
      const stale = vectors.stale?.total ?? 0
      const buttonStyle = (disabled) => ({ padding: '4px 12px', fontSize: 12, cursor: disabled ? 'default' : 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, opacity: disabled ? 0.6 : 1 })

      return h('div', { style: cardStyle },
        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Vector index'),
        h('div', { style: { fontSize: 12, marginBottom: 6, color: stale === 0 ? 'var(--dsw-alias-state-success-primary)' : muted } },
          vectors.activeModel ? `● ${vectors.activeModel}` : '● no encoder declared',
          stale === 0 ? ' — every vector matches' : ` — ${stale} item(s) unusable`),
        stale === 0 ? null : h('div', { style: { ...muted, fontSize: 11, marginBottom: 6 } },
          `${foreign} from another encoder, ${missing} with no vector. Dense search skips them; keyword search still finds them.`),
        (vectors.byModel ?? []).length === 0 ? null : h('div', { style: { marginBottom: 6 } },
          ...vectors.byModel.map((entry) => h('div', {
            key: `${entry.kind}:${entry.model}`,
            style: { fontSize: 11, ...muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
          }, `${String(entry.count).padStart(5)}  ${entry.kind}  ${entry.model}`))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            onClick: () => act('reembed', '/vectors/reembed'),
            disabled: busy !== '' || stale === 0,
            style: buttonStyle(busy !== '' || stale === 0),
          }, busy === 'reembed' ? 'Re-embedding…' : 'Re-embed now'),
          h('button', {
            onClick: () => act('purge', '/vectors/purge'),
            disabled: busy !== '' || foreign === 0,
            style: buttonStyle(busy !== '' || foreign === 0),
          }, busy === 'purge' ? 'Purging…' : 'Drop unusable vectors'),
          h('button', { onClick: () => { void refresh() }, style: buttonStyle(false) }, 'Refresh')),
        note === '' ? null : h('div', { style: { ...muted, fontSize: 11, marginTop: 6 } }, note),
        error === '' ? null : h('div', { style: { ...danger, fontSize: 11, marginTop: 6 } }, error)
      )
    }

    /**
     * Manual document ingestion.
     *
     * The file is read in the browser and sent as text: the host writes it into
     * the configured ingestion folder and then indexes it, so an upload that
     * indexes badly is still readable in one place on disk.
     */
    function DocumentUploadCard() {
      const [collection, setCollection] = useState('uploads')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [sources, setSources] = useState([])

      const refresh = useCallback(async () => {
        try {
          const data = await call('/corpus/sources?limit=50')
          setSources(data?.sources ?? [])
        } catch {
          // A source list that cannot be read is not worth an error banner over
          // the upload control itself.
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const upload = async (event) => {
        const input = event?.target
        const file = input?.files?.[0]
        if (!file) return
        setBusy(true)
        setError('')
        setStatus(null)
        try {
          const text = await file.text()
          const result = await call('/corpus/upload', {
            method: 'POST',
            body: JSON.stringify({ filename: file.name, content: text, collection }),
          })
          setStatus(result)
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
          if (input) input.value = ''
        }
      }

      const cardStyle = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: 12, background: 'var(--dsw-alias-bg-layer-2)', marginTop: 8 }
      const muted = { color: 'var(--dsw-alias-label-tertiary)' }
      const danger = { color: 'var(--dsw-alias-label-error)' }
      const inputStyle = { padding: '4px 8px', fontSize: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4 }

      return h('div', { style: cardStyle },
        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Reference documents'),
        h('div', { style: { ...muted, fontSize: 11, marginBottom: 8 } },
          'Upload a document to index it for search_reference. Files land in the configured ingestion folder.'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            type: 'file',
            onChange: upload,
            disabled: busy,
            'aria-label': 'Upload a document to index',
            style: { fontSize: 12 },
          }),
          h('label', { style: { fontSize: 11, color: muted.text || '#777' } }, 'Collection: ',
            h('input', {
              type: 'text',
              value: collection,
              onChange: (e) => setCollection(e.target.value),
              style: { ...inputStyle, width: 120 },
            }))),
        busy ? h('div', { style: { ...muted, fontSize: 11, marginTop: 6 } }, 'Uploading and indexing…') : null,
        status ? h('div', { style: { fontSize: 11, marginTop: 6 } },
          `Indexed ${status.record?.chunkCount ?? 0} chunk(s) from ${status.filename} into "${status.collection}"`,
          status.record?.status === 'skipped' ? ' (unchanged, skipped)' : '') : null,
        error ? h('div', { style: { ...danger, fontSize: 11, marginTop: 6 } }, error) : null,
        sources.length === 0
          ? h('div', { style: { ...muted, fontSize: 11, marginTop: 8 } }, 'No reference documents indexed yet.')
          : h('div', { style: { marginTop: 8 } },
              h('div', { style: { ...muted, fontSize: 11, marginBottom: 4 } }, `${sources.length} indexed source(s):`),
              ...sources.slice(0, 10).map((s) => h('div', {
                key: `${s.collection}:${s.source_path}`,
                style: { fontSize: 11, color: muted.text || '#777', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: s.source_path,
              }, `${s.chunk_count} chunks · ${s.origin} · ${s.source_path}`)))
      )
    }

    /**
     * Passive recall, per preset.
     *
     * Off by default: the layer changes what an agent sees on every turn, so
     * turning it on is a deliberate act recorded against a preset. The list comes
     * from the host's policy document, which the shipped preset registry fills.
     */
    function RecallPolicyCard() {
      const [state, setState] = useState(null)
      const [presets, setPresets] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const refresh = useCallback(async () => {
        try {
          setState(await call('/recall-policy'))
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
        try {
          const data = await call('/status')
          setPresets(data?.presets ?? [])
        } catch { /* the preset list is a convenience here */ }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const write = async (next) => {
        setBusy(true)
        setError('')
        try {
          setState(await call('/recall-policy', { method: 'POST', body: JSON.stringify(next) }))
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (state === null) return null
      const known = [...new Set([...(presets ?? []), ...Object.keys(state.presets ?? {})])].sort()
      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '3px 0' }

      return h(Panel, { title: 'Passive recall' },
        h('div', { style: ui.caption }, 'Inject recalled memory at the start of a turn. Off unless a preset is switched on.'),
        state.problem ? h('div', { style: { ...ui.error, marginTop: 6 } }, state.problem) : null,
        h('div', { style: rowStyle },
          h('span', null, 'Default for presets not listed'),
          h('input', {
            type: 'checkbox',
            checked: state.default === true,
            disabled: busy,
            onChange: (e) => write({ default: e.target.checked, presets: state.presets ?? {} }),
          })),
        known.length === 0
          ? h('div', { style: { ...ui.empty, marginTop: 4 } }, 'No presets reported by the host.')
          : h('div', { style: { marginTop: 4 } }, ...known.map((preset) => h('div', { key: preset, style: rowStyle },
              h('span', { style: ui.mono }, preset),
              h('input', {
                type: 'checkbox',
                checked: (state.presets ?? {})[preset] === true,
                disabled: busy,
                'aria-label': `Passive recall for ${preset}`,
                onChange: (e) => write({ default: state.default === true, presets: { ...(state.presets ?? {}), [preset]: e.target.checked } }),
              })))),
        h('div', { style: { ...ui.caption, marginTop: 6 } }, state.path ?? ''),
        error === '' ? null : h('div', { style: { ...ui.error, marginTop: 6 } }, error))
    }

    /** Embedder preparation card: shows model status and allows download trigger. */
    function PrepareEmbedderCard() {
      const [status, setStatus] = useState({ phase: 'unknown', reason: 'unknown' })
      const [variant, setVariant] = useState('q8')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const refresh = useCallback(async (which) => {
        try {
          // `/status` carries the host-side preparation state: phase, reason,
          // verified pin, byte progress, and the variant catalogue.
          const data = await call(`/status${which ? `?variant=${encodeURIComponent(which)}` : ''}`)
          const prep = data?.preparation ?? {}
          setStatus({
            phase: prep.phase ?? 'unknown',
            reason: prep.reason ?? 'unknown',
            pinVerified: prep.pinVerified === true,
            estimate: prep.estimate ?? null,
            progress: prep.progress ?? null,
            cachedPath: prep.cachedPath ?? null,
            error: prep.error ?? null,
            variants: prep.variants ?? [],
            defaultVariant: prep.defaultVariant ?? 'q8',
            presentFiles: prep.presentFiles,
            totalFiles: prep.totalFiles,
          })
          setError('')
        } catch (e) {
          setStatus({ phase: 'unknown', reason: String(e.message || e) })
        }
      }, [])

      // Poll only while work is in flight; an idle panel generates no traffic.
      useEffect(() => {
        let live = true
        void refresh(variant)
        const timer = setInterval(() => {
          setStatus((current) => {
            if (live && ['downloading', 'verifying'].includes(current.phase)) void refresh(variant)
            return current
          })
        }, 1500)
        return () => { live = false; clearInterval(timer) }
      }, [refresh, variant])

      const start = async () => {
        setBusy(true)
        setError('')
        try {
          await call('/prepare-embedder', { method: 'POST', body: JSON.stringify({ variant }) })
          await refresh(variant)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const cardStyle = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: 12, background: 'var(--dsw-alias-bg-layer-2)', marginTop: 8 }
      const muted = { color: 'var(--dsw-alias-label-tertiary)' }
      const danger = { color: 'var(--dsw-alias-label-error)' }
      const ready = status.phase === 'ready'
      const active = ['downloading', 'verifying'].includes(status.phase)
      const bytes = status.progress?.completedBytes
      const total = status.progress?.totalBytes
      const selected = (status.variants ?? []).find((v) => v.id === variant)
      const totalMb = selected?.totalBytes
        ? (selected.totalBytes / 1e6).toFixed(0)
        : (status.estimate?.recommendedDiskBytes ? (status.estimate.recommendedDiskBytes / 1e6).toFixed(0) : null)

      return h('div', { style: cardStyle },
        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Embedding Model'),
        h('div', { style: { fontSize: 12, color: ready ? 'var(--dsw-alias-state-success-primary)' : muted, marginBottom: 8 } },
          ready ? '● ready' : `● ${status.phase}`, ' — ', status.reason),
        (status.variants ?? []).length === 0 ? null : h('div', { style: { marginBottom: 6 } },
          h('select', {
            value: variant,
            disabled: active,
            onChange: (e) => setVariant(e.target.value),
            style: { fontSize: 12, padding: '2px 4px', maxWidth: '100%', cursor: active ? 'default' : 'pointer' },
          }, ...status.variants.map((v) => h('option', { key: v.id, value: v.id, title: v.note }, v.label)))),
        selected?.note ? h('div', { style: { ...muted, fontSize: 11, marginBottom: 6 } }, selected.note) : null,
        totalMb === null ? null : h('div', { style: { ...muted, fontSize: 11, marginBottom: 6 } },
          `${totalMb} MB download once prepared · 256-d float16 vectors`,
          status.totalFiles ? ` · ${status.presentFiles ?? 0}/${status.totalFiles} files cached` : ''),
        status.pinVerified === false
          ? h('div', { style: { ...muted, fontSize: 11, marginBottom: 6 } },
              'This variant has no verified sha256 pin, so a download is refused rather than trusted.')
          : null,
        bytes === undefined || total === undefined ? null : h('div', { style: { ...muted, fontSize: 11, marginBottom: 6 } },
          `${(bytes / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`),
        status.error ? h('div', { style: { ...danger, fontSize: 11, marginBottom: 6 } }, status.error) : null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            onClick: start,
            disabled: busy || active || ready,
            style: { padding: '4px 12px', fontSize: 12, cursor: (busy || active || ready) ? 'default' : 'pointer', background: 'var(--dsw-alias-button-primary-fill)', color: '#fff', border: 'none', borderRadius: 4, opacity: (busy || active || ready) ? 0.6 : 1 },
          }, ready ? 'Prepared' : (active ? 'Preparing…' : 'Prepare model')),
          h('button', {
            onClick: () => { void refresh(variant) },
            style: { padding: '4px 10px', fontSize: 12, cursor: 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4 },
          }, 'Refresh')),
        error === '' ? null : h('div', { style: { ...danger, fontSize: 11, marginTop: 6 } }, error)
      )
    }

    /**
     * The working surface: the Memory tab in the right Sidebar.
     *
     * The settings tab configures memory — the encoder, the core directives, the
     * vector report. This is where the work happens, next to the file browser and
     * the terminal, because managing corpus documents is a session activity and
     * not a preference.
     */
    function MemoryTab({ sessionId }) {
      const [sources, setSources] = useState([])
      const [inbox, setInbox] = useState([])
      const [vectors, setVectors] = useState(null)
      const [collection, setCollection] = useState('uploads')
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')

      const refresh = useCallback(async () => {
        try {
          const data = await call('/corpus/sources?limit=100')
          setSources(data?.sources ?? [])
          setInbox(data?.inbox ?? [])
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
        try {
          const status = await call('/status')
          setVectors(status?.vectors ?? null)
        } catch { /* the vector report is optional here */ }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const act = async (label, path, payload) => {
        setBusy(label)
        setError('')
        setNote('')
        try {
          const result = await call(path, { method: 'POST', body: JSON.stringify(payload ?? {}) })
          if (path.endsWith('reindex')) setNote(`${result.status} · ${result.chunkCount ?? 0} chunk(s)`)
          else if (path.endsWith('remove')) setNote(`forgot ${result.removedChunks} chunk(s)${result.removedFile ? ', deleted the file' : ''}`)
          else if (path.endsWith('reembed')) setNote(`re-embedded ${result.embedded ?? 0}; ${result.remaining ?? 0} left`)
          else if (path.endsWith('purge')) setNote(`dropped ${result.purged?.total ?? 0} unusable vector(s)`)
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const upload = async (event) => {
        const input = event?.target
        const file = input?.files?.[0]
        if (!file) return
        setBusy('upload')
        setError('')
        setNote('')
        try {
          const text = await file.text()
          const result = await call('/corpus/upload', { method: 'POST', body: JSON.stringify({ filename: file.name, content: text, collection }) })
          setNote(`indexed ${result.record?.chunkCount ?? 0} chunk(s) from ${result.filename}`)
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
          if (input) input.value = ''
        }
      }

      const search = async () => {
        if (query.trim().length === 0) { setHits(null); return }
        setBusy('search')
        setError('')
        try {
          setHits(await call('/search', {
            method: 'POST',
            body: JSON.stringify({ query: query.trim(), includeCore: false, includeEpisodic: false, includeCorpus: true, limit: 8 }),
          }))
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const stale = vectors?.stale?.total ?? 0
      const foreign = vectors?.foreign?.total ?? 0
      const disabled = busy !== ''
      const btn = (extra) => ({ ...ui.button, ...(extra ?? {}), ...(disabled ? ui.disabled : {}) })

      // Sections as small builders rather than one nested expression: the shape is
      // easier to read and a missing parenthesis has one obvious place to be.
      const searchSection = () => h(Panel, {
        title: 'Search the corpus',
        actions: h('span', { style: ui.caption }, hits === null ? '' : `${hits.total} hit(s)`),
      },
        h('div', { style: { display: 'flex', gap: 6 } },
          h('input', {
            type: 'text', value: query, placeholder: 'topic, rule, or phrase',
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void search() },
            style: { ...ui.input, flex: 1 },
          }),
          h('button', {
            onClick: search,
            disabled: disabled || query.trim().length === 0,
            style: { ...ui.primaryButton, ...((disabled || query.trim().length === 0) ? ui.disabled : {}) },
          }, busy === 'search' ? 'Searching…' : 'Search')),
        hits === null ? null : h('div', { style: { marginTop: 8 } },
          hits.results.length === 0
            ? h('div', { style: ui.empty }, 'No matches.')
            : h('div', null, ...hits.results.map((hit, index) => h(HitRow, { key: hit.id ?? index, hit, first: index === 0 })))))

      const uploadSection = () => h(Panel, { title: 'Add a document' },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            type: 'file', onChange: upload, disabled,
            'aria-label': 'Upload a document to index',
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          }),
          h('label', { style: { ...ui.caption, display: 'inline-flex', alignItems: 'center', gap: 4 } }, 'Collection',
            h('input', { type: 'text', value: collection, onChange: (e) => setCollection(e.target.value), style: { ...ui.input, width: 110 } }))),
        h('div', { style: { ...ui.caption, marginTop: 6 } }, 'The file is written to the ingestion folder, then indexed.'))

      const inboxSection = () => h(Panel, {
        title: 'Ingestion folder', count: inbox.length,
        actions: inbox.length === 0 ? null : h('span', { style: ui.caption }, 'Re-index forces one file back through'),
      },
        inbox.length === 0
          ? h('div', { style: ui.empty }, 'No files waiting.')
          : h('div', null, ...inbox.slice(0, 40).map((entry) => h('div', { key: entry.path, style: ui.row },
              h('span', { style: ui.name, title: entry.path }, `${entry.collection}/${entry.filename}`),
              h('span', { style: ui.caption }, `${Math.round((entry.bytes ?? 0) / 1024)} KB`),
              h('button', { onClick: () => act('reindex', '/corpus/reindex', { collection: entry.collection, filename: entry.filename }), disabled, style: btn() }, 'Re-index'),
              h('button', {
                onClick: () => act('remove', '/corpus/remove', { collection: entry.collection, sourcePath: `${entry.collection}/${entry.filename}`, inbox: true }),
                disabled, style: btn({ color: 'var(--dsw-alias-label-error)' }),
              }, 'Delete')))))

      const sourcesSection = () => h(Panel, { title: 'Indexed sources', count: sources.length },
        sources.length === 0
          ? h('div', { style: ui.empty }, 'Nothing indexed yet.')
          : h('div', null, ...sources.slice(0, 60).map((source) => h('div', {
              key: `${source.collection}:${source.source_path}`, style: ui.row,
            },
              h('span', { style: ui.name, title: `${source.collection}/${source.source_path}` }, `${source.collection}/${source.source_path}`),
              h('span', { style: ui.caption }, `${source.chunk_count} chunk(s) · ${source.origin}`),
              h('button', {
                onClick: () => act('remove', '/corpus/remove', { collection: source.collection, sourcePath: source.source_path }),
                disabled, style: btn(),
              }, 'Forget')))))

      const vectorSection = () => vectors === null ? null : h(Panel, {
        title: 'Vector index',
        actions: h('span', { style: stale === 0 ? { ...ui.caption, color: 'var(--dsw-alias-state-success-primary)' } : ui.caption },
          vectors.activeModel ? (stale === 0 ? 'all vectors match' : `${stale} unusable`) : 'no encoder declared'),
      },
        h('div', { style: ui.caption }, vectors.activeModel ?? 'unknown'),
        stale === 0 ? null : h('div', { style: { marginTop: 6 } },
          h('div', { style: { ...ui.muted, fontSize: 11, marginBottom: 6 } },
            `${foreign} from another encoder, ${stale - foreign} with no vector. Dense search skips them; keyword search still finds them.`),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { onClick: () => act('reembed', '/vectors/reembed', { limit: 200 }), disabled, style: btn() },
              busy === 'reembed' ? 'Re-embedding…' : 'Re-embed now'),
            h('button', {
              onClick: () => act('purge', '/vectors/purge', {}),
              disabled: disabled || foreign === 0,
              style: { ...ui.button, ...((disabled || foreign === 0) ? ui.disabled : {}) },
            }, 'Drop unusable'))))

      // No heading and no session id: the chip already says "Memory", and an id a
      // person cannot act on was noise in a panel they read.
      return h('div', { style: { padding: 10, overflowY: 'auto', height: '100%', fontSize: 12, color: 'var(--dsw-alias-label-primary)' } },
        searchSection(),
        uploadSection(),
        inboxSection(),
        sourcesSection(),
        vectorSection(),
        note === '' ? null : h('div', { style: { ...ui.muted, fontSize: 11, marginBottom: 6 } }, note),
        error === '' ? null : h('div', { style: { ...ui.error, marginBottom: 6 } }, error),
        h('button', { onClick: () => { void refresh() }, style: ui.button }, 'Refresh'))
    }

    /** The tab chip. */
    function MemoryTabTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, 'Memory')
    }

    /** Stable identity for the tab type, body, and title registrations. */
    const MEMORY_TAB_ID = '@local/dsh-memory'
    const MEMORY_TAB_KIND = 'memory'

    return {
      // Two client services beyond the slot registry: the tab registry that
      // owns the type, and the navigation controller that opens it.
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'memory-core', order: 50,
          label: 'Core Memories',
        }, CoreMemoriesPanel))

        // The type. `patterns` is omitted: this is a page type, opened by kind
        // rather than by a resource address, and the guide entry is how a person
        // reaches it.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: MEMORY_TAB_ID,
          kind: MEMORY_TAB_KIND,
          title: () => 'Memory',
          keepMounted: true,
          guide: [{
            id: MEMORY_TAB_ID,
            order: 30,
            title: () => 'Memory',
            description: () => 'Corpus documents, the ingestion folder, and the vector report',
          }],
        }), 'memory.tab-type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: MEMORY_TAB_ID,
        }, MemoryTab))

        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: MEMORY_TAB_ID,
        }, MemoryTabTitle))
      },
      // Exported for the offline suite, which exercises the factory contract
      // without a browser.
      __components: { RecallPolicyCard, CoreMemoriesPanel, PrepareEmbedderCard, VectorHealthCard, DocumentUploadCard, MemoryTab, MemoryTabTitle, HitRow, Panel },
    }
  },
})
