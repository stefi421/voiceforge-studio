import type { ParsedTitles } from '@shared/types'
import { normalizeTitle } from '../util/common'

/** Parse a newline (or CSV first-column) list of titles, trimming and de-duplicating. */
export function parseTitles(text: string): ParsedTitles {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const titles: string[] = []
  const seen = new Set<string>()
  const duplicatesRemoved: string[] = []
  let blankLinesRemoved = 0
  for (const raw of lines) {
    let line = raw.replace(/^﻿/, '').trim()
    if (!line) {
      blankLinesRemoved++
      continue
    }
    // Strip numbering like "1." / "1)" / "- " at the start
    line = line.replace(/^(?:\d{1,3}[.)]\s+|[-*•]\s+)/, '').trim()
    // Strip surrounding quotes
    line = line.replace(/^"(.*)"$/, '$1').trim()
    if (!line) {
      blankLinesRemoved++
      continue
    }
    if (line.length > 200) line = line.slice(0, 200).trim()
    const key = normalizeTitle(line)
    if (!key) continue
    if (seen.has(key)) {
      duplicatesRemoved.push(line)
      continue
    }
    seen.add(key)
    titles.push(line)
  }
  return { titles, duplicatesRemoved, blankLinesRemoved }
}

/** First-column CSV extraction (handles quoted fields with commas). */
export function csvFirstColumn(csv: string): string[] {
  const out: string[] = []
  for (const rawLine of csv.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let field = ''
    if (line.startsWith('"')) {
      let i = 1
      while (i < line.length) {
        const ch = line[i]!
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          break
        }
        field += ch
        i++
      }
    } else {
      field = line.split(/[,;\t]/)[0] ?? ''
    }
    if (field.trim()) out.push(field.trim())
  }
  // Drop a header row that looks like a label
  if (out.length > 1 && /^(title|game|name|product)s?$/i.test(out[0]!)) out.shift()
  return out
}
