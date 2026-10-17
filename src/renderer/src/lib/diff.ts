/**
 * Minimal line-based diff (LCS). Good enough for comparing script and prompt
 * versions of a few hundred lines. O(n*m) memory; inputs are capped to keep it
 * responsive.
 */

export type DiffOp = 'eq' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
  /** 1-based line number in the left (old) text, if present. */
  left: number | null
  /** 1-based line number in the right (new) text, if present. */
  right: number | null
}

const MAX_LINES = 4000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const n = a.length
  const m = b.length

  // Trim common prefix/suffix for speed.
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ op: 'eq', text: a[i] ?? '', left: i + 1, right: i + 1 })

  const subA = a.slice(start, endA)
  const subB = b.slice(start, endB)
  const la = subA.length
  const lb = subB.length

  // LCS table using typed arrays (flat).
  const width = lb + 1
  const table = new Uint32Array((la + 1) * width)
  for (let i = la - 1; i >= 0; i--) {
    for (let j = lb - 1; j >= 0; j--) {
      const idx = i * width + j
      if (subA[i] === subB[j]) {
        table[idx] = (table[idx + width + 1] ?? 0) + 1
      } else {
        const down = table[idx + width] ?? 0
        const right = table[idx + 1] ?? 0
        table[idx] = down >= right ? down : right
      }
    }
  }

  let i = 0
  let j = 0
  while (i < la && j < lb) {
    if (subA[i] === subB[j]) {
      out.push({ op: 'eq', text: subA[i] ?? '', left: start + i + 1, right: start + j + 1 })
      i++
      j++
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: 'del', text: subA[i] ?? '', left: start + i + 1, right: null })
      i++
    } else {
      out.push({ op: 'add', text: subB[j] ?? '', left: null, right: start + j + 1 })
      j++
    }
  }
  while (i < la) {
    out.push({ op: 'del', text: subA[i] ?? '', left: start + i + 1, right: null })
    i++
  }
  while (j < lb) {
    out.push({ op: 'add', text: subB[j] ?? '', left: null, right: start + j + 1 })
    j++
  }

  const tail = n - endA
  for (let k = 0; k < tail; k++) {
    out.push({ op: 'eq', text: a[endA + k] ?? '', left: endA + k + 1, right: endB + k + 1 })
  }
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const l of lines) {
    if (l.op === 'add') added++
    else if (l.op === 'del') removed++
    else unchanged++
  }
  return { added, removed, unchanged }
}
