import type { Job, JobStage, JobStatus, QueueStats, VoiceSettings } from '@shared/types'
import type { Services } from '../services/container'
import type { ScopedLogger } from '../services/logger'
import { LEASE_MS, Pipeline } from '../pipeline/pipeline'
import { AppError, toAppError } from '../util/errors'
import { computeBackoffMs } from '../util/retry'
import { ACTIVE_STATUSES, USER_WAIT_STATUSES } from '../db/repos/jobRepo'
import { newId, normalizeTitle } from '../util/common'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseClosedError } from '../db/database'

interface Running {
  controller: AbortController
  pauseRequested: boolean
  owner: string
  promise: Promise<void>
  /**
   * Set when a user action (e.g. "Regenerate script") replaces the running work: the job's state
   * is reset only after the old run has fully stopped, so the old run can never overwrite it.
   */
  afterExit?: () => void
}

/** Rough per-stage durations used for the ETA until the history has real samples. */
const STAGE_DEFAULT_SECONDS = { research: 40, script: 60, validate: 10, audio: 30, save: 2 }

const STAGES_FOR_MODE: Record<string, JobStage[]> = {
  auto: ['research', 'script', 'audio', 'save'],
  review_before_voice: ['research', 'script', 'approval', 'audio', 'save'],
  scripts_only: ['research', 'script', 'save']
}

const STAGE_START_STATUS: Record<JobStage, JobStatus> = {
  research: 'pending',
  script: 'pending',
  approval: 'awaiting_approval',
  audio: 'pending',
  save: 'pending',
  done: 'completed'
}

/**
 * Durable job queue. State lives in SQLite; this class only orchestrates.
 * - `tick()` dispatches runnable jobs while concurrency allows.
 * - Each job runs in its own async loop calling `Pipeline.step()` until it
 *   waits, finishes or fails.
 * - Transient failures reschedule with exponential backoff (+jitter) up to
 *   `generation.maxStageRetries`; permanent failures mark the job failed.
 */
