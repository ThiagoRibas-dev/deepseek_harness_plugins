/**
 * The plugin's configuration schema.
 *
 * Separate from `plugin.js` for the same reason `preference.js` is: this module
 * imports `@deepseek-ai/schemastery`, which does not resolve under plain `node`,
 * so keeping the schema here lets it be validated offline against the real
 * library before it is ever handed to the loader.
 *
 * That matters more than it looks. The Loader validates a row's `config` against
 * this schema at mount, and a schema that rejects the shipped patch takes the
 * plugin down — so the schema is checked against the actual patch values rather
 * than assumed correct.
 *
 * `.volatile()` marks the fields the settings service may persist into the
 * plugin's profile entry. `dataRoot` is deliberately **not** volatile: where the
 * weights live is deployment configuration, not a user preference.
 */
import z from '@deepseek-ai/schemastery'

/** Default voice: the best-graded voice in the model's own card. */
export const DEFAULT_VOICE = 'af_heart'

export const Config = z.object({
  /** Where pinned weights are cached. Supplied by the patch via `dshHomePath`. */
  dataRoot: z.string(),
  /** Which voice speaks, before any instruction or mood overrides it. */
  voice: z.string().default(DEFAULT_VOICE).volatile(),
  /** Baseline speaking rate, 1 being the model's own. */
  speed: z.number().min(0.5).max(2).default(1).volatile(),
  /**
   * Which engine speaks. `kokoro` is the quality voice and needs ~2.6× real time on a
   * CPU without AVX. `piper` is VITS and measured **0.29** — with a *medium* voice. The
   * voice's quality tier matters more than the engine: `en_US-lessac-high` measures 2.12,
   * which is slower than real time. The patch sets the default a profile starts from; the
   * settings pane records what the user actually chose.
   */
  provider: z.string().default('kokoro').volatile(),
  /** Profile-level default for auto-speak, which a chat inherits until toggled. */
  autoEnabled: z.boolean().default(false).volatile(),
  /** Standing delivery direction, compiled into voice and speed. */
  instructions: z.string().default('').volatile(),
  /** Whether the text is read for pace by the classifier or the heuristic. */
  toneEnabled: z.boolean().default(true).volatile(),

  /**
   * Whether the HTTP surface is served. Off by default, and the route answers
   * 503 rather than disappearing when it is off, so the setting can be toggled
   * without a restart.
   */
  apiEnabled: z.boolean().default(false).volatile(),
  /**
   * The bearer token callers must present. Required unless anonymous access is
   * explicitly allowed: this deployment binds to 0.0.0.0 and plugin routes do not
   * inherit the harness's own authentication.
   */
  apiToken: z.string().default('').volatile(),
  /** Mount point. Fixed at mount, since a route cannot be re-registered live. */
  apiPath: z.string().default('/v1/audio'),
  /** Explicit opt-out of authentication. Turning this on exposes the host's CPU. */
  apiAllowAnonymous: z.boolean().default(false).volatile(),
  /**
   * Bound on one request's input. Long input is segmented and read in full, so
   * this is a guard against unbounded work rather than a speech limit.
   */
  apiMaxInputChars: z.number().min(1).default(20000).volatile(),
  /**
   * Characters per synthesized segment. Kept well under the graph's 512-token
   * ceiling: phoneme count varies with the text, and overflowing it truncates
   * silently rather than failing.
   */
  segmentChars: z.number().min(40).max(2000).default(400).volatile(),

  /**
   * ONNX Runtime intra-op threads for the Kokoro graph.
   *
   * Measured rather than assumed: on this host 4 threads was **slower** than 1
   * (18.1 s vs 15.8 s for the same 6 s of audio), because the CPU has two physical
   * cores and the work is memory-heavy. 2 has since been tested against 1 and is **flat**
   * for both engines (Kokoro 2.73 → 2.64; Piper 4606 → 4492 ms), so this is a knob rather
   * than a lever: nothing measurable changes. Takes effect on the next prepare.
   */
  threads: z.number().min(1).max(16).default(1).volatile(),
})
