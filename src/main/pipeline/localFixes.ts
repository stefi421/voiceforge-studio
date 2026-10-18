import type { ScriptSection } from '@shared/types'
import { normalizeHeading, SPOKEN_DOMAIN_NAMES } from './validator'

/**
 * Deterministic repairs applied to every writer output before validation (1.6.0). Each one
 * fixes a mistake that would otherwise cost a full OpenAI rewrite, without changing what the
 * script says:
 *  - markdown links → their text; bare URLs / web addresses removed;
 *  - citation markers ([1], 【…】, (source: …), turn0search tokens) removed;
 *  - markdown emphasis, heading markers and bullet markers removed;
 *  - a title line (or "Title: …") at the very top removed;
 *  - an "Intro"/"Introduction" label line removed when the format doesn't use such a label
 *    ("Intro: text" keeps the text);
 *  - repeated spaces, trailing spaces and extra blank lines tidied.
 * Returns the fixed text and the list of fixes applied (logged as a job event).
 */
const URL_SOURCE = String.raw`\b(?:https?:\/\/|www\.)[^\s)]+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|tv|co|app|dev)\b(?:\/[^\s)]*)?`
/** A web address that is not one of the spoken store names (non-global: safe for .test()). */
const URL_ANY = { test: (s: string): boolean => new RegExp(URL_SOURCE, 'i').test(s.replace(SPOKEN_DOMAIN_NAMES, ' ')) }
const URL_IN_PARENS = new RegExp(String.raw`\s?\((?:[^()\n]*\s)?(?:${URL_SOURCE})[^()\n]*\)`, 'gi')

export function localScriptFixes(text: string, ctx: { titles: string[]; structure: ScriptSection[] }): { text: string; fixes: string[] } {
  const fixes: string[] = []
  let t = text.replace(/\r\n/g, '\n')
  const labels = new Set(ctx.structure.flatMap((s) => [s.label, ...s.aliases]).map((l) => normalizeHeading(l)))

  const before = (re: RegExp): boolean => re.test(t)

  // Markdown links: [text](url) → text
  if (before(/\[([^\]\n]{1,200})\]\((?:https?:\/\/|www\.)[^)\s]+\)/)) {
    t = t.replace(/\[([^\]\n]{1,200})\]\((?:https?:\/\/|www\.)[^)\s]+\)/g, '$1')
    fixes.push('markdown links')
  }
  // Bare URLs and web addresses. Removing one from the middle of a sentence would leave a broken
  // sentence ("Visit  for more."), so: a parenthesised address or a line that is only an address
  // (optionally "Source: …") is removed; any other sentence containing an address is dropped whole —
  // such sentences are calls to visit a site, not content.
  if (URL_ANY.test(t)) {
    t = t
      .split('\n')
      .map((line) => {
        if (!URL_ANY.test(line)) return line
        let l = line.replace(URL_IN_PARENS, (m) => (URL_ANY.test(m) ? '' : m))
        if (!URL_ANY.test(l)) return l
        if (/^\s*(?:(?:source|sources|link|links|website|site|more info)\s*:\s*)?(?:\S+\s*)$/i.test(l) && URL_ANY.test(l)) return null
        // Sentence ends are punctuation followed by whitespace, so the dots inside an address never split it.
        l = l
          .split(/(?<=[.!?…]["'”’)\]]?)\s+/)
          .filter((x) => !URL_ANY.test(x))
          .join(' ')
          .trim()
        return l.length ? l : null
      })
      .filter((line): line is string => line !== null)
      .join('\n')
    fixes.push('web addresses')
  }
  // Citation markers
  const citeRe = /\s?\[\^?\d{1,3}\]|\s?\[(?:source|src|citation)[^\]\n]*\]|\s?\((?:source|src):[^)\n]*\)|\s?【[^】\n]*】|\s?\bcite(?:turn|web)\w*|\s?\bturn\d+search\d+\b/gi
  if (before(new RegExp(citeRe.source, 'i'))) {
    t = t.replace(citeRe, '')
    fixes.push('citation markers')
  }
  // Emphasis and inline code
  if (before(/\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`/)) {
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/`([^`\n]+)`/g, '$1')
    fixes.push('markdown emphasis')
  }
  // Heading, quote and bullet markers at the start of lines
  if (before(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+•]\s+|\d{1,2}[.)]\s+(?=\S))/m)) {
    t = t
      .split('\n')
      .map((line) => {
        const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/)
        if (heading) return heading[1]!.trim()
        const quote = line.match(/^\s{0,3}>\s+(.*)$/)
        if (quote) return quote[1]!
        const bullet = line.match(/^\s{0,3}[-*+•]\s+(.*)$/)
        if (bullet) return bullet[1]!
        // Numbered list items ("1. Gameplay") only when what follows is a section label.
        const num = line.match(/^\s{0,3}\d{1,2}[.)]\s+(.*)$/)
        if (num && labels.has(normalizeHeading(num[1]!))) return num[1]!
        return line
      })
      .join('\n')
    fixes.push('markdown markers')
  }

  // Title line at the very top
  const lines = t.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim().length > 0)
  if (firstIdx >= 0) {
    const first = lines[firstIdx]!.trim()
    const plain = first.replace(/^(?:title|game|product)\s*(?::|[-–]\s)\s*/i, '').replace(/[.:!]+$/, '').trim()
    const titles = ctx.titles.map((x) => x.trim()).filter(Boolean)
    const longest = Math.max(0, ...titles.map((x) => x.length))
    const isTitle = titles.some((x) => normalizeHeading(plain) === normalizeHeading(x)) || /^(?:title|game|product)\s*(?::|[-–]\s)/i.test(first)
    if (isTitle && first.length <= longest + 20 && !labels.has(normalizeHeading(first))) {
      lines.splice(firstIdx, 1)
      t = lines.join('\n')
      fixes.push('title line')
    }
  }

  // "Intro" / "Introduction" label when the format doesn't use it
  if (!labels.has('intro') && !labels.has('introduction')) {
    const introRe = /^\s*(?:intro|introduction)\s*:?\s*$/gim
    const inlineRe = /^\s*(?:intro|introduction)\s*:\s+(?=\S)/gim
    if (introRe.test(t) || inlineRe.test(t)) {
      t = t.replace(/^\s*(?:intro|introduction)\s*:?\s*$\n?/gim, '').replace(/^\s*(?:intro|introduction)\s*:\s+(?=\S)/gim, '')
      fixes.push('"Intro" label')
    }
  }

  // Whitespace tidy (never inside words): repeated spaces, space before punctuation, empty parens left by removals.
  const tidy = t
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+(?=\S)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (tidy !== t.trim() && !fixes.length) fixes.push('spacing')
  return { text: tidy, fixes }
}