export class QueueEngine {
  readonly pipeline: Pipeline
  private running = new Map<string, Running>()
  private timer: NodeJS.Timeout | null = null
  private queuePaused = false
  private spendingPaused = false
  private stopped = false
  private lastStatsJson = ''
  private batchNotified = new Set<string>()
  private readonly instanceId = newId()
  /** Auth/quota problem that stopped the queue; cleared on resume. */
  private providerBlocked: NonNullable<QueueStats['providerBlocked']> | null = null
  private statsTimer: NodeJS.Timeout | null = null

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    this.pipeline = new Pipeline(s, log)
    this.queuePaused = s.settingsRepo.get<boolean>('queue_paused') ?? false
    this.providerBlocked = s.settingsRepo.get<NonNullable<QueueStats['providerBlocked']>>('provider_blocked') ?? null
    s.settings.onChange(() => this.tick())
    // Live slot changes (adaptive limits, cool-downs) are pushed to the UI, coalesced to ≤ 4/s.
    this.pipeline.governor.onChange(() => {
      if (this.statsTimer || this.stopped) return
      this.statsTimer = setTimeout(() => {
        this.statsTimer = null
        if (!this.stopped) this.publishStats()
      }, 250)
      // Never keep the process alive just to publish stats.
      this.statsTimer.unref?.()
    })
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    this.recover()
    this.timer = setInterval(() => this.tick(), 1000)
    this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = null
    for (const r of this.running.values()) r.controller.abort(new AppError('cancelled', 'Application is closing.', { retryable: false }))
    await Promise.allSettled([...this.running.values()].map((r) => r.promise))
    this.s.jobs.releaseAll()
  }

  /** Inspect unfinished work from a previous process and put it back into a safe state. */
  recover(): void {
    this.s.jobs.releaseAll()
    // `script_ready` is only ever a transient status of a running job; left over, nothing would pick it up.
    const stuck = this.s.jobs.listByStatus([...ACTIVE_STATUSES, 'script_ready'])
    for (const job of stuck) {
      let note = 'Recovered after restart; resuming at the same stage.'
      let stage = job.stage
      if (job.stage === 'audio' && job.audioId) {
        const audio = this.s.audio.get(job.audioId)
        if (audio?.status === 'ready' && fs.existsSync(audio.filePath)) {
          stage = 'save'
          note = 'Recovered after restart; audio had already been written, continuing with saving files.'
        }
      }
      if (job.stage === 'script' && job.scriptId) {
        const script = this.s.scripts.get(job.scriptId)
        if (script && (script.status === 'validated' || script.status === 'approved')) {
          stage = job.mode === 'scripts_only' ? 'save' : job.mode === 'review_before_voice' ? 'approval' : 'audio'
          note = 'Recovered after restart; the script had already been validated.'
        }
      }
      this.s.jobs.update(job.id, { stage })
      this.s.jobs.setStatus(job.id, STAGE_START_STATUS[stage], { stage, event: 'recovered', detail: note })
    }
    if (stuck.length) this.log.info('Recovered interrupted jobs', { count: stuck.length })
  }

  // ---------------------------------------------------------------------------
  // Dispatch loop
  // ---------------------------------------------------------------------------

  tick(): void {
    if (this.stopped) return
    try {
      this.publishStats()
      if (this.spendingPaused) {
        // Re-check every tick so a new day/month (or a raised limit) resumes automatically.
        try {
          this.pipeline.checkSpending()
          this.spendingPaused = false
          this.s.events.notify('info', 'Queue resumed', 'Spending is below the configured limit again; processing continues.')
        } catch {
          return
        }
      }
      if (this.queuePaused) return
      const max = this.s.settings.get().generation.maxConcurrentJobs
      const free = max - this.running.size
      if (free <= 0) return
      const candidates = this.s.jobs.nextRunnable(free * 2)
      for (const job of candidates) {
        if (this.running.size >= max) break
        if (this.running.has(job.id)) continue
        const owner = `${this.instanceId}:${job.id}`
        if (!this.s.jobs.claim(job.id, owner, LEASE_MS)) continue
        this.launch(job, owner)
      }
    } catch (err) {
      this.log.error('Queue tick failed', { error: toAppError(err).message })
    }
  }

  private launch(job: Job, owner: string): void {
    const controller = new AbortController()
    const entry: Running = { controller, pauseRequested: false, owner, promise: Promise.resolve() }
    entry.promise = this.runJob(job.id, entry).finally(() => {
      this.running.delete(job.id)
      this.s.jobs.release(job.id)
      if (entry.afterExit) {
        try {
          entry.afterExit()
        } catch (err) {
          this.log.warn('Could not apply the requested change after the job stopped', { jobId: job.id, error: toAppError(err).message })
        }
      }
      this.publishStats(true)
      this.maybeNotifyBatch(job.batchId)
      setTimeout(() => this.tick(), 50)
    })
    this.running.set(job.id, entry)
  }

  private async runJob(jobId: string, entry: Running): Promise<void> {
    const ctx = {
      signal: entry.controller.signal,
      owner: entry.owner,
      heartbeat: () => this.s.jobs.heartbeat(jobId, entry.owner, LEASE_MS)
    }
    const hb = setInterval(ctx.heartbeat, LEASE_MS / 3)
    const aborted = (): AppError => new AppError('cancelled', 'Stopped.', { retryable: false })
    try {
      while (true) {
        // A pause/cancel/shutdown that arrived while a stage finished without noticing the abort
        // (e.g. the provider answered just before) must still take effect — otherwise the job would
        // be left in an intermediate status (or un-cancelled by the stage's own status update).
        if (entry.controller.signal.aborted) return this.handleFailure(jobId, entry, aborted())
        const job = this.s.jobs.get(jobId)
        if (!job) return
        const outcome = await this.pipeline.step(jobId, ctx)
        if (outcome === 'done') return
        if (outcome === 'wait') {
          if (entry.controller.signal.aborted) this.handleFailure(jobId, entry, aborted())
          return
        }
        // 'continue': loop to the next stage; the lease is still ours.
      }
    } catch (err) {
      // After an abort the user's intent wins over whatever the interrupted request reported
      // (the ElevenLabs SDK, for example, reports an aborted request as a connection error).
      this.handleFailure(jobId, entry, entry.controller.signal.aborted ? aborted() : toAppError(err))
    } finally {
      clearInterval(hb)
    }
  }

  private handleFailure(jobId: string, entry: Running, err: AppError): void {
    const job = this.s.jobs.get(jobId)
    if (!job) return
    if (err.kind === 'cancelled') {
      // A replacement (regenerate) resets the job itself once this run has stopped.
      if (entry.afterExit) return
      if (job.status === 'cancelled') {
        // Cancelled by the user: keep it.
      } else if (entry.pauseRequested) {
        this.s.jobs.update(jobId, { lastError: null })
        this.s.jobs.setStatus(jobId, 'paused', { event: 'paused', detail: `Paused during ${job.stage}`, resumeStatus: STAGE_START_STATUS[job.stage] })
      } else if (this.stopped) {
        // App shutdown: the title continues at the same stage on the next start (finished stages are kept).
        this.s.jobs.setStatus(jobId, STAGE_START_STATUS[job.stage], { event: 'interrupted', detail: 'The app was closed; this title continues at the same stage on the next start.' })
      } else {
        this.s.jobs.setStatus(jobId, 'cancelled', { event: 'cancelled', detail: null })
      }
      this.emitJob(jobId)
      return
    }
    // Auth / quota problems affect every job of that provider: stop the queue once with one clear
    // notification instead of failing every title. The job goes back to waiting at the same stage.
    if (err.kind === 'auth' || err.kind === 'quota') {
      const provider: 'openai' | 'elevenlabs' = job.stage === 'audio' || /ELEVEN/i.test(err.code) ? 'elevenlabs' : 'openai'
      const name = provider === 'openai' ? 'OpenAI' : 'ElevenLabs'
      const first = !this.providerBlocked
      if (first) {
        this.providerBlocked = { provider, message: err.message, action: err.action, at: new Date().toISOString() }
        this.s.settingsRepo.set('provider_blocked', this.providerBlocked)
        this.queuePaused = true
        this.s.settingsRepo.set('queue_paused', true)
        for (const [id, r] of this.running) {
          if (id === jobId) continue
          r.pauseRequested = true
          r.controller.abort(new AppError('cancelled', `${name} problem — queue paused.`, { retryable: false }))
        }
        // The first job keeps the error so the cause is visible on it.
        this.s.jobs.update(jobId, { lastError: err.toJobError(), nextRunAt: null })
        this.s.jobs.setStatus(jobId, 'failed', { event: 'failed', detail: err.message })
        this.log.error('Provider problem — queue paused', { provider, kind: err.kind, error: err.message })
        this.s.events.notify('error', `${name}: ${err.kind === 'quota' ? 'not enough credits' : 'the API key was rejected'} — queue paused`, `${err.message} ${err.action} Then press "Resume queue"; failed titles can be retried.`)
      } else {
        this.s.jobs.update(jobId, { lastError: err.toJobError(), nextRunAt: null })
        this.s.jobs.setStatus(jobId, 'pending', { event: 'provider_blocked', detail: err.message })
      }
      this.emitJob(jobId)
      this.publishStats(true)
      return
    }
    if (err.kind === 'spending_limit') {
      this.spendingPaused = true
      this.s.jobs.update(jobId, { lastError: err.toJobError() })
      this.s.jobs.setStatus(jobId, 'pending', { event: 'spending_limit', detail: err.message })
      this.s.events.notify('warning', 'Spending limit reached', err.message + ' The queue is paused until the limit is raised in Settings → Spending.')
      this.emitJob(jobId)
      return
    }
    const stageAttempts = job.stage === 'research' ? job.researchAttempts : job.stage === 'script' ? job.scriptAttempts : job.audioAttempts
    const maxStageRetries = this.s.settings.get().generation.maxStageRetries
    if (err.retryable && stageAttempts <= maxStageRetries) {
      const delay = computeBackoffMs(Math.max(0, stageAttempts - 1), 5000, 5 * 60_000, Math.random, err.retryAfterMs)
      const nextRunAt = new Date(Date.now() + delay).toISOString()
      this.s.jobs.update(jobId, { lastError: err.toJobError(), nextRunAt })
      this.s.jobs.setStatus(jobId, 'pending', { event: 'scheduled_retry', detail: `${err.message} — retrying in ${Math.round(delay / 1000)}s (attempt ${stageAttempts}/${maxStageRetries + 1})` })
      this.log.warn('Job scheduled for retry', { jobId, stage: job.stage, delayMs: delay, error: err.message })
    } else {
      this.s.jobs.update(jobId, { lastError: err.toJobError(), nextRunAt: null })
      this.s.jobs.setStatus(jobId, 'failed', { event: 'failed', detail: err.message })
      this.log.error('Job failed', { jobId, stage: job.stage, kind: err.kind, error: err.message })
      this.s.events.notify('error', `Failed: ${job.title}`, err.message)
    }
    this.emitJob(jobId)
  }

  private emitJob(jobId: string): void {
    const view = this.s.jobs.getView(jobId)
    if (view) this.s.events.jobChanged(view)
  }

  private maybeNotifyBatch(batchId: string): void {
    const batch = this.s.jobs.getBatch(batchId)
    if (!batch) return
    // Titles waiting for the user (approval, title choice) are not finished: the batch is done only
    // when every title is completed, failed or cancelled.
    const remaining = this.s.jobs.list({ batchId, status: ['pending', ...ACTIVE_STATUSES, 'paused', 'script_ready', ...USER_WAIT_STATUSES] }).length
    if (remaining === 0 && !this.batchNotified.has(batchId) && batch.total > 0) {
      this.batchNotified.add(batchId)
      this.s.events.emit('batch:completed', { batchId, name: batch.name, completed: batch.completed, failed: batch.failed, folder: this.batchFolder(batchId) })
    }
  }

  /** The deepest folder that contains every finished project of a batch (null when nothing finished). */
  batchFolder(batchId: string): string | null {
    const dirs = [
      ...new Set(
        this.s.jobs
          .list({ batchId, status: ['completed'], limit: 2000 })
          .map((j) => this.s.projects.get(j.projectId)?.folderPath)
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
      )
    ]
    if (!dirs.length) return null
    if (dirs.length === 1) return dirs[0]!
    const split = dirs.map((d) => path.resolve(d).split(path.sep))
    const common: string[] = []
    for (let i = 0; i < split[0]!.length; i++) {
      const part = split[0]![i]!
      if (split.every((p) => p[i] === part)) common.push(part)
      else break
    }
    const joined = common.join(path.sep)
    return joined || null
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  stats(): QueueStats {
    const base = this.s.jobs.stats(this.queuePaused, this.spendingPaused, null)
    const { progressPercent, remainingSeconds } = this.progress()
    // Effective parallelism is bounded by the provider slots, not by the number of titles in flight.
    const st = this.s.settings.get()
    const slots = this.pipeline.governor.status()
    const conc = Math.max(1, Math.min(st.generation.maxConcurrentJobs, Math.max(slots.openai.limit, slots.elevenlabs.limit)))
    const remaining = base.pending + base.processing
    const eta = remaining > 0 ? Math.round(remainingSeconds / conc) : 0
    return { ...base, estimatedSecondsRemaining: eta, progressPercent, providers: this.pipeline.governor.status(), providerBlocked: this.providerBlocked }
  }

  private stageMediansCache: { at: number; value: Record<string, number> } | null = null

  /** Median seconds per stage from history, falling back to rough defaults until data exists. */
  stageSeconds(): Record<JobStage, number> {
    const now = Date.now()
    if (!this.stageMediansCache || now - this.stageMediansCache.at > 30_000) {
      const samples = this.s.jobs.stageDurationSamples()
      const median = (list: number[] | undefined): number | null => {
        if (!list || !list.length) return null
        const sorted = [...list].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
      }
      const m: Record<string, number> = {}
      for (const k of ['researching', 'writing_script', 'validating_script', 'generating_audio', 'saving_files']) {
        const v = median(samples[k])
        if (v !== null) m[k] = v
      }
      this.stageMediansCache = { at: now, value: m }
    }
    const m = this.stageMediansCache.value
    return {
      research: m.researching ?? STAGE_DEFAULT_SECONDS.research,
      script: (m.writing_script ?? STAGE_DEFAULT_SECONDS.script) + (m.validating_script ?? STAGE_DEFAULT_SECONDS.validate),
      approval: 0,
      audio: m.generating_audio ?? STAGE_DEFAULT_SECONDS.audio,
      save: m.saving_files ?? STAGE_DEFAULT_SECONDS.save,
      done: 0
    }
  }

  /**
   * Progress across the batches that still have work: finished stages / total stages,
   * so a single running job advances the bar at every stage instead of sitting at 0 %.
   * Also returns the estimated automatic work left (user-wait and paused jobs excluded).
   */
  progress(): { progressPercent: number; remainingSeconds: number } {
    const jobs = this.s.jobs.listForProgress()
    if (!jobs.length) return { progressPercent: this.s.jobs.stats(false, false, null).total > 0 ? 100 : 0, remainingSeconds: 0 }
    const secs = this.stageSeconds()
    let doneUnits = 0
    let totalUnits = 0
    let remainingSeconds = 0
    for (const j of jobs) {
      const stages: JobStage[] = STAGES_FOR_MODE[j.mode] ?? STAGES_FOR_MODE.auto!
      totalUnits += stages.length
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
        doneUnits += stages.length
        continue
      }
      const idx = Math.max(0, stages.indexOf(j.stage))
      const inProgress = (ACTIVE_STATUSES as string[]).includes(j.status)
      doneUnits += idx + (inProgress ? 0.5 : 0)
      const waiting = (USER_WAIT_STATUSES as string[]).includes(j.status) || j.status === 'paused' || j.status === 'script_ready'
      if (!waiting) {
        for (let i = idx; i < stages.length; i++) remainingSeconds += (secs[stages[i]!] ?? 0) * (i === idx && inProgress ? 0.5 : 1)
      }
    }
    return { progressPercent: totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0, remainingSeconds: Math.round(remainingSeconds) }
  }

  private publishStats(force = false): void {
    let st: QueueStats
    try {
      st = this.stats()
    } catch (err) {
      // The database can close (shutdown, restore, tests) while a coalesced stats timer is pending.
      if (err instanceof DatabaseClosedError) return
      throw err
    }
    const json = JSON.stringify(st)
    if (force || json !== this.lastStatsJson) {
      this.lastStatsJson = json
      this.s.events.stats(st)
    }
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  pauseAll(): QueueStats {
    this.queuePaused = true
    this.s.settingsRepo.set('queue_paused', true)
    for (const [id, r] of this.running) {
      r.pauseRequested = true
      r.controller.abort(new AppError('cancelled', 'Paused by user.', { retryable: false }))
      void id
    }
    this.publishStats(true)
    return this.stats()
  }

  resumeAll(): QueueStats {
    this.queuePaused = false
    this.s.settingsRepo.set('queue_paused', false)
    if (this.providerBlocked) {
      this.providerBlocked = null
      this.s.settingsRepo.set('provider_blocked', null)
      // The provider (keys, cached plan) may have changed while paused.
      this.s.providers.reset()
    }
    for (const job of this.s.jobs.listByStatus(['paused'])) this.resumeJob(job.id)
    this.publishStats(true)
    this.tick()
    return this.stats()
  }

  pauseJob(id: string): Job {
    const running = this.running.get(id)
    if (running) {
      running.pauseRequested = true
      running.controller.abort(new AppError('cancelled', 'Paused by user.', { retryable: false }))
      return this.s.jobs.get(id)!
    }
    const job = this.s.jobs.get(id)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    if (job.status === 'pending' || job.status === 'research_review_required' || job.status === 'awaiting_approval' || job.status === 'script_ready') {
      // `script_ready` is transient (nothing picks it up again): resume at the start of the current stage.
      this.s.jobs.setStatus(id, 'paused', { event: 'paused', detail: null, resumeStatus: job.status === 'script_ready' ? STAGE_START_STATUS[job.stage] : job.status })
    }
    this.emitJob(id)
    return this.s.jobs.get(id)!
  }

  resumeJob(id: string): Job {
    const job = this.s.jobs.get(id)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    if (job.status === 'paused') {
      const target = job.resumeStatus && job.resumeStatus !== 'paused' ? job.resumeStatus : STAGE_START_STATUS[job.stage]
      this.s.jobs.update(id, { nextRunAt: null })
      this.s.jobs.setStatus(id, target, { event: 'resumed', detail: null, resumeStatus: null })
    }
    this.emitJob(id)
    this.tick()
    return this.s.jobs.get(id)!
  }

  /** Retry a failed/cancelled job from the stage it failed at (completed stages are kept). */
  retryJob(id: string): Job {
    const job = this.s.jobs.get(id)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'paused') {
      const stage: JobStage = job.stage === 'done' ? 'save' : job.stage
      this.s.jobs.update(id, { lastError: null, nextRunAt: null, stage })
      this.s.jobs.setStatus(id, STAGE_START_STATUS[stage], { stage, event: 'retried', detail: `Retrying from ${stage}`, resumeStatus: null })
    } else if (job.status === 'pending' && job.nextRunAt) {
      this.s.jobs.update(id, { nextRunAt: null })
    }
    this.emitJob(id)
    this.tick()
    return this.s.jobs.get(id)!
  }

  cancelJob(id: string): Job {
    const running = this.running.get(id)
    if (running) {
      running.pauseRequested = false
      running.controller.abort(new AppError('cancelled', 'Cancelled by user.', { retryable: false }))
      this.s.jobs.setStatus(id, 'cancelled', { event: 'cancelled', detail: 'Cancelled by user' })
    } else {
      const job = this.s.jobs.get(id)
      if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
      if (job.status !== 'completed') this.s.jobs.setStatus(id, 'cancelled', { event: 'cancelled', detail: 'Cancelled by user' })
      this.maybeNotifyBatch(job.batchId)
    }
    this.emitJob(id)
    return this.s.jobs.get(id)!
  }

  removeJob(id: string): void {
    const running = this.running.get(id)
    if (running) running.controller.abort(new AppError('cancelled', 'Removed by user.', { retryable: false }))
    this.s.jobs.remove(id)
    this.publishStats(true)
  }

  retryFailed(batchId?: string): number {
    const failed = this.s.jobs.list({ batchId, status: ['failed', 'cancelled'] })
    for (const j of failed) this.retryJob(j.id)
    return failed.length
  }

  clearFinished(batchId?: string): number {
    const finished = this.s.jobs.list({ batchId, status: ['completed', 'cancelled'] })
    for (const j of finished) this.s.jobs.remove(j.id)
    this.publishStats(true)
    return finished.length
  }

  /**
   * User chose a research candidate / provided notes. Re-runs research with the hint.
   * Choosing a candidate (or typing a title) is an explicit rename: the job AND its
   * project/folder take the chosen title. Research on its own never renames anything.
   */
  resolveResearch(jobId: string, opts: { candidateIndex?: number; manualTitle?: string; manualNotes?: string }): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    const research = job.researchId ? this.s.research.get(job.researchId) : undefined
    const channel = this.s.channels.get(job.channelId)
    let notes = job.manualResearchNotes ?? ''
    let title = job.title
    const overrides = { ...(job.overrides ?? {}) }
    const libraryChoice = research?.model === 'library'
    if (opts.candidateIndex !== undefined && research) {
      const c = research.data.ambiguityCandidates?.[opts.candidateIndex]
      if (!c) throw new AppError('config', 'That candidate does not exist.', { retryable: false })
      if (c.gameId) {
        // A saved Game Library entry: reuse its research (no credits) and keep the user's title.
        if (!this.s.games.get(c.gameId)) throw new AppError('config', 'That saved game no longer exists.', { retryable: false, code: 'GAME_NOT_FOUND' })
        overrides.libraryGameId = c.gameId
        delete overrides.skipLibraryNear
        this.s.jobs.update(jobId, { overrides, researchId: null, lastError: null, stage: 'research' })
        this.s.jobs.setStatus(jobId, 'pending', { stage: 'research', event: 'research_resolved', detail: `Using saved research: ${c.title}` })
        this.emitJob(jobId)
        this.tick()
        return this.s.jobs.get(jobId)!
      }
      notes = `The user confirmed the correct title is "${c.title}"${c.developer ? ` by ${c.developer}` : ''}${c.year ? ` (${c.year})` : ''}. ${c.note ?? ''}`.trim()
      title = c.title?.trim() || title
    }
    // Rejecting the saved matches means "this is a different game": research it as new.
    if (libraryChoice) {
      overrides.skipLibraryNear = true
      delete overrides.libraryGameId
    }
    if (opts.manualTitle?.trim()) title = opts.manualTitle.trim()
    if (opts.manualNotes?.trim()) notes = [notes, opts.manualNotes.trim()].filter(Boolean).join('\n')
    if (title !== job.title) {
      const project = this.s.projects.get(job.projectId)
      if (project && project.title !== title) {
        try {
          this.pipeline.projects.rename(project.id, title)
        } catch (err) {
          this.log.warn('Could not rename the project folder after the user chose a title', { jobId, error: toAppError(err).message })
          this.s.projects.update(project.id, { title, titleNormalized: normalizeTitle(title) })
        }
      }
      this.s.jobs.addEvent(jobId, 'title_changed', null, null, `${job.title} → ${title}`)
      // Learn what the user typed, so the same spelling resolves to this game next time.
      overrides.aliasTitles = [...new Set([...(overrides.aliasTitles ?? []), job.title])]
    }
    this.s.jobs.update(jobId, { title, manualResearchNotes: notes || null, researchId: null, lastError: null, stage: 'research', overrides })
    if (channel?.research.mode === 'manual' && !notes.trim()) {
      throw new AppError('insufficient_info', 'Manual research notes are required for this channel.', { retryable: false })
    }
    this.s.jobs.setStatus(jobId, 'pending', { stage: 'research', event: 'research_resolved', detail: notes ? notes.slice(0, 200) : null })
    this.emitJob(jobId)
    this.tick()
    return this.s.jobs.get(jobId)!
  }

  /**
   * Approves the newest script of the job's project and moves on to audio (or save).
   * `force` lets the user approve a script that still has validation errors — the
   * decision is recorded on the script and in the job history, and the audio stage
   * accepts it. Without `force`, a script with errors is rejected here.
   */
  approveScript(jobId: string, force = false): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    const running = this.running.get(jobId)
    if (running) throw new AppError('config', 'The job is still running; wait for it to pause or finish before approving.', { retryable: false })
    // Approving moves the job on to (paid) audio generation: only for a job that is actually waiting
    // for a decision — never a finished or queued one (a stale dialog or a double click).
    if (!(['awaiting_approval', 'failed', 'cancelled', 'paused'] as Job['status'][]).includes(job.status)) {
      throw new AppError('config', job.status === 'completed' ? 'This title is already finished; use "Regenerate voiceover" to voice it again.' : 'This title is not waiting for approval.', { retryable: false, code: 'NOT_AWAITING_APPROVAL' })
    }
    const latest = this.s.scripts.latestForProject(job.projectId)
    const script = latest && latest.createdAt >= (job.scriptId ? this.s.scripts.get(job.scriptId)?.createdAt ?? '' : '') ? latest : job.scriptId ? this.s.scripts.get(job.scriptId) : undefined
    if (!script) throw new AppError('config', 'There is no script to approve.', { retryable: false })
    const errors = script.validation?.issues.filter((i) => i.severity === 'error') ?? []
    const hasErrors = script.status === 'invalid' || errors.length > 0
    if (hasErrors && !force) {
      throw new AppError('validation', `The script still fails validation: ${errors.map((i) => i.message).join('; ')}`, {
        action: 'Edit the script to fix the issues, or approve it anyway to continue with the script as it is.',
        retryable: false,
        code: 'APPROVE_NEEDS_FORCE'
      })
    }
    this.s.scripts.update(script.id, { status: 'approved', approvedWithIssues: hasErrors })
    const stage: JobStage = job.mode === 'scripts_only' ? 'save' : 'audio'
    this.s.jobs.update(jobId, { scriptId: script.id, lastError: null, stage })
    this.s.jobs.setStatus(jobId, 'pending', {
      stage,
      event: hasErrors ? 'approved_with_issues' : 'approved',
      detail: hasErrors ? `Script v${script.version} approved despite: ${errors.map((i) => i.message).join('; ')}`.slice(0, 500) : `Script v${script.version} approved`
    })
    if (hasErrors) this.log.warn('Script approved with validation errors', { jobId, scriptId: script.id, errors: errors.map((e) => e.code) })
    this.emitJob(jobId)
    this.tick()
    return this.s.jobs.get(jobId)!
  }

  rejectScript(jobId: string, feedback: string): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    if (job.scriptId) this.s.scripts.update(job.scriptId, { status: 'rejected' })
    return this.regenerateScript(jobId, feedback)
  }

  regenerateScript(jobId: string, feedback?: string): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    const running = this.running.get(jobId)
    if (running) {
      // Reset only after the old run has stopped, so a stage finishing late cannot overwrite the reset.
      running.pauseRequested = false
      running.afterExit = () => this.resetForNewScript(jobId, feedback)
      running.controller.abort(new AppError('cancelled', 'Regenerating.', { retryable: false }))
      return this.s.jobs.get(jobId)!
    }
    return this.resetForNewScript(jobId, feedback)
  }

  private resetForNewScript(jobId: string, feedback?: string): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    this.s.jobs.update(jobId, {
      scriptId: null,
      audioId: null,
      lastError: null,
      nextRunAt: null,
      stage: 'script',
      overrides: { ...(job.overrides ?? {}), scriptFeedback: feedback?.trim() || undefined, useScriptId: undefined }
    })
    this.s.jobs.setStatus(jobId, 'pending', { stage: 'script', event: 'regenerate_script', detail: feedback?.trim() || null })
    this.emitJob(jobId)
    this.tick()
    return this.s.jobs.get(jobId)!
  }

  /** Creates a new audio-only job for a project (optionally with another voice). */
  regenerateAudio(opts: { projectId: string; scriptId?: string; voiceId?: string; voiceName?: string; modelId?: string; voiceSettings?: VoiceSettings; freshTake?: boolean }): Job {
    const project = this.s.projects.get(opts.projectId)
    if (!project) throw new AppError('config', 'Project not found.', { retryable: false })
    const script = opts.scriptId ? this.s.scripts.get(opts.scriptId) : this.s.scripts.latestForProject(opts.projectId)
    if (!script) throw new AppError('config', 'This project has no script yet.', { retryable: false })
    if (script.status === 'rejected' || (script.status === 'invalid' && !script.approvedWithIssues)) {
      throw new AppError('validation', 'The selected script version did not pass validation.', { action: 'Open the script, fix or approve it (approving is allowed even with warnings), then regenerate.', retryable: false, code: 'SCRIPT_NOT_APPROVED' })
    }
    const batch = this.s.jobs.createBatch(`Regenerate audio: ${project.title}`, 'auto')
    const job = this.s.jobs.create({
      batchId: batch.id,
      projectId: project.id,
      channelId: project.channelId,
      title: project.title,
      mode: 'auto',
      position: 0,
      stage: 'script',
      overrides: { useScriptId: script.id, voiceId: opts.voiceId, voiceName: opts.voiceName, modelId: opts.modelId, voiceSettings: opts.voiceSettings, freshTake: opts.freshTake || undefined }
    })
    this.emitJob(job.id)
    this.tick()
    return job
  }

  isQueuePaused(): boolean {
    return this.queuePaused
  }
}
