import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Channel, Job, ResearchData, ResearchResult, ResearchSource, Script, TemplateVersion, ValidationIssue, ValidationReport } from '@shared/types'
import type { Services } from '../services/container'
import { moveInto, ProjectService } from '../services/projects'
import { atomicWriteFile, describeFsError, sha256Buffer } from '../services/files'
import type { ScopedLogger } from '../services/logger'
import { AppError, toAppError } from '../util/errors'
import { withRetry } from '../util/retry'
import { ConcurrencyGovernor } from '../queue/governor'
import { PRIORITY } from '../queue/limits'
import { countWords, estimateDurationSec, normalizeTitle, nowIso } from '../util/common'
import { elevenCost, openaiCost } from './cost'
import { chunksCoverText, partAnchors, splitForParallel } from './chunker'
import crypto from 'node:crypto'
import { concatMp3, isMp3Format, parseMp3, pcmDuration } from './mp3'
import { applyPronunciation, describeIssuesForRewrite, onlyLengthErrors, stripSectionHeadings, targetChars, validateScript } from './validator'
import { KNOWN_MODEL_LIMITS, voiceSettingsForModel } from '../providers/elevenlabs'
import { StyleService } from '../services/style'
import { buildNarrationText, normalizeLockedText } from './style'
import { compactResearch, GameLibrary, subjectFor, TYPICAL_RESEARCH_TOKENS } from '../services/gameLibrary'
import { localScriptFixes } from './localFixes'
import { inputTokens, RESEARCH_FULL_OUTPUT_TOKENS, RESEARCH_OUTPUT_TOKENS, scriptOutputTokens, WEB_SEARCH_INPUT_TOKENS } from './tokens'
import { buildScriptPrompt, researchInstructions, researchUserInput } from '../providers/prompts'
import type { ScriptRequest, ScriptResponse } from '../providers/types'

const LEASE_MS = 120_000
/** Rate-limit (429) retries allowed per request; each waits as long as OpenAI asks. */
const RATE_LIMIT_RETRIES = 8
/** Voice parts are kept this long so a resume or a regeneration after a small edit can reuse them. */
const TTS_CACHE_MS = 30 * 24 * 60 * 60 * 1000

