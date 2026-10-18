/**
 * 1.5.0: parallel voice parts (+ resume without re-billing), stage-priority scheduling, adaptive
 * concurrency (AIMD, rate-limit headers, ElevenLabs plan/headers), circuit breaker, per-stage
 * timings, pre-flight checks and the 1.5 settings upgrade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { PreflightService } from '../src/main/services/preflight'
import { chunksCoverText, splitForParallel } from '../src/main/pipeline/chunker'
import { parseMp3 } from '../src/main/pipeline/mp3'
import {
  AimdController,
  CircuitBreaker,
  elevenConcurrencyForTier,
  parseDurationMs,
  parseElevenConcurrencyHeaders,
  parseOpenAIRateHeaders,
  PrioritySemaphore,
  providerTelemetry
} from '../src/main/queue/limits'
import { buildTimings } from '../src/main/db/repos/jobRepo'
import { AppError } from '../src/main/util/errors'
import { seedDefaults } from '../src/main/services/seed'

let env: TestEnv | undefined
let engine: QueueEngine | undefined
let gen: GenerationService

const boot = (speedDefaults = true) => {
  env = createTestEnv({ speedDefaults })
  engine = new QueueEngine(env.s, new Logger().child('t'))
  gen = new GenerationService(env.s, engine)
}
afterEach(async () => {
  await engine?.stop()
  env?.cleanup()
  engine = undefined
  env = undefined
})

const E = (): TestEnv => env!
const Q = (): QueueEngine => engine!
const gv = () => E().s.channels.getByName('Game Vault')!
const settle = (ids: string[], statuses: string[], timeout = 20000) => waitFor(() => ids.every((id) => statuses.includes(E().s.jobs.get(id)!.status)), timeout)

function longNarration(): string {
  const p = (n: number) => `Paragraph ${n} explains one part of the game in a calm, natural way, so the listener can follow every idea without effort. It keeps going for a while to make the paragraph realistic.`
  const parts = ['Welcome back to the channel. Today we look at a game.', 'Gameplay', p(1), p(2), p(3), 'Pros', p(4), p(5), 'Cons', p(6), p(7), 'Conclusion', p(8), 'Thanks for watching.']
  return parts.join('\n\n')
}

describe('parallel split', () => {
  it('splits long narration into similar parts at paragraph boundaries without orphaning headings', () => {
    const text = longNarration()
    const chunks = splitForParallel(text, 3, 10000, { minChars: 500 })
    expect(chunks).toHaveLength(3)
    expect(chunksCoverText(text, chunks)).toBe(true)
    for (const c of chunks) {
      const last = c.text.split(/\n{2,}/).pop()!
      expect(['Gameplay', 'Pros', 'Cons', 'Conclusion']).not.toContain(last)
    }
    // Prefers cutting right before a heading.
    expect(chunks.slice(1).some((c) => /^(Pros|Cons|Conclusion|Gameplay)\n/.test(c.text))).toBe(true)
    expect(chunks[1]!.previousText).toBeTruthy()
    expect(chunks[0]!.nextText).toBeTruthy()
    const lens = chunks.map((c) => c.text.length)
    expect(Math.max(...lens) / Math.min(...lens)).toBeLessThan(2.5)
  })

  it('keeps short narration in one request and still honours the per-request limit', () => {
    expect(splitForParallel('Short text. Only a little.', 3, 10000)).toHaveLength(1)
    const text = longNarration()
    const chunks = splitForParallel(text, 2, 600, { minChars: 100 })
    expect(chunks.every((c) => c.text.length <= 600)).toBe(true)
    expect(chunksCoverText(text, chunks)).toBe(true)
  })
})

describe('parallel voice generation', () => {
  beforeEach(() => boot(true))

  it('voices the parts at the same time and joins them into one valid MP3', async () => {
    let active = 0
    let peak = 0
    const orig = E().eleven.synthImpl
    E().eleven.synthImpl = async (req) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 40))
      active--
      return orig(req)
    }
    E().s.settings.update({ elevenlabs: { parallelParts: 3, concurrency: 3 }, generation: { autoTuneConcurrency: false } })
    Q().start()
    const { jobIds } = gen.createBatch({ channelId: gv().id, mode: 'auto', entries: [{ title: 'Parallel Game', channelId: null }], skipExisting: false })
    await settle(jobIds, ['completed', 'failed'])
    const job = E().s.jobs.get(jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(E().eleven.calls.length).toBe(3)
    expect(peak).toBeGreaterThan(1)
    const script = E().s.scripts.get(job.scriptId!)!
    const joined = [...E().eleven.calls].map((c) => c.text).join(' ').replace(/\s+/g, ' ')
    expect(joined.length).toBe(script.narrationText.replace(/\s+/g, ' ').length)
    const audio = E().s.audio.get(job.audioId!)!
    expect(audio.chunkCount).toBe(3)
    expect(parseMp3(fs.readFileSync(audio.filePath)).valid).toBe(true)
    const workDir = path.join(E().s.paths.userData, 'projects', job.projectId)
    expect(fs.existsSync(workDir) ? fs.readdirSync(workDir).some((f) => f.endsWith('.part')) : false).toBe(false)
    expect(E().s.jobs.listEvents({ jobId: job.id }).some((e) => e.event === 'audio_parts')).toBe(true)
  })

  it('reuses finished parts after a failure instead of paying for them again', async () => {
    E().s.settings.update({ elevenlabs: { parallelParts: 3, concurrency: 3, maxRetries: 0 }, generation: { autoTuneConcurrency: false, maxStageRetries: 0 } })
    const orig = E().eleven.synthImpl
    let failOnce = true
    E().eleven.synthImpl = async (req) => {
      if (failOnce && req.previousText && req.nextText) {
        failOnce = false
        await new Promise((r) => setTimeout(r, 20))
        throw new AppError('provider_down', 'ElevenLabs returned a server error (500).', { retryable: false })
      }
      return orig(req)
    }
    Q().start()
    const { jobIds } = gen.createBatch({ channelId: gv().id, mode: 'auto', entries: [{ title: 'Resume Game', channelId: null }], skipExisting: false })
    await settle(jobIds, ['failed'])
    expect(E().eleven.calls.length).toBe(3)
    Q().retryJob(jobIds[0]!)
    await settle(jobIds, ['completed'])
    // Only the failed middle part was requested again.
    expect(E().eleven.calls.length).toBe(4)
    const job = E().s.jobs.get(jobIds[0]!)!
    expect(E().s.jobs.listEvents({ jobId: job.id }).filter((e) => e.event === 'audio_part_reused')).toHaveLength(2)
    expect(E().s.audio.versions(job.projectId).filter((a) => a.status === 'ready')).toHaveLength(1)
  })

  it('retries a part without continuity hints when the model rejects them, and remembers it', async () => {
    E().s.settings.update({ elevenlabs: { parallelParts: 2, concurrency: 2 }, generation: { autoTuneConcurrency: false } })
    E().s.channels.update(gv().id, { elevenModelId: 'eleven_test_no_context' })
    const orig = E().eleven.synthImpl
    E().eleven.synthImpl = (req) => {
      if (req.previousText || req.nextText) throw new AppError('config', 'ElevenLabs rejected the request: previous_text is not supported for this model', { retryable: false })
      return orig(req)
    }
    Q().start()
    const { jobIds } = gen.createBatch({ channelId: gv().id, mode: 'auto', entries: [{ title: 'No Context Game', channelId: null }], skipExisting: false })
    await settle(jobIds, ['completed', 'failed'])
    expect(E().s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    const ok = E().eleven.calls.filter((c) => !c.previousText && !c.nextText)
    expect(ok.length).toBe(2)
  })
})

describe('scheduling and adaptive concurrency', () => {
  it('serves higher priorities first, FIFO within a priority, and honours aborts', async () => {
    const sem = new PrioritySemaphore(1)
    const release = await sem.acquire()
    const order: string[] = []
    const a = sem.acquire(undefined, 1).then((r) => (order.push('research-1'), r))
    const b = sem.acquire(undefined, 3).then((r) => (order.push('audio'), r))
    const c = sem.acquire(undefined, 1).then((r) => (order.push('research-2'), r))
    const ctl = new AbortController()
    const d = sem.acquire(ctl.signal, 5)
    ctl.abort()
    await expect(d).rejects.toMatchObject({ kind: 'cancelled' })
    release()
    for (const p of [b, a, c]) (await p)()
    expect(order).toEqual(['audio', 'research-1', 'research-2'])
    expect(sem.state()).toEqual({ limit: 1, inUse: 0, waiting: 0 })
  })

  it('picks jobs that are further along first', () => {
    boot(false)
    const g = gv()
    const batch = E().s.jobs.createBatch('b', 'auto')
    const mk = (title: string, stage: 'research' | 'script' | 'audio') => {
      const p = E().s.projects.create({ channelId: g.id, title, titleNormalized: title.toLowerCase(), folderName: title, folderPath: path.join(E().dir, title) })
      return E().s.jobs.create({ batchId: batch.id, projectId: p.id, channelId: g.id, title, mode: 'auto', position: 0, stage })
    }
    const r = mk('R', 'research')
    const sc = mk('S', 'script')
    const au = mk('A', 'audio')
    expect(E().s.jobs.nextRunnable(3).map((j) => j.id)).toEqual([au.id, sc.id, r.id])
  })

  it('AIMD: +1 after a run of successes, halves on a rate limit, stays within bounds', () => {
    const c = new AimdController({ start: 4, min: 1, max: 10, increaseAfter: 3 })
    for (let i = 0; i < 9; i++) c.onSuccess()
    expect(c.value).toBe(7)
    expect(c.onRateLimit()).toBe(3)
    for (let i = 0; i < 100; i++) c.onSuccess()
    expect(c.value).toBe(10)
    for (let i = 0; i < 10; i++) c.onRateLimit()
    expect(c.value).toBe(1)
  })

  it('parses OpenAI rate-limit and ElevenLabs concurrency headers and maps plans', () => {
    const h = new Headers({ 'x-ratelimit-limit-requests': '5000', 'x-ratelimit-remaining-requests': '4999', 'x-ratelimit-limit-tokens': '800000', 'x-ratelimit-remaining-tokens': '799000', 'x-ratelimit-reset-requests': '12ms', 'x-ratelimit-reset-tokens': '1m30s' })
    const info = parseOpenAIRateHeaders(h)!
    expect(info).toMatchObject({ limitRequests: 5000, remainingRequests: 4999, remainingTokens: 799000, resetRequestsMs: 12, resetTokensMs: 90000 })
    expect(parseOpenAIRateHeaders(new Headers())).toBeNull()
    expect(parseDurationMs('6m0s')).toBe(360000)
    expect(parseDurationMs('2.5s')).toBe(2500)
    expect(parseElevenConcurrencyHeaders({ 'current-concurrent-requests': '2', 'maximum-concurrent-requests': '10' })).toMatchObject({ current: 2, maximum: 10 })
    expect(parseElevenConcurrencyHeaders(new Headers())).toBeNull()
    expect(elevenConcurrencyForTier('pro', 'eleven_v4')).toBe(10)
    expect(elevenConcurrencyForTier('creator', 'eleven_flash_v2_5')).toBe(10)
    expect(elevenConcurrencyForTier('starter', 'eleven_multilingual_v2')).toBe(3)
    expect(elevenConcurrencyForTier('something_new', 'eleven_v4')).toBeNull()
  })

  it('learns the ElevenLabs limit from the plan, then from response headers; manual mode keeps Settings', async () => {
    boot(true)
    const gov = Q().pipeline.governor
    E().s.settings.update({ generation: { autoTuneConcurrency: true }, elevenlabs: { concurrency: 2 } })
    expect(gov.status().elevenlabs.source).toBe('default')
    await gov.ensureElevenPlan()
    expect(gov.status().elevenlabs).toMatchObject({ limit: 5, source: 'plan' }) // mock plan: creator
    providerTelemetry.onEleven?.({ current: 1, maximum: 8, at: Date.now() })
    expect(gov.status().elevenlabs).toMatchObject({ limit: 8, source: 'headers' })
    E().s.settings.update({ generation: { autoTuneConcurrency: false } })
    expect(gov.status().elevenlabs).toMatchObject({ limit: 2, source: 'manual' })
    expect(gov.status().openai.source).toBe('manual')
  })

  it('lowers OpenAI concurrency after a 429 and raises it again after successes', async () => {
    boot(true)
    const gov = Q().pipeline.governor
    E().s.settings.update({ generation: { autoTuneConcurrency: true } })
    expect(gov.status().openai.limit).toBe(6)
    await expect(gov.withOpenAI(1, undefined, async () => {
      throw new AppError('rate_limit', 'OpenAI rate limit reached.', { retryable: true })
    })).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(gov.status().openai.limit).toBe(3)
    for (let i = 0; i < 3; i++) await gov.withOpenAI(1, undefined, async () => 1)
    expect(gov.status().openai.limit).toBe(4)
  })
})

describe('circuit breaker', () => {
  it('opens after repeated transient failures, cools down and closes on success', async () => {
    let changes = 0
    const b = new CircuitBreaker('X', { threshold: 3, cooldownMs: 80 }, () => changes++)
    b.recordFailure('a')
    b.recordFailure('b')
    expect(b.isOpen()).toBe(false)
    b.recordFailure('c')
    expect(b.isOpen()).toBe(true)
    expect(b.state().lastError).toBe('c')
    const t0 = Date.now()
    await b.waitIfOpen()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60)
    b.recordSuccess()
    expect(b.state()).toMatchObject({ open: false, consecutiveFailures: 0 })
    expect(changes).toBe(2)
  })

  it('shows the cool-down in the queue stats when a provider keeps failing', async () => {
    boot(true)
    const gov = Q().pipeline.governor
    for (let i = 0; i < 4; i++) {
      await expect(gov.withOpenAI(1, undefined, async () => {
        throw new AppError('network', 'Could not connect to the OpenAI API.', { retryable: true })
      })).rejects.toBeTruthy()
    }
    const st = Q().stats().providers!.openai
    expect(st.coolingDownUntil).toBeTruthy()
    expect(st.lastError).toMatch(/connect/)
  })
})

describe('timings', () => {
  it('builds stage segments from status events and excludes user waits', () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 18, 10, 0, s)).toISOString()
    const ev = [
      { to_status: 'pending', event: 'created', detail: null, at: t(0) },
      { to_status: 'researching', event: 'status', detail: null, at: t(2) },
      { to_status: 'writing_script', event: 'status', detail: null, at: t(32) },
      { to_status: 'validating_script', event: 'status', detail: null, at: t(70) },
      { to_status: 'awaiting_approval', event: 'script_ready', detail: null, at: t(71) },
      { to_status: 'pending', event: 'approved', detail: null, at: t(171) },
      { to_status: 'generating_audio', event: 'status', detail: null, at: t(172) },
      { to_status: 'saving_files', event: 'status', detail: null, at: t(190) },
      { to_status: 'completed', event: 'completed', detail: null, at: t(191) }
    ]
    const r = buildTimings('j', ev)
    expect(r.totals).toMatchObject({ research: 30, script: 38, validate: 1, audio: 18, save: 1, waiting: 3 })
    expect(r.totalSeconds).toBe(91)
    expect(r.segments.map((s) => s.stage)).toEqual(['waiting', 'research', 'script', 'validate', 'waiting', 'audio', 'save'])
  })

  it('exposes per-job timings and medians for finished jobs', async () => {
    boot(false)
    Q().start()
    const { jobIds } = gen.createBatch({ channelId: gv().id, mode: 'auto', entries: [{ title: 'Timed A', channelId: null }, { title: 'Timed B', channelId: null }], skipExisting: false })
    await settle(jobIds, ['completed'])
    const t = E().s.jobs.timings(jobIds[0]!)
    expect(t.segments.some((s) => s.stage === 'research')).toBe(true)
    expect(t.segments.some((s) => s.stage === 'audio')).toBe(true)
    const sum = E().s.jobs.timingSummary({})
    expect(sum.samples).toBe(2)
    expect(Object.keys(sum.medians)).toEqual(['research', 'script', 'validate', 'audio', 'save', 'waiting'])
  })
})

describe('pre-flight checks', () => {
  beforeEach(() => boot(false))
  const input = () => ({ channelId: gv().id, mode: 'auto' as const, entries: [{ title: 'Pre Game', channelId: null }], skipExisting: false })

  it('passes when everything is ready', async () => {
    const r = await new PreflightService(E().s, gen).run(input())
    expect(r.canStart).toBe(true)
    expect(r.needsOverride).toBe(false)
    expect(r.checks.map((c) => c.key)).toEqual(expect.arrayContaining(['openai_key', 'eleven_key', 'characters', 'voices', 'output_folder']))
    expect(r.checks.filter((c) => c.status === 'error')).toHaveLength(0)
  })

  it('blocks on a missing key, a rejected key, a missing or deleted voice and an unwritable folder', async () => {
    E().s.secrets.clear('openai')
    let r = await new PreflightService(E().s, gen).run(input())
    expect(r.checks.find((c) => c.key === 'openai_key')).toMatchObject({ status: 'error', overridable: false })
    expect(r.canStart).toBe(false)
    await expect(new PreflightService(E().s, gen).assertCanStart(input())).rejects.toMatchObject({ code: 'PREFLIGHT_BLOCKED' })
    E().s.secrets.set('openai', 'sk-test-openai-key-1234567890')

    E().eleven.getSubscription = async () => {
      throw new AppError('auth', 'ElevenLabs rejected the API key.', { retryable: false, code: 'ELEVEN_AUTH' })
    }
    r = await new PreflightService(E().s, gen).run(input())
    expect(r.checks.find((c) => c.key === 'eleven_key')).toMatchObject({ status: 'error' })
    delete (E().eleven as unknown as Record<string, unknown>).getSubscription

    E().s.channels.update(gv().id, { elevenVoiceId: null })
    r = await new PreflightService(E().s, gen).run(input())
    expect(r.checks.find((c) => c.key === 'voices')).toMatchObject({ status: 'error' })
    E().s.channels.update(gv().id, { elevenVoiceId: 'voice-deleted', elevenVoiceName: 'Old' })
    r = await new PreflightService(E().s, gen).run(input())
    expect(r.checks.find((c) => c.key === 'voices')!.message).toMatch(/no longer/)
    E().s.channels.update(gv().id, { elevenVoiceId: 'voice-1' })

    const blocker = path.join(E().dir, 'not-a-folder')
    fs.writeFileSync(blocker, 'x')
    E().s.settings.update({ general: { outputRoot: path.join(blocker, 'sub') } })
    r = await new PreflightService(E().s, gen).run(input())
    expect(r.checks.find((c) => c.key === 'output_folder')).toMatchObject({ status: 'error', overridable: false })
  })

  it('treats too few ElevenLabs characters and low disk space as overridable', async () => {
    E().eleven.getSubscription = async () => ({ tier: 'creator', characterCount: 99_000, characterLimit: 100_000, nextResetUnix: null, status: 'active' })
    const spy = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 100, bsize: 1024 * 1024 } as unknown as fs.StatsFs)
    const svc = new PreflightService(E().s, gen)
    const r = await svc.run(input())
    expect(r.checks.find((c) => c.key === 'characters')).toMatchObject({ status: 'error', overridable: true })
    expect(r.checks.find((c) => c.key === 'disk_space')).toMatchObject({ status: 'error', overridable: true })
    expect(r).toMatchObject({ canStart: true, needsOverride: true })
    await expect(svc.assertCanStart(input())).rejects.toMatchObject({ code: 'PREFLIGHT_NEEDS_OVERRIDE' })
    await expect(svc.assertCanStart({ ...input(), startAnyway: true })).resolves.toBeTruthy()
    spy.mockRestore()
  })

  it('caches provider answers for 60 s', async () => {
    let subCalls = 0
    const orig = E().eleven.getSubscription.bind(E().eleven)
    E().eleven.getSubscription = async () => {
      subCalls++
      return orig()
    }
    const svc = new PreflightService(E().s, gen)
    await svc.run(input())
    await svc.run(input())
    expect(subCalls).toBe(1)
  })
})

describe('1.5 settings upgrade', () => {
  it('moves research to the small model and raises titles in flight only when still at the old defaults', () => {
    boot(false)
    E().s.settingsRepo.set('seeded_v15', false)
    E().s.settings.update({ openai: { researchModel: 'gpt-6.1-sol' }, generation: { maxConcurrentJobs: 6 } })
    seedDefaults(E().s)
    expect(E().s.settings.get().openai.researchModel).toBe('gpt-6-luna')
    expect(E().s.settings.get().generation.maxConcurrentJobs).toBe(16)
    E().s.settingsRepo.set('seeded_v15', false)
    E().s.settings.update({ openai: { researchModel: 'gpt-5.5' }, generation: { maxConcurrentJobs: 3 } })
    seedDefaults(E().s)
    expect(E().s.settings.get().openai.researchModel).toBe('gpt-5.5')
    expect(E().s.settings.get().generation.maxConcurrentJobs).toBe(3)
  })
})
