import fs from 'node:fs'
import path from 'node:path'
import type { BatchEstimate, Channel, CreateBatchInput, CreateBatchResult, ParsedTitles } from '@shared/types'
import type { Services } from './container'
import { ProjectService } from './projects'
import type { QueueEngine } from '../queue/engine'
import { csvFirstColumn, parseTitles } from '../pipeline/titles'
import { xlsxFirstColumn } from '../pipeline/xlsx'
import { estimateJobCost } from '../pipeline/cost'
import { AppError } from '../util/errors'
import { normalizeTitle } from '../util/common'
import { StyleService } from './style'

export class GenerationService {
  private projectsSvc: ProjectService
  private style: StyleService

  constructor(
    private s: Services,
    private engine: QueueEngine
  ) {
    this.projectsSvc = new ProjectService(s)
    this.style = new StyleService(s)
  }

  /** Template chosen for an entry: the batch's format applies to the batch channel only. */
  private templateFor(input: CreateBatchInput, channel: Channel): string | null {
    return channel.id === input.channelId ? input.templateId ?? null : null
  }

  /** Format gate for one channel of a batch (same rule createBatch enforces). */
  gate(channel: Channel, input: CreateBatchInput): ReturnType<StyleService['gate']> {
    return this.style.gate(channel, input.mode, this.templateFor(input, channel))
  }

  parseTitles(text: string): ParsedTitles {
    return parseTitles(text)
  }

  importTitles(filePath: string): ParsedTitles {
    if (!fs.existsSync(filePath)) throw new AppError('filesystem', 'The selected file does not exist.', { retryable: false })
    const ext = path.extname(filePath).toLowerCase()
    const buf = fs.readFileSync(filePath)
    if (buf.length > 10 * 1024 * 1024) throw new AppError('config', 'The file is larger than 10 MB.', { retryable: false })
    let lines: string[]
    if (ext === '.xlsx' || ext === '.xlsm') lines = xlsxFirstColumn(buf)
    else if (ext === '.csv' || ext === '.tsv') lines = csvFirstColumn(buf.toString('utf8'))
    else lines = buf.toString('utf8').split(/\r?\n/)
    return parseTitles(lines.join('\n'))
  }

  private resolveChannels(input: CreateBatchInput): { base: Channel; perEntry: Channel[] } {
    const base = this.s.channels.get(input.channelId)
    if (!base) throw new AppError('config', 'The selected channel does not exist.', { retryable: false })
    const perEntry = input.entries.map((e) => {
      if (!e.channelId) return base
      const c = this.s.channels.get(e.channelId)
      if (!c) throw new AppError('config', `Channel ${e.channelId} does not exist.`, { retryable: false })
      return c
    })
    return { base, perEntry }
  }

  estimate(input: CreateBatchInput): BatchEstimate {
    const { perEntry } = this.resolveChannels(input)
    const settings = this.s.settings.get()
    const warnings: string[] = []
    let openai = 0
    let eleven = 0
    let characters = 0
    const seen = new Set<string>()
    input.entries.forEach((e, i) => {
      const ch = perEntry[i]!
      const key = `${ch.id}:${normalizeTitle(e.title)}`
      if (seen.has(key)) return
      seen.add(key)
      const expectedChars = Math.round((ch.minChars + ch.maxChars) / 2) || 4000
      const est = estimateJobCost(settings.spending.pricing, {
        model: ch.openaiModel || settings.openai.defaultModel,
        expectedChars,
        research: ch.research.enabled && ch.research.mode !== 'manual',
        reviewPass: settings.generation.aiReviewPass && ch.validation.aiReviewPass,
        audio: input.mode !== 'scripts_only'
      })
      openai += est.openai
      eleven += est.eleven
      characters += est.characters
    })
    const jobs = seen.size
    if (jobs >= settings.generation.largeBatchWarningThreshold) warnings.push(`Large batch: ${jobs} jobs will be created.`)
    const channelsUsed = [...new Set(perEntry.map((c) => c.id))].map((id) => perEntry.find((c) => c.id === id)!)
    for (const ch of channelsUsed) {
      if (input.mode !== 'scripts_only' && !ch.elevenVoiceId) warnings.push(`Channel "${ch.name}" has no ElevenLabs voice selected; audio jobs will fail until one is chosen.`)
      const gate = this.style.gate(ch, input.mode, this.templateFor(input, ch))
      if (!gate.allowed) warnings.push(gate.error.message)
      else if (gate.warning) warnings.push(gate.warning)
    }
    const secrets = this.s.secrets.status()
    if (!secrets.openai) warnings.push('No OpenAI API key is configured (Settings → OpenAI).')
    if (input.mode !== 'scripts_only' && !secrets.elevenlabs) warnings.push('No ElevenLabs API key is configured (Settings → ElevenLabs).')
    const limits = settings.spending
    const total = openai + eleven
    if (limits.dailyLimitUsd !== null && limits.dailyLimitUsd > 0) {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const today = this.s.usage.spendSince(startOfDay.toISOString())
      if (today + total > limits.dailyLimitUsd) warnings.push(`This batch (~$${total.toFixed(2)}) would exceed today's spending limit ($${limits.dailyLimitUsd.toFixed(2)}); the queue will pause when the limit is reached.`)
    }
    return { jobs, estimatedOpenAICost: openai, estimatedElevenCost: eleven, estimatedTotal: total, estimatedCharacters: characters, estimatedSeconds: this.estimateSeconds(jobs, input.mode), warnings }
  }

