/**
 * Rate-limit benchmark (skipped unless VF_BENCH=1). Runs the real queue + pipeline against a mock
 * OpenAI that enforces tokens-per-minute per model the way OpenAI does: each request is counted
 * at (input tokens + max_output_tokens) when it arrives; over the limit it gets a 429 with
 * Retry-After. Response headers report remaining/reset like the real API.
 * Defaults model a Build-tier account: gpt-6.1-sol 30,000 TPM (scripts), gpt-6-luna 200,000 TPM
 * (research). Time is scaled down VF_BENCH_SCALE× (default 100: 1 minute = 600 ms).
 * Latencies (unscaled): research 11 s, script 30 s, TTS 23 s — the user's 1.6.0 run.
 * Self-contained (only APIs that 1.6.0 also has), so the same file measures before and after.
 */
import { describe, expect, it } from 'vitest'
import { createTestEnv, waitFor } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { providerTelemetry } from '../src/main/queue/limits'
import { buildScriptPrompt } from '../src/main/providers/prompts'
import { AppError } from '../src/main/util/errors'

const SCALE = Number(process.env.VF_BENCH_SCALE ?? 100)
const MINUTE = 60_000 / SCALE
const TPM: Record<string, number> = { 'gpt-6.1-sol': Number(process.env.VF_BENCH_SOL_TPM ?? 30_000), 'gpt-6-luna': Number(process.env.VF_BENCH_LUNA_TPM ?? 200_000) }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class TokenWindow {
  private tokens: number
  private at = Date.now()
  constructor(readonly limit: number) {
    this.tokens = limit
  }
  private refill(): void {
    const now = Date.now()
    this.tokens = Math.min(this.limit, this.tokens + ((now - this.at) * this.limit) / MINUTE)
    this.at = now
  }
  take(cost: number): { ok: boolean; remaining: number; resetMs: number; retryAfterMs: number } {
    this.refill()
    const ok = this.tokens >= Math.min(cost, this.limit)
    if (ok) this.tokens -= cost
    const remaining = Math.max(0, Math.floor(this.tokens))
    const rate = this.limit / MINUTE
    return { ok, remaining, resetMs: Math.ceil((this.limit - remaining) / rate), retryAfterMs: ok ? 0 : Math.ceil((Math.min(cost, this.limit) - this.tokens) / rate) }
  }
}

describe.skipIf(!process.env.VF_BENCH)('rate-limit benchmark', () => {
  for (const jobs of (process.env.VF_BENCH_SIZES ?? '3,10').split(',').map(Number)) {
    it(`runs ${jobs} titles under per-model TPM limits`, async () => {
      const env = createTestEnv({ speedDefaults: true })
      env.s.settings.update({ openai: { defaultModel: 'gpt-6.1-sol', researchModel: 'gpt-6-luna', maxRetries: 6 } })
      const gv = env.s.channels.getByName('Game Vault')!
      env.s.channels.update(gv.id, { openaiModel: null })
      const windows = new Map<string, TokenWindow>()
      const stats = { r429: 0, requests: 0, reserved: { research: 0, script: 0 } as Record<string, number> }
      const call = async <T>(model: string, kind: 'research' | 'script', cost: number, latencyMs: number, run: () => T | Promise<T>): Promise<T> => {
        const w = windows.get(model) ?? new TokenWindow(TPM[model] ?? 1_000_000)
        windows.set(model, w)
        stats.requests++
        const r = w.take(cost)
        const headers = { limitRequests: 500, remainingRequests: 499, limitTokens: w.limit, remainingTokens: r.remaining, resetRequestsMs: Math.ceil(MINUTE / 500), resetTokensMs: r.resetMs, at: Date.now() }
        if (!r.ok) {
          stats.r429++
          await sleep(5)
          providerTelemetry.onOpenAI?.({ ...headers, at: Date.now() }, model)
          throw new AppError('rate_limit', `Rate limit reached for ${model} on tokens per min.`, { retryable: true, retryAfterMs: Math.max(1, r.retryAfterMs) })
        }
        stats.reserved[kind] = (stats.reserved[kind] ?? 0) + cost
        await sleep(latencyMs / SCALE)
        providerTelemetry.onOpenAI?.({ ...headers, at: Date.now() }, model)
        return run()
      }
      const origResearch = env.openai.researchImpl
      env.openai.researchImpl = (req) => call(req.model, 'research', 1500 + 3000 + (req.maxOutputTokens ?? 5000), 11_000, () => origResearch(req))
      const origScript = env.openai.scriptImpl
      env.openai.scriptImpl = (req) => {
        const p = buildScriptPrompt(req)
        const input = Math.ceil((p.instructions.length + p.input.length) / 4)
        return call(req.model, 'script', input + req.maxOutputTokens, 30_000, () => origScript(req))
      }
      const origSynth = env.eleven.synthImpl
      env.eleven.synthImpl = async (req) => {
        await sleep(((23_000 / SCALE) * req.text.length) / 4700)
        return origSynth(req)
      }
      const engine = new QueueEngine(env.s, new Logger().child('bench'))
      const gen = new GenerationService(env.s, engine)
      engine.start()
      const t0 = Date.now()
      const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: Array.from({ length: jobs }, (_, i) => ({ title: `Rate Game ${i + 1}`, channelId: null })), skipExisting: false })
      await waitFor(() => jobIds.every((id) => ['completed', 'failed'].includes(env.s.jobs.get(id)!.status)), 600_000, 20)
      const wall = Date.now() - t0
      const done = jobIds.map((id) => new Date(env.s.jobs.get(id)!.completedAt ?? env.s.jobs.get(id)!.updatedAt).getTime() - t0).sort((a, b) => a - b)
      const report = {
        jobs,
        scaledWallSeconds: Math.round((wall * SCALE) / 1000),
        firstDoneScaledSeconds: Math.round((done[0]! * SCALE) / 1000),
        openaiRequests: stats.requests,
        http429: stats.r429,
        reservedPerScript: Math.round(stats.reserved.script! / env.openai.count('script')),
        reservedPerResearch: Math.round(stats.reserved.research! / Math.max(1, env.openai.count('research'))),
        failed: jobIds.filter((id) => env.s.jobs.get(id)!.status === 'failed').length
      }
      console.log('RATEBENCH', JSON.stringify(report))
      expect(report.failed).toBe(0)
      await engine.stop()
      env.cleanup()
    }, 700_000)
  }
})
