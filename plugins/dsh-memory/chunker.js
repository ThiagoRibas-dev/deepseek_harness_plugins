/**
 * Text chunking for corpus ingestion.
 *
 * Chunks target ~1,800 characters with ~200 characters of overlap, and they are
 * cut on structure rather than on a character count: paragraph breaks first, then
 * sentence ends, then whitespace. A fixed-width slice produces chunks that begin
 * mid-sentence, which both embeds worse and reads worse in a search result.
 *
 * The overlap is carried as the tail of the previous chunk, snapped forward to a
 * word boundary so a chunk never opens with half a word.
 *
 * @module @local/dsh-memory/chunker
 */

import { calculateAlphaRatio } from './embedding.js';

/** Target chunk size in characters. */
export const DEFAULT_CHUNK_CHARS = 1800;

/** Characters of the previous chunk repeated at the start of the next. */
export const DEFAULT_OVERLAP_CHARS = 200;

/** Hard ceiling on chunks produced from one source, so one huge file cannot run away. */
export const MAX_CHUNKS_PER_SOURCE = 500;

/** Single blank-line separated block. */
function splitBlocks(text) {
  return text.split(/\n[ \t]*\n+/);
}

/** Split an oversized block at sentence ends, then at whitespace. */
function splitOversized(block, maxChars) {
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/);
  const pieces = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    // A single sentence longer than the budget: break on whitespace.
    let rest = sentence;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut <= 0) cut = maxChars;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest.length > 0) pieces.push(rest);
  }
  return pieces;
}

/** The last `overlapChars` of a chunk, advanced to the next word boundary. */
function overlapTail(text, overlapChars) {
  if (overlapChars <= 0 || text.length <= overlapChars) return '';
  const raw = text.slice(text.length - overlapChars);
  const space = raw.search(/\s/);
  return space === -1 ? raw : raw.slice(space + 1);
}

/**
 * Derive a title from content: the first markdown heading, else the first line.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function deriveTitle(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n', 40)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) return heading[1].trim().slice(0, 200);
  }
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return first ? first.slice(0, 200) : null;
}

/**
 * Split text into overlapping chunks.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxChars=1800]
 * @param {number} [options.overlapChars=200]
 * @param {number} [options.maxChunks=500]
 * @returns {{ chunks: Array<{ index: number, content: string, textRatio: number }>, truncated: boolean, totalChunks: number }}
 */
export function chunkText(text, options = {}) {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 2)));
  const maxChunks = Math.max(1, options.maxChunks ?? MAX_CHUNKS_PER_SOURCE);

  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return { chunks: [], truncated: false, totalChunks: 0 };

  const pieces = [];
  for (const block of splitBlocks(normalized)) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= maxChars) {
      pieces.push(trimmed);
    } else {
      pieces.push(...splitOversized(trimmed, maxChars));
    }
  }

  // Greedily pack pieces into chunks, so a short trailing paragraph rides along
  // with its predecessor instead of becoming a chunk of its own.
  const raw = [];
  let current = '';
  // A piece too small to stand on its own — a lone heading, a one-line note —
  // rides with whatever follows rather than becoming a chunk of its own. An
  // orphaned 12-character chunk embeds to noise and reads as noise in a result.
  const minStandalone = Math.max(1, Math.min(overlapChars || 200, Math.floor(maxChars / 4)));
  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
      continue;
    }
    const orphan = current.length < minStandalone;
    if (orphan || current.length + piece.length + 2 <= maxChars) {
      current = `${current}\n\n${piece}`;
    } else {
      raw.push(current);
      const tail = overlapTail(current, overlapChars);
      current = tail.length > 0 ? `${tail}\n\n${piece}` : piece;
      // A carried tail can push the new chunk over budget; trim from the front
      // at a word boundary rather than emitting an oversized chunk.
      while (current.length > maxChars) {
        let cut = current.indexOf(' ', current.length - maxChars);
        if (cut === -1) cut = current.length - maxChars;
        current = current.slice(cut).replace(/^\s+/, '');
      }
    }
  }
  if (current.length > 0) raw.push(current);

  const kept = raw.slice(0, maxChunks);
  return {
    chunks: kept.map((content, index) => ({
      index,
      content,
      textRatio: calculateAlphaRatio(content),
    })),
    truncated: raw.length > kept.length,
    totalChunks: raw.length,
  };
}

/**
 * Whether a buffer looks binary.
 *
 * A NUL byte in the first kilobyte is the cheap test the content itself offers;
 * decoding a binary file as text produces chunks that embed as noise.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean}
 */
export function looksBinary(buffer) {
  const window = buffer.subarray(0, Math.min(1024, buffer.length));
  for (const byte of window) {
    if (byte === 0) return true;
  }
  return false;
}
