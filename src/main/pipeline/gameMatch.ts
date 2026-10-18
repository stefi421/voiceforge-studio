/**
 * Title normalisation and matching for the Game Library (1.6.0).
 *
 * Goal: a game researched once is never researched again — but research for one game must
 * never be reused for a *different* game. So:
 *  - `exact`: the normalised key (or a learned alias) is identical → reuse silently.
 *  - `auto`:  a near-certain spelling variant (typo-level edit distance, same words in another
 *             order) with exactly one such candidate → reuse silently.
 *  - `near`:  plausible but risky (one title extends the other — "Hollow Knight" vs
 *             "Hollow Knight: Silksong", edition words, sequels) → the user chooses once and the
 *             typed title is learned as an alias.
 *  - `none`:  research it.
 */

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 }

/** Words that only describe an edition. Two titles differing only by these are NOT auto-matched. */
export const EDITION_WORDS = new Set([
  'remastered',
  'remaster',
  'remake',
  'definitive',
  'edition',
  'complete',
  'goty',
  'deluxe',
  'ultimate',
  'enhanced',
  'directors',
  'cut',
  'anniversary',
  'collection',
  'redux',
  'hd',
  'legacy',
  'special',
  'gold',
  'premium',
  'standard'
])

/** Normalised word list of a title: lower case, symbols/punctuation removed, roman numerals → digits, leading "the" dropped. */
export function titleTokens(title: string): string[] {
  const words = title
    // Trademark signs first: NFKC would turn "™" into the letters "TM".
    .replace(/[™®©℠]/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/'s\b/g, 's')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (ROMAN[w] !== undefined && w !== 'i' ? String(ROMAN[w]) : w))
  // "I" as a numeral only at the end ("Final Fantasy I"); elsewhere it is the pronoun.
  if (words.length > 1 && words[words.length - 1] === 'i') words[words.length - 1] = '1'
  if (words[0] === 'the' && words.length > 1) words.shift()
  return words
}

/** The lookup key used for exact matches and aliases. */
export function gameKey(title: string): string {
  return titleTokens(title).join(' ')
}

/** The part before a subtitle separator (":" or " - " / " – "), normalised. Empty when there is no subtitle. */
export function baseKey(title: string): string {
  const m = title.split(/\s*[:：]\s*|\s+[-–—]\s+/)
  return m.length > 1 ? gameKey(m[0]!) : ''
}

/** Edit distance where swapping two neighbouring letters counts as one typo (optimal string alignment). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = v
    }
    prev2 = prev
    prev = cur
  }
  return prev[b.length]!
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max
}

function digitsOf(key: string): string {
  return (key.match(/\d+/g) ?? []).join(',')
}

export interface LibraryEntryKeys {
  gameId: string
  canonicalTitle: string
  /** Every normalised key of the entry (canonical + aliases). */
  keys: string[]
}

export interface MatchResult {
  kind: 'exact' | 'auto' | 'near' | 'none'
  gameId: string | null
  canonicalTitle: string | null
  candidates: Array<{ gameId: string; canonicalTitle: string }>
}

/**
 * Classifies a typed title against library entries. Never returns `auto` when a sequel number
 * or an edition word differs, and never when more than one entry is plausible.
 */
export function matchTitle(title: string, entries: LibraryEntryKeys[]): MatchResult {
  const key = gameKey(title)
  const none: MatchResult = { kind: 'none', gameId: null, canonicalTitle: null, candidates: [] }
  if (!key) return none
  const exact = entries.find((e) => e.keys.includes(key))
  if (exact) return { kind: 'exact', gameId: exact.gameId, canonicalTitle: exact.canonicalTitle, candidates: [] }

  const tokens = key.split(' ')
  const tokenSet = new Set(tokens)
  const base = baseKey(title)
  const auto: LibraryEntryKeys[] = []
  const near: LibraryEntryKeys[] = []
  for (const e of entries) {
    let isAuto = false
    let isNear = false
    for (const k of e.keys) {
      if (digitsOf(k) !== digitsOf(key)) {
        // Different sequel numbers are different games — unless one side simply has no number and
        // the rest is a subtitle relation (handled as `near` below).
        const kt = new Set(k.split(' '))
        const shared = [...tokenSet].filter((t) => kt.has(t)).length
        if (shared >= Math.min(tokenSet.size, kt.size) && Math.min(tokenSet.size, kt.size) >= 1 && (digitsOf(k) === '' || digitsOf(key) === '')) isNear = true
        continue
      }
      const kTokens = k.split(' ')
      const kSet = new Set(kTokens)
      const sameSet = kSet.size === tokenSet.size && [...kSet].every((t) => tokenSet.has(t))
      if (sameSet) {
        isAuto = true
        break
      }
      // Typo-level difference on the whole title (no edition words involved).
      const sim = similarity(k, key)
      const editionDiff = [...kSet, ...tokenSet].some((t) => EDITION_WORDS.has(t) && !(kSet.has(t) && tokenSet.has(t)))
      // One typo is enough on longer titles ("Emberwrad"); short words ("Portal"/"Mortal") need more care.
      const oneTypo = Math.min(k.length, key.length) >= 8 && levenshtein(k, key) <= 1
      if ((sim >= 0.92 || oneTypo) && !editionDiff && Math.abs(k.length - key.length) <= 3) {
        isAuto = true
        break
      }
      // One title extends the other (subtitle, edition, extra words): plausible, ask once.
      const smaller = kSet.size <= tokenSet.size ? kSet : tokenSet
      const larger = smaller === kSet ? tokenSet : kSet
      if ([...smaller].every((t) => larger.has(t)) && smaller.size >= 1) isNear = true
      else if (base && base === k) isNear = true
      else if (sim >= 0.85) isNear = true
    }
    if (isAuto) auto.push(e)
    else if (isNear) near.push(e)
  }
  if (auto.length === 1 && near.length === 0) return { kind: 'auto', gameId: auto[0]!.gameId, canonicalTitle: auto[0]!.canonicalTitle, candidates: [] }
  const plausible = [...auto, ...near]
  if (plausible.length) {
    return {
      kind: 'near',
      gameId: null,
      canonicalTitle: null,
      candidates: plausible.slice(0, 5).map((e) => ({ gameId: e.gameId, canonicalTitle: e.canonicalTitle }))
    }
  }
  return none
}
