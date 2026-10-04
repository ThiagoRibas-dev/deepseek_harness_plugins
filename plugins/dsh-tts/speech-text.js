/**
 * Text conditioning for speech: what the models should actually be handed.
 *
 * ## Why this exists
 *
 * Markdown markers and tabletop mechanics read terribly aloud. A reply containing
 * `**The gate is barred.**` becomes "asterisk asterisk the gate is barred asterisk
 * asterisk", a stat line becomes a stream of abbreviations, and a markdown table becomes
 * an unpunctuated river of cells. The filter is worth more to perceived quality than the
 * model is, which is why it runs once, host-side, before segmentation — so the button,
 * auto-speak, and every external API caller all inherit it, and the tone classifier gets
 * cleaner input too.
 *
 * ## Provenance
 *
 * `stripMarkdown` is the ruleset from the reference implementation you supplied
 * (`openclaw/openclaw`, `src/shared/text/strip-markdown.ts`), kept recognisably the same
 * — same order, same regexes — so the two dialects do not drift apart. Three additions
 * are marked **[beyond the reference]** and exist because speech output, not channel
 * fallback, is the consumer here: fenced code blocks, links, and list markers.
 *
 * `stripMechanics` is ours and genre-specific, deliberately in its own function so the
 * markdown half stays comparable to the reference.
 *
 * Pure and dependency-free on purpose: testable offline, and usable from the host only.
 */

/**
 * Flatten markdown markers, keeping the readable text.
 * @param text - raw reply text.
 * @returns the same text with markers removed.
 */
export function stripMarkdown(text) {
  let result = text

  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')

  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
  result = result.replace(/(?<![\p{L}\p{N}])_(?!_)(.+?)(?<!_)_(?![\p{L}\p{N}])/gu, '$1')

  result = result.replace(/~~(.+?)~~/g, '$1')
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '$1')
  result = result.replace(/^>\s?(.*)$/gm, '$1')
  result = result.replace(/^[-*_]{3,}$/gm, '')

  // [beyond the reference] A fenced block is code, and the spec's rule is to skip it
  // rather than read it aloud. The reference only handles inline spans, which would
  // leave a whole fence — indentation, backticks and all — in the spoken text.
  //
  // The `$(?![\s\S])` fallback is *end of input*, not "end of line": under the `m` flag a
  // bare `$` also matches at every line end, so the lazy body stopped at the first line
  // boundary and left the closing fence in the text. Caught by "a fenced block is
  // dropped, not read aloud" — which is the whole reason that check exists.
  result = result.replace(/^```[^\n]*\n[\s\S]*?(?:^```[ \t]*$|$(?![\s\S]))/gm, '')

  result = result.replace(/`([^`]+)`/g, '$1')

  // [beyond the reference] Keep a link's text, drop its target: read aloud, a URL is
  // noise, and the spec is explicit about not speaking paths. Images lose everything,
  // since their alt text describes a picture rather than saying anything.
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // [beyond the reference] A bullet's marker is punctuation for the eye; spoken, it is a
  // stray "dash" or "asterisk" at the start of every line.
  result = result.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, '')

  result = result.replace(/\n{3,}/g, '\n\n')

  return result.trim()
}

/**
 * Strip tabletop mechanics that read badly aloud.
 *
 * Conservative by design: prose survives, and only shapes that are unmistakably
 * mechanical are removed. Anything a sentence is *about* — "you take 12 damage" — is
 * prose and stays.
 *
 * @param text - text that has already been through {@link stripMarkdown}.
 * @returns the same text with mechanical fragments removed.
 */
export function stripMechanics(text) {
  return text
    // Markdown table rows, including the `|---|` delimiter row that shares its shape.
    .replace(/^\s*\|.*\|\s*$/gm, '')
    // Dice notation: `2d6+3`, `1d20`, `4d6`. The result is normally stated in prose
    // anyway, so the notation itself is pure noise.
    .replace(/\b\d{0,3}d\d{1,3}(?:\s*[+-]\s*\d+)?\b/gi, '')
    // A stat line is a line that is *only* stat fragments — the shape a stat block has.
    // Anchored so a sentence that happens to mention AC is untouched.
    .replace(
      /^\s*(?:AC|HP|HD|Fort|Ref|Will|BAB|CR|XP|Init|Speed|Saves?|Attack|Full Attack|Damage|Skills?|Feats?|Special|Size|Type|Senses)\b[^.\n]*$/gim,
      '',
    )
    // The removals above leave gaps and stranded punctuation behind them.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * The whole filter, in the order that matters: markdown first (so a marker never hides a
 * mechanical shape from the second pass), then mechanics, then a final tidy.
 *
 * @param text - raw reply text.
 * @returns text to hand to the segmenter and the models.
 */
export function stripForSpeech(text) {
  if (typeof text !== 'string') return ''
  const stripped = stripMechanics(stripMarkdown(text))
  return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
