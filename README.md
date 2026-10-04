# deepseek_harness_plugins

Plugins and presets for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), kept in one
repository so they can be linked into a DSH profile from a single checkout.

## Contents

| Path | What it is |
| --- | --- |
| `plugins/dsh-meridian-antigravity/` | Model API connector that registers the `meridian-antigravity` provider route and speaks Anthropic Messages to a local [Meridian](https://github.com/rynfar/meridian) bridge running the Antigravity backend over a signed-in `agy` CLI. |
| `plugins/dsh-dd35-preset/` | Agent preset: a solo D&D 3.5e Dungeon Master. Adds oracle, dice, combat, campaign-state and reference tools, plus automatic turn memory. |
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
| `dsh-meridian-antigravity` | `./tests/run.sh` | Offline. Builds a throwaway module-resolution rig; set `DSH_INSTALL_ROOT` when the harness is not at the default path. No live Meridian and no subscription quota. |
| `dsh-dd35-preset` | `node --test` (from the plugin folder) | Offline. Covers workspace resolution only; the plugin has no harness-level test rig. |

## Notes

- `dsh-dd35-preset` resolves `campaign/`, `rules/` and `compendium/` under the **session workspace**
  (`session.header.cwd`) — the folder the user opened — never under the bundle. A `workspace` config
  value on one of its plugins pins a fixed root instead.
- `plugins/dsh-tts` carries no remote of its own in this repository. Its earlier standalone git
  history, if preserved locally, is kept outside version control (see the note in the commit that
  imported it).
