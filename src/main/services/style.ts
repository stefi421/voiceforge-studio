import type fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  Channel,
  ChannelOpening,
  ComplianceCheck,
  FixedTextBlock,
  JobMode,
  ReferenceFormat,
  ReferenceScript,
  ResearchData,
  StyleAnalysis,
  StyleTestResult,
  Template,
  TemplateApprovalStatus,
  TemplateVersion
} from '@shared/types'
import type { Services } from './container'
import { PRODUCTION_STATUSES, SUPERVISED_STATUSES } from '../db/repos/channelRepo'
import { AppError, toAppError } from '../util/errors'
import { withRetry } from '../util/retry'
import { countWords, newId, nowIso } from '../util/common'
import { detectFixedText, deterministicCompliance, referenceStats } from '../pipeline/style'
import { validateScript } from '../pipeline/validator'
import { openaiCost } from '../pipeline/cost'

export const REFERENCE_LIMITS = { maxTextChars: 200_000, maxPerTemplate: 30, maxFileBytes: 20 * 1024 * 1024 }
const EXT_FORMAT: Record<string, ReferenceFormat> = { '.txt': 'txt', '.md': 'md', '.markdown': 'md', '.docx': 'docx', '.pdf': 'pdf' }
/** References sent to the writer per request (most recent first) and their size cap. */
const PROMPT_REFERENCES = 3
const PROMPT_REFERENCE_CHARS = 7000

export type GateResult = { allowed: true; warning: string | null } | { allowed: false; error: AppError }

/** Plain-text extraction for reference imports. Exported for tests. */
export async function extractReferenceText(filePath: string): Promise<{ text: string; format: ReferenceFormat }> {
  const ext = path.extname(filePath).toLowerCase()
  const format = EXT_FORMAT[ext]
  if (!format) throw new AppError('config', `Unsupported file type "${ext || 'none'}". Use TXT, Markdown, DOCX or PDF.`, { retryable: false, code: 'REFERENCE_UNSUPPORTED' })
  let st: fs.Stats
  try {
    st = await fsp.stat(filePath)
  } catch {
    throw new AppError('filesystem', 'The file no longer exists.', { retryable: false, code: 'REFERENCE_MISSING' })
  }
  if (!st.isFile()) throw new AppError('filesystem', 'Only regular files can be imported.', { retryable: false, code: 'REFERENCE_NOT_FILE' })
  if (st.size > REFERENCE_LIMITS.maxFileBytes) throw new AppError('config', 'The file is larger than 20 MB.', { retryable: false, code: 'REFERENCE_TOO_LARGE' })
  const buf = await fsp.readFile(filePath)
  let text: string
  if (format === 'txt' || format === 'md') {
    text = buf.toString('utf8').replace(/^﻿/, '')
  } else if (format === 'docx') {
    const mammoth = await import('mammoth')
    const extract = (mammoth as unknown as { extractRawText?: typeof import('mammoth').extractRawText; default?: { extractRawText: typeof import('mammoth').extractRawText } }).extractRawText ?? (mammoth as unknown as { default: { extractRawText: typeof import('mammoth').extractRawText } }).default.extractRawText
    const res = await extract({ buffer: buf })
    text = res.value
  } else {
    const unpdf = (await import('unpdf')) as typeof import('unpdf') & { default?: typeof import('unpdf') }
    const extractText = unpdf.extractText ?? unpdf.default!.extractText
    const res = await extractText(new Uint8Array(buf), { mergePages: true })
    text = Array.isArray(res.text) ? res.text.join('\n\n') : res.text
  }
  return { text: normalizeReferenceText(text), format }
}

