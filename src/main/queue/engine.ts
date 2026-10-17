import type { Job, JobStage, JobStatus, QueueStats, VoiceSettings } from '@shared/types'
import type { Services } from '../services/container'
import type { ScopedLogger } from '../services/logger'
import { LEASE_MS, Pipeline } from '../pipeline/pipeline'
import { AppError, toAppError } from '../util/errors'
import { computeBackoffMs } from '../util/retry'
import { ACTIVE_STATUSES } from '../db/repos/jobRepo'
import { newId } from '../util/common'
import fs from 'node:fs'

interface Running {
  controller: AbortController
  pauseRequested: boolean
  owner: string
  promise: Promise<void>
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

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    this.pipeline = new Pipeline(s, log)
    this.queuePaused = s.settingsRepo.get<boolean>('queue_paused') ?? false
    s.settings.onChange(() => this.tick())
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
    for (const r of this.running.values()) r.controller.abort(new AppError('cancelled', 'Application is closing.', { retryable: false }))
    await Promise.allSettled([...this.running.values()].map((r) => r.promise))
    this.s.jobs.releaseAll()
  }

  /** Inspect unfinished work from a previous process and put it back into a safe state. */
  recover(): void {
    this.s.jobs.releaseAll()
    const stuck = this.s.jobs.listByStatus(ACTIVE_STATUSES)
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
    try {
      while (!entry.controller.signal.aborted) {
        const job = this.s.jobs.get(jobId)
        if (!job) return
        const outcome = await this.pipeline.step(jobId, ctx)
        if (outcome === 'done' || outcome === 'wait') return
        // 'continue': loop to the next stage; the lease is still ours.
      }
    } catch (err) {
      this.handleFailure(jobId, entry, toAppError(err))
    } finally {
      clearInterval(hb)
    }
  }

  private handleFailure(jobId: string, entry: Running, err: AppError): void {
    const job = this.s.jobs.get(jobId)
    if (!job) return
    if (err.kind === 'cancelled') {
      if (entry.pauseRequested) {
        this.s.jobs.update(jobId, { lastError: null })
        this.s.jobs.setStatus(jobId, 'paused', { event: 'paused', detail: `Paused during ${job.stage}`, resumeStatus: STAGE_START_STATUS[job.stage] })
      } else if (job.status !== 'cancelled') {
        this.s.jobs.setStatus(jobId, 'cancelled', { event: 'cancelled', detail: null })
      }
      this.emitJob(jobId)
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
    const remaining = this.s.jobs.list({ batchId, status: ['pending', ...ACTIVE_STATUSES, 'paused'] }).length
    if (remaining === 0 && !this.batchNotified.has(batchId) && batch.total > 0) {
      this.batchNotified.add(batchId)
      this.s.events.emit('batch:completed', { batchId, name: batch.name, completed: batch.completed, failed: batch.failed })
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  stats(): QueueStats {
    const avg = this.s.jobs.averageCompletionSeconds()
    const base = this.s.jobs.stats(this.queuePaused, this.spendingPaused, null)
    const remaining = base.pending + base.processing
    const conc = Math.max(1, this.s.settings.get().generation.maxConcurrentJobs)
    const eta = avg && remaining > 0 ? Math.round((avg * remaining) / conc) : remaining > 0 ? null : 0
    return { ...base, estimatedSecondsRemaining: eta }
  }

  private publishStats(force = false): void {
    const st = this.stats()
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
      this.s.jobs.setStatus(id, 'paused', { event: 'paused', detail: null, resumeStatus: job.status })
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

  /** User chose a research candidate / provided notes. Re-runs research with the hint. */
  resolveResearch(jobId: string, opts: { candidateIndex?: number; manualTitle?: string; manualNotes?: string }): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    const research = job.researchId ? this.s.research.get(job.researchId) : undefined
    const channel = this.s.channels.get(job.channelId)
    let notes = job.manualResearchNotes ?? ''
    let title = job.title
    if (opts.candidateIndex !== undefined && research) {
      const c = research.data.ambiguityCandidates?.[opts.candidateIndex]
      if (!c) throw new AppError('config', 'That candidate does not exist.', { retryable: false })
      notes = `The user confirmed the correct title is "${c.title}"${c.developer ? ` by ${c.developer}` : ''}${c.year ? ` (${c.year})` : ''}. ${c.note ?? ''}`.trim()
      title = c.title || title
    }
    if (opts.manualTitle?.trim()) title = opts.manualTitle.trim()
    if (opts.manualNotes?.trim()) notes = [notes, opts.manualNotes.trim()].filter(Boolean).join('\n')
    this.s.jobs.update(jobId, { title, manualResearchNotes: notes || null, researchId: null, lastError: null, stage: 'research' })
    if (channel?.research.mode === 'manual' && !notes.trim()) {
      throw new AppError('insufficient_info', 'Manual research notes are required for this channel.', { retryable: false })
    }
    this.s.jobs.setStatus(jobId, 'pending', { stage: 'research', event: 'research_resolved', detail: notes ? notes.slice(0, 200) : null })
    this.emitJob(jobId)
    this.tick()
    return this.s.jobs.get(jobId)!
  }

  approveScript(jobId: string): Job {
    const job = this.s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    const latest = this.s.scripts.latestForProject(job.projectId)
    const script = latest && latest.createdAt >= (job.scriptId ? this.s.scripts.get(job.scriptId)?.createdAt ?? '' : '') ? latest : job.scriptId ? this.s.scripts.get(job.scriptId) : undefined
    if (!script) throw new AppError('config', 'There is no script to approve.', { retryable: false })
    if (script.status === 'invalid') {
      const errs = script.validation?.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ') ?? ''
      throw new AppError('validation', `The script still fails validation: ${errs}`, { action: 'Edit the script to fix the issues, then approve.', retryable: false })
    }
    this.s.scripts.update(script.id, { status: 'approved' })
    const stage: JobStage = job.mode === 'scripts_only' ? 'save' : 'audio'
    this.s.jobs.update(jobId, { scriptId: script.id, lastError: null, stage })
    this.s.jobs.setStatus(jobId, 'pending', { stage, event: 'approved', detail: `Script v${script.version} approved` })
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
    if (running) running.controller.abort(new AppError('cancelled', 'Regenerating.', { retryable: false }))
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
  regenerateAudio(opts: { projectId: string; scriptId?: string; voiceId?: string; voiceName?: string; modelId?: string; voiceSettings?: VoiceSettings }): Job {
    const project = this.s.projects.get(opts.projectId)
    if (!project) throw new AppError('config', 'Project not found.', { retryable: false })
    const script = opts.scriptId ? this.s.scripts.get(opts.scriptId) : this.s.scripts.latestForProject(opts.projectId)
    if (!script) throw new AppError('config', 'This project has no script yet.', { retryable: false })
    if (script.status === 'invalid' || script.status === 'rejected') {
      throw new AppError('validation', 'The selected script version did not pass validation.', { action: 'Choose a validated version or fix the script first.', retryable: false })
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
      overrides: { useScriptId: script.id, voiceId: opts.voiceId, voiceName: opts.voiceName, modelId: opts.modelId, voiceSettings: opts.voiceSettings }
    })
    this.emitJob(job.id)
    this.tick()
    return job
  }

  isQueuePaused(): boolean {
    return this.queuePaused
  }
}
