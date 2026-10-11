# Documentation

| Path | Contents |
| :--- | :--- |
| [`lessons-learned.md`](lessons-learned.md) | Every error class this project has hit, with symptom and cause. Read before writing plugin code. |
| [`global-plugins.md`](global-plugins.md) | The set of harness-wide plugins and what each provides. |
| [`dd35/`](dd35/) | The D&D 3.5 campaign preset: handoff state, memory model, oracle work, architecture. |
| [`plugins/`](plugins/) | Per-plugin design documents, grouped by plugin package. |
| [`archive/`](archive/) | Superseded plans and one-off session reports. Kept for history. |

## Campaign (DD35)

| Path | Contents |
| :--- | :--- |
| [`dd35/handoff.md`](dd35/handoff.md) | Live session state: what shipped, what is open, falsified theories. Read before resuming work. |
| [`dd35/memory-model.md`](dd35/memory-model.md) | The memory model specification. |
| [`dd35/future-improvements.md`](dd35/future-improvements.md) | The FI-numbered backlog. |
| [`dd35/preset-architecture.md`](dd35/preset-architecture.md) | How the preset is composed. |
| [`dd35/passive-rag-resume-state.md`](dd35/passive-rag-resume-state.md) | Retrieval-layer resume state. |

## Plugins

Each plugin directory holds its own `docs/` folder. The package `README.md` at the plugin root is a pointer, so package tooling still finds it.

| Plugin | Documentation |
| :--- | :--- |
| `dsh-dd35-preset` | [`plugins/dsh-dd35-preset/docs/README.md`](../plugins/dsh-dd35-preset/docs/README.md) |
| `dsh-meridian-antigravity` | [`plugins/dsh-meridian-antigravity/`](plugins/dsh-meridian-antigravity/) — connector notes, remediation, quota, spent-batch plan |
| `dsh-compaction-guard` | [`plugins/dsh-compaction-guard/`](plugins/dsh-compaction-guard/) — implementation and coverage plans |
| `dsh-tool-result-policy` | [`plugins/dsh-tool-result-policy.md`](plugins/dsh-tool-result-policy.md) — the Path A retention specification |
| `dsh-context-pressure` | [`plugins/dsh-context-pressure/docs/README.md`](../plugins/dsh-context-pressure/docs/README.md) |
| `dsh-tts` | [`plugins/dsh-tts/docs/README.md`](../plugins/dsh-tts/docs/README.md) |
