/**
 * The browser half.
 *
 * A plain JavaScript bundle, not a compiled one. A client bundle is a closure
 * factory registered through `window.__ModuleLoader__.load({ id, factory })`,
 * where `factory(require)` receives a `require` into the shell's shared module
 * table — and **React is in that table**, so nothing has to be bundled to supply
 * it. That keeps this file inside the workspace instead of requiring a package in
 * the DSH checkout and a build pipeline.
 *
 * What it is not: JSX, TSX, and CSS modules are constructs of the build path.
 * Components here use `React.createElement` and inline styles.
 *
 * It talks to the host over the HTTP surface rather than a typert Remote, because
 * a route is far less machinery and the client is not the only intended caller.
 *
 * `id` must equal the package name — the loader keys every bundle by the graph row
 * it is executing.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-tts',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Identity the host injects into the page, since the route authenticates. */
    const identity = () => window.__DSH_TTS__ ?? { prefix: '/v1/audio', token: '' }

    /**
     * Call the TTS surface.
     *
     * The token is injected into the page by the host rather than configured here:
     * the route cannot inherit the harness's own authentication, and the page is
     * only served to an already-authenticated browser.
     */
    const request = async (path, options = {}) => {
      const { prefix, token } = identity()
      const response = await fetch(prefix + path, {
        ...options,
        headers: {
          ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
      })
      if (!response.ok) {
        // A failed request answers JSON even on the audio routes, because the
        // dispatcher decides the body before it knows what succeeded.
        let message = `TTS request failed: ${response.status}`
        try {
          const payload = await response.json()
          if (payload?.message !== undefined) message = payload.message
        } catch { /* a non-JSON failure body leaves the status message in place */ }
        throw new Error(message)
      }
      return response
    }

    const call = async (path, options) => {
      const response = await request(path, options)
      return (response.headers.get('content-type') ?? '').includes('application/json')
        ? await response.json() : null
    }

    const callAudio = async (path, options) => new Uint8Array(await (await request(path, options)).arrayBuffer())

    /**
     * Play one WAV, replacing anything already playing.
     *
     * A single slot rather than a queue: two overlapping voices would be worse
     * than losing the earlier one, and a button press is an explicit request to
     * hear *this* now.
     */
    /**
     * One AudioContext for the page, resumed by the click that starts the request.
     *
     * This is the bug behind "I clicked and nothing happened". Synthesizing a long
     * message takes the better part of a minute on this host, and a browser's
     * transient user activation expires after a few seconds — so by the time the
     * audio arrived, `new Audio(...).play()` was refused and there was no gesture
     * left to ask for. An AudioContext resumed *during* the click stays usable no
     * matter how long the fetch then takes.
     */
    let audioContext = null
    let playing = null

    const context = () => {
      if (audioContext === null) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (Ctor === undefined) return null
        audioContext = new Ctor()
      }
      return audioContext
    }

    /** Call synchronously from a click handler, before anything is awaited. */
    const unlockAudio = () => {
      const ctx = context()
      if (ctx !== null && ctx.state === 'suspended') void ctx.resume()
    }

    const stop = () => {
      if (playing === null) return
      const source = playing
      playing = null
      try { source.stop() } catch { /* already ended */ }
    }

    const play = async (bytes) => {
      stop()
      const ctx = context()
      if (ctx === null) throw new Error('this browser has no Web Audio support')
      if (ctx.state === 'suspended') await ctx.resume()
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const buffer = await ctx.decodeAudioData(copy)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      playing = source
      await new Promise((resolve, reject) => {
        source.onended = () => { playing = null; resolve() }
        try { source.start() } catch (error) { playing = null; reject(error) }
      })
    }

    const button = (label, onClick, disabled) => h('button', {
      type: 'button', onClick, disabled, style: { marginRight: 6, padding: '2px 8px', cursor: disabled ? 'default' : 'pointer' },
    }, label)

    const row = (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' } }, ...children)

    /**
     * Model readiness: how big the download is, what it is doing, and the one
     * button that starts it.
     *
     * The estimate is shown before anything is fetched, because a first run that
     * silently pulls 92 MB is a first run nobody trusts.
     */
    function PrepareCard() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        try {
          setState(await call('/status'))
          setError('')
        } catch (failure) { setError(String(failure.message ?? failure)) }
      }, [])

      useEffect(() => {
        let live = true
        const tick = async () => { if (live) await refresh() }
        void tick()
        // Only poll while there is something to watch; an idle panel should not
        // generate traffic for the life of the tab.
        const timer = setInterval(() => {
          setState((current) => {
            const active = current !== null && !['ready', 'unprepared', 'failed', 'cancelled'].includes(current.phase)
            if (active) void refresh()
            return current
          })
        }, 1500)
        return () => { live = false; clearInterval(timer) }
      }, [refresh])

      const start = async () => {
        setBusy(true)
        try { await call('/prepare', { method: 'POST' }); await refresh() }
        catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }
      const stop = async () => {
        setBusy(true)
        try { await call('/cancel', { method: 'POST' }); await refresh() }
        catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }

      const phase = state?.phase ?? 'unknown'
      // The card is shared by both engines, so its title comes from the host rather than
      // from the component that happens to render it.
      const provider = state?.provider ?? 'kokoro'
      const ready = phase === 'ready'
      const steps = state?.steps ?? []
      const pending = steps.filter((step) => step.status !== 'complete')
      const estimate = state?.estimate
      const bytes = state?.completedBytes
      const total = state?.totalBytes

      return h('div', { style: { marginBottom: 12 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } },
          provider === 'piper' ? 'Piper (local ONNX)' : 'Kokoro (local ONNX)'),
        row(
          h('span', { style: { color: ready ? '#3fb950' : '#d29922' } }, ready ? '● ready' : `● ${phase}`),
          state?.voice === undefined ? null : h('span', { style: { opacity: 0.7 } }, `voice ${state.voice}`),
        ),
        estimate === undefined ? null : h('div', { style: { opacity: 0.7, fontSize: 12 } },
          `${(estimate.recommendedDiskBytes / 1e6).toFixed(1)} MB on disk · ~${(estimate.expectedMemoryBytes / 1e6).toFixed(0)} MB memory · ${estimate.minimumMinutes}–${estimate.maximumMinutes} min`),
        bytes === undefined || total === undefined ? null : h('div', { style: { opacity: 0.7, fontSize: 12 } },
          `${(bytes / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`),
        // `steps` is a list of { kind, status }. Joining it directly printed
        // "[object Object]" five times; only the unfinished ones are worth showing.
        pending.length === 0 ? null : h('div', { style: { opacity: 0.7, fontSize: 12 } },
          pending.map((step) => `${step.kind}: ${step.status}`).join(' · ')),
        row(
          // Naming the action honestly: for Piper, Prepare downloads the voice.
          button(ready ? 'Reprepare' : (provider === 'piper' ? 'Download voice' : 'Prepare model'), start, busy || ready),
          phase === 'unprepared' || ready ? null : button('Cancel', stop, busy),
        ),
        error === '' ? null : h('div', { style: { color: '#f85149', fontSize: 12 } }, error),
      )
    }

    /**
     * How a voice appears in the picker.
     *
     * The host supplies the human label (`af_heart` → *Heart · US female*), so both
     * engines name their voices the same way, and this falls back to the id for a host
     * that predates it. A voice that is pinned but not yet fetched is listed with its size
     * rather than hidden, because it *is* selectable: choosing it and pressing Prepare is
     * what downloads it. Showing the price before the click is the whole reason the
     * catalogue travels with the pins.
     *
     * Tolerates a bare string as well as an object, so an older host still renders a
     * usable list.
     */
    function voiceLabel(entry) {
      if (typeof entry === 'string') return entry
      const id = String(entry?.id ?? '')
      const name = typeof entry?.label === 'string' && entry.label !== '' ? entry.label : id
      if (entry?.present !== false) return name
      const bytes = Number(entry?.bytes)
      return Number.isFinite(bytes) && bytes > 0
        ? `${name} — download ${(bytes / 1e6).toFixed(0)} MB`
        : `${name} — not downloaded`
    }

    /** The settings pane: the model, and how it should speak. */
    function SettingsPanel() {
      const [voices, setVoices] = useState({ voices: [], default: '' })
      const [settings, setSettings] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let live = true
        void (async () => {
          try {
            const [list, stored] = await Promise.all([call('/voices'), call('/settings')])
            if (!live) return
            setVoices(list)
            setSettings(stored)
          } catch (failure) { if (live) setError(String(failure.message ?? failure)) }
        })()
        return () => { live = false }
      }, [])

      // Every control writes through to the host, which is what makes a choice survive
      // a restart. These values are deliberately *not* client-owned state: the pane
      // renders what the host reports and sends the change back.
      const save = async (patch) => {
        try {
          setSettings(await call('/settings', { method: 'POST', body: JSON.stringify(patch) }))
          setError('')
        } catch (failure) { setError(String(failure.message ?? failure)) }
      }

      // `settings.voice` is the *active* engine's voice: the host resolves the engine's own
      // key and reports the result, so the pane never needs to know that Piper keeps its
      // choice under `piperVoice`.
      const voice = settings?.voice ?? voices.default ?? ''
      const tone = settings?.toneEnabled === true
      const instructions = settings?.instructions ?? ''
      // Not `=== true`: a number field must not silently collapse 0 to its default.
      const threads = typeof settings?.threads === 'number' ? settings.threads : 1

      return h('div', {},
        h(PrepareCard),
        h('div', { style: { marginTop: 8 } },
          row(h('label', { style: { minWidth: 90 } }, 'Voice'),
            h('select', {
              value: voice,
              onChange: (event) => void save({ voice: event.target.value }),
              style: { flex: 1, minWidth: 160 },
            }, ...voices.voices.map((entry) => {
              const id = typeof entry === 'string' ? entry : String(entry?.id ?? '')
              return h('option', { key: id, value: id }, voiceLabel(entry))
            }))),
          row(h('label', { style: { minWidth: 90 } }, 'Tone pass'),
            h('input', {
              type: 'checkbox', checked: tone,
              onChange: (event) => void save({ toneEnabled: event.target.checked }),
            }),
            h('span', { style: { opacity: 0.7, fontSize: 12 } }, 'read the text for pace before speaking')),
          row(h('label', { style: { minWidth: 90, alignSelf: 'flex-start' } }, 'Delivery'),
            h('textarea', {
              value: instructions, rows: 2, placeholder: 'e.g. slow and ominous, a british woman',
              // Typed locally, saved once: a request per keystroke would be a write
              // storm for a field nobody reads until the next utterance.
              onChange: (event) => setSettings((current) => ({ ...current, instructions: event.target.value })),
              onBlur: (event) => void save({ instructions: event.target.value }),
              style: { flex: 1, minWidth: 200, fontFamily: 'inherit' },
            })),
          row(h('label', { style: { minWidth: 90 } }, 'Threads'),
            h('input', {
              type: 'number', min: 1, max: 16, value: threads,
              // Local echo while typing, one write when the field is left — and only
              // when the value is one the host will accept, so clearing the box does
              // not flash a validation error at someone mid-edit.
              onChange: (event) => setSettings((current) => ({ ...current, threads: Number(event.target.value) })),
              onBlur: (event) => {
                const next = Number(event.target.value)
                if (Number.isSafeInteger(next) && next >= 1 && next <= 16) void save({ threads: next })
                else setSettings((current) => ({ ...current, threads }))
              },
              style: { width: 64 },
            }),
            h('span', { style: { opacity: 0.7, fontSize: 12 } },
              'ONNX threads — read when a model loads, so it applies on the next prepare. '
              + 'Measured: 4 was slower than 1 on this host; 2 is untested.')),
          h('div', { style: { opacity: 0.6, fontSize: 11 } },
            settings?.provider === 'piper'
              ? 'Piper is one voice per model, so delivery reaches speed only. Anything else is reported rather than silently dropped.'
              : 'Kokoro exposes only voice and speed. Anything it cannot express is reported rather than silently dropped.'),
        ),
        error === '' ? null : h('div', { style: { color: '#f85149', fontSize: 12 } }, error),
      )
    }

    // ---- auto-speak ---------------------------------------------------------

    /** How long a newly seen chat settles before it may speak. */
    const AUTO_PRIME_MS = 1200

    /**
     * Arming state for auto-speak, shared by the header toggle and the watcher.
     *
     * The watcher mounts once per *closed* turn — every historical turn when a chat opens,
     * and again whenever a virtualised node re-mounts while scrolling. Whether a mount is
     * a *new reply* is answered by the host (`/latest`: the newest assistant message in the
     * durable log), so scrolling is silent with no client-side heuristic at all. Priming
     * covers the one case the host cannot distinguish — opening a chat, where the newest
     * message is genuine history — and turning the toggle on re-primes, which makes the
     * boundary "replies that arrive after you asked for them".
     */
    const autoSpeak = { sessionId: null, primed: false, seen: new Set() }
    let autoPrimeTimer = null

    /** Start (or restart) the priming window for one chat. */
    function primeAutoSpeak(sessionId) {
      autoSpeak.sessionId = sessionId
      autoSpeak.primed = false
      autoSpeak.seen = new Set()
      if (autoPrimeTimer !== null) clearTimeout(autoPrimeTimer)
      autoPrimeTimer = setTimeout(() => { autoSpeak.primed = true; autoPrimeTimer = null }, AUTO_PRIME_MS)
    }

    /**
     * Read each new reply in this chat, when its toggle is on.
     *
     * It hangs off the per-message slot because that is the only place the shell tells a
     * plugin that a turn *closed*: the slot renders from the turn tail only once
     * `closing !== null`, and it carries the durable message id. Nothing here needs the
     * text — the host resolves it and segments it — which is why completion mode needs
     * no stream hook at all.
     *
     * Renderless on purpose: this is a subscription, not a control.
     */
    function AutoSpeak({ sessionId, messageId }) {
      useEffect(() => {
        if (typeof messageId !== 'string' || typeof sessionId !== 'string') return
        if (autoSpeak.sessionId !== sessionId) primeAutoSpeak(sessionId)
        if (!autoSpeak.primed || autoSpeak.seen.has(messageId)) return
        autoSpeak.seen.add(messageId)
        void (async () => {
          try {
            // One call answers both questions — does this chat speak, and is this the
            // newest message — because both are facts about the durable log rather than
            // about what is currently on screen. The second is what makes a scroll silent.
            const state = await call(`/latest?sessionId=${encodeURIComponent(sessionId)}`)
            if (state?.effective !== true || state.messageId !== messageId) return
            // Playback may still need activating — auto-speak fires without a fresh
            // gesture, and a blocked play() would throw into the next line.
            unlockAudio()
            const bytes = await callAudio('/speech', {
              method: 'POST', body: JSON.stringify({ sessionId, messageId }),
            })
            await play(bytes)
          } catch {
            // A failed read must not disturb the chat: the button still works, and the
            // next reply tries again.
          }
        })()
      }, [sessionId, messageId])
      return null
    }

    /**
     * Speak one assistant message, on demand.
     *
     * Receives `messageId` from the slot's owner props and `sessionId` from the
     * injected face; the host resolves the text, so the client never reads message
     * content.
     */
    function SpeakButton({ messageId, sessionId }) {
      const [state, setState] = useState('idle')
      const [failure, setFailure] = useState('')
      const busy = state === 'working'

      const speak = async () => {
        if (state === 'playing') { stop(); setState('idle'); return }
        // Before any await: this is the only moment the browser will grant
        // permission to play, and the request may take a minute.
        unlockAudio()
        setState('working')
        setFailure('')
        try {
          const bytes = await callAudio('/speech', {
            method: 'POST', body: JSON.stringify({ sessionId, messageId }),
          })
          setState('playing')
          await play(bytes)
          setState('idle')
        } catch (error) {
          setState('idle')
          setFailure(String(error?.message ?? error))
        }
      }

      const failed = failure !== ''
      const label = state === 'working' ? '…' : state === 'playing' ? '◼' : failed ? '🔇' : '🔊'
      const title = failed ? failure : state === 'playing' ? 'Stop' : 'Read this aloud'
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('button', {
          type: 'button', onClick: speak, disabled: busy, title, 'aria-label': title,
          style: {
            background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1, padding: '2px 4px',
            color: failed ? '#f85149' : 'inherit',
          },
        }, label),
        // A tooltip is not a diagnosis. A failure shows its reason where it can be
        // read without hovering.
        failed ? h('span', { style: { color: '#f85149', fontSize: 11 } }, failure) : null)
    }

    /**
     * The chat-level switch: does this conversation speak its replies.
     *
     * The preference is host state — a JSON file the plugin owns, keyed by session id
     * — so this reads and writes it through the route rather than keeping a local
     * flag. `auto: null` means "inherit the profile default", which is why the three
     * states are shown distinctly rather than collapsed into on/off.
     *
     * It is deliberately *not* a session event. Appending a custom event type made
     * every conversation that touched it unloadable, because `Session.append()` cannot
     * set the `ignorable` marker the persistence reader requires for an unknown type
     * (`preference.js` carries the detail). Do not add a "store it in the log" path.
     */
    function ChatToggle({ sessionId }) {
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState('')
      const [busy, setBusy] = useState(false)
      // Whether a model is prepared. Defaults to true, so an unreachable status endpoint
      // cannot disable a control that would probably have worked.
      const [ready, setReady] = useState(true)

      const refresh = useCallback(async () => {
        try {
          setState(await call(`/preference?sessionId=${encodeURIComponent(sessionId)}`))
          setFailure('')
        } catch (error) { setFailure(String(error?.message ?? error)) }
        // Read separately: a failure here must not blank out the preference above.
        try {
          const status = await call('/status')
          setReady(status?.phase === 'ready')
        } catch { setReady(true) }
      }, [sessionId])

      useEffect(() => { void refresh() }, [refresh])

      const set = async (auto) => {
        setBusy(true)
        try {
          setState(await call('/preference', {
            method: 'POST', body: JSON.stringify({ sessionId, auto }),
          }))
          // Turning it on arms auto-speak from here: the replies already on screen are
          // history, and reading them aloud is not what "turn it on" means.
          if (auto === true) primeAutoSpeak(sessionId)
          setFailure('')
        } catch (error) { setFailure(String(error?.message ?? error)) }
        finally { setBusy(false) }
      }

      const effective = state?.effective === true
      const inherited = state !== null && state.auto === null
      const title = failure !== '' ? failure
        : ready === false
          // The spec's rule: first use should be an invitation to download, not a trap
          // that fails into an error. A toggle that flips and then cannot speak is worse
          // than one that says what it needs.
          ? 'No voice model is prepared yet — open the TTS plugin settings and press Prepare'
          : inherited ? `Speaking: ${effective ? 'on' : 'off'} (inherited from the profile default)`
            : `Speaking: ${effective ? 'on' : 'off'} for this chat`
      return h('button', {
        type: 'button', disabled: busy || ready === false, title, 'aria-label': title,
        onClick: () => { void set(!effective) },
        style: {
          background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer',
          opacity: effective ? 1 : 0.45, padding: '2px 4px',
          color: failure === '' ? 'inherit' : '#f85149',
        },
      }, effective ? '🔊' : '🔇')
    }

    /**
     * The engine picker, sitting beside the Speaking toggle.
     *
     * **Profile-wide, not per-chat** — it decides which model is resident. Its
     * neighbour *is* per-chat, and nothing on screen would say so, so the tooltip does.
     *
     * It renders before its fetch lands rather than returning nothing: a header control
     * that appears a moment late is worse than one showing the value it is about to
     * confirm, and a null first render would also break the offline suite's
     * "components render an element" check.
     */
    function ProviderSelect() {
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState('')

      useEffect(() => {
        let live = true
        void (async () => {
          try {
            const stored = await call('/settings')
            if (live) setState(stored)
          } catch (error) { if (live) setFailure(String(error?.message ?? error)) }
        })()
        return () => { live = false }
      }, [])

      const providers = state?.providers ?? [{ id: state?.provider ?? 'kokoro', name: 'Voice engine' }]
      const title = failure !== ''
        ? failure
        : 'Voice engine, for every chat — Kokoro sounds better, Piper is much faster'

      return h('select', {
        value: state?.provider ?? providers[0].id,
        disabled: failure !== '',
        title,
        'aria-label': title,
        onChange: async (event) => {
          try {
            setState(await call('/settings', { method: 'POST', body: JSON.stringify({ provider: event.target.value }) }))
            setFailure('')
          } catch (error) { setFailure(String(error?.message ?? error)) }
        },
        style: {
          background: 'none', border: 'none', padding: '2px 0', maxWidth: 130,
          cursor: failure === '' ? 'pointer' : 'default',
          color: failure === '' ? 'inherit' : '#f85149',
        },
      }, ...providers.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)))
    }

    return {
      // Only `slots`: this half talks to the host over HTTP, so it needs no
      // Remote, and it uses literal strings rather than the locale registry.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@local/dsh-tts',
        }, SettingsPanel))

        // Both slots are `scope: 'session'` and pass `sessionId` as a *standard*
        // prop, so neither component needs a custom `inject` to learn which
        // conversation it is in — the slot hands it over.
        //
        // The registration surface for these slots is `{ id, order, label }` and
        // nothing else. `id` is required and namespaces the entry, so `tts` sits
        // beside the shipped `feedback` entry rather than replacing it; `order`
        // 20 clears both `feedback` (10) in the action row and `job-list` (20) in
        // the header, which is why the header uses 25.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'tts', order: 20,
        }, SpeakButton))

        // The auto-speak watcher: a renderless second entry in the same slot that reads
        // each new reply when this chat's toggle is on. Its own id, so it adds an entry
        // rather than replacing the button — the button stays independent of the toggle,
        // which is a fact about the wiring rather than a pair of careful `if`s.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'tts-auto', order: 21,
        }, AutoSpeak))

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'tts', order: 25,
          label: () => 'Speak replies',
        }, ChatToggle))

        // A second entry in the same slot, one step ahead of the toggle: which engine
        // speaks, next to whether it speaks.
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'tts-provider', order: 24,
          label: () => 'Voice engine',
        }, ProviderSelect))
      },
      // Exported for the offline suite, which exercises the factory contract
      // without a browser.
      __components: {
        PrepareCard, SettingsPanel, SpeakButton, AutoSpeak, ChatToggle, ProviderSelect,
        call, identity, play, stop, unlockAudio,
        // Pure, and therefore testable offline: the label the picker shows is one of the
        // places a download feature can go wrong without any error appearing.
        voiceLabel,
      },
    }
  },
})
