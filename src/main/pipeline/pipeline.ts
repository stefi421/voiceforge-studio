import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Channel, Job, ResearchData, ResearchResult, ResearchSource, Script, TemplateVersion, ValidationIssue, ValidationReport } from '@shared/types'
import type { Services } from '../services/container'
import { moveInto, ProjectService } from '../services/projects'
import { atomicWriteFile, describeFsError, sha256Buffer } from '../services/files'
import type { ScopedLogger } from '../services/logger'
import { AppError, toAppError } from '../util/errors'
import { Semaphore, withRetry } from '../util/retry'
import { countWords, estimateDurationSec, normalizeTitle, nowIso } from '../util/common'
import { elevenCost, openaiCost } from './cost'
import { chunksCoverText, splitIntoChunks } from './chunker'
import { concatMp3, isMp3Format, parseMp3, pcmDuration } from './mp3'
import { applyPronunciation, describeIssuesForRewrite, onlyLengthErrors, stripSectionHeadings, targetChars, validateScript } from './validator'
import { KNOWN_MODEL_LIMITS, voiceSettingsForModel } from '../providers/elevenlabs'
import { StyleService } from '../services/style'
import { buildNarrationText, normalizeLockedText } from './style'

/** Research is reused across channels (same category) for 30 days — facts don't change per channel. */
const RESEARCH_CACHE_MS = 30 * 24 * 60 * 60 * 1000
const LEASE_MS = 120_000

export interface StageContext {
  signal: AbortSignal
  owner: string
  heartbeat: () => void
}

export type StageOutcome = 'continue' | 'wait' | 'done'

/**
 * Executes one job stage at a time and persists every intermediate result
 * before moving on. The queue engine calls `step()` repeatedly until the
 * outcome is `done` or `wait` (user input required).
 */