export function normalizeReferenceText(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Channel Style Preservation Studio: reference library, analysis, approval and
 * style tests, plus the template resolution/gating used by generation.
 */
/** Copies a version into an input for a new version (status handled by the caller). */
export function versionToInput(v: TemplateVersion): import('@shared/types').TemplateVersionInput {
  return {
    systemPrompt: v.systemPrompt,
    structure: v.structure,
    exampleScript: v.exampleScript,
    notes: v.notes,
    placeholder: v.placeholder,
    fixedBlocks: v.fixedBlocks,
    findings: v.findings,
    confirmedRules: v.confirmedRules,
    unverified: v.unverified,
    headingsSpoken: v.headingsSpoken,
    referenceSetVersion: v.referenceSetVersion
  }
}

export class StyleService {
  constructor(private s: Services) {}

  // ---- opening (fast path for intro/outro) --------------------------------------

  getOpening(channelId: string): ChannelOpening {
    const channel = this.s.channels.get(channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const r = this.resolve(channel)
    const locked = (kind: 'intro' | 'outro'): string => r?.version.fixedBlocks.find((b) => b.locked && b.kind === kind)?.text ?? ''
    return {
      channelId,
      templateId: r?.template.id ?? null,
      versionId: r?.version.id ?? null,
      intro: locked('intro'),
      outro: locked('outro'),
      openWithChannelIntro: channel.validation.openWithChannelIntro !== false
    }
  }

  /**
   * Saves the intro/outro typed by the owner as LOCKED spoken blocks of the channel's default
   * format. Always a NEW version (approved versions are never edited in place); the new version
   * keeps the current status because the owner is stating these words themselves
   * (provenance `user_confirmed`). Unchanged text creates no version.
   */
  setOpening(channelId: string, input: { intro: string; outro: string; openWithChannelIntro: boolean }): ChannelOpening {
    const channel = this.s.channels.get(channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    if ((channel.validation.openWithChannelIntro !== false) !== input.openWithChannelIntro) {
      this.s.channels.update(channelId, { validation: { ...channel.validation, openWithChannelIntro: input.openWithChannelIntro } })
    }
    const r = this.resolve(channel)
    if (!r) throw new AppError('config', `Channel "${channel.name}" has no script format yet.`, { retryable: false, code: 'FORMAT_MISSING' })
    const cur = this.getOpening(channelId)
    const intro = input.intro.trim()
    const outro = input.outro.trim()
    if (cur.intro === intro && cur.outro === outro) return this.getOpening(channelId)
    const keep = r.version.fixedBlocks.filter((b) => !(b.locked && (b.kind === 'intro' || b.kind === 'outro')))
    const blocks: FixedTextBlock[] = [...keep]
    if (intro) blocks.unshift({ id: newId(), kind: 'intro', text: intro, locked: true, provenance: 'user_confirmed', spoken: true, occurrences: 0 })
    if (outro) blocks.push({ id: newId(), kind: 'outro', text: outro, locked: true, provenance: 'user_confirmed', spoken: true, occurrences: 0 })
    const status = r.version.approvalStatus
    const v = this.s.channels.addVersion(r.template.id, { ...versionToInput(r.version), fixedBlocks: blocks, approvalStatus: status, notes: `${r.version.notes ? r.version.notes + '\n' : ''}Opening/closing set in the Writing tab (${nowIso().slice(0, 10)}).` })
    if (v.approvalStatus !== status) this.s.channels.setVersionStatus(v.id, status)
    this.s.channels.setActiveVersion(channelId, v.id)
    return this.getOpening(channelId)
  }

  // ---- template resolution & gating -----------------------------------------

  /** Resolves the format for a channel: an explicit template (must belong to the channel) or the channel default. */
  resolve(channel: Channel, templateId?: string | null): { template: Template; version: TemplateVersion } | null {
    let template: Template | undefined
    if (templateId) {
      template = this.s.channels.getTemplate(templateId)
      if (!template || template.channelId !== channel.id) template = undefined
    }
    if (!template) template = this.s.channels.defaultTemplate(channel.id)
    if (!template) return null
    const version = this.s.channels.activeVersionOf(template.id)
    return version ? { template, version } : null
  }

  /** Part 6 Stage 2: may this format be used in this mode? */
  gate(channel: Channel, mode: JobMode, templateId?: string | null): GateResult {
    const r = this.resolve(channel, templateId)
    if (!r) {
      return { allowed: false, error: new AppError('config', `Channel "${channel.name}" has no script format yet.`, { action: 'Open Channels → this channel → Formats and import approved reference scripts.', retryable: false, code: 'FORMAT_MISSING' }) }
    }
    const { template, version } = r
    const status = version.approvalStatus
    const label = `${channel.name} › ${template.name}`
    // 1.3.0: an unverified format no longer blocks the channel. It can be used under supervision
    // (Review before voice / Scripts only); scripts then follow the channel's written rules only.
    if (version.placeholder || status === 'not_configured' || status === 'references_imported') {
      if (mode === 'auto') {
        return {
          allowed: false,
          error: new AppError('config', `The format "${label}" is not verified yet — use Review before voice, or import approved reference scripts and approve the format.`, {
            action: 'Switch the mode to Review before voice (or Scripts only). For Fully automatic, import 3–5 approved scripts in Channels → Formats and approve the format.',
            retryable: false,
            code: 'FORMAT_NOT_APPROVED'
          })
        }
      }
      return { allowed: true, warning: `"${label}": format not verified — scripts follow the channel rules only. Review each script before audio.` }
    }
    if (PRODUCTION_STATUSES.includes(status)) return { allowed: true, warning: null }
    if (SUPERVISED_STATUSES.includes(status)) {
      if (mode === 'auto') {
        return {
          allowed: false,
          error: new AppError('config', `The format "${label}" is not approved yet — use Review before voice, or approve it in Channels → Formats.`, {
            action: 'Switch the mode to Review before voice (or Scripts only), or approve the format after checking it.',
            retryable: false,
            code: 'FORMAT_NOT_APPROVED'
          })
        }
      }
      const why = status === 'test_failed' ? 'its last style test failed' : status === 'provisional' ? 'it is built from written rules only and not yet checked against approved reference scripts' : 'it is waiting for your approval'
      return { allowed: true, warning: `"${label}" is not approved (${why}); review every script before audio.` }
    }
    return { allowed: true, warning: null }
  }

  /** Reference scripts sent to the writer as style examples. */
  promptReferences(templateId: string): Array<Pick<ReferenceScript, 'title' | 'text'>> {
    return this.s.channels
      .listReferences(templateId)
      .slice(-PROMPT_REFERENCES)
      .reverse()
      .map((r) => ({ title: r.title, text: r.text.length > PROMPT_REFERENCE_CHARS ? `${r.text.slice(0, PROMPT_REFERENCE_CHARS)}\n[…truncated]` : r.text }))
  }

  // ---- references --------------------------------------------------------------

  private requireTemplate(templateId: string): Template {
    const t = this.s.channels.getTemplate(templateId)
    if (!t) throw new AppError('config', 'Format not found.', { retryable: false, code: 'FORMAT_NOT_FOUND' })
    return t
  }

  private afterReferencesChanged(template: Template): void {
    const v = this.s.channels.activeVersionOf(template.id)
    if (v && (v.approvalStatus === 'not_configured' || v.placeholder) && this.s.channels.countReferences(template.id) > 0) {
      this.s.channels.setVersionStatus(v.id, 'references_imported')
    }
  }

  addReference(input: { templateId: string; title: string; text: string; sourceFormat?: ReferenceFormat; sourceFileName?: string | null }): ReferenceScript {
    const template = this.requireTemplate(input.templateId)
    const text = normalizeReferenceText(input.text)
    if (text.length < 50) throw new AppError('config', 'The reference script is too short (at least 50 characters).', { retryable: false, code: 'REFERENCE_TOO_SHORT' })
    if (text.length > REFERENCE_LIMITS.maxTextChars) throw new AppError('config', 'The reference script is longer than 200,000 characters.', { retryable: false, code: 'REFERENCE_TOO_LONG' })
    if (this.s.channels.countReferences(template.id) >= REFERENCE_LIMITS.maxPerTemplate) {
      throw new AppError('config', `A format can hold at most ${REFERENCE_LIMITS.maxPerTemplate} reference scripts.`, { action: 'Delete an older reference first.', retryable: false, code: 'REFERENCE_LIMIT' })
    }
    const ref = this.s.channels.addReference({
      channelId: template.channelId,
      templateId: template.id,
      title: input.title.trim() || `Reference ${this.s.channels.countReferences(template.id) + 1}`,
      text,
      sourceFormat: input.sourceFormat ?? 'paste',
      sourceFileName: input.sourceFileName ?? null,
      charCount: text.length,
      wordCount: countWords(text)
    })
    this.afterReferencesChanged(template)
    return ref
  }

  async importFiles(templateId: string, paths: string[]): Promise<{ added: ReferenceScript[]; failed: Array<{ path: string; message: string }> }> {
    this.requireTemplate(templateId)
    const added: ReferenceScript[] = []
    const failed: Array<{ path: string; message: string }> = []
    for (const p of paths) {
      try {
        if (!path.isAbsolute(p)) throw new AppError('filesystem', 'Only absolute file paths can be imported.', { retryable: false, code: 'REFERENCE_PATH' })
        const { text, format } = await extractReferenceText(p)
        added.push(this.addReference({ templateId, title: path.basename(p, path.extname(p)), text, sourceFormat: format, sourceFileName: path.basename(p) }))
      } catch (err) {
        failed.push({ path: p, message: toAppError(err).message })
      }
    }
    return { added, failed }
  }

  updateReference(id: string, patch: { title?: string; text?: string }): ReferenceScript {
    const cur = this.s.channels.getReference(id)
    if (!cur) throw new AppError('config', 'Reference script not found.', { retryable: false, code: 'REFERENCE_NOT_FOUND' })
    const next: { title?: string; text?: string; charCount?: number; wordCount?: number } = {}
    if (patch.title !== undefined) next.title = patch.title.trim() || cur.title
    if (patch.text !== undefined) {
      const text = normalizeReferenceText(patch.text)
      if (text.length < 50) throw new AppError('config', 'The reference script is too short (at least 50 characters).', { retryable: false, code: 'REFERENCE_TOO_SHORT' })
      if (text.length > REFERENCE_LIMITS.maxTextChars) throw new AppError('config', 'The reference script is longer than 200,000 characters.', { retryable: false, code: 'REFERENCE_TOO_LONG' })
      Object.assign(next, { text, charCount: text.length, wordCount: countWords(text) })
    }
    return this.s.channels.updateReference(id, next)
  }

  deleteReference(id: string): void {
    this.s.channels.deleteReference(id)
  }

  // ---- analysis ----------------------------------------------------------------

  async analyze(templateId: string, instructions = '', signal?: AbortSignal): Promise<StyleAnalysis> {
    const template = this.requireTemplate(templateId)
    const channel = this.s.channels.get(template.channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const refs = this.s.channels.listReferences(templateId)
    if (!refs.length) throw new AppError('config', 'Import at least one approved reference script first (3–5 recommended).', { retryable: false, code: 'REFERENCES_REQUIRED' })
    const version = this.s.channels.activeVersionOf(templateId)
    const owner = [instructions.trim(), version?.confirmedRules.trim() ?? ''].filter(Boolean).join('\n')
    const settings = this.s.settings.get()
    const model = channel.openaiModel || settings.openai.defaultModel
    const ai = await withRetry(
      () =>
        this.s.providers.openai().analyzeStyle({
          channel,
          contentType: template.contentType,
          references: refs.map((r) => ({ title: r.title, text: r.text.length > 20000 ? r.text.slice(0, 20000) : r.text })),
          instructions: owner,
          model,
          signal
        }),
      { maxRetries: settings.openai.maxRetries, signal }
    )
    this.recordUsage(channel, 'style_analysis', ai.model, ai.usage)
    const caveats = [...ai.caveats]
    if (refs.length === 1) caveats.unshift('Only one reference script was analysed: one example cannot establish which text is fixed, and every finding is at most "inferred". Import 3–5 approved scripts.')
    else if (refs.length < 3) caveats.unshift(`Only ${refs.length} reference scripts were analysed; 3–5 are recommended before strict format preservation.`)
    caveats.push('Fixed text is only proposed. Nothing is locked until you approve it.')
    const analysis: StyleAnalysis = {
      templateId,
      referenceSetVersion: this.s.channels.referenceSetVersion(templateId),
      stats: referenceStats(refs, channel.validation.wordsPerMinute),
      findings: ai.findings.map((f) => (f.provenance === 'user_confirmed' ? { ...f, provenance: 'inferred' } : f)),
      fixedBlocks: detectFixedText(refs),
      suggestedStructure: ai.sections,
      suggestedSystemPrompt: ai.systemPrompt,
      unknowns: ai.unknowns,
      caveats,
      analyzedAt: nowIso()
    }
    this.s.channels.saveAnalysis(analysis)
    if (version && !PRODUCTION_STATUSES.includes(version.approvalStatus)) this.s.channels.setVersionStatus(version.id, 'template_extracted')
    return analysis
  }

  // ---- approval ------------------------------------------------------------------

  /**
   * User action only. Approving makes the version the active one of its template
   * (and the channel default when appropriate). Statuses that only the app sets
   * (test results) cannot be chosen here.
   */
  setApproval(versionId: string, status: TemplateApprovalStatus): TemplateVersion {
    const v = this.s.channels.getVersion(versionId)
    if (!v) throw new AppError('config', 'Template version not found.', { retryable: false, code: 'VERSION_NOT_FOUND' })
    if (status === 'test_passed' || status === 'test_failed') {
      throw new AppError('config', 'Test results are set by running a style test.', { retryable: false, code: 'STATUS_NOT_SETTABLE' })
    }
    if ((status === 'approved' || status === 'awaiting_approval') && v.placeholder) {
      throw new AppError('config', 'A placeholder format cannot be approved. Create a real version from your reference scripts first.', { retryable: false, code: 'PLACEHOLDER_NOT_APPROVABLE' })
    }
    const next = this.s.channels.setVersionStatus(versionId, status)
    if (status === 'approved') this.s.channels.setActiveVersion(v.channelId, versionId)
    return next
  }

  /**
   * Lock/unlock/edit fixed blocks. An approved version is never edited in place
   * (Rule 11): the change becomes a new version awaiting approval.
   */
  setFixedBlocks(versionId: string, blocks: TemplateVersion['fixedBlocks']): TemplateVersion {
    const v = this.s.channels.getVersion(versionId)
    if (!v) throw new AppError('config', 'Template version not found.', { retryable: false, code: 'VERSION_NOT_FOUND' })
    const clean = blocks.filter((b) => b.text.trim()).map((b) => ({ ...b, id: b.id || newId(), text: b.text.trim() }))
    if (PRODUCTION_STATUSES.includes(v.approvalStatus)) {
      return this.s.channels.addVersion(v.templateId, {
        systemPrompt: v.systemPrompt,
        structure: v.structure,
        exampleScript: v.exampleScript,
        notes: `Copy of v${v.version} with changed fixed text.`,
        approvalStatus: 'awaiting_approval',
        fixedBlocks: clean,
        findings: v.findings,
        confirmedRules: v.confirmedRules,
        unverified: v.unverified,
        headingsSpoken: v.headingsSpoken,
        referenceSetVersion: v.referenceSetVersion
      })
    }
    return this.s.channels.setVersionFixedBlocks(versionId, clean)
  }

  // ---- style test ------------------------------------------------------------------

  async runTest(templateId: string, title: string, notes?: string, signal?: AbortSignal): Promise<StyleTestResult> {
    const template = this.requireTemplate(templateId)
    const channel = this.s.channels.get(template.channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const version = this.s.channels.activeVersionOf(templateId)
    if (!version) throw new AppError('config', 'This format has no version yet.', { retryable: false, code: 'FORMAT_MISSING' })
    if (version.placeholder || version.approvalStatus === 'not_configured' || version.approvalStatus === 'references_imported') {
      throw new AppError('config', 'Analyse the reference scripts and create a template version before running a style test.', { retryable: false, code: 'FORMAT_NOT_CONFIGURED' })
    }
    const cleanTitle = title.trim()
    if (!cleanTitle) throw new AppError('config', 'Enter a game or product title for the test.', { retryable: false })
    const settings = this.s.settings.get()
    const openai = this.s.providers.openai()

    let research: ResearchData | null = null
    if (channel.research.enabled && channel.research.mode !== 'manual') {
      const r = await withRetry(() => openai.research({ title: cleanTitle, category: channel.category, settings: channel.research, model: settings.openai.researchModel || settings.openai.defaultModel, manualNotes: notes ?? null, signal }), {
        maxRetries: settings.openai.maxRetries,
        signal
      })
      this.recordUsage(channel, 'style_test_research', r.model, r.usage)
      research = r.data
    }
    const references = this.promptReferences(templateId)
    const model = channel.openaiModel || settings.openai.defaultModel
    const out = await withRetry(
      () =>
        openai.writeScript({
          channel,
          template: version,
          title: cleanTitle,
          research,
          researchSources: [],
          model,
          temperature: settings.openai.temperature,
          maxOutputTokens: settings.openai.maxOutputTokens,
          reasoningEffort: settings.openai.reasoningEffort,
          references,
          signal
        }),
      { maxRetries: settings.openai.maxRetries, signal }
    )
    this.recordUsage(channel, 'style_test_script', out.model, out.usage)
    const report = validateScript(out.text, {
      channel,
      template: version,
      expectedTitle: research?.canonicalTitle || cleanTitle,
      researchConfirmed: false,
      strictness: settings.generation.validationStrictness,
      lengthToleranceChars: settings.generation.lengthToleranceChars
    })
    const checks: ComplianceCheck[] = deterministicCompliance(report, version)
    try {
      const cmp = await withRetry(() => openai.compareStyle({ channel, title: cleanTitle, script: out.text, references, research, model: settings.openai.reviewModel || model, signal }), { maxRetries: 1, signal })
      this.recordUsage(channel, 'style_test_compare', cmp.model, cmp.usage)
      const v = (xs: Array<{ severity: string }>): ComplianceCheck['verdict'] => (xs.some((x) => x.severity === 'error') ? 'fail' : xs.length ? 'warning' : 'pass')
      checks.push({
        key: 'style',
        label: 'Style vs. references',
        verdict: references.length ? v(cmp.styleDeviations) : 'not_applicable',
        details: references.length ? (cmp.styleDeviations.length ? cmp.styleDeviations.map((d) => d.message) : ['No style deviations found.']) : ['No reference scripts to compare against.']
      })
      checks.push({ key: 'claims', label: 'Unsupported claims', verdict: v(cmp.unsupportedClaims), details: cmp.unsupportedClaims.length ? cmp.unsupportedClaims.map((d) => d.message) : ['No unsupported claims found.'] })
    } catch (err) {
      const e = toAppError(err)
      if (e.kind === 'cancelled') throw e
      checks.push({ key: 'style', label: 'Style vs. references', verdict: 'warning', details: [`The comparison could not run: ${e.message}`] })
    }
    const passed = !checks.some((c) => c.verdict === 'fail')
    const result: StyleTestResult = { id: newId(), templateId, templateVersionId: version.id, title: cleanTitle, scriptText: out.text, checks, passed, createdAt: nowIso() }
    this.s.channels.saveStyleTest(result)
    // A test never approves anything; it records the result on the tested version.
    this.s.channels.setVersionStatus(version.id, passed ? (PRODUCTION_STATUSES.includes(version.approvalStatus) ? 'test_passed' : version.approvalStatus) : 'test_failed')
    return result
  }

  private recordUsage(channel: Channel, kind: string, model: string, usage: { inputTokens: number; outputTokens: number; reported?: Record<string, unknown> }): void {
    this.s.usage.record({
      provider: 'openai',
      kind,
      model,
      jobId: null,
      channelId: channel.id,
      projectId: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      characters: 0,
      estimatedCost: openaiCost(this.s.settings.get().spending.pricing, model, usage.inputTokens, usage.outputTokens),
      reported: usage.reported ?? null
    })
  }
}

