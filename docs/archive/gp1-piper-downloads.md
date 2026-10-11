# GP-1 — Piper voice downloads: plan and progress

Working notes for the feature, kept in the repo so the plan outlives any one conversation. The
design record belongs in `global-plugins.md` when this is done; this file is the scratchpad.

## The goal

A Piper voice that has been *pinned but not fetched* should be selectable, and preparing it should
download it. Today the manifest already calls itself the catalogue:

> "Unlike Kokoro these are NOT all pre-installed, so this manifest is also the catalogue: a voice
> listed here can be selected before it has been fetched."

...but the code does not honour that. `providerVoices('piper')` reads the **disk**
(`listPiperVoices`), so an unfetched voice is invisible; `prepare()` then fails with a message
telling the user to run `node fetch-piper.mjs`. And the cost shown is a hardcoded
`PIPER_ESTIMATE` of 64 MiB rather than the pinned voice's real size.

So the gap is not a missing design. It is three places that were written before the manifest
became the catalogue.

## Decisions already settled

- **The catalogue is the pinned set in `assets.json`**, not upstream's `voices.json`. Every entry
  carries a verified sha256, so nothing enters the picker that cannot be verified on arrival. The
  three pinned voices are `en_US-amy-medium`, `en_US-lessac-medium`, `en_US-lessac-high`.
- Upstream's `voices.json` would offer every Piper voice with sizes and md5s, but we hold no hash
  for the manifest itself, so using it would mean trusting it on first use. Not worth breaking the
  pin rule for a longer list. Adding a voice means adding a pin from a real fetch.
- **Sizes come from the pins.** Each voice's `files` carries `bytes` — 63,201,294 for each medium,
  113,895,201 for `lessac-high`. Nothing needs estimating.

## Work

- [x] `piper.js` — a catalogue function: every pinned voice with `{ id, dir, present, bytes, path,
      configPath, files }`, presence by existence (cheap, synchronous).
- [x] `piper.js` — `piperFiles`: the *pure* seam. Given the manifest, a voice and a root, return
      `[{ name, url, dest, asset }]` for every file. No filesystem, no network — which is what makes
      the download path testable offline.
- [x] `plugin.js` — `providerVoices('piper')` reads the catalogue, so unfetched voices are selectable.
- [x] `plugin.js` — `createPiperPreparation().prepare()` downloads what is missing through
      `ensureAsset` (progress emitted as `downloading` → `loading` → `ready`), re-verifies the model
      after a fetch, and gained an `AbortController` so `cancel()` actually stops the download.
- [x] `plugin.js` — the estimate comes from the selected voice's pin, replacing `PIPER_ESTIMATE`.
- [x] `plugin.js` — `activeVoice()`'s Piper fallback prefers a voice already on disk.
- [x] `route.js` — `/voices` entries carry `{ id, present, bytes }`.
- [x] `client.js` — the picker labels an unfetched voice with its size; the card is provider-aware
      (*Download voice* for Piper, and the title now follows the host instead of saying "Kokoro").
- [x] `check.js` — 11 cases for `piperFiles` and `catalogueVoices`.
- [x] `check-client.mjs` — 4 cases for `voiceLabel`.
- [x] `check-http.mjs` — `/settings` coverage (5 cases), which did not exist before.
- [x] `global-plugins.md` — the built record, and the "Still open" list trimmed.

## Found on the way, and fixed

- **`SETTING_KEYS` was missing `piperVoice`**, so a Piper voice chose in the pane was rejected by the
  route and the choice never stuck. The client no longer knows about two keys at all: `writeSettings`
  accepts either and normalises through `setVoice`.
- **The Prepare card's title was hardcoded to "Kokoro (local ONNX)"** regardless of engine.
- **`check-http.mjs` had no `/settings` tests**, which is precisely why the allowlist bug survived.

## Deliberately not done

- Test coverage for `writeSettings`'s key normalisation, and for the download path itself, is *live*
  rather than offline: both need the real plugin (or a fake asset server). The offline suite covers
  the paths, the presence logic and the labels, which is where the silent failures live.
- **Voice grades, as opposed to labels.** The model card publishes a grade per voice and the manifest
  carries an optional `grade` the pane would render, but nothing populates it: pinning the card first is
  what makes a grade citable. Recorded so the empty field is not later mistaken for an oversight.

## Progress log

- 2026-10-03 — plan written; read the preparation, route and pane code.
- 2026-10-03 — implemented: catalogue, download, cancel, per-voice estimate, `/voices` shape, pane
  labels and title. 22 new checks across three suites.
- 2026-10-03 — `node verify.mjs pre` → **324 passed, 0 failing**, matching the predicted table exactly
  (28 / 215 / 30 / 51). Offline green; the download path and the settings normalisation are still
  unexercised, because both need the running host.
- 2026-10-03 — **voice labels**, the second item on the list: `voiceLabel` in `kokoro.js` and
  `piperVoiceLabel` in `piper.js`, both pure; `/voices` entries carry `label`; the pane prefers it and
  falls back to the id. 15 more checks. Grades are deliberately *not* shown — no pinned copy of the
  model card means no citable grade, and the field is supported-but-empty rather than invented.
- 2026-10-03 — **live verification**, for the two things the offline suite cannot reach:
  `POST /settings` with `{"provider":"piper","piperVoice":"en_US-lessac-high"}` returned **200** — the
  allowlist fix, confirmed against the running host rather than a fake — and the pane's *Download voice*
  fetched the 114 MB voice and then spoke with it. Both work.
- 2026-10-03 — **the live benchmark found what the offline work could not**: `en_US-lessac-high` runs at
  **RTF 2.12** (4492 ms for 2.12 s of audio) against `en_US-amy-medium`'s **0.29**. A 7× difference from
  the same engine, produced purely by the voice's quality tier. Kokoro `af_bella` was 2.59–2.60, unchanged;
  `threads` 1 against 2 was flat again (4492 against 4606 ms). So the fast path is a *medium* voice, and
  the tier word in the label is the only warning the pane gives. Written into `global-plugins.md`.

## Expected suite numbers on the next `node verify.mjs pre`

| Suite | Verified | Labels added | Expected now |
|---|---|---|---|
| `smoke.mjs` | 28 | 0 | 28 |
| `check.js` | 215 | 12 | 227 |
| `check-http.mjs` | 30 | 0 | 30 |
| `check-client.mjs` | 51 | 3 | 54 |
| **total** | **324** | **15** | **339** |

If a number differs, that is information: the suite is asserting something the change moved, and the
assertion is the thing to read first.

## Constraints to respect

- **The plugin installs its own requirements.** Nothing here may need a manual step: no
  `node fetch-piper.mjs` in a user-facing message. (`fetch-piper.mjs` stays as the tool that records
  hashes when *pinning* a new voice — it is a maintainer's tool, not a user's.)
- **Every artifact is verified.** `ensureAsset` checks the sha256; nothing bypasses it.
- **The suite must stay green.** It was 302 checks after the `raw` addition. If a change cannot be
  tested offline, isolate the untestable part — that is what `piperFiles` and `voiceLabel` are for.
