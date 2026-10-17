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
