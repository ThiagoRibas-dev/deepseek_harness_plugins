# deepseek_harness_plugins

Plugins and presets for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), kept in one
repository so they can be linked into a DSH profile from a single checkout.

## Contents

| Path | What it is |
| --- | --- |
| `plugins/dsh-compaction-guard/` | Two guards against the compaction behaviours that destroyed a session: refuse a degenerate summary before it is committed, and defer tool-result pruning while a provider holds a delivered-prefix tool continuation. |
| `plugins/dsh-context-pressure/` | Steers one pre-compaction notice into a running turn when the context window crosses a configured fraction, so the model can persist state before compaction replaces earlier history. |
| `plugins/dsh-dd35-preset/` | Agent preset: a solo D&D 3.5e Dungeon Master. Adds oracle, dice, combat, campaign-state and reference tools, plus automatic turn memory and optional per-campaign persona/notes files. |
| `plugins/dsh-meridian-antigravity/` | Model API connector that registers the `meridian-antigravity` provider route and speaks Anthropic Messages to a local [Meridian](https://github.com/rynfar/meridian) bridge running the Antigravity backend over a signed-in `agy` CLI. |
| `plugins/dsh-tts/` | Local text-to-speech plugin (Kokoro / Piper) with an optional HTTP surface. |
| `docs/` | Design notes, reports and plans written while building the above. |
| `presets/` | Placeholder for standalone preset YAML. |

## Installing into a DSH profile

Each plugin is a bundle with its own `cordis.patch.yml`. A profile links them by path, for example in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: llm-meridian-antigravity
  name: "@local/dsh-meridian-antigravity"
  config:
    baseURL: http://127.0.0.1:3457
    apiKeyEnv: MERIDIAN_API_KEY
```

The plugin manager can also install a directory or bundle directly. Plugin code is imported once per
harness process, so restart DSH after changing any of it.

## Tests

| Plugin | Command | Notes |
| --- | --- | --- |
| `dsh-compaction-guard` | `node --test` (from the plugin folder) | Offline. Covers degenerate-summary rejection and deferred pruning while a batch is pending. |
| `dsh-context-pressure` | `node --test tests/*.test.js` (from the plugin folder) | Offline. The band policy and message rendering are pure, so no harness rig is needed. |
| `dsh-dd35-preset` | `node --test` (from the plugin folder) | Offline. Builds a throwaway module-resolution rig so the tool modules can be invoked directly; also covers workspace resolution, campaign prompt files and turn capture. |
| `dsh-meridian-antigravity` | `./tests/run.sh` | Offline. Builds a throwaway module-resolution rig; set `DSH_INSTALL_ROOT` when the harness is not at the default path. No live Meridian and no subscription quota. |

## Notes

- `dsh-dd35-preset` resolves `campaign/`, `rules/` and `compendium/` under the **session workspace**
  (`session.header.cwd`) — the folder the user opened — never under the bundle. A `workspace` config
  value on one of its plugins pins a fixed root instead.
- `dsh-dd35-preset` reads two optional files from the **active campaign** directory on every request
  (`prompt.js`): `dm_persona.md` joins the system prompt as a section directly after the persona
  prefix, and `dm_notes.md` — the DM's durable scratchpad, which the DM maintains with the ordinary
  `read`/`write`/`edit` tools — arrives as a runtime-context snapshot instead, so writing notes never
  invalidates the cached system-prompt prefix. Both are per-campaign, so `set_active_campaign`
  switches them, and neither needs a harness restart. The split is deliberate: `dm_persona.md` carries
  voice and presentation, while `dm_notes.md` is the home for campaign-specific truth — house rules,
  rulings already given, and in-play facts — which must not live in `AGENTS.md` or another
  workspace-global file, since those are shared by every campaign in the folder. Covered by
  `tests/prompt.test.mjs`.
- `plugins/dsh-tts` carries no remote of its own in this repository. Its earlier standalone git
  history, if preserved locally, is kept outside version control (see the note in the commit that
  imported it).
- **A user-role message is not necessarily the player.** Producers inject model-facing content as a
  `user`-role message and declare their own `source.kind`; only `kind: 'user'` *with* a client-minted
  `rpcId` is a prompt a human typed. `dsh-dd35-preset`'s turn capture keys on exactly that, because
  `dsh-context-pressure`'s notice was previously recorded as the player's own words in
  `campaign_log.md` and in the turn transcripts. Two known rpcId-less shapes are deliberate: ACP
  delivers real prompts as `{ kind: 'user' }` (`acp/session.ts`), and command producers such as
  `command-goal` do the same. Neither records turns under that predicate.
