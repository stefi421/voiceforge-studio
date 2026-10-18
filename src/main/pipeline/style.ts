import type { Channel, ComplianceCheck, FixedTextBlock, FixedTextKind, ReferenceScript, ReferenceStats, ScriptSection, TemplateVersion, ValidationIssue, ValidationReport } from '@shared/types'
import { countWords, estimateDurationSec, newId } from '../util/common'
import { findSections, normalizeHeading } from './validator'

/**
 * Deterministic helpers for the Channel Style Preservation Studio: fixed-text
 * detection across approved reference scripts, locked-text validation and the
 * clean narration text sent to ElevenLabs. Nothing here calls a model.
 */

/** Normalise text for verbatim comparison: case, whitespace, curly quotes and dashes. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Strips trailing punctuation so "…matter." and "…matter" compare equal at the end of a script. */
function stripEdgePunct(s: string): string {
  return s.replace(/^[\s"'([{-]+/, '').replace(/[\s.!?,;:"')\]}-]+$/, '')
}

/** A line that looks like a heading: short, no terminal sentence punctuation, at least one letter. */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 60) return false
  if (/[.!?]["')\]]?$/.test(t)) return false
  if (!/\p{L}/u.test(t)) return false
  return t.split(/\s+/).length <= 8
}

interface Unit {
  text: string
  norm: string
  /** Relative position of the unit's start inside its reference (0..1). */
  pos: number
  heading: boolean
}

/** Splits a reference into heading lines and sentences, keeping relative positions. */
export function splitUnits(text: string): Unit[] {
  const clean = text.replace(/\r\n/g, '\n')
  const total = Math.max(1, clean.length)
  const units: Unit[] = []
  let offset = 0
  for (const rawLine of clean.split('\n')) {
    const lineStart = offset
    offset += rawLine.length + 1
    const line = rawLine.trim()
    if (!line) continue
    if (looksLikeHeading(line)) {
      units.push({ text: line, norm: normalizeForMatch(line), pos: lineStart / total, heading: true })
      continue
    }
    // Sentence split that keeps "e.g." style abbreviations reasonably intact.
    const re = /[^.!?]+(?:[.!?]+["')\]]*|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      const sentence = m[0].trim()
      if (sentence.length < 12) continue
      const start = lineStart + rawLine.indexOf(m[0])
      units.push({ text: sentence, norm: normalizeForMatch(sentence), pos: Math.max(0, start) / total, heading: false })
    }
  }
  return units
}

const CTA_RE = /\b(subscribe|like (?:the|this) video|hit the bell|notification|comment below|let me know in the comments|see you in the next)\b/i

/**
 * Finds text that appears verbatim in at least two references (all of them when
 * there are exactly two). Provenance is `consistent` when every reference has it,
 * otherwise `inferred`. Blocks are proposals: they are never locked automatically.
 */
export function detectFixedText(refs: Array<Pick<ReferenceScript, 'text'>>): FixedTextBlock[] {
  if (refs.length < 2) return []
  const perRef = refs.map((r) => splitUnits(r.text))
  const counts = new Map<string, { text: string; refs: Set<number>; positions: number[]; heading: boolean }>()
  perRef.forEach((units, ri) => {
    for (const u of units) {
      const entry = counts.get(u.norm) ?? { text: u.text, refs: new Set<number>(), positions: [], heading: u.heading }
      if (!entry.refs.has(ri)) entry.positions.push(u.pos)
      entry.refs.add(ri)
      entry.heading = entry.heading && u.heading
      counts.set(u.norm, entry)
    }
  })
  const minRefs = 2
  const blocks: FixedTextBlock[] = []
  for (const [, e] of counts) {
    if (e.refs.size < minRefs) continue
    const avgPos = e.positions.reduce((a, b) => a + b, 0) / e.positions.length
    let kind: FixedTextKind
    if (e.heading) kind = 'heading'
    else if (avgPos <= 0.15) kind = 'intro'
    else if (avgPos >= 0.85) kind = CTA_RE.test(e.text) ? 'cta' : 'outro'
    else kind = CTA_RE.test(e.text) ? 'cta' : 'transition'
    blocks.push({
      id: newId(),
      kind,
      text: e.text,
      locked: false,
      provenance: e.refs.size === refs.length ? 'consistent' : 'inferred',
      spoken: kind !== 'heading',
      occurrences: e.refs.size
    })
  }
  const order: Record<FixedTextKind, number> = { intro: 0, heading: 1, transition: 2, cta: 3, outro: 4, other: 5 }
  return blocks.sort((a, b) => order[a.kind] - order[b.kind] || b.occurrences - a.occurrences)
}

export function referenceStats(refs: Array<Pick<ReferenceScript, 'text'>>, wordsPerMinute: number): ReferenceStats {
  if (!refs.length) return { count: 0, minChars: 0, maxChars: 0, avgChars: 0, avgWords: 0, avgDurationSec: 0 }
  const chars = refs.map((r) => r.text.trim().length)
  const words = refs.map((r) => countWords(r.text))
  const durs = refs.map((r) => estimateDurationSec(r.text, wordsPerMinute))
  const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  return { count: refs.length, minChars: Math.min(...chars), maxChars: Math.max(...chars), avgChars: avg(chars), avgWords: avg(words), avgDurationSec: avg(durs) }
}

/** Removes leading heading lines (section labels / short title lines) so the intro check sees the first spoken sentence. */
function bodyWithoutLeadingHeadings(text: string, structure: ScriptSection[]): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const headingLines = new Set(findSections(text, structure).map((s) => s.line))
  let i = 0
  while (i < lines.length && (!lines[i]!.trim() || headingLines.has(i) || (i < 3 && looksLikeHeading(lines[i]!)))) i++
  return lines.slice(i).join('\n')
}

function lineIsBlock(line: string, block: FixedTextBlock): boolean {
  return normalizeHeading(line) === normalizeHeading(block.text) || normalizeForMatch(line) === normalizeForMatch(block.text)
}

/** Validator for locked fixed text (Rules 1–3 of the channel spec). Only locked blocks are enforced. */
export function validateFixedBlocks(text: string, template: Pick<TemplateVersion, 'fixedBlocks' | 'structure'> | null): ValidationIssue[] {
  const locked = (template?.fixedBlocks ?? []).filter((b) => b.locked && b.text.trim())
  if (!locked.length) return []
  const issues: ValidationIssue[] = []
  const norm = normalizeForMatch(text)
  const body = normalizeForMatch(bodyWithoutLeadingHeadings(text, template?.structure ?? []))
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const short = (s: string): string => (s.length > 90 ? `${s.slice(0, 87)}…` : s)
  const headingPositions: Array<{ block: FixedTextBlock; line: number }> = []
  for (const b of locked) {
    const bn = normalizeForMatch(b.text)
    if ((b.kind === 'intro' || b.kind === 'outro') && b.wholeParagraph) {
      const paras = scriptParagraphs(text, template?.structure ?? [])
      const target = b.kind === 'intro' ? paras[0] : paras[paras.length - 1]
      if (!target || exactKey(target) !== exactKey(b.text)) {
        issues.push(
          b.kind === 'intro'
            ? { code: 'fixed_intro', severity: 'error', message: `The first paragraph must be exactly the locked introduction, on its own: "${short(b.text)}". Put the rest of the opening in the next paragraph.` }
            : { code: 'fixed_outro', severity: 'error', message: `The last paragraph must be exactly the locked closing, on its own: "${short(b.text)}". Nothing may follow it.` }
        )
      }
      continue
    }
    if (b.kind === 'intro') {
      if (!body.startsWith(stripEdgePunct(bn))) {
        issues.push({ code: 'fixed_intro', severity: 'error', message: `The locked introduction must open the script exactly: "${short(b.text)}". Keep it word for word.` })
      }
    } else if (b.kind === 'outro') {
      if (!stripEdgePunct(norm).endsWith(stripEdgePunct(bn))) {
        issues.push({ code: 'fixed_outro', severity: 'error', message: `The locked conclusion must close the script exactly: "${short(b.text)}". Keep it word for word and add nothing after it.` })
      }
    } else if (b.kind === 'heading') {
      const idx = lines.findIndex((l) => lineIsBlock(l, b))
      if (idx < 0) issues.push({ code: 'fixed_heading', severity: 'error', message: `The locked heading "${short(b.text)}" is missing (it must be its own line).` })
      else headingPositions.push({ block: b, line: idx })
    } else if (!norm.includes(stripEdgePunct(bn))) {
      issues.push({ code: 'fixed_text', severity: 'error', message: `The locked ${b.kind} text is missing or was reworded: "${short(b.text)}".` })
    }
  }
  // Locked headings keep the order they were approved in.
  const expected = locked.filter((b) => b.kind === 'heading').map((b) => b.id)
  const actual = [...headingPositions].sort((a, b) => a.line - b.line).map((h) => h.block.id)
  const exp = expected.filter((id) => actual.includes(id))
  if (actual.some((id, i) => id !== exp[i])) {
    issues.push({ code: 'fixed_heading_order', severity: 'error', message: `Locked headings are out of order. Expected: ${exp.map((id) => locked.find((b) => b.id === id)?.text).join(' → ')}.` })
  }
  return issues
}


// ---------------------------------------------------------------------------
// Exact format reproduction (1.4.0 reference pack): paragraphs, normaliser, skeleton
// ---------------------------------------------------------------------------

/** Case-preserving comparison key: only whitespace, quote and dash style are ignored. */
export function exactKey(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s*[–—−]\s*/g, '-')
    .replace(/\s+-\s+/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Paragraphs of a script (blank-line separated), with single-line breaks inside a paragraph kept. */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * Spoken paragraphs in order, with section heading lines removed — used to find the
 * first (intro) and last (outro) paragraph. A heading written directly above its text
 * (no blank line) is stripped from that paragraph.
 */
export function scriptParagraphs(text: string, structure: ScriptSection[]): string[] {
  const isHeading = (line: string): boolean => {
    const n = normalizeHeading(line)
    return structure.some((sec) => [sec.label, ...sec.aliases].some((c) => c.toLowerCase().trim() === n))
  }
  const out: string[] = []
  for (const p of splitParagraphs(text)) {
    const lines = p.split('\n').filter((l) => !isHeading(l))
    const rest = lines.join('\n').trim()
    if (rest) out.push(rest)
  }
  return out
}

function sentencesOf(paragraph: string): string[] {
  return paragraph.match(/[^.!?]+(?:[.!?]+["'’”)\]]*|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [paragraph]
}

/** If `para` begins with `block` (by exactKey), returns [block, remainder]; else null. */
function splitLeading(para: string, block: string): [string, string] | null {
  const target = exactKey(block).toLowerCase()
  const sentences = sentencesOf(para)
  let acc = ''
  for (let i = 0; i < sentences.length; i++) {
    acc = acc ? `${acc} ${sentences[i]}` : sentences[i]!
    const k = exactKey(acc).toLowerCase()
    if (k === target) return [block.trim(), sentences.slice(i + 1).join(' ').trim()]
    if (!target.startsWith(k)) return null
  }
  return null
}

function splitTrailing(para: string, block: string): [string, string] | null {
  const target = exactKey(block).toLowerCase()
  const sentences = sentencesOf(para)
  let acc = ''
  for (let i = sentences.length - 1; i >= 0; i--) {
    acc = acc ? `${sentences[i]} ${acc}` : sentences[i]!
    const k = exactKey(acc).toLowerCase()
    if (k === target) return [sentences.slice(0, i).join(' ').trim(), block.trim()]
    if (!target.endsWith(k)) return null
  }
  return null
}

/**
 * Deterministic post-processor applied to every writer output before validation.
 * It only fixes presentation — never content:
 * - line endings, trailing spaces, runs of blank lines, markdown heading/bold markers on label lines;
 * - section label lines are rewritten to the exact approved label (case, trailing colon);
 * - a whole-paragraph locked intro/outro that differs only by case, whitespace, quote or
 *   dash style is replaced by the locked text, and one that was merged into the neighbouring
 *   paragraph is split back out into its own paragraph.
 * Text that is actually reworded is left alone so the validator reports it.
 */
export function normalizeLockedText(text: string, template: Pick<TemplateVersion, 'structure' | 'fixedBlocks'> | null): string {
  if (!template) return text
  const whole = template.fixedBlocks.filter((b) => b.locked && b.wholeParagraph && b.text.trim())
  // Whitespace is only normalised for exact-paragraph formats; other formats keep the text as written.
  let t = whole.length ? text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : text
  const labels = template.structure.flatMap((sec) => [sec.label, ...sec.aliases])
  t = t
    .split('\n')
    .map((line) => {
      const stripped = line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*\*\*(.+?)\*\*\s*$/, '$1').replace(/^\s*__(.+?)__\s*$/, '$1')
      if (stripped.trim().length === 0 || stripped.trim().length > 60) return line
      const n = normalizeHeading(stripped)
      const hit = labels.find((l) => l.toLowerCase().trim() === n)
      return hit ?? line
    })
    .join('\n')
  if (!whole.length) return t
  const paras = splitParagraphs(t)
  const isLabel = (p: string): boolean => labels.some((l) => l === p.trim())
  const intro = whole.find((b) => b.kind === 'intro')
  if (intro) {
    const i = paras.findIndex((p) => !isLabel(p))
    if (i >= 0) {
      const p = paras[i]!
      if (exactKey(p).toLowerCase() === exactKey(intro.text).toLowerCase()) paras[i] = intro.text.trim()
      else {
        const split = splitLeading(p, intro.text)
        if (split) paras.splice(i, 1, ...split.filter(Boolean))
      }
    }
  }
  const outro = whole.find((b) => b.kind === 'outro')
  if (outro && paras.length) {
    const i = paras.length - 1
    const p = paras[i]!
    if (exactKey(p).toLowerCase() === exactKey(outro.text).toLowerCase()) paras[i] = outro.text.trim()
    else {
      const split = splitTrailing(p, outro.text)
      if (split) paras.splice(i, 1, ...split.filter(Boolean))
    }
  }
  return paras.join('\n\n')
}

export interface SkeletonPart {
  kind: 'intro' | 'opening' | 'section' | 'outro'
  /** Verbatim text for intro/outro; label for sections. */
  text: string
  /** Typical body paragraph count (median over the references). */
  paragraphs: number
}

/**
 * Derives the format skeleton from the version and its reference scripts: locked intro,
 * opening paragraphs before the first label, each label with its typical paragraph count,
 * then the locked outro. Returns [] when the format has no labelled structure.
 */
export function buildFormatSkeleton(template: Pick<TemplateVersion, 'structure' | 'fixedBlocks'>, references: Array<Pick<ReferenceScript, 'text'>>): SkeletonPart[] {
  if (!template.structure.length) return []
  const intro = template.fixedBlocks.find((b) => b.locked && b.kind === 'intro' && b.text.trim())
  const outro = template.fixedBlocks.find((b) => b.locked && b.kind === 'outro' && b.text.trim())
  const keys = ['__opening', ...template.structure.map((s) => s.key)]
  const counts = new Map<string, number[]>(keys.map((k) => [k, []]))
  for (const ref of references) {
    const paras = splitParagraphs(ref.text)
    let current = '__opening'
    const per = new Map<string, number>(keys.map((k) => [k, 0]))
    paras.forEach((p, idx) => {
      const sec = template.structure.find((s) => [s.label, ...s.aliases].some((c) => normalizeHeading(c) === normalizeHeading(p)) && p.length <= 60)
      if (sec) {
        current = sec.key
        return
      }
      const isIntro = idx === 0 && !!intro
      const isOutro = idx === paras.length - 1 && !!outro
      if (isIntro || isOutro) return
      per.set(current, (per.get(current) ?? 0) + 1)
    })
    for (const k of keys) counts.get(k)!.push(per.get(k) ?? 0)
  }
  const median = (xs: number[]): number => {
    if (!xs.length) return 0
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]!
  }
  const parts: SkeletonPart[] = []
  if (intro) parts.push({ kind: 'intro', text: intro.text.trim(), paragraphs: 1 })
  const opening = median(counts.get('__opening')!)
  if (opening > 0) parts.push({ kind: 'opening', text: '', paragraphs: opening })
  for (const sec of template.structure) parts.push({ kind: 'section', text: sec.label, paragraphs: median(counts.get(sec.key)!) })
  if (outro) parts.push({ kind: 'outro', text: outro.text.trim(), paragraphs: 1 })
  return parts
}

/**
 * Clean narration for ElevenLabs: section headings and non-spoken fixed blocks are
 * removed unless the format reads headings aloud. The saved Script.txt keeps them.
 */
export function buildNarrationText(text: string, template: Pick<TemplateVersion, 'structure' | 'fixedBlocks' | 'headingsSpoken'> | null, channel: Pick<Channel, 'validation'>): string {
  const clean = text.replace(/\r\n/g, '\n').trim()
  // The format decides; channels without a format fall back to the channel setting.
  const spoken = template ? !!template.headingsSpoken : !!channel.validation.narrateSectionHeadings
  const lines = clean.split('\n')
  const drop = new Set<number>()
  if (!spoken && template) for (const s of findSections(clean, template.structure)) drop.add(s.line)
  const silent = (template?.fixedBlocks ?? []).filter((b) => !b.spoken && b.text.trim())
  lines.forEach((l, i) => {
    if (silent.some((b) => lineIsBlock(l, b))) drop.add(i)
  })
  return lines
    .filter((_l, i) => !drop.has(i))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const PROHIBITED_CODES = new Set(['url', 'citation', 'markdown', 'forbidden_phrase', 'ai_leak'])

/** Deterministic part of a style-test compliance report, built from a validation report. */
export function deterministicCompliance(report: ValidationReport, template: Pick<TemplateVersion, 'structure' | 'fixedBlocks'>): ComplianceCheck[] {
  const byCodes = (codes: string[]): ValidationIssue[] => report.issues.filter((i) => codes.includes(i.code))
  const verdict = (issues: ValidationIssue[], applicable = true): ComplianceCheck['verdict'] =>
    !applicable ? 'not_applicable' : issues.some((i) => i.severity === 'error') ? 'fail' : issues.length ? 'warning' : 'pass'
  const hasStructure = template.structure.some((s) => s.required)
  const locked = template.fixedBlocks.filter((b) => b.locked)
  const sections = byCodes(['section_missing', 'section_duplicate'])
  const order = byCodes(['section_order', 'fixed_heading_order'])
  const intro = byCodes(['fixed_intro', 'intro_missing'])
  const outro = byCodes(['fixed_outro'])
  const fixed = byCodes(['fixed_heading', 'fixed_text'])
  const length = byCodes(['too_long', 'too_short', 'duration_off_target'])
  const prohibited = report.issues.filter((i) => PROHIBITED_CODES.has(i.code))
  const msgs = (xs: ValidationIssue[], ok: string): string[] => (xs.length ? xs.map((i) => i.message) : [ok])
  return [
    { key: 'sections', label: 'Required sections', verdict: verdict(sections, hasStructure), details: hasStructure ? msgs(sections, `Found: ${report.sectionsFound.join(', ') || '—'}`) : ['This format has no confirmed section list yet.'] },
    { key: 'order', label: 'Section order', verdict: verdict(order, hasStructure || locked.some((b) => b.kind === 'heading')), details: msgs(order, 'Sections appear in the approved order.') },
    { key: 'intro', label: 'Introduction', verdict: verdict(intro, locked.some((b) => b.kind === 'intro') || intro.length > 0), details: locked.some((b) => b.kind === 'intro') ? msgs(intro, 'Locked introduction is present word for word.') : ['No locked introduction for this format.'] },
    { key: 'outro', label: 'Conclusion', verdict: verdict(outro, locked.some((b) => b.kind === 'outro')), details: locked.some((b) => b.kind === 'outro') ? msgs(outro, 'Locked conclusion closes the script word for word.') : ['No locked conclusion for this format.'] },
    { key: 'fixed_text', label: 'Locked text', verdict: verdict(fixed, locked.some((b) => b.kind !== 'intro' && b.kind !== 'outro')), details: msgs(fixed, 'All locked headings and phrases are present.') },
    { key: 'length', label: 'Length', verdict: verdict(length), details: msgs(length, `${report.charCount.toLocaleString('en-US')} characters, ~${Math.round(report.estimatedDurationSec / 60)} min.`) },
    { key: 'prohibited', label: 'Prohibited content', verdict: verdict(prohibited), details: msgs(prohibited, 'No URLs, citations, markdown, forbidden phrases or AI notes.') }
  ]
}
