/**
 * The optional tone classifier, behind the same shape as the built-in heuristic.
 *
 * `readTextPace` in `delivery.js` counts exclamation marks and sentence lengths,
 * which is cheap and always available. This reads the passage with a
 * 7-class emotion model instead and maps arousal to pace — anger and fear are
 * fast, sadness is slow. A binary sentiment model would have been the wrong
 * instrument: "I am furious" and "I am delighted" share a valence and are
 * opposite in pace.
 *
 * The reader is built lazily and **degrades to nothing**: if the model is absent
 * or fails, the caller keeps the heuristic. Tone classification is an
 * improvement, never a prerequisite, so a missing second model must not stop
 * speech.
 *
 * Measured on the development host, a Pentium with no AVX: 27–85 ms for a
 * sentence, against ~15 s for the synthesis itself. The encoder is not what
 * makes this machine slow; the vocoder is.
 */
import { readFileSync } from 'node:fs'
import { toneToPace } from './delivery.js'
import { loadOrt } from './kokoro.js'

/** RoBERTa's position limit, minus room for the two sentinel tokens. */
const MAX_TOKENS = 510

/** Numerically stable softmax over the raw logits. */
function softmax(values) {
  const max = Math.max(...values)
  const exps = values.map((value) => Math.exp(value - max))
  const total = exps.reduce((sum, value) => sum + value, 0)
  return exps.map((value) => value / total)
}

/**
 * Build a tone reader.
 *
 * Both heavy imports are dynamic so that importing this module costs nothing and
 * so the offline suite can load it without the native and WASM toolchains.
 *
 * @param paths.model - the pinned `model_quantized.onnx`.
 * @param paths.tokenizerJson - the pinned `tokenizer.json`.
 * @param paths.tokenizerConfig - the pinned `tokenizer_config.json`.
 * @returns an object whose `read(text)` resolves to the {@link readTextPace} shape.
 */
export async function createToneReader({ model, tokenizerJson, tokenizerConfig }) {
  const { Tokenizer } = await import('@huggingface/tokenizers')
  const ort = await loadOrt()

  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(tokenizerJson, 'utf8')),
    JSON.parse(readFileSync(tokenizerConfig, 'utf8')),
  )
  // One thread: measured faster than four on this host, which is memory-bound.
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 1 })

  return {
    /** @returns a pace reading, or null when the text carries no usable signal. */
    async read(text) {
      const source = String(text ?? '').trim()
      if (source.length === 0) return null
      const encoded = tokenizer.encode(source)
      const ids = encoded.ids.slice(0, MAX_TOKENS)
      if (ids.length === 0) return null
      const big = BigInt64Array.from(ids, (id) => BigInt(id))
      const result = await session.run({
        input_ids: new ort.Tensor('int64', big, [1, ids.length]),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]),
      })
      const logits = result[session.outputNames[0]]
      return toneToPace(softmax(Array.from(logits.data, Number)))
    },
  }
}