/** What a voiceover is made of; identical hashes produce identical audio requests. */
export function audioContentHash(text: string, voiceId: string, modelId: string, outputFormat: string, voiceSettings: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify({ t: text, v: voiceId, m: modelId, f: outputFormat, s: voiceSettings ?? null })).digest('hex')
}
/** Per-call timeouts (v1.5); the Settings timeout still applies when it is lower. */
const CALL_TIMEOUT_MS = { research: 120_000, script: 180_000, ttsPart: 120_000 }
/** Models that rejected previous_text/next_text continuity hints (remembered for this run). */
const NO_CONTEXT_MODELS = new Set<string>()

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
  /** Provider slots, adaptive concurrency and circuit breakers (v1.5). */
  readonly governor: ConcurrencyGovernor
  /** Permanent research reuse (1.6.0). */
  readonly library: GameLibrary

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    this.projectsSvc = new ProjectService(s)
    this.style = new StyleService(s)
    this.governor = new ConcurrencyGovernor(s, log)
    this.library = new GameLibrary(s, log)
  }

  private timeout(kind: keyof typeof CALL_TIMEOUT_MS, provider: 'openai' | 'elevenlabs'): number {
    const st = this.s.settings.get()
    const configured = provider === 'openai' ? st.openai.timeoutMs : st.elevenlabs.timeoutMs
    return Math.min(CALL_TIMEOUT_MS[kind], configured || CALL_TIMEOUT_MS[kind])
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

    // Game Library (1.6.0): a game researched once is reused for every later script on any channel.
    const reuse = this.reuseFromLibrary(job, channel)
    if (reuse !== 'research') return reuse

    this.checkSpending()
    this.setStatus(job.id, 'researching')
    this.s.jobs.update(job.id, { researchAttempts: job.researchAttempts + 1 })
    const model = this.s.settings.get().openai.researchModel || channel.openaiModel || this.s.settings.get().openai.defaultModel
    // Retries happen outside the slot so a waiting backoff never blocks other titles.
    const timeoutMs = this.timeout('research', 'openai')
    const storeHint = job.overrides?.steamAppId ? { appId: job.overrides.steamAppId, url: job.overrides.storeUrl ?? '' } : null
    const useWeb = research.mode === 'openai_web_search'
    // 1.6.1: a small output cap (reserved against the model's tokens/min); once more with the full cap if it runs out.
    let maxOut = RESEARCH_OUTPUT_TOKENS
    const promptTokens = inputTokens(researchInstructions(channel.category, research, useWeb), researchUserInput(job.title, channel.category, job.manualResearchNotes, storeHint)) + (useWeb ? WEB_SEARCH_INPUT_TOKENS : 0)
    const callResearch = () =>
      withRetry(
        (attempt) =>
          this.governor.withOpenAI({ model, priority: PRIORITY.research, estTokens: promptTokens + maxOut, jobId: job.id, kind: 'research', attempt }, ctx.signal, () =>
            this.s.providers.openai().research({ title: job.title, category: channel.category, settings: research, model, manualNotes: job.manualResearchNotes, signal: ctx.signal, timeoutMs, maxOutputTokens: maxOut, storeHint })
          ),
        this.openaiRetryOptions(job, ctx, model, 'Research')
      )
    let result: Awaited<ReturnType<typeof callResearch>>
    try {
      result = await callResearch()
    } catch (err) {
      const e = toAppError(err)
      if (e.code !== 'MAX_OUTPUT_TOKENS' || maxOut >= RESEARCH_FULL_OUTPUT_TOKENS) throw e
      this.s.jobs.addEvent(job.id, 'retry', null, null, `Research needed more than ${maxOut.toLocaleString('en-US')} output tokens; retrying once with ${RESEARCH_FULL_OUTPUT_TOKENS.toLocaleString('en-US')}`)
      maxOut = RESEARCH_FULL_OUTPUT_TOKENS
      result = await callResearch()
    }
    this.recordOpenAIUsage(job, 'research', result.model, result.usage)
    const data = result.data
    const candidates = data.ambiguityCandidates ?? []
    // Don't stop for a choice when the typed title IS the top candidate and research is confident enough.
    const typedMatchesTop = candidates.length > 0 && normalizeTitle(candidates[0]!.title) === normalizeTitle(job.title)
    const exactAndConfident = typedMatchesTop && data.confidence >= research.minConfidence
    // A pasted store link identifies the game exactly: never ask which one was meant.
    const ambiguous = !storeHint && research.askOnAmbiguity && candidates.length > 1 && data.confidence < 0.85 && !exactAndConfident
    const insufficient = !!data.insufficientReason?.trim() || data.confidence < research.minConfidence
    const status: ResearchResult['status'] = ambiguous ? 'ambiguous' : insufficient ? 'insufficient' : 'confirmed'
    const row = this.s.research.create({ jobId: job.id, projectId: job.projectId, status, data, sources: result.sources, model: result.model, mode: research.mode })
    this.s.jobs.update(job.id, { researchId: row.id })
    if (status === 'confirmed') {
      try {
        const game = this.library.record({
          typedTitle: job.title,
          aliases: [...(job.overrides?.aliasTitles ?? []), ...(job.overrides?.storeUrl ? [job.overrides.storeUrl] : [])],
          steamAppId: job.overrides?.steamAppId ?? null,
          subject: subjectFor(channel.category),
          data,
          sources: result.sources,
          model: result.model,
          tokens: result.usage.inputTokens + result.usage.outputTokens
        })
        this.s.research.setGame(row.id, game.id)
        this.s.games.markUsed(game.id)
      } catch (err) {
        // The library is an optimisation: a failure to save never fails the job.
        this.log.warn('Could not save research to the Game Library', { jobId: job.id, error: toAppError(err).message })
      }
      this.s.jobs.update(job.id, { stage: 'script' })
      // The official title is kept alongside the user's title; it never renames the project/folder —
      // except for a title derived from a pasted link (1.6.1), which takes the official title.
      const canonical = data.canonicalTitle?.trim()
      if (canonical && job.overrides?.titleFromUrl) this.adoptOfficialTitle(job, canonical)
      else if (canonical && normalizeTitle(canonical) !== normalizeTitle(job.title)) this.s.projects.update(job.projectId, { canonicalTitle: canonical })
      return 'continue'
    }
    const detail = ambiguous ? `Ambiguous title: ${candidates.map((c) => c.title).join(' / ')}` : data.insufficientReason || `Low confidence (${data.confidence.toFixed(2)} < ${research.minConfidence})`
    this.setStatus(job.id, 'research_review_required', { event: ambiguous ? 'research_ambiguous' : 'research_insufficient', detail })
    this.s.events.notify('warning', ambiguous ? 'Which game did you mean?' : 'Not enough reliable information', `${job.title}: ${detail}`)
    return 'wait'
  }

  /**
   * Game Library lookup (1.6.0). Returns `continue` when saved research was attached (no OpenAI
   * call), `wait` when the user must pick between saved entries once, or `research` when the
   * title has to be researched.
   */
  private reuseFromLibrary(job: Job, channel: Channel): StageOutcome | 'research' {
    const chosenId = job.overrides?.libraryGameId
    // Notes typed by the user ask for fresh research with their input (unless they picked a saved game).
    if (job.manualResearchNotes?.trim() && !chosenId) return 'research'
    let game = chosenId ? this.s.games.get(chosenId) : undefined
    let how = 'the saved research you chose'
    const appId = job.overrides?.steamAppId
    // 1.6.1: a Steam app id identifies the game exactly and beats any name match.
    if (!game && appId) {
      game = this.s.games.byAppId(appId)
      if (game) how = 'saved research (same Steam app)'
    }
    if (!game) {
      const m = this.library.match(job.title, channel.category)
      const named = (m.kind === 'exact' || m.kind === 'auto') && m.gameId ? this.s.games.get(m.gameId) : undefined
      if (named && appId && named.steamAppId && named.steamAppId !== appId) {
        // Same name, different Steam app: a different game (research it).
        this.s.jobs.addEvent(job.id, 'library_skip', null, null, `Saved "${named.canonicalTitle}" is Steam app ${named.steamAppId}, this link is app ${appId}; researching it as a different game.`)
      } else if (named) {
        game = named
        how = m.kind === 'exact' ? 'saved research' : `saved research for "${m.canonicalTitle}"`
        if (appId && !named.steamAppId) this.s.games.setSteamAppId(named.id, appId)
      } else if (m.kind === 'near' && !appId && !job.overrides?.skipLibraryNear && channel.research.askOnAmbiguity) {
        const candidates = m.candidates.map((c) => {
          const g = this.s.games.get(c.gameId)
          return { title: c.canonicalTitle, developer: g?.developer ?? '', year: (g?.releaseDate ?? '').slice(0, 4), note: 'Saved research — reusing it uses no credits.', gameId: c.gameId }
        })
        const r = this.s.research.create({
          jobId: job.id,
          projectId: job.projectId,
          status: 'ambiguous',
          data: { ...emptyResearch(job.title, channel.category, ''), confidence: 0, ambiguityCandidates: candidates },
          sources: [],
          model: 'library',
          mode: channel.research.mode
        })
        this.s.jobs.update(job.id, { researchId: r.id })
        this.setStatus(job.id, 'research_review_required', { event: 'research_library_choice', detail: `Saved research may match: ${candidates.map((c) => c.title).join(' / ')}` })
        this.s.events.notify('info', 'Is this a game you already researched?', `${job.title}: pick the saved game (no credits) or research it as a new one.`)
        return 'wait'
      }
    }
    if (!game) return 'research'
    if (!chosenId && this.library.isStale(game)) {
      this.s.jobs.addEvent(job.id, 'research_stale', null, null, `Saved research for ${game.canonicalTitle} is older than the refresh window; researching again.`)
      return 'research'
    }
    const data = this.library.researchData(game)
    const row = this.s.research.create({ jobId: job.id, projectId: job.projectId, status: 'confirmed', data, sources: game.sources, model: 'library', mode: channel.research.mode })
    this.s.research.setGame(row.id, game.id)
    this.s.games.markUsed(game.id)
    // A choice the user made once is never asked again.
    if (chosenId) this.s.games.addAlias(game.id, job.title)
    if (job.overrides?.storeUrl) this.s.games.addAlias(game.id, job.overrides.storeUrl)
    this.s.jobs.update(job.id, { researchId: row.id, stage: 'script' })
    this.s.reuse.record({
      kind: 'research',
      jobId: job.id,
      channelId: job.channelId,
      projectId: job.projectId,
      tokensSaved: game.researchTokens || TYPICAL_RESEARCH_TOKENS,
      usdSaved: this.library.savedResearchUsd(game),
      detail: game.canonicalTitle
    })
    this.s.jobs.addEvent(job.id, 'research_reused', null, null, `Reused ${how}: ${game.canonicalTitle} (researched ${game.researchedAt.slice(0, 10)}) — no research credits used`)
    if (job.overrides?.titleFromUrl) this.adoptOfficialTitle(job, game.canonicalTitle)
    else if (normalizeTitle(game.canonicalTitle) !== normalizeTitle(job.title)) this.s.projects.update(job.projectId, { canonicalTitle: game.canonicalTitle })
    this.log.info('Research reused from the Game Library', { jobId: job.id, title: job.title, gameId: game.id })
    return 'continue'
  }

  /**
   * 1.6.1: a job whose title was derived from a pasted link takes the official title for the job,
   * the project and the (not yet created) output folder. Kept as-is when another project of the
   * channel already has that title or the folder already exists.
   */
  private adoptOfficialTitle(job: Job, official: string): void {
    const title = official.trim()
    if (!title || title === job.title) return
    try {
      const renamed = this.projectsSvc.retitle(job.projectId, title)
      if (renamed) {
        this.s.jobs.update(job.id, { title, overrides: { ...(job.overrides ?? {}), titleFromUrl: false, aliasTitles: [...new Set([...(job.overrides?.aliasTitles ?? []), job.title])] } })
        this.s.jobs.addEvent(job.id, 'retitled', null, null, `Title from the link "${job.title}" → official title "${title}"`)
        const view = this.s.jobs.getView(job.id)
        if (view) this.s.events.jobChanged(view)
      } else {
        this.s.projects.update(job.projectId, { canonicalTitle: title })
      }
    } catch (err) {
      this.log.warn('Could not take the official title for a link-derived job', { jobId: job.id, error: toAppError(err).message })
    }
  }

  /** Retry options for OpenAI calls: Retry-After honoured, waits shown on the job (1.6.1). */
  private openaiRetryOptions(job: Job, ctx: StageContext, model: string, label: string): Parameters<typeof withRetry>[1] {
    const settings = this.s.settings.get()
    return {
      maxRetries: settings.openai.maxRetries,
      // A 429 is OpenAI asking us to slow down, not a failure: allow more of those.
      maxRateLimitRetries: Math.max(settings.openai.maxRetries, RATE_LIMIT_RETRIES),
      signal: ctx.signal,
      onRetry: (attempt, delay, err) => {
        ctx.heartbeat()
        this.governor.noteRetryWait(job.id, model, delay, err.kind)
        this.s.jobs.addEvent(job.id, 'retry', null, null, `${label} retry ${attempt} in ${Math.round(delay / 1000)}s: ${err.message}`)
      }
    }
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
    // 1.6.0, fewer tokens: one reference script is enough when the format is pinned down by locked
    // text and required labels; the skeleton still counts paragraphs over every reference.
    const lockedElements = template.fixedBlocks.filter((b) => b.locked && b.text.trim()).length + template.structure.filter((sec) => sec.required).length
    const references = this.style.promptReferences(loaded.templateId, lockedElements >= 3 ? 1 : 2)
    const skeletonReferences = this.s.channels.listReferences(loaded.templateId).map((r) => ({ text: r.text }))
    const provenance = { templateId: loaded.templateId, contentType: loaded.contentType, referenceSetVersion: this.s.channels.referenceSetVersion(loaded.templateId), researchId: job.researchId ?? null }
    const research = job.researchId ? this.s.research.get(job.researchId) : undefined
    // Compact research (1.6.0): fewer prompt tokens, same facts; user-corrected library facts apply.
    const researchData = research && research.status !== 'insufficient' ? (research.mode === 'manual' ? research.data : compactResearch(research.data)) : null
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
    // 1.6.1: the cap is reserved against the model's tokens/min, so it is sized to the script
    // (max chars / 3.2 + reasoning headroom). If the model still runs out, the call is retried
    // once with the full limit (shown in the job's history).
    const tokenCap = scriptOutputTokens(channel.maxChars || 5000, settings.openai.reasoningEffort, settings.openai.maxOutputTokens)
    let maxOutputTokens = tokenCap
    type WriterOpts = { previousScript?: string; issues?: string; feedback?: string; tighten?: { cut: number; target: number; max: number } }
    const scriptRequest = (opts: WriterOpts, tokens: number): ScriptRequest => ({
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
      skeletonReferences,
      // Same stable prefix for every title of this format → provider-side prompt caching.
      promptCacheKey: `vf:${template.id}`,
      signal: ctx.signal,
      timeoutMs: this.timeout('script', 'openai')
    })
    const callWriter = async (opts: WriterOpts, kind: string) => {
      const send = () => {
        const req = scriptRequest(opts, maxOutputTokens)
        const prompt = buildScriptPrompt(req)
        const estTokens = inputTokens(prompt.instructions, prompt.input) + maxOutputTokens
        return withRetry(
          (attempt) => this.governor.withOpenAI({ model, priority: PRIORITY.script, estTokens, jobId: job.id, kind, attempt }, ctx.signal, () => this.s.providers.openai().writeScript(req)),
          this.openaiRetryOptions(job, ctx, model, 'Script')
        )
      }
      let out: ScriptResponse
      try {
        out = await send()
      } catch (err) {
        const e = toAppError(err)
        if (e.code !== 'MAX_OUTPUT_TOKENS' || maxOutputTokens >= settings.openai.maxOutputTokens) throw e
        this.s.jobs.addEvent(job.id, 'retry', null, null, `The script needed more than ${maxOutputTokens.toLocaleString('en-US')} output tokens; retrying once with ${settings.openai.maxOutputTokens.toLocaleString('en-US')}`)
        maxOutputTokens = settings.openai.maxOutputTokens
        out = await send()
      }
      ctx.heartbeat()
      this.recordOpenAIUsage(job, kind, out.model, out.usage)
      // Presentation-only fixes (label case, quote/dash style, a locked intro/outro merged into a
      // neighbouring paragraph) so they don't cost a rewrite. Reworded text is left for the validator.
      // 1.6.0: fixable slips (links, citations, markdown, a title line, an "Intro" label) are repaired
      // locally instead of costing a rewrite.
      const local = localScriptFixes(out.text, { titles: [job.title, researchData?.canonicalTitle ?? ''], structure: template.structure })
      if (local.fixes.length) this.s.jobs.addEvent(job.id, 'local_fixes', null, null, `Fixed without a rewrite: ${local.fixes.join(', ')}`)
      return { ...out, text: normalizeLockedText(local.text, template) }
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
          const review = await withRetry(
            (attempt) =>
              this.governor.withOpenAI({ model: settings.openai.reviewModel || model, priority: PRIORITY.review, estTokens: inputTokens(text) + 3000, jobId: job.id, kind: 'review', attempt }, ctx.signal, () =>
                this.s.providers.openai().reviewScript({ channel, title: job.title, script: text, research: researchData, model: settings.openai.reviewModel || model, signal: ctx.signal })
              ),
            { maxRetries: 1, signal: ctx.signal }
          )
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
    let resumeRow: ReturnType<Services['audio']['get']> | undefined
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
        // Keep the row (and its file path) so finished parts written before the interruption are reused
        // instead of being generated — and billed — again.
        resumeRow = existing
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
    // v1.5: long narration is split into up to N similar parts (paragraph boundaries, headings kept
    // with their text) that are voiced at the same time and joined frame by frame.
    const parts = Math.max(1, Math.min(4, settings.elevenlabs.parallelParts ?? 1))
    const freshTake = job.overrides?.freshTake === true
    // Keep the previous split points of this project when possible (only changed parts are voiced again).
    const chunks = splitForParallel(narration, parts, safeLimit, { anchors: freshTake ? undefined : this.s.audio.latestPartAnchors(job.projectId) ?? undefined })
    if (!chunks.length) throw new AppError('validation', 'The narration text is empty after processing.', { retryable: false })
    if (!chunksCoverText(narration, chunks)) throw new AppError('unknown', 'Internal error: chunking changed the narration text.', { retryable: false })
    const voiceSettings = voiceSettingsForModel(modelId, baseVoiceSettings, live ? { modelId, name: '', description: '', canDoTextToSpeech: true, canUseStyle: live.canUseStyle, canUseSpeakerBoost: live.canUseSpeakerBoost, maxCharacters: live.maxCharacters, languages: [] } : null)

    // 1.6.0: identical narration + voice + model + format + settings is never voiced twice.
    const contentHash = audioContentHash(narration, voiceId, modelId, outputFormat, voiceSettings)
    if (!freshTake) {
      const same = this.s.audio.findReadyByHash(contentHash, (p) => fs.existsSync(p))
      if (same) return this.reuseIdenticalAudio(job, same, narration.length, resumeRow)
    }

    const project = this.s.projects.get(job.projectId)!
    // Audio is generated in app data and moved into the output folder when the job completes.
    const dir = this.projectsSvc.workDir(project)
    let audioRow: NonNullable<typeof resumeRow>
    let finalPath: string
    const sameRequest = resumeRow && resumeRow.scriptId === script.id && resumeRow.voiceId === voiceId && resumeRow.modelId === modelId && resumeRow.outputFormat === outputFormat
    if (resumeRow && sameRequest) {
      audioRow = this.s.audio.update(resumeRow.id, { status: 'generating', chunkCount: chunks.length })
      finalPath = resumeRow.filePath
    } else {
      if (resumeRow) this.s.audio.update(resumeRow.id, { status: 'failed' })
      const version = this.s.audio.nextVersion(job.projectId)
      finalPath = path.join(dir, this.projectsSvc.audioFileName(version, outputFormat))
      if (fs.existsSync(finalPath)) finalPath = path.join(dir, `Voice_v${version}_${Date.now()}.${path.extname(finalPath).slice(1)}`)
      audioRow = this.s.audio.create({
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
    }
    this.log.info('Generating audio', { jobId: job.id, parts: chunks.length, chars: narration.length, model: modelId, resumed: !!sameRequest })

    // Part files only matter for multi-part scripts (parallel + resume after a crash); a single
    // request is written once, directly as the final file. Part names carry a hash of their text,
    // so a part is only reused for exactly the same words.
    const multi = chunks.length > 1
    // Parts are cached by their exact text + voice settings for 30 days (app data), so a resume after
    // a crash, or a regeneration after a small edit, only pays for parts whose words changed.
    const partPathOf = (text: string, _index: number): string => this.ttsCachePath(audioContentHash(text, voiceId, modelId, outputFormat, voiceSettings), outputFormat)
    let singleInfo: ReturnType<typeof parseMp3> | null = null
    const ttsTimeout = this.timeout('ttsPart', 'elevenlabs')
    const synthPart = async (chunk: (typeof chunks)[number]): Promise<Buffer> => {
      const partPath = partPathOf(chunk.text, chunk.index)
      if (multi && !freshTake && fs.existsSync(partPath)) {
        const buf = await fsp.readFile(partPath).catch(() => Buffer.alloc(0))
        if (buf.length > 0 && (!isMp3Format(outputFormat) || parseMp3(buf).valid)) {
          this.s.jobs.addEvent(job.id, 'audio_part_reused', null, null, `Part ${chunk.index + 1}/${chunks.length} reused (identical text) — 0 characters`)
          this.s.reuse.record({ kind: 'tts_part', jobId: job.id, channelId: job.channelId, projectId: job.projectId, charactersSaved: chunk.text.length, usdSaved: elevenCost(this.s.settings.get().spending.pricing, chunk.text.length) })
          return buf
        }
      }
      const useContext = !NO_CONTEXT_MODELS.has(modelId)
      const request = (withContext: boolean) =>
        this.s.providers.eleven().synthesize({
          text: chunk.text,
          voiceId,
          modelId,
          outputFormat,
          voiceSettings,
          previousText: withContext ? chunk.previousText || undefined : undefined,
          nextText: withContext ? chunk.nextText || undefined : undefined,
          signal: ctx.signal,
          timeoutMs: ttsTimeout
        })
      const res = await withRetry(
        () =>
          this.governor.withEleven(PRIORITY.audio, ctx.signal, async () => {
            try {
              return await request(useContext && !NO_CONTEXT_MODELS.has(modelId))
            } catch (err) {
              const e = toAppError(err)
              // A model that refuses continuity hints: retry this part once without them and remember it.
              if (e.kind === 'config' && (chunk.previousText || chunk.nextText) && /previous_text|next_text|previous text|next text|context/i.test(`${e.message} ${e.details ?? ''}`)) {
                NO_CONTEXT_MODELS.add(modelId)
                this.log.warn('ElevenLabs model rejected continuity hints; continuing without them', { modelId })
                return await request(false)
              }
              throw e
            }
          }),
        {
          maxRetries: settings.elevenlabs.maxRetries,
          signal: ctx.signal,
          onRetry: (n, delay, err) => {
            ctx.heartbeat()
            this.s.jobs.addEvent(job.id, 'retry', null, null, `Audio part ${chunk.index + 1}/${chunks.length} retry ${n} in ${Math.round(delay / 1000)}s: ${err.message}`)
          }
        }
      )
      ctx.heartbeat()
      this.recordElevenUsage(job, modelId, chunk.text.length, res.requestId ? { requestId: res.requestId, chunk: chunk.index } : null)
      if (!res.audio.length) throw new AppError('provider_down', 'ElevenLabs returned an empty audio response.', { retryable: true })
      if (isMp3Format(outputFormat)) {
        const info = parseMp3(res.audio)
        if (!info.valid) throw new AppError('provider_down', 'ElevenLabs returned data that is not a valid MP3 stream.', { details: `frames=${info.frames}`, retryable: true })
        if (!multi) singleInfo = info
      }
      // Persist each finished part immediately: if a sibling fails, a retry only pays for the missing parts.
      if (multi) await atomicWriteFile(partPath, res.audio)
      return res.audio
    }
    this.throwIfAborted(ctx.signal)
    const settled = await Promise.allSettled(chunks.map((c) => synthPart(c)))
    const firstFailure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstFailure) throw toAppError(firstFailure.reason)
    const buffers = settled.map((r) => (r as PromiseFulfilledResult<Buffer>).value)
    if (multi) this.s.jobs.addEvent(job.id, 'audio_parts', null, null, `${chunks.length} parts voiced in parallel`)

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
    // Cached parts stay in app data for 30 days; only legacy (≤1.5) part files next to the audio are removed.
    for (const f of await fsp.readdir(path.dirname(finalPath)).catch(() => [] as string[])) {
      if (f.startsWith(path.basename(finalPath) + '.') && f.endsWith('.part')) await fsp.unlink(path.join(path.dirname(finalPath), f)).catch(() => undefined)
    }
    const sha = sha256Buffer(combined)
    this.s.audio.update(audioRow.id, { status: 'ready', bytes: combined.length, durationSec: durationSec ?? null, sha256: sha })
    this.s.audio.setContent(audioRow.id, contentHash, multi ? partAnchors(chunks) : null)
    this.s.jobs.update(job.id, { stage: 'save' })
    this.s.jobs.addEvent(job.id, 'audio_ready', null, null, `${path.basename(finalPath)} (${(combined.length / 1024).toFixed(0)} KB, ${durationSec ? durationSec.toFixed(1) + 's' : 'duration n/a'})`)
    return 'continue'
  }

  /** Uses an already generated identical voiceover (0 ElevenLabs characters). */
  private async reuseIdenticalAudio(job: Job, same: NonNullable<ReturnType<Services['audio']['get']>>, characters: number, resumeRow: ReturnType<Services['audio']['get']> | undefined): Promise<StageOutcome> {
    if (resumeRow && resumeRow.id !== same.id) this.s.audio.update(resumeRow.id, { status: 'failed' })
    const pricing = this.s.settings.get().spending.pricing
    if (same.projectId === job.projectId) {
      // This project already has exactly this voiceover: point the job at it instead of making a duplicate version.
      this.s.jobs.update(job.id, { audioId: same.id, stage: 'save' })
      this.s.jobs.addEvent(job.id, 'audio_reused', null, null, `Identical voiceover already exists (v${same.version}) — 0 characters used`)
    } else {
      const project = this.s.projects.get(job.projectId)!
      const dir = this.projectsSvc.workDir(project)
      const version = this.s.audio.nextVersion(job.projectId)
      let dest = path.join(dir, this.projectsSvc.audioFileName(version, same.outputFormat))
      if (fs.existsSync(dest)) dest = path.join(dir, `Voice_v${version}_${Date.now()}.${path.extname(dest).slice(1)}`)
      try {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.copyFile(same.filePath, dest)
      } catch (err) {
        const d = describeFsError(err, 'copying the identical voiceover')
        throw new AppError('filesystem', d.message, { action: d.action, retryable: true })
      }
      const row = this.s.audio.create({
        projectId: job.projectId,
        scriptId: job.scriptId!,
        jobId: job.id,
        filePath: dest,
        voiceId: same.voiceId,
        voiceName: same.voiceName,
        modelId: same.modelId,
        voiceSettings: same.voiceSettings,
        outputFormat: same.outputFormat,
        bytes: same.bytes,
        durationSec: same.durationSec,
        sha256: same.sha256,
        characters,
        chunkCount: same.chunkCount,
        status: 'ready'
      })
      const hash = this.s.db.get<{ content_hash: string | null }>('SELECT content_hash FROM audio_files WHERE id = ?', same.id)?.content_hash
      if (hash) this.s.audio.setContent(row.id, hash, null)
      this.s.jobs.update(job.id, { audioId: row.id, stage: 'save' })
      this.s.jobs.addEvent(job.id, 'audio_reused', null, null, 'Identical narration and voice settings were voiced before — copied, 0 characters used')
    }
    this.s.reuse.record({ kind: 'tts_full', jobId: job.id, channelId: job.channelId, projectId: job.projectId, charactersSaved: characters, usdSaved: elevenCost(pricing, characters) })
    return 'continue'
  }

  private ttsCacheDir(): string {
    return path.join(this.s.paths.userData, 'tts-cache')
  }

  private ttsCachePath(hash: string, outputFormat: string): string {
    const ext = isMp3Format(outputFormat) ? 'mp3' : outputFormat.startsWith('pcm') ? 'pcm' : 'bin'
    return path.join(this.ttsCacheDir(), `${hash}.${ext}`)
  }

  /** Removes cached voice parts older than 30 days. */
  async cleanTtsCache(maxAgeMs = TTS_CACHE_MS): Promise<number> {
    let removed = 0
    const dir = this.ttsCacheDir()
    const files = await fsp.readdir(dir).catch(() => [] as string[])
    for (const f of files) {
      const full = path.join(dir, f)
      const st = await fsp.stat(full).catch(() => null)
      if (st && st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) {
        await fsp.unlink(full).catch(() => undefined)
        removed++
      }
    }
    return removed
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
