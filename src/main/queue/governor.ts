import type { ProviderLiveStatus } from '@shared/types'
import type { Services } from '../services/container'
import type { ScopedLogger } from '../services/logger'
import { AppError, toAppError } from '../util/errors'
import { sleep } from '../util/common'
import {
  AimdController,
  CircuitBreaker,
  elevenConcurrencyForTier,
  isTransientKind,
  PrioritySemaphore,
  providerTelemetry,
  type ElevenConcurrencyInfo,
  type OpenAIRateInfo
} from './limits'

const ELEVEN_TIER_CACHE_KEY = 'eleven_tier'
const ELEVEN_TIER_TTL_MS = 6 * 60 * 60 * 1000
const MAX_AUTO = 10

type ElevenSource = 'headers' | 'plan' | 'adaptive' | 'manual' | 'default'

/**
 * Owns the provider slots (v1.5). In automatic mode:
 * - OpenAI: AIMD — start at 6, +1 after 3 successes in a row (max 10), halve on 429; waits
 *   before sending when the rate-limit headers say the token/request budget is almost spent.
 * - ElevenLabs: the plan's real concurrency, from the `maximum-concurrent-requests` response
 *   header when present, else from the subscription tier (ELEVEN_TIER_CONCURRENCY), else the
 *   manual value; a "too many concurrent requests" 429 lowers it by one until headers say more.
 * In manual mode the Settings values are used as-is. Each provider also has a circuit breaker.
 */
export class ConcurrencyGovernor {
  readonly openaiSem: PrioritySemaphore
  readonly elevenSem: PrioritySemaphore
  readonly aimd = new AimdController({ start: 6, min: 1, max: MAX_AUTO, increaseAfter: 3 })
  readonly openaiBreaker: CircuitBreaker
  readonly elevenBreaker: CircuitBreaker
  private openaiInfo: OpenAIRateInfo | null = null
  private eleven: { value: number; source: ElevenSource; detail: string } = { value: 3, source: 'default', detail: 'default until the plan is known' }
  private planLookup: Promise<void> | null = null
  private lastPlanLookupAt = 0
  private listeners = new Set<() => void>()

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    const st = s.settings.get()
    this.eleven = { value: st.elevenlabs.concurrency, source: 'default', detail: 'default until the plan is known' }
    const cachedTier = s.cache.get<{ tier: string }>(ELEVEN_TIER_CACHE_KEY, ELEVEN_TIER_TTL_MS)
    if (cachedTier?.tier) this.applyTier(cachedTier.tier)
    this.openaiSem = new PrioritySemaphore(this.openaiLimit())
    this.elevenSem = new PrioritySemaphore(this.elevenLimit())
    this.openaiBreaker = new CircuitBreaker('OpenAI', { threshold: 4, cooldownMs: 30_000 }, () => this.changed())
    this.elevenBreaker = new CircuitBreaker('ElevenLabs', { threshold: 4, cooldownMs: 30_000 }, () => this.changed())
    s.settings.onChange(() => this.apply())
    providerTelemetry.onOpenAI = (info) => this.onOpenAIHeaders(info)
    providerTelemetry.onEleven = (info) => this.onElevenHeaders(info)
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }

  private get auto(): boolean {
    return this.s.settings.get().generation.autoTuneConcurrency !== false
  }

  openaiLimit(): number {
    return this.auto ? this.aimd.value : this.s.settings.get().openai.concurrency
  }

  elevenLimit(): number {
    return this.auto ? Math.max(1, Math.min(MAX_AUTO, this.eleven.value)) : this.s.settings.get().elevenlabs.concurrency
  }

  apply(): void {
    this.openaiSem?.setLimit(this.openaiLimit())
    this.elevenSem?.setLimit(this.elevenLimit())
    this.changed()
  }

  // ---------------------------------------------------------------------------
  // Telemetry
  // ---------------------------------------------------------------------------

  onOpenAIHeaders(info: OpenAIRateInfo): void {
    this.openaiInfo = info
  }

  onElevenHeaders(info: ElevenConcurrencyInfo): void {
    if (info.maximum !== null && info.maximum > 0) {
      const value = Math.min(MAX_AUTO, info.maximum)
      if (value !== this.eleven.value || this.eleven.source !== 'headers') {
        this.eleven = { value, source: 'headers', detail: `your plan allows ${info.maximum} at once` }
        this.log.info('ElevenLabs concurrency from response headers', { maximum: info.maximum })
        this.apply()
      }
    }
  }

  private applyTier(tier: string): boolean {
    const model = this.s.settings.get().elevenlabs.defaultModelId || 'eleven_v4'
    const n = elevenConcurrencyForTier(tier, model)
    if (n === null) return false
    if (this.eleven.source === 'headers') return true
    this.eleven = { value: Math.min(MAX_AUTO, n), source: 'plan', detail: `${tier} plan` }
    return true
  }

  /** Looks up the ElevenLabs plan once (cached 6 h) so the first batch already uses the right limit. */
  async ensureElevenPlan(): Promise<void> {
    if (!this.auto || this.eleven.source === 'headers' || this.eleven.source === 'plan') return
    if (Date.now() - this.lastPlanLookupAt < 60_000) return
    if (this.planLookup) return this.planLookup
    this.lastPlanLookupAt = Date.now()
    this.planLookup = (async () => {
      try {
        let t: NodeJS.Timeout | undefined
        // Never hold voice requests for long: without an answer in 10 s the current limit is kept.
        const sub = await Promise.race([
          this.s.providers.eleven().getSubscription(),
          new Promise<never>((_, reject) => {
            t = setTimeout(() => reject(new Error('plan lookup timed out')), 10_000)
          })
        ]).finally(() => clearTimeout(t))
        if (sub?.tier) {
          this.s.cache.set(ELEVEN_TIER_CACHE_KEY, { tier: sub.tier })
          if (this.applyTier(sub.tier)) {
            this.log.info('ElevenLabs concurrency from plan', { tier: sub.tier, limit: this.eleven.value })
            this.apply()
          }
        }
      } catch (err) {
        this.log.debug('ElevenLabs plan lookup failed; keeping the current limit', { error: toAppError(err).message })
      } finally {
        this.planLookup = null
      }
    })()
    return this.planLookup
  }

  /** Waits briefly when the OpenAI headers show the request/token budget is almost spent. */
  private async openaiBudgetWait(signal?: AbortSignal): Promise<void> {
    const i = this.openaiInfo
    if (!i) return
    const age = Date.now() - i.at
    const lowTokens = i.remainingTokens !== null && i.limitTokens !== null && i.remainingTokens < Math.max(8000, i.limitTokens * 0.05)
    const lowRequests = i.remainingRequests !== null && i.remainingRequests <= 1
    if (!lowTokens && !lowRequests) return
    const reset = Math.max(lowTokens ? i.resetTokensMs ?? 0 : 0, lowRequests ? i.resetRequestsMs ?? 0 : 0)
    const wait = Math.min(15_000, reset - age)
    if (wait > 50) await sleep(wait, signal).catch(() => {
      throw new AppError('cancelled', 'Cancelled.', { retryable: false })
    })
  }

  // ---------------------------------------------------------------------------
  // Guarded calls
  // ---------------------------------------------------------------------------

  async withOpenAI<T>(priority: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    await this.openaiBreaker.waitIfOpen(signal).catch((e) => {
      throw toAppError(e)
    })
    await this.openaiBudgetWait(signal)
    const release = await this.openaiSem.acquire(signal, priority)
    try {
      const out = await fn()
      this.openaiBreaker.recordSuccess()
      if (this.auto) {
        const before = this.aimd.value
        if (this.aimd.onSuccess() !== before) this.apply()
      }
      return out
    } catch (e) {
      const err = toAppError(e)
      if (err.kind === 'rate_limit' && this.auto) {
        this.aimd.onRateLimit()
        this.log.info('OpenAI rate limit — lowering concurrency', { limit: this.aimd.value })
        this.apply()
      }
      if (isTransientKind(err.kind)) this.openaiBreaker.recordFailure(err.message)
      throw err
    } finally {
      release()
    }
  }

  async withEleven<T>(priority: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    await this.ensureElevenPlan()
    await this.elevenBreaker.waitIfOpen(signal).catch((e) => {
      throw toAppError(e)
    })
    const release = await this.elevenSem.acquire(signal, priority)
    try {
      const out = await fn()
      this.elevenBreaker.recordSuccess()
      return out
    } catch (e) {
      const err = toAppError(e)
      if (err.kind === 'rate_limit' && this.auto && /concurren/i.test(`${err.message} ${err.details ?? ''}`) && this.eleven.value > 1) {
        this.eleven = { value: this.eleven.value - 1, source: 'adaptive', detail: 'lowered after a concurrency limit response' }
        this.log.info('ElevenLabs concurrency limit hit — lowering', { limit: this.eleven.value })
        this.apply()
      }
      if (isTransientKind(err.kind)) this.elevenBreaker.recordFailure(err.message)
      throw err
    } finally {
      release()
    }
  }

  // ---------------------------------------------------------------------------
  // Status for the UI
  // ---------------------------------------------------------------------------

  status(): { openai: ProviderLiveStatus; elevenlabs: ProviderLiveStatus } {
    const auto = this.auto
    const o = this.openaiSem.state()
    const e = this.elevenSem.state()
    const ob = this.openaiBreaker.state()
    const eb = this.elevenBreaker.state()
    return {
      openai: {
        limit: o.limit,
        inUse: o.inUse,
        waiting: o.waiting,
        source: auto ? 'adaptive' : 'manual',
        detail: auto ? (this.openaiInfo?.limitRequests ? `adapts to your rate limits (${this.openaiInfo.limitRequests.toLocaleString()} requests/min)` : 'adapts to your rate limits') : 'set manually',
        coolingDownUntil: ob.openUntil,
        lastError: ob.lastError
      },
      elevenlabs: {
        limit: e.limit,
        inUse: e.inUse,
        waiting: e.waiting,
        source: auto ? this.eleven.source : 'manual',
        detail: auto ? this.eleven.detail : 'set manually',
        coolingDownUntil: eb.openUntil,
        lastError: eb.lastError
      }
    }
  }
}