  /**
   * Wall-clock estimate: one job end to end, then the rest pipelined through the slowest
   * stage (OpenAI stages share the OpenAI concurrency, audio the ElevenLabs concurrency).
   * Uses the engine's per-stage medians from history (defaults until data exists).
   */
  estimateSeconds(jobs: number, mode: CreateBatchInput['mode']): number {
    if (jobs <= 0) return 0
    const st = this.s.settings.get()
    const secs = this.engine.stageSeconds()
    const textStages = secs.research + secs.script
    const audio = mode === 'scripts_only' ? 0 : secs.audio
    const perJob = textStages + audio + secs.save
    // Live slots (automatic tuning) when available, else the manual values.
    const live = this.engine.pipeline?.governor?.status()
    const openaiLimit = live?.openai.limit ?? st.openai.concurrency
    const elevenLimit = live?.elevenlabs.limit ?? st.elevenlabs.concurrency
    const parts = Math.max(1, st.elevenlabs.parallelParts ?? 1)
    const openaiLanes = Math.max(1, Math.min(openaiLimit, st.generation.maxConcurrentJobs))
    // Audio time per job (history) already reflects parallel parts; each job uses up to `parts` slots.
    const elevenLanes = Math.max(1, Math.min(elevenLimit / parts, st.generation.maxConcurrentJobs))
    const perExtra = Math.max(textStages / openaiLanes, audio / elevenLanes)
    return Math.round(perJob + (jobs - 1) * perExtra)
  }

  createBatch(input: CreateBatchInput): CreateBatchResult {
    const { base, perEntry } = this.resolveChannels(input)
    if (input.templateId) {
      const t = this.s.channels.getTemplate(input.templateId)
      if (!t || t.channelId !== base.id) throw new AppError('config', 'The selected format does not belong to this channel.', { retryable: false, code: 'FORMAT_NOT_FOUND' })
    }
    // Part 6 Stage 2: never fall back to a generic template; refuse before creating anything.
    for (const ch of [...new Map(perEntry.map((c) => [c.id, c])).values()]) {
      const gate = this.style.gate(ch, input.mode, this.templateFor(input, ch))
      if (!gate.allowed) throw gate.error
    }
    const settings = this.s.settings.get()
    const name = input.name?.trim() || `${base.name} — ${new Date().toLocaleString()}`
    const skipped: string[] = []
    const seen = new Set<string>()
    const jobIds: string[] = []
    const batch = this.s.jobs.createBatch(name, input.mode)
    this.s.db.transaction(() => {
      input.entries.forEach((entry, i) => {
        const channel = perEntry[i]!
        const title = entry.title.trim()
        const key = `${channel.id}:${normalizeTitle(title)}`
        if (settings.generation.duplicateDetection && seen.has(key)) {
          skipped.push(`${title} (duplicate in this batch)`)
          return
        }
        seen.add(key)
        const { project, created } = this.projectsSvc.getOrCreate(channel, title)
        if (!created) {
          const active = this.s.jobs.countForProject(project.id, ['pending', 'researching', 'writing_script', 'validating_script', 'script_ready', 'awaiting_approval', 'research_review_required', 'generating_audio', 'saving_files'])
          if (active > 0) {
            skipped.push(`${title} (already queued)`)
            return
          }
          if (input.skipExisting && this.s.jobs.countForProject(project.id, ['completed']) > 0) {
            skipped.push(`${title} (already completed)`)
            return
          }
        }
        const notes = input.manualResearchNotes?.[title] ?? input.manualResearchNotes?.[normalizeTitle(title)] ?? null
        const templateId = this.style.resolve(channel, this.templateFor(input, channel))?.template.id
        const job = this.s.jobs.create({ batchId: batch.id, projectId: project.id, channelId: channel.id, title, mode: input.mode, position: i, manualResearchNotes: notes, overrides: templateId ? { templateId } : undefined })
        jobIds.push(job.id)
      })
    })
    if (!jobIds.length) {
      this.s.jobs.listByStatus([]) // no-op to keep the batch; nothing queued
    }
    this.s.logger.child('generation').info('Batch created', { batchId: batch.id, jobs: jobIds.length, skipped: skipped.length })
    for (const id of jobIds) {
      const view = this.s.jobs.getView(id)
      if (view) this.s.events.jobChanged(view)
    }
    this.engine.tick()
    return { batchId: batch.id, jobIds, skipped }
  }
}
