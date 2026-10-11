# AGENTS.md

This repo contains ou hand-rolled plugins (`plugins/`) and documentation (`docs/`). The actual harness repository is on `/export/DownloadsSSD/AI/TEXT/deepseek-harness/`, and we try to avoid changing the harness' source code.

## Read these first

Before working on any plugin, read [`docs/lessons-learned.md`](docs/lessons-learned.md). It documents every major problem this project has run into so far — service access issues, loader problems, continuation failures, result shape bugs, and so on — along with what caused them and how to avoid repeating the same mistakes.

Before resuming work on a campaign, read [`docs/dd35/handoff.md`](docs/dd35/handoff.md). It tracks what’s been shipped, what’s still open, and which approaches we’ve already tried and ruled out.

## Writing style

Keep the writing clear and direct in code, docs, and chat.

- Please focus on stating what is true, avoiding vague or flowery language.
- Focus on actionable steps for the reader.
- Try to state the core issue directly rather than relying on contrastive phrasing like “this is a bug, not a performance issue.”
- Try to avoid personifying files or systems; describe their functions directly.
- It is helpful to be literal rather than using metaphors.
- Please avoid conversational filler like “it’s worth noting,” “to be fair,” or “importantly.”
- Consider using past tense for past events.
- It is best to be specific with numbers and states.

## Important practices

- Try to look for the actual source code or logs and provide the User with the results, rather than making unchecked assumptions.
- It is important to write plugin failures to disk before rethrowing them. The harness won’t show the reason otherwise. Consider using the `logPluginError` + `guard` pattern from docs/lessons-learned.md §5. The logger should be designed not to throw.
- Get the actual stack trace before trying to diagnose why a plugin won’t start. Check the launcher console and `$DSH_HOME/plugin-errors/`.
- Declare a service before trying to read it from `ctx`. Optional chaining won’t save you — the read itself will throw if the service wasn’t injected.
- Cap any tool result that could grow without limit. Uncapped results create bloated transcripts and cause provider timeouts.
- If a session stops replying, check the assistant output for the `[Meridian Antigravity]` marker. A refused turn can look like a healthy session.
- Test any new tool-result stripping on a throwaway session first. It has caused continuation issues in many campaigns.
- Diagnose the actual symptom before trying to make the error go away by editing state or transcripts.

## Approach

- Before committing to a theory, figure out what would prove it wrong and test that.
- Measure the cheap thing before reasoning about the expensive one.

## Scope and constraints

- Work inside the session workspace. The main campaign repository requires elevated permissions.
- Ask before running subagents on metered models.
- Changes to bundles or `cordis.patch.yml` don’t take effect until the harness restarts. Note the current state when making changes.