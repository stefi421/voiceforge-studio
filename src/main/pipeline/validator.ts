import type { Channel, ScriptSection, TemplateVersion, ValidationIssue, ValidationReport } from '@shared/types'
import { countWords, estimateDurationSec } from '../util/common'

/**
 * Deterministic script validation. No network, no AI — every rule here is
 * reproducible, which is what makes the "do not send a failed script to
 * ElevenLabs" guarantee meaningful. The optional AI review pass lives in the
 * pipeline and only adds issues on top of this report.
 */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|tv|co|app|dev)\b(?:\/[^\s]*)?/i
const CITATION_RE = /\[\d{1,3}\]|\[(?:source|src|citation)[^\]]*\]|\((?:source|src):[^)]*\)|【[^】]*】|\[\^?\d+\]|\bcite(?:turn|web)\w*/i
const MARKDOWN_RE = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`/m
const AI_LEAK_PATTERNS = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bhere(?:'s| is) (?:the|your) script\b/i,
  /\bsystem prompt\b/i,
  /\b(?:i cannot|i can't) (?:verify|browse)\b/i,
  /\[(?:insert|add|your)\s[^\]]*\]/i,
  /\bplaceholder\b/i,
  /\bword count:\s*\d+/i,
  /\bcharacter count:\s*\d+/i
]
const FIRSTHAND_PATTERNS = [
  /\b(?:in|during) my (?:testing|playthrough|time with)\b/i,
  /\bi (?:played|tested|benchmarked|measured|clocked)\b/i,
  /\bwe (?:played|tested|benchmarked|measured|clocked)\b/i,
  /\bhands-on (?:testing|time)\b/i,
  /\b\d{2,3}\s?fps\b/i,
  /\bafter \d+ hours\b/i
]

export interface ValidationContext {
  channel: Channel
  template: TemplateVersion | null
  expectedTitle: string
  researchConfirmed: boolean
  strictness: 'relaxed' | 'standard' | 'strict'
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalise a heading line for comparison. */
export function normalizeHeading(line: string): string {
  return line
    .trim()
    .replace(/^[#>*\-\d.)\s]+/, '')
    .replace(/[:\-–—.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Returns the ordered list of section labels found as standalone heading lines. */
export function findSections(text: string, structure: ScriptSection[]): Array<{ key: string; label: string; line: number }> {
  const lines = text.split(/\r?\n/)
  const found: Array<{ key: string; label: string; line: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim().length === 0 || raw.trim().length > 60) continue
    const norm = normalizeHeading(raw)
    for (const sec of structure) {
      const candidates = [sec.label, ...sec.aliases].map((c) => c.toLowerCase().trim())
      if (candidates.includes(norm)) {
        found.push({ key: sec.key, label: raw.trim(), line: i })
        break
      }
    }
  }
  return found
}

export function validateScript(text: string, ctx: ValidationContext): ValidationReport {
  const issues: ValidationIssue[] = []
  const { channel } = ctx
  const rules = channel.validation
  const clean = text.replace(/\r\n/g, '\n').trim()
  const charCount = clean.length
  const wordCount = countWords(clean)
  const estimatedDurationSec = estimateDurationSec(clean, rules.wordsPerMinute)
  const structure = ctx.template?.structure ?? []

  if (charCount === 0) {
    issues.push({ code: 'empty', severity: 'error', message: 'The script is empty.' })
  }

  // Length
  if (channel.maxChars > 0 && charCount > channel.maxChars) {
    issues.push({ code: 'too_long', severity: 'error', message: `Script has ${charCount} characters; the channel maximum is ${channel.maxChars}.` })
  }
  if (channel.minChars > 0 && charCount < channel.minChars) {
    issues.push({
      code: 'too_short',
      severity: ctx.strictness === 'relaxed' ? 'warning' : 'error',
      message: `Script has ${charCount} characters; the channel minimum is ${channel.minChars}.`
    })
  }

  // Duration sanity (warning only; character limits are the hard rule)
  if (channel.targetDurationSec > 0) {
    const ratio = estimatedDurationSec / channel.targetDurationSec
    if (ratio < 0.6 || ratio > 1.5) {
      issues.push({
        code: 'duration_off_target',
        severity: 'warning',
        message: `Estimated narration ${Math.round(estimatedDurationSec)}s vs target ${channel.targetDurationSec}s (at ${rules.wordsPerMinute} wpm).`
      })
    }
  }

  // URLs / citations / markdown
  if (rules.forbidUrls && URL_RE.test(clean)) {
    issues.push({ code: 'url', severity: 'error', message: 'The narration contains a URL or web address.' })
  }
  if (rules.forbidCitations && CITATION_RE.test(clean)) {
    issues.push({ code: 'citation', severity: 'error', message: 'The narration contains citation markers (e.g. [1], [source]).' })
  }
  if (rules.forbidMarkdown && MARKDOWN_RE.test(clean)) {
    issues.push({ code: 'markdown', severity: 'error', message: 'The narration contains markdown formatting (#, **, bullets).' })
  }

  // Forbidden phrases: channel-level + validation-level
  const forbidden = [...new Set([...rules.forbiddenPhrases])].filter((p) => p.trim().length > 0)
  for (const phrase of forbidden) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(phrase.trim())}(?![\\p{L}\\p{N}])`, 'iu')
    if (re.test(clean)) {
      issues.push({ code: 'forbidden_phrase', severity: 'error', message: `Contains the forbidden phrase "${phrase}".` })
    }
  }

  // AI leakage
  for (const re of AI_LEAK_PATTERNS) {
    if (re.test(clean)) {
      issues.push({ code: 'ai_leak', severity: 'error', message: `Contains text that looks like AI instructions or notes: "${clean.match(re)?.[0]}".` })
      break
    }
  }

  // Firsthand claims (only an error when research did not confirm testing)
  if (!ctx.researchConfirmed) {
    for (const re of FIRSTHAND_PATTERNS) {
      const m = clean.match(re)
      if (m) {
        issues.push({
          code: 'firsthand_claim',
          severity: ctx.strictness === 'strict' ? 'error' : 'warning',
          message: `Contains a firsthand/benchmark claim that is not supported by research: "${m[0]}".`
        })
        break
      }
    }
  }

  // Language (cheap heuristic: expect latin script and common English words)
  if (rules.language === 'en' && charCount > 200) {
    const latin = (clean.match(/[A-Za-z]/g) ?? []).length
    const letters = (clean.match(/\p{L}/gu) ?? []).length
    const commonEnglish = (clean.match(/\b(?:the|and|you|with|that|this|for|are|is)\b/gi) ?? []).length
    if (letters > 0 && latin / letters < 0.9) {
      issues.push({ code: 'language', severity: 'error', message: 'The script does not appear to be written in English (non-Latin characters).' })
    } else if (commonEnglish < 5) {
      issues.push({ code: 'language', severity: 'warning', message: 'The script contains very few common English words; check the language.' })
    }
  }

  // Title presence
  if (ctx.expectedTitle && charCount > 0) {
    const t = ctx.expectedTitle.toLowerCase()
    const firstWords = t.split(/\s+/).slice(0, 2).join(' ')
    if (!clean.toLowerCase().includes(t) && !(firstWords.length > 3 && clean.toLowerCase().includes(firstWords))) {
      issues.push({ code: 'title_missing', severity: 'warning', message: `The script never mentions "${ctx.expectedTitle}".` })
    }
  }

  // Intro requirement: if the channel declares an exact intro sentence, require it near the start.
  const quotedIntro = channel.introRequirements.match(/"([^"]{20,})"/)?.[1]
  if (quotedIntro) {
    const head = clean.slice(0, Math.max(400, quotedIntro.length + 50)).toLowerCase()
    if (!head.includes(quotedIntro.toLowerCase().slice(0, 40))) {
      issues.push({ code: 'intro_missing', severity: 'error', message: 'The required intro sentence is missing from the start of the script.' })
    }
  }

  // Sections
  const sectionsFound = findSections(clean, structure)
  const foundKeys = sectionsFound.map((s) => s.key)
  const requiredKeys = structure.filter((s) => s.required).map((s) => s.key)
  for (const key of requiredKeys) {
    if (!foundKeys.includes(key)) {
      const sec = structure.find((s) => s.key === key)!
      issues.push({ code: 'section_missing', severity: 'error', message: `Required section "${sec.label}" is missing (expected as a standalone line).` })
    }
  }
  if (rules.enforceSectionOrder && requiredKeys.length > 1) {
    const order = foundKeys.filter((k) => requiredKeys.includes(k))
    const expected = requiredKeys.filter((k) => order.includes(k))
    const inOrder = order.every((k, i) => k === expected[i])
    if (!inOrder) {
      issues.push({ code: 'section_order', severity: 'error', message: `Sections are out of order. Expected: ${expected.map((k) => structure.find((s) => s.key === k)?.label).join(' → ')}.` })
    }
  }
  const duplicates = foundKeys.filter((k, i) => foundKeys.indexOf(k) !== i)
  if (duplicates.length) {
    issues.push({ code: 'section_duplicate', severity: 'warning', message: `Duplicate section heading(s): ${[...new Set(duplicates)].join(', ')}.` })
  }

  const ok = issues.every((i) => i.severity !== 'error')
  return {
    ok,
    issues,
    charCount,
    wordCount,
    estimatedDurationSec,
    sectionsFound: sectionsFound.map((s) => s.label),
    checkedAt: new Date().toISOString()
  }
}

/** Builds the feedback paragraph handed back to the model for a rewrite. */
export function describeIssuesForRewrite(report: ValidationReport): string {
  const errs = report.issues.filter((i) => i.severity === 'error')
  if (!errs.length) return ''
  return errs.map((e, i) => `${i + 1}. ${e.message}`).join('\n')
}

/** Removes section heading lines (used when the channel does not narrate headings). */
export function stripSectionHeadings(text: string, structure: ScriptSection[]): string {
  const found = new Set(findSections(text, structure).map((s) => s.line))
  return text
    .split(/\r?\n/)
    .filter((_l, i) => !found.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Applies pronunciation substitutions to the narration text sent to TTS. */
export function applyPronunciation(text: string, rules: Array<{ from: string; to: string }>): string {
  let out = text
  for (const r of rules) {
    if (!r.from.trim()) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(r.from.trim())}(?![\\p{L}\\p{N}])`, 'giu')
    out = out.replace(re, r.to)
  }
  return out
}