export class Pipeline {
  private projectsSvc: ProjectService
  readonly style: StyleService
  /** Project/folder helpers shared with the queue engine. */
  get projects(): ProjectService {
    return this.projectsSvc
  }
  readonly openaiSem: Semaphore
  readonly elevenSem: Semaphore

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    this.projectsSvc = new ProjectService(s)
    this.style = new StyleService(s)
    const st = s.settings.get()
    this.openaiSem = new Semaphore(st.openai.concurrency)
    this.elevenSem = new Semaphore(st.elevenlabs.concurrency)
    s.settings.onChange((next) => {
      this.openaiSem.setLimit(next.openai.concurrency)
      this.elevenSem.setLimit(next.elevenlabs.concurrency)
    })
  }

  // ---------------------------------------------------------------------------

  async step(jobId: string, ctx: StageContext): Promise<StageOutcome> {
    const job = this.s.jobs.get(jobId)
    if (!job) return 'done'
    const channel = this.s.channels.get(job.channelId)
    if (!channel) throw new AppError('config', 'The channel for this job no longer exists.', { retryable: false })
    switch (job.stage) {
      case 'research':
        return this.runResearch(job, channel, ctx)
      case 'script':
        return this.runScript(job, channel, ctx)
      case 'approval':
        this.setStatus(job.id, 'awaiting_approval')
        return 'wait'
      case 'audio':
        return this.runAudio(job, channel, ctx)
      case 'save':
        return this.runSave(job, channel)
      case 'done':
        return 'done'
      default:
        throw new AppError('unknown', `Unknown stage ${String(job.stage)}`)
    }
  }

  private setStatus(jobId: string, status: Job['status'], extra: Parameters<Services['jobs']['setStatus']>[2] = {}): Job {
    const job = this.s.jobs.setStatus(jobId, status, extra)
    const view = this.s.jobs.getView(jobId)
    if (view) this.s.events.jobChanged(view)
    return job
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AppError('cancelled', 'Cancelled.', { retryable: false })
  }

  // ---------------------------------------------------------------------------
  // Spending safeguards
  // ---------------------------------------------------------------------------

  checkSpending(): void {
    const st = this.s.settings.get().spending
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(startOfDay)
    startOfMonth.setDate(1)
    if (st.dailyLimitUsd !== null && st.dailyLimitUsd > 0) {
      const today = this.s.usage.spendSince(startOfDay.toISOString())
      if (today >= st.dailyLimitUsd) {
        throw new AppError('spending_limit', `The daily spending limit ($${st.dailyLimitUsd.toFixed(2)}) has been reached (estimated spend today: $${today.toFixed(2)}).`, { retryable: false })
      }
    }
    if (st.monthlyLimitUsd !== null && st.monthlyLimitUsd > 0) {
      const month = this.s.usage.spendSince(startOfMonth.toISOString())
      if (month >= st.monthlyLimitUsd) {
        throw new AppError('spending_limit', `The monthly spending limit ($${st.monthlyLimitUsd.toFixed(2)}) has been reached (estimated spend this month: $${month.toFixed(2)}).`, { retryable: false })
      }
    }
  }

  private recordOpenAIUsage(job: Job, kind: string, model: string, usage: { inputTokens: number; outputTokens: number; reported?: Record<string, unknown> }): void {
    const pricing = this.s.settings.get().spending.pricing
    this.s.usage.record({
      provider: 'openai',
      kind,
      model,
      jobId: job.id,
      channelId: job.channelId,
      projectId: job.projectId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      characters: 0,
      estimatedCost: openaiCost(pricing, model, usage.inputTokens, usage.outputTokens),
      reported: usage.reported ?? null
    })
  }

  private recordElevenUsage(job: Job, model: string, characters: number, reported: Record<string, unknown> | null): void {
    const pricing = this.s.settings.get().spending.pricing
    this.s.usage.record({
      provider: 'elevenlabs',
      kind: 'tts',
      model,
      jobId: job.id,
      channelId: job.channelId,
      projectId: job.projectId,
      inputTokens: 0,
      outputTokens: 0,
      characters,
      estimatedCost: elevenCost(pricing, characters),
      reported
    })
  }

  // ---------------------------------------------------------------------------
  // Research
  // ---------------------------------------------------------------------------

  private async runResearch(job: Job, channel: Channel, ctx: StageContext): Promise<StageOutcome> {
    if (job.researchId && this.s.research.get(job.researchId)) {
      this.s.jobs.update(job.id, { stage: 'script' })
      return 'continue'
    }
    const research = channel.research
    if (!research.enabled) {
      this.s.jobs.update(job.id, { stage: 'script' })
      return 'continue'
    }
    if (research.mode === 'manual') {
      if (!job.manualResearchNotes?.trim()) {
        const r = this.s.research.create({
          jobId: job.id,
          projectId: job.projectId,
          status: 'insufficient',
          data: emptyResearch(job.title, channel.category, 'This channel uses manual research. Paste the facts for this title.'),
          sources: [],
          model: null,
          mode: 'manual'
        })
        this.s.jobs.update(job.id, { researchId: r.id })
        this.setStatus(job.id, 'research_review_required', { event: 'research_manual_required', detail: 'Manual research notes required' })
        return 'wait'
      }
      const r = this.s.research.create({
        jobId: job.id,
        projectId: job.projectId,
        status: 'manual',
        data: { ...emptyResearch(job.title, channel.category, ''), summary: job.manualResearchNotes.trim(), confirmedFacts: [], confidence: 1 },
        sources: [],
        model: null,
        mode: 'manual'
      })
      this.s.jobs.update(job.id, { researchId: r.id, stage: 'script' })
      return 'continue'
    }

    // Cache: identical title + category + mode within 30 days, unless the user added notes.
    const cacheKey = `${channel.category}:${research.mode}:${normalizeTitle(job.title)}`
    if (!job.manualResearchNotes?.trim()) {
      const cached = this.s.research.cacheGet(cacheKey, RESEARCH_CACHE_MS)
      if (cached && cached.status === 'confirmed') {
        const copy = this.s.research.create({ jobId: job.id, projectId: job.projectId, status: 'confirmed', data: cached.data, sources: cached.sources, model: cached.model, mode: cached.mode })
        this.s.jobs.update(job.id, { researchId: copy.id, stage: 'script' })
        this.s.jobs.addEvent(job.id, 'research_cached', null, null, `Reused research from ${cached.createdAt}`)
        this.log.info('Research cache hit', { jobId: job.id, title: job.title })
        return 'continue'
      }
    }

    this.checkSpending()
    this.setStatus(job.id, 'researching')
    this.s.jobs.update(job.id, { researchAttempts: job.researchAttempts + 1 })
    const model = this.s.settings.get().openai.researchModel || channel.openaiModel || this.s.settings.get().openai.defaultModel
    const release = await this.openaiSem.acquire(ctx.signal)
    let result
    try {
      result = await withRetry(() => this.s.providers.openai().research({ title: job.title, category: channel.category, settings: research, model, manualNotes: job.manualResearchNotes, signal: ctx.signal }), {
        maxRetries: this.s.settings.get().openai.maxRetries,
        signal: ctx.signal,
        onRetry: (attempt, delay, err) => {
          ctx.heartbeat()
          this.s.jobs.addEvent(job.id, 'retry', null, null, `Research retry ${attempt} in ${Math.round(delay / 1000)}s: ${err.message}`)
        }
      })
    } finally {
      release()
    }
    this.recordOpenAIUsage(job, 'research', result.model, result.usage)
    const data = result.data
    const candidates = data.ambiguityCandidates ?? []
    // Don't stop for a choice when the typed title IS the top candidate and research is confident enough.
    const typedMatchesTop = candidates.length > 0 && normalizeTitle(candidates[0]!.title) === normalizeTitle(job.title)
    const exactAndConfident = typedMatchesTop && data.confidence >= research.minConfidence
    const ambiguous = research.askOnAmbiguity && candidates.length > 1 && data.confidence < 0.85 && !exactAndConfident
    const insufficient = !!data.insufficientReason?.trim() || data.confidence < research.minConfidence
    const status: ResearchResult['status'] = ambiguous ? 'ambiguous' : insufficient ? 'insufficient' : 'confirmed'
    const row = this.s.research.create({ jobId: job.id, projectId: job.projectId, status, data, sources: result.sources, model: result.model, mode: research.mode })
    this.s.jobs.update(job.id, { researchId: row.id })
    if (status === 'confirmed') {
      this.s.research.cacheSet(cacheKey, row.id)
      this.s.jobs.update(job.id, { stage: 'script' })
      // The official title is kept alongside the user's title; it never renames the project/folder.
      const canonical = data.canonicalTitle?.trim()
      if (canonical && normalizeTitle(canonical) !== normalizeTitle(job.title)) this.s.projects.update(job.projectId, { canonicalTitle: canonical })
      return 'continue'
    }
    const detail = ambiguous ? `Ambiguous title: ${candidates.map((c) => c.title).join(' / ')}` : data.insufficientReason || `Low confidence (${data.confidence.toFixed(2)} < ${research.minConfidence})`
    this.setStatus(job.id, 'research_review_required', { event: ambiguous ? 'research_ambiguous' : 'research_insufficient', detail })
    this.s.events.notify('warning', ambiguous ? 'Which game did you mean?' : 'Not enough reliable information', `${job.title}: ${detail}`)
    return 'wait'
  }

  // ---------------------------------------------------------------------------
  // Script
  // ---------------------------------------------------------------------------

  private loadTemplate(channel: Channel, job?: Job): { version: TemplateVersion; templateId: string; contentType: string } {
    const r = this.style.resolve(channel, job?.overrides?.templateId)
    if (!r) {
      throw new AppError('config', `Channel "${channel.name}" has no active script format.`, {
        action: 'Open Channels → this channel → Formats, import approved reference scripts and approve a template.',
        retryable: false,
        code: 'FORMAT_MISSING'
      })
    }
    const tv = r.version
    if (job?.mode === 'auto' && !['approved', 'test_passed'].includes(tv.approvalStatus)) {
      throw new AppError('config', `The format "${channel.name} › ${r.template.name}" is not approved for Fully automatic mode.`, {
        action: 'Retry in Review before voice mode, or approve the format in Channels → Formats.',
        retryable: false,
        code: 'FORMAT_NOT_APPROVED'
      })
    }
    return { version: tv, templateId: r.template.id, contentType: r.template.contentType }
  }

  private async runScript(job: Job, channel: Channel, ctx: StageContext): Promise<StageOutcome> {
    // Audio-only regeneration: use the requested script version directly.
    if (job.overrides?.useScriptId) {
      const existing = this.s.scripts.get(job.overrides.useScriptId)
      if (!existing) throw new AppError('config', 'The requested script version no longer exists.', { retryable: false })
      this.s.jobs.update(job.id, { scriptId: existing.id, stage: job.mode === 'scripts_only' ? 'save' : 'audio' })
      return 'continue'
    }
    if (job.scriptId) {
      const existing = this.s.scripts.get(job.scriptId)
      if (existing && (existing.status === 'validated' || existing.status === 'approved')) {
        this.s.jobs.update(job.id, { stage: this.nextStageAfterScript(job) })
        return 'continue'
      }
    }
    const loaded = this.loadTemplate(channel, job)
    const template = loaded.version
    const references = this.style.promptReferences(loaded.templateId)
    const provenance = { templateId: loaded.templateId, contentType: loaded.contentType, referenceSetVersion: this.s.channels.referenceSetVersion(loaded.templateId), researchId: job.researchId ?? null }
    const research = job.researchId ? this.s.research.get(job.researchId) : undefined
    const researchData = research && research.status !== 'insufficient' ? research.data : null
    const researchSources: ResearchSource[] = research?.sources ?? []
    const settings = this.s.settings.get()
    const model = channel.openaiModel || settings.openai.defaultModel
    const maxAttempts = Math.max(1, (channel.validation.maxRewriteAttempts ?? settings.generation.maxRewriteAttempts) + 1)
    const strictness = settings.generation.validationStrictness
    const feedback = job.overrides?.scriptFeedback

    this.checkSpending()
    this.setStatus(job.id, 'writing_script')
    this.s.jobs.update(job.id, { scriptAttempts: job.scriptAttempts + 1 })

    const tolerance = settings.generation.lengthToleranceChars
    // Speed: cap output tokens to what the script needs (≈3.5 chars/token, ×2 headroom, + a small
    // reasoning budget). If the model still runs out, the call is retried once with the full limit.
    const tokenCap = Math.min(settings.openai.maxOutputTokens, Math.max(2500, Math.ceil(((channel.maxChars || 5000) * 2) / 3.5) + 1500))
    let maxOutputTokens = tokenCap
    type WriterOpts = { previousScript?: string; issues?: string; feedback?: string; tighten?: { cut: number; target: number; max: number } }
    const writeOnce = (opts: WriterOpts, tokens: number) =>
      this.s.providers.openai().writeScript({
        channel,
        template,
        title: job.title,
        research: researchData,
        researchSources,
        model,
        temperature: settings.openai.temperature,
        maxOutputTokens: tokens,
        reasoningEffort: settings.openai.reasoningEffort,
        previousScript: opts.previousScript,
        issues: opts.issues,
        feedback: opts.feedback,
        tighten: opts.tighten,
        references,
        // Same stable prefix for every title of this format → provider-side prompt caching.
        promptCacheKey: `vf:${template.id}`,
        signal: ctx.signal
      })
    const callWriter = async (opts: WriterOpts, kind: string) => {
      const release = await this.openaiSem.acquire(ctx.signal)
      let out
      try {
        out = await withRetry(
          async () => {
            try {
              return await writeOnce(opts, maxOutputTokens)
            } catch (err) {
              const e = toAppError(err)
              if (e.code === 'MAX_OUTPUT_TOKENS' && maxOutputTokens < settings.openai.maxOutputTokens) {
                maxOutputTokens = settings.openai.maxOutputTokens
                return await writeOnce(opts, maxOutputTokens)
              }
              throw e
            }
          },
          {
            maxRetries: settings.openai.maxRetries,
            signal: ctx.signal,
            onRetry: (n, delay, err) => {
              ctx.heartbeat()
              this.s.jobs.addEvent(job.id, 'retry', null, null, `Script retry ${n} in ${Math.round(delay / 1000)}s: ${err.message}`)
            }
          }
        )
      } finally {
        release()
      }
      ctx.heartbeat()
      this.recordOpenAIUsage(job, kind, out.model, out.usage)
      // Presentation-only fixes (label case, quote/dash style, a locked intro/outro merged into a
      // neighbouring paragraph) so they don't cost a rewrite. Reworded text is left for the validator.
      return { ...out, text: normalizeLockedText(out.text, template) }
    }

    /** Deterministic checks + optional AI review. `finalVerdict` applies the length tolerance. */
    const evaluate = async (text: string, finalVerdict: boolean): Promise<ValidationReport> => {
      this.setStatus(job.id, 'validating_script')
      const report = validateScript(text, {
        channel,
        template,
        expectedTitle: researchData?.canonicalTitle || job.title,
        researchConfirmed: false,
        strictness,
        lengthToleranceChars: tolerance,
        strictLength: !finalVerdict
      })
      let aiIssues: ValidationIssue[] = []
      // The extra fact-check request is opt-in (Settings → Generation) since 1.3.0: it roughly doubles script time.
      if (report.ok && settings.generation.aiReviewPass && channel.validation.aiReviewPass && strictness !== 'relaxed') {
        try {
          const r2 = await this.openaiSem.acquire(ctx.signal)
          let review
          try {
            review = await withRetry(() => this.s.providers.openai().reviewScript({ channel, title: job.title, script: text, research: researchData, model: settings.openai.reviewModel || model, signal: ctx.signal }), {
              maxRetries: 1,
              signal: ctx.signal
            })
          } finally {
            r2()
          }
          this.recordOpenAIUsage(job, 'review', review.model, review.usage)
          aiIssues = review.issues.map((i) => (strictness === 'standard' && i.severity === 'error' ? i : { ...i, severity: strictness === 'strict' ? i.severity : 'warning' }))
        } catch (err) {
          const e = toAppError(err)
          if (e.kind === 'cancelled') throw e
          this.log.warn('AI review pass failed; continuing with deterministic validation only', { jobId: job.id, error: e.message })
          this.s.jobs.addEvent(job.id, 'review_skipped', null, null, e.message)
        }
      }
      return { ...report, issues: [...report.issues, ...aiIssues], ok: report.ok && aiIssues.every((i) => i.severity !== 'error') }
    }

    const finish = async (text: string, report: ValidationReport, source: Script['source'], usedModel: string): Promise<StageOutcome> => {
      const script = await this.persistScript(job, channel, template, text, report, source, usedModel, provenance)
      this.s.jobs.update(job.id, { scriptId: script.id })
      const warnings = report.issues.filter((i) => i.severity === 'warning')
      if (warnings.length) this.s.jobs.addEvent(job.id, 'validation_warnings', null, null, warnings.map((w) => w.message).join(' | '))
      const next = this.nextStageAfterScript(job)
      if (next === 'approval') {
        this.s.jobs.update(job.id, { stage: 'approval' })
        this.setStatus(job.id, 'awaiting_approval', { event: 'script_ready', detail: `Script v${script.version} ready for approval` })
        return 'wait'
      }
      this.s.jobs.update(job.id, { stage: next })
      this.setStatus(job.id, 'script_ready', { event: 'script_validated', detail: `Script v${script.version} validated` })
      return 'continue'
    }

    let previous: string | undefined
    let issuesText: string | undefined
    let lastReport: ValidationReport | null = null
    let lastText = ''
    let lastModel = model
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted(ctx.signal)
      if (attempt > 1) this.setStatus(job.id, 'writing_script', { event: 'rewrite', detail: `Rewrite attempt ${attempt - 1}: ${issuesText?.split('\n')[0] ?? ''}`.slice(0, 300) })
      const out = await callWriter({ previousScript: previous, issues: issuesText, feedback: attempt === 1 ? feedback : undefined }, attempt === 1 ? 'script' : 'script_rewrite')
      lastText = out.text
      lastModel = out.model
      // Strict length inside the loop so the model keeps converging; the tolerance only decides the final verdict.
      const strictReport = await evaluate(out.text, false)
      if (strictReport.ok) return finish(out.text, strictReport, attempt === 1 ? 'ai' : 'rewrite', out.model)
      lastReport = strictReport
      const failedScript = await this.persistScript(job, channel, template, out.text, strictReport, attempt === 1 ? 'ai' : 'rewrite', out.model, provenance)
      this.s.jobs.update(job.id, { scriptId: failedScript.id })
      previous = out.text
      issuesText = describeIssuesForRewrite(strictReport, channel)
      this.s.jobs.addEvent(job.id, 'validation_failed', null, null, issuesText)
    }

    // Last resort for a draft that is good except for being too long: one targeted "tighten" pass,
    // judged with the length tolerance (relaxed/standard) so a few characters over become a warning.
    if (lastReport && previous && onlyLengthErrors(lastReport) && lastReport.issues.filter((i) => i.severity === 'error').every((i) => i.code === 'too_long') && channel.maxChars > 0) {
      this.throwIfAborted(ctx.signal)
      const cut = lastReport.charCount - channel.maxChars
      this.setStatus(job.id, 'writing_script', { event: 'tighten', detail: `Tightening: cutting ${cut} characters to fit ${channel.maxChars}` })
      const out = await callWriter({ previousScript: previous, tighten: { cut, target: targetChars(channel), max: channel.maxChars } }, 'script_tighten')
      lastText = out.text
      lastModel = out.model
      const finalReport = await evaluate(out.text, true)
      if (finalReport.ok) return finish(out.text, finalReport, 'rewrite', out.model)
      lastReport = finalReport
      const failedScript = await this.persistScript(job, channel, template, out.text, finalReport, 'rewrite', out.model, provenance)
      this.s.jobs.update(job.id, { scriptId: failedScript.id })
    }
    void lastText
    void lastModel
    const summary = lastReport ? describeIssuesForRewrite(lastReport, channel) : 'Validation failed.'
    throw new AppError('validation', `The script failed validation after ${maxAttempts} attempt(s):\n${summary}`, {
      action: 'Open the script (Review script), edit it or regenerate with feedback, or approve it anyway to continue.',
      retryable: false
    })
  }

  private nextStageAfterScript(job: Job): Job['stage'] {
    if (job.mode === 'scripts_only') return 'save'
    if (job.mode === 'review_before_voice') return 'approval'
    return 'audio'
  }

  private async persistScript(
    job: Job,
    channel: Channel,
    template: TemplateVersion,
    rawText: string,
    report: ValidationReport,
    source: Script['source'],
    model: string | null,
    provenance: { templateId: string; contentType: string; referenceSetVersion: number; researchId: string | null }
  ): Promise<Script> {
    const text = rawText.replace(/\r\n/g, '\n').trim()
    const project = this.s.projects.get(job.projectId)
    if (!project) throw new AppError('config', 'Project missing for job.', { retryable: false })
    // Drafts live in app data; only the finished script is published to the output folder (runSave).
    const dir = this.projectsSvc.workDir(project)
    const script = this.s.scripts.create({
      projectId: job.projectId,
      jobId: job.id,
      templateVersionId: template.id,
      templateVersionNumber: template.version,
      text,
      charCount: report.charCount,
      wordCount: report.wordCount,
      estimatedDurationSec: report.estimatedDurationSec,
      status: report.ok ? 'validated' : 'invalid',
      source,
      model,
      validation: report,
      filePath: null,
      narrationText: buildNarrationText(text, template, channel),
      ...provenance
    })
    const file = path.join(dir, this.projectsSvc.scriptFileName(script.version))
    try {
      await atomicWriteFile(file, text + '\n')
    } catch (err) {
      const d = describeFsError(err, 'saving the script')
      throw new AppError('filesystem', d.message, { action: d.action, retryable: false })
    }
    this.s.scripts.update(script.id, { filePath: file })
    return this.s.scripts.get(script.id)!
  }

  /** Called from a user action: saves a manual edit as a new validated/approved version. */
  async saveManualScript(projectId: string, rawText: string, baseScriptId?: string): Promise<Script> {
    const text = rawText.replace(/\r\n/g, '\n').trim()
    const project = this.s.projects.get(projectId)
    if (!project) throw new AppError('config', 'Project not found.', { retryable: false })
    const channel = this.s.channels.get(project.channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const base = baseScriptId ? this.s.scripts.get(baseScriptId) : this.s.scripts.latestForProject(projectId)
    const template = base?.templateVersionId ? this.s.channels.getVersion(base.templateVersionId) ?? null : this.style.resolve(channel)?.version ?? null
    const gen = this.s.settings.get().generation
    const report = validateScript(text, { channel, template, expectedTitle: project.title, researchConfirmed: true, strictness: gen.validationStrictness, lengthToleranceChars: gen.lengthToleranceChars })
    const dir = this.projectsSvc.workDir(project)
    const script = this.s.scripts.create({
      projectId,
      jobId: base?.jobId ?? null,
      templateVersionId: template?.id ?? null,
      templateVersionNumber: template?.version ?? null,
      text,
      charCount: report.charCount,
      wordCount: report.wordCount,
      estimatedDurationSec: report.estimatedDurationSec,
      status: report.ok ? 'validated' : 'invalid',
      source: 'manual',
      model: null,
      validation: report,
      filePath: null,
      narrationText: buildNarrationText(text, template, channel),
      templateId: base?.templateId ?? template?.templateId ?? null,
      contentType: base?.contentType ?? (template ? this.s.channels.getTemplate(template.templateId)?.contentType ?? null : null),
      referenceSetVersion: base?.referenceSetVersion ?? null,
      researchId: base?.researchId ?? null
    })
    const file = path.join(dir, this.projectsSvc.scriptFileName(script.version))
    await atomicWriteFile(file, text + '\n')
    return this.s.scripts.update(script.id, { filePath: file })
  }

  revalidate(scriptId: string): ValidationReport {
    const script = this.s.scripts.get(scriptId)
    if (!script) throw new AppError('config', 'Script not found.', { retryable: false })
    const project = this.s.projects.get(script.projectId)!
    const channel = this.s.channels.get(project.channelId)!
    const template = script.templateVersionId ? this.s.channels.getVersion(script.templateVersionId) ?? null : null
    const gen = this.s.settings.get().generation
    const report = validateScript(script.text, { channel, template, expectedTitle: project.title, researchConfirmed: true, strictness: gen.validationStrictness, lengthToleranceChars: gen.lengthToleranceChars })
    // A force-approved script keeps its approval even when the rules still flag it.
    const status = report.ok ? (script.status === 'approved' ? 'approved' : 'validated') : script.status === 'approved' && script.approvedWithIssues ? 'approved' : 'invalid'
    this.s.scripts.update(scriptId, { validation: report, status })
    return report
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  private async runAudio(job: Job, channel: Channel, ctx: StageContext): Promise<StageOutcome> {
    if (job.mode === 'scripts_only') {
      this.s.jobs.update(job.id, { stage: 'save' })
      return 'continue'
    }
    // Recovery: an audio row that already completed for this job means the request succeeded before a crash.
    if (job.audioId) {
      const existing = this.s.audio.get(job.audioId)
      if (existing?.status === 'ready' && fs.existsSync(existing.filePath)) {
        this.s.jobs.update(job.id, { stage: 'save' })
        return 'continue'
      }
      if (existing && existing.status !== 'ready') {
        const adopted = await this.tryAdoptCompleteFile(existing.filePath, existing.outputFormat)
        if (adopted) {
          this.s.audio.update(existing.id, { status: 'ready', bytes: adopted.bytes, durationSec: adopted.durationSec, sha256: adopted.sha256 })
          this.s.jobs.addEvent(job.id, 'audio_recovered', null, null, 'Found a complete audio file written before the interruption; reusing it.')
          this.s.jobs.update(job.id, { stage: 'save' })
          return 'continue'
        }
        this.s.audio.update(existing.id, { status: 'failed' })
      }
    }
    const scriptId = job.scriptId
    const script = scriptId ? this.s.scripts.get(scriptId) : undefined
    if (!script) throw new AppError('config', 'No script is attached to this job.', { action: 'Regenerate the script first.', retryable: false })
    if (script.status === 'invalid' || script.status === 'rejected') {
      throw new AppError('validation', 'The attached script did not pass validation, so no audio was generated.', { action: 'Fix and approve the script, then retry.', retryable: false })
    }
    const voiceId = job.overrides?.voiceId || channel.elevenVoiceId
    const voiceName = job.overrides?.voiceName || channel.elevenVoiceName || voiceId || ''
    const modelId = job.overrides?.modelId || channel.elevenModelId
    const settings = this.s.settings.get()
    const outputFormat = channel.outputFormat || settings.elevenlabs.defaultOutputFormat
    const baseVoiceSettings = job.overrides?.voiceSettings ?? channel.elevenVoiceSettings
    if (!voiceId) {
      throw new AppError('config', `Channel "${channel.name}" has no ElevenLabs voice selected.`, { action: 'Open the channel profile → Voice tab and pick a voice.', retryable: false })
    }
    this.checkSpending()
    this.setStatus(job.id, 'generating_audio')
    this.s.jobs.update(job.id, { audioAttempts: job.audioAttempts + 1 })

    // Narration text
    const template = script.templateVersionId ? this.s.channels.getVersion(script.templateVersionId) : undefined
    // Clean narration (headings / non-spoken fixed text removed) was computed when the script was saved.
    let narration = script.narrationText && script.narrationText !== script.text ? script.narrationText : buildNarrationText(script.text, template ?? null, channel)
    if (!narration.trim()) narration = stripSectionHeadings(script.text, template?.structure ?? [])
    narration = applyPronunciation(narration, channel.pronunciationRules)

    // Model limits (live list cached, else known table)
    const liveModels = this.s.cache.get<Array<{ modelId: string; maxCharacters: number | null; canUseStyle: boolean; canUseSpeakerBoost: boolean }>>('eleven_models', 24 * 60 * 60 * 1000) ?? []
    const live = liveModels.find((m) => m.modelId === modelId) ?? null
    const limit = settings.elevenlabs.maxCharsPerRequest > 0 ? settings.elevenlabs.maxCharsPerRequest : live?.maxCharacters ?? KNOWN_MODEL_LIMITS[modelId]?.maxChars ?? 5000
    const safeLimit = Math.max(500, Math.floor(limit * 0.95))
    const chunks = splitIntoChunks(narration, safeLimit)
    if (!chunks.length) throw new AppError('validation', 'The narration text is empty after processing.', { retryable: false })
    if (!chunksCoverText(narration, chunks)) throw new AppError('unknown', 'Internal error: chunking changed the narration text.', { retryable: false })
    const voiceSettings = voiceSettingsForModel(modelId, baseVoiceSettings, live ? { modelId, name: '', description: '', canDoTextToSpeech: true, canUseStyle: live.canUseStyle, canUseSpeakerBoost: live.canUseSpeakerBoost, maxCharacters: live.maxCharacters, languages: [] } : null)

    const project = this.s.projects.get(job.projectId)!
    // Audio is generated in app data and moved into the output folder when the job completes.
    const dir = this.projectsSvc.workDir(project)
    const version = this.s.audio.nextVersion(job.projectId)
    let finalPath = path.join(dir, this.projectsSvc.audioFileName(version, outputFormat))
    if (fs.existsSync(finalPath)) finalPath = path.join(dir, `Voice_v${version}_${Date.now()}.${path.extname(finalPath).slice(1)}`)
    const audioRow = this.s.audio.create({
      projectId: job.projectId,
      scriptId: script.id,
      jobId: job.id,
      filePath: finalPath,
      voiceId,
      voiceName,
      modelId,
      voiceSettings: baseVoiceSettings,
      outputFormat,
      bytes: 0,
      durationSec: null,
      sha256: null,
      characters: narration.length,
      chunkCount: chunks.length,
      status: 'generating'
    })
    this.s.jobs.update(job.id, { audioId: audioRow.id })
    this.log.info('Generating audio', { jobId: job.id, chunks: chunks.length, chars: narration.length, model: modelId })

    const buffers: Buffer[] = []
    // Part files only matter for multi-chunk scripts (resume after a crash mid-way); a single
    // request is written once, directly as the final file.
    const multi = chunks.length > 1
    let singleInfo: ReturnType<typeof parseMp3> | null = null
    for (const chunk of chunks) {
      this.throwIfAborted(ctx.signal)
      const partPath = `${finalPath}.chunk${chunk.index}.part`
      // Recovery within a job: reuse a chunk that was fully written before an interruption.
      if (multi && fs.existsSync(partPath)) {
        const buf = await fsp.readFile(partPath)
        if (buf.length > 0 && (!isMp3Format(outputFormat) || parseMp3(buf).valid)) {
          buffers.push(buf)
          continue
        }
      }
      const release = await this.elevenSem.acquire(ctx.signal)
      let res
      try {
        res = await withRetry(
          () =>
            this.s.providers.eleven().synthesize({
              text: chunk.text,
              voiceId,
              modelId,
              outputFormat,
              voiceSettings,
              previousText: chunk.previousText || undefined,
              nextText: chunk.nextText || undefined,
              signal: ctx.signal
            }),
          {
            maxRetries: settings.elevenlabs.maxRetries,
            signal: ctx.signal,
            onRetry: (n, delay, err) => {
              ctx.heartbeat()
              this.s.jobs.addEvent(job.id, 'retry', null, null, `Audio chunk ${chunk.index + 1}/${chunks.length} retry ${n} in ${Math.round(delay / 1000)}s: ${err.message}`)
            }
          }
        )
      } finally {
        release()
      }
      ctx.heartbeat()
      this.recordElevenUsage(job, modelId, chunk.text.length, res.requestId ? { requestId: res.requestId, chunk: chunk.index } : null)
      if (!res.audio.length) throw new AppError('provider_down', 'ElevenLabs returned an empty audio response.', { retryable: true })
      if (isMp3Format(outputFormat)) {
        const info = parseMp3(res.audio)
        if (!info.valid) throw new AppError('provider_down', 'ElevenLabs returned data that is not a valid MP3 stream.', { details: `frames=${info.frames}`, retryable: true })
        if (!multi) singleInfo = info
      }
      if (multi) await atomicWriteFile(partPath, res.audio)
      buffers.push(res.audio)
    }

    const combined = multi ? (isMp3Format(outputFormat) ? concatMp3(buffers) : Buffer.concat(buffers)) : buffers[0]!
    let durationSec: number | null | undefined
    if (isMp3Format(outputFormat)) {
      const info = singleInfo ?? parseMp3(combined)
      if (!info.valid) throw new AppError('unknown', 'The combined MP3 failed verification.', { retryable: true })
      durationSec = info.durationSec
      const expectedMin = narration.length / 25 // ~25 chars/sec is a very fast speaking rate; anything shorter means missing speech
      if (info.durationSec < expectedMin * 0.5) {
        throw new AppError('provider_down', `The generated audio is suspiciously short (${info.durationSec.toFixed(1)}s for ${narration.length} characters).`, { retryable: true })
      }
    } else {
      durationSec = pcmDuration(combined.length, outputFormat)
    }
    try {
      await atomicWriteFile(finalPath, combined)
    } catch (err) {
      const d = describeFsError(err, 'saving the voiceover')
      throw new AppError('filesystem', d.message, { action: d.action, retryable: false })
    }
    for (const chunk of chunks) await fsp.unlink(`${finalPath}.chunk${chunk.index}.part`).catch(() => undefined)
    const sha = sha256Buffer(combined)
    this.s.audio.update(audioRow.id, { status: 'ready', bytes: combined.length, durationSec: durationSec ?? null, sha256: sha })
    this.s.jobs.update(job.id, { stage: 'save' })
    this.s.jobs.addEvent(job.id, 'audio_ready', null, null, `${path.basename(finalPath)} (${(combined.length / 1024).toFixed(0)} KB, ${durationSec ? durationSec.toFixed(1) + 's' : 'duration n/a'})`)
    return 'continue'
  }

  private async tryAdoptCompleteFile(filePath: string, outputFormat: string): Promise<{ bytes: number; durationSec: number | null; sha256: string } | null> {
    try {
      if (!fs.existsSync(filePath)) return null
      const buf = await fsp.readFile(filePath)
      if (!buf.length) return null
      if (isMp3Format(outputFormat)) {
        const info = parseMp3(buf)
        if (!info.valid) return null
        return { bytes: buf.length, durationSec: info.durationSec, sha256: sha256Buffer(buf) }
      }
      return { bytes: buf.length, durationSec: pcmDuration(buf.length, outputFormat), sha256: sha256Buffer(buf) }
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  private async runSave(job: Job, channel: Channel): Promise<StageOutcome> {
    this.setStatus(job.id, 'saving_files')
    const project = this.s.projects.get(job.projectId)!
    const work = this.projectsSvc.workDir(project)
    const script = job.scriptId ? this.s.scripts.get(job.scriptId) : undefined
    let audio = job.audioId ? this.s.audio.get(job.audioId) : undefined
    const research = job.researchId ? this.s.research.get(job.researchId) : undefined
    if (audio && audio.status !== 'ready') throw new AppError('unknown', 'Audio is not marked ready.', { retryable: false })
    const publishDir = this.projectsSvc.publishDir(project)
    let publishedScript: string | null = null
    let publishedAudio: string | null = null
    try {
      // 1) Metadata stays in app data — the output folder only gets the files you send on.
      if (script) await atomicWriteFile(path.join(work, 'Narration.txt'), (script.narrationText || script.text) + '\n')
      if (research) {
        await atomicWriteFile(path.join(work, 'Research.json'), JSON.stringify({ status: research.status, mode: research.mode, model: research.model, data: research.data, sources: research.sources, createdAt: research.createdAt }, null, 2))
      }

      // 2) Publish the script (replaces the previous Script.txt of this project).
      if (script) {
        publishedScript = path.join(publishDir, this.projectsSvc.publishedScriptName(project))
        const tmp = path.join(work, `publish_${script.id}.txt`)
        await atomicWriteFile(tmp, script.text + '\n')
        await moveInto(tmp, publishedScript)
        this.s.scripts.update(script.id, { filePath: publishedScript })
      }

      // 3) Publish the audio. Never overwrites a different existing file; a crash between the move
      //    and the DB update is recovered by adopting the already-moved file.
      if (audio) {
        const wanted = path.join(publishDir, this.projectsSvc.publishedAudioName(project, audio.version, audio.outputFormat))
        const alreadyPublished = path.resolve(audio.filePath) === path.resolve(wanted) || this.projectsSvc.isPublishedFile(project, audio.filePath)
        if (alreadyPublished && fs.existsSync(audio.filePath)) {
          publishedAudio = audio.filePath
        } else if (fs.existsSync(audio.filePath)) {
          let dest = wanted
          if (fs.existsSync(dest)) dest = dest.replace(/(\.[a-z0-9]+)$/i, `_${Date.now()}$1`)
          await moveInto(audio.filePath, dest)
          publishedAudio = dest
          audio = this.s.audio.update(audio.id, { filePath: dest })
        } else if (fs.existsSync(wanted) && audio.sha256 && sha256Buffer(await fsp.readFile(wanted)) === audio.sha256) {
          publishedAudio = wanted
          audio = this.s.audio.update(audio.id, { filePath: wanted })
        } else {
          throw new AppError('filesystem', 'The voiceover file disappeared before the job could complete.', { action: 'Retry the job; the audio will be regenerated.', retryable: false })
        }
      }

      const meta = {
        app: 'VoiceForge Studio',
        projectId: project.id,
        title: project.title,
        layout: project.layout,
        channel: { id: channel.id, name: channel.name },
        job: { id: job.id, mode: job.mode, completedAt: nowIso() },
        script: script
          ? {
              id: script.id,
              version: script.version,
              model: script.model,
              templateId: script.templateId,
              contentType: script.contentType,
              templateVersionId: script.templateVersionId,
              templateVersion: script.templateVersionNumber,
              referenceSetVersion: script.referenceSetVersion,
              researchId: script.researchId,
              validation: script.validation ? { ok: script.validation.ok, errors: script.validation.issues.filter((i) => i.severity === 'error').length, warnings: script.validation.issues.filter((i) => i.severity === 'warning').length } : null,
              approvedWithIssues: script.approvedWithIssues,
              chars: script.charCount,
              words: script.wordCount,
              file: publishedScript,
              narrationFile: path.join(work, 'Narration.txt')
            }
          : null,
        audio: audio ? { id: audio.id, version: audio.version, voiceId: audio.voiceId, voiceName: audio.voiceName, modelId: audio.modelId, outputFormat: audio.outputFormat, durationSec: audio.durationSec, sha256: audio.sha256, file: publishedAudio } : null
      }
      await atomicWriteFile(path.join(work, 'project.json'), JSON.stringify(meta, null, 2))
    } catch (err) {
      if (err instanceof AppError) throw err
      const d = describeFsError(err, 'saving the finished files')
      throw new AppError('filesystem', d.message, { action: d.action, retryable: true })
    }
    if (this.s.projects.get(project.id)?.folderPath !== publishDir) this.s.projects.update(project.id, { folderPath: publishDir })
    this.s.jobs.update(job.id, { stage: 'done', lastError: null })
    this.setStatus(job.id, 'completed', { stage: 'done', event: 'completed', detail: publishedAudio ? path.basename(publishedAudio) : publishedScript ? path.basename(publishedScript) : null })
    this.s.projects.touch(project.id)
    return 'done'
  }
}

export function emptyResearch(title: string, category: Channel['category'], insufficientReason: string): ResearchData {
  return {
    subjectType: category === 'tech' ? 'product' : 'game',
    canonicalTitle: title,
    developer: '',
    publisher: '',
    genre: '',
    releaseStatus: 'unknown',
    releaseDate: '',
    platforms: [],
    summary: '',
    gameplayMechanics: [],
    combatSystems: '',
    explorationSystems: '',
    multiplayer: '',
    keyMechanics: [],
    technicalInfo: [],
    specifications: [],
    confirmedFacts: [],
    uncertainFacts: [],
    confidence: 0,
    ambiguityCandidates: [],
    insufficientReason
  }
}

export { LEASE_MS, countWords, estimateDurationSec }
