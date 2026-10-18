/**
 * Splits long narration into chunks that fit a per-request character limit,
 * cutting only at paragraph or sentence boundaries. The original text is
 * preserved: joining the chunks with their separators reproduces it exactly.
 */
export interface TextChunk {
  index: number
  text: string
  /** Characters of the original preceding this chunk (for continuity hints). */
  previousText: string
  nextText: string
}

const SENTENCE_END = /(?<=[.!?…]["'”’)\]]?)\s+/u

export function splitIntoChunks(text: string, maxChars: number, contextChars = 300): TextChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return []
  if (maxChars <= 0) throw new Error('maxChars must be positive')
  if (normalized.length <= maxChars) return [{ index: 0, text: normalized, previousText: '', nextText: '' }]

  const paragraphs = normalized.split(/\n{2,}/)
  const pieces: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim()) pieces.push(current.trim())
    current = ''
  }

  const pushUnit = (unit: string): void => {
    if (!unit) return
    if (unit.length > maxChars) {
      // Sentence longer than the limit: hard split at word boundaries as a last resort.
      flush()
      let rest = unit
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars)
        if (cut < maxChars * 0.5) cut = maxChars
        pieces.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      current = rest
      return
    }
    const joiner = current ? ' ' : ''
    if ((current + joiner + unit).length > maxChars) {
      flush()
      current = unit
    } else {
      current = current + joiner + unit
    }
  }

  for (const para of paragraphs) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= maxChars) {
      const joiner = current ? '\n\n' : ''
      if ((current + joiner + p).length > maxChars) {
        flush()
        current = p
      } else {
        current = current + joiner + p
      }
      continue
    }
    // Paragraph too long: split into sentences.
    flush()
    for (const sentence of p.split(SENTENCE_END)) pushUnit(sentence.trim())
    flush()
  }
  flush()

  return pieces.map((piece, index) => ({
    index,
    text: piece,
    previousText: index > 0 ? pieces[index - 1]!.slice(-contextChars) : '',
    nextText: index < pieces.length - 1 ? pieces[index + 1]!.slice(0, contextChars) : ''
  }))
}

/** Sanity check that no text was lost or duplicated while chunking. */
export function chunksCoverText(text: string, chunks: TextChunk[]): boolean {
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
  return squash(chunks.map((c) => c.text).join(' ')) === squash(text)
}

/** A heading-like paragraph: one short line without terminal punctuation. */
function isHeadingParagraph(p: string): boolean {
  const t = p.trim()
  return t.length > 0 && t.length <= 60 && !t.includes('\n') && !/[.!…,;:]["'”’)\]]?$/.test(t)
}

/**
 * Splits narration into `parts` pieces of similar length for parallel TTS (v1.5). Cuts only
 * between paragraphs, never right after a heading (the heading stays with its text), and
 * prefers cutting just before a heading. Each piece still respects `maxChars` (oversized
 * pieces are chunked again with `splitIntoChunks`). Joining the pieces with blank lines
 * reproduces the text; `chunksCoverText` verifies it.
 */
export function splitForParallel(text: string, parts: number, maxChars: number, opts: { minChars?: number; contextChars?: number } = {}): TextChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const minChars = opts.minChars ?? 1800
  const contextChars = opts.contextChars ?? 300
  const base = splitIntoChunks(normalized, maxChars, contextChars)
  if (parts <= 1 || normalized.length < minChars || base.length >= parts) return base
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length < 2) return base
  const total = paragraphs.reduce((n, p) => n + p.length + 2, 0)
  const cuts: number[] = [] // split BEFORE paragraph index
  let cum = 0
  const cumBefore: number[] = []
  for (const p of paragraphs) {
    cumBefore.push(cum)
    cum += p.length + 2
  }
  for (let k = 1; k < parts; k++) {
    const target = (total * k) / parts
    let best = -1
    let bestScore = Infinity
    for (let i = 1; i < paragraphs.length; i++) {
      if (cuts.includes(i) || (cuts.length && i <= cuts[cuts.length - 1]!)) continue
      if (isHeadingParagraph(paragraphs[i - 1]!)) continue // never orphan a heading at the end of a part
      const dist = Math.abs(cumBefore[i]! - target) / total
      const score = dist - (isHeadingParagraph(paragraphs[i]!) && dist < 0.12 ? 0.08 : 0)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best > 0) cuts.push(best)
  }
  if (!cuts.length) return base
  const pieces: string[] = []
  let start = 0
  for (const c of [...cuts, paragraphs.length]) {
    const piece = paragraphs.slice(start, c).join('\n\n')
    if (piece) pieces.push(piece)
    start = c
  }
  // Respect the per-request limit inside each piece.
  const flat: string[] = []
  for (const piece of pieces) {
    if (piece.length <= maxChars) flat.push(piece)
    else for (const c of splitIntoChunks(piece, maxChars, contextChars)) flat.push(c.text)
  }
  return flat.map((piece, index) => ({
    index,
    text: piece,
    previousText: index > 0 ? flat[index - 1]!.slice(-contextChars) : '',
    nextText: index < flat.length - 1 ? flat[index + 1]!.slice(0, contextChars) : ''
  }))
}
