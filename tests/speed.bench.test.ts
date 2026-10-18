/**
 * Speed benchmark (skipped unless VF_BENCH=1). Runs the real queue + pipeline with mock
 * providers that sleep like the real APIs (scaled down 100×: research 300 ms ≈ 30 s,
 * script 400 ms ≈ 40 s, review 200 ms ≈ 20 s, TTS 200 ms ≈ 20 s) and prints wall time and
 * provider calls per job, so before/after numbers can be compared.
 */
import { describe, expect, it } from 'vitest'
import { createTestEnv, waitFor } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { BackupService } from '../src/main/services/backup'

const SCALE = Number(process.env.VF_BENCH_SCALE ?? 100)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!process.env.VF_BENCH)('speed benchmark', () => {
  it('measures a 10-title batch', async () => {
    // VF_BENCH_14=1 reproduces the 1.4 behaviour (manual concurrency, one TTS request per script).
    const env = createTestEnv({ speedDefaults: !process.env.VF_BENCH_14 })
    if (process.env.VF_BENCH_14) env.s.settings.update({ generation: { maxConcurrentJobs: 6 } })
    const gv = env.s.channels.getByName('Game Vault')!
    const v = env.s.channels.activeVersionOf(env.s.channels.defaultTemplate(gv.id)!.id)!
    env.s.channels.setVersionStatus(v.id, 'approved')
    env.s.channels.update(gv.id, { elevenVoiceId: 'voice-1', elevenVoiceName: 'Test' })
    if (process.env.VF_BENCH_LEGACY) {
      // Approximates the 1.2.0 defaults: low concurrency and the AI fact check on.
      env.s.settings.update({ openai: { concurrency: 2 }, elevenlabs: { concurrency: 1 }, generation: { maxConcurrentJobs: 2, aiReviewPass: true } })
    }
    const origResearch = env.openai.researchImpl
    env.openai.researchImpl = async (req) => {
      await sleep(30_000 / SCALE)
      return origResearch(req)
    }
    const origScript = env.openai.scriptImpl
    env.openai.scriptImpl = async (req) => {
      await sleep(40_000 / SCALE)
      // Each channel gets its own wording (so the second run really voices new scripts).
      const out = await origScript(req)
      return { ...out, text: out.text.replace('Today we look at', `Today on ${req.channel.name} we look at`) }
    }
    const origReview = env.openai.reviewImpl
    env.openai.reviewImpl = async (req) => {
      await sleep(20_000 / SCALE)
      return origReview(req)
    }
    const origSynth = env.eleven.synthImpl
    // TTS time scales with text length (≈20 s for a full 4,750-character script).
    env.eleven.synthImpl = async (req) => {
      await sleep(((20_000 / SCALE) * req.text.length) / 4750)
      return origSynth(req)
    }
    const engine = new QueueEngine(env.s, new Logger().child('bench'))
    const gen = new GenerationService(env.s, engine)
    engine.start()
    const titles = Array.from({ length: Number(process.env.VF_BENCH_JOBS ?? 10) }, (_, i) => `Bench Game ${i + 1}`)
    const runOnce = async (label: string, channelId: string): Promise<string[]> => {
      const openaiBefore = env.openai.calls.length
      const ttsBefore = env.eleven.calls.length
      const t0 = Date.now()
      const { jobIds } = gen.createBatch({ channelId, mode: 'auto', entries: titles.map((t) => ({ title: t, channelId: null })), skipExisting: false })
      await waitFor(() => jobIds.every((id) => ['completed', 'failed'].includes(env.s.jobs.get(id)!.status)), 120_000)
      const wall = Date.now() - t0
      const firstDone = Math.min(...jobIds.map((id) => new Date(env.s.jobs.get(id)!.updatedAt).getTime())) - t0
      const calls = env.openai.calls.slice(openaiBefore).reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {})
      const report = {
        run: label,
        jobs: jobIds.length,
        wallMs: wall,
        scaledWallMinutes: +((wall * SCALE) / 60_000).toFixed(1),
        firstJobScaledSeconds: Math.round((firstDone * SCALE) / 1000),
        openaiCallsPerJob: Object.fromEntries(Object.entries(calls).map(([k, n]) => [k, n / jobIds.length])),
        ttsCallsPerJob: (env.eleven.calls.length - ttsBefore) / jobIds.length,
        limits: { openai: engine.stats().providers?.openai.limit, elevenlabs: engine.stats().providers?.elevenlabs.limit }
      }
      console.log('BENCH', JSON.stringify(report))
      if (process.env.VF_BENCH_TRACE) {
        const ev = env.s.jobs.listEvents({ jobId: jobIds[0]!, limit: 200 }).slice().reverse()
        for (const e of ev) console.log('EV', new Date(e.at).getTime() - t0, e.event, e.toStatus ?? '', (e.detail ?? '').slice(0, 60))
      }
      return jobIds
    }
    const jobIds = await runOnce('first', gv.id)
    // 1.6.0: the same 10 titles again on a second channel — research comes from the Game Library.
    const backup = new BackupService(env.s)
    const second = backup.importChannel(JSON.stringify(backup.exportChannel(gv.id)))
    const researchBefore = env.openai.count('research')
    const again = await runOnce('second run, same titles', second)
    expect(env.openai.count('research')).toBe(researchBefore)
    expect(again.every((id) => env.s.jobs.get(id)!.status === 'completed')).toBe(true)
    expect(jobIds.every((id) => env.s.jobs.get(id)!.status === 'completed')).toBe(true)
    await engine.stop()
    env.cleanup()
  }, 180_000)
})
