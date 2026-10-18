import type { OpenAIModelLimit, ProviderLiveStatus, WaitingFor } from '@shared/types'
import type { Services } from '../services/container'
import type { ScopedLogger } from '../services/logger'
import { AppError, toAppError } from '../util/errors'
import {
  AimdController,
  CircuitBreaker,
  elevenConcurrencyForTier,
  isTransientKind,
  ModelBudget,
  PrioritySemaphore,
  providerTelemetry,
  type ElevenConcurrencyInfo,
  type OpenAIRateInfo
} from './limits'
import { currentProviderCall, jobWaits, providerCallStore, type ProviderCallContext } from './callContext'

const ELEVEN_TIER_CACHE_KEY = 'eleven_tier'
const ELEVEN_TIER_TTL_MS = 6 * 60 * 60 * 1000
const OPENAI_LIMITS_CACHE_KEY = 'openai_model_limits'
const OPENAI_LIMITS_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_AUTO = 10
/** Waits shorter than this are not worth showing in the queue. */
const SHOW_WAIT_MS = 400

type KnownLimits = Record<string, { tpm: number | null; rpm: number | null; at: string }>
type ElevenSource = 'headers' | 'plan' | 'adaptive' | 'manual' | 'default'

/** What a guarded OpenAI call needs (1.6.1): limits and slots are per model. */
export interface OpenAICallSpec {
  model: string
  priority: number
  /** Tokens OpenAI will count when the request arrives: input (chars / 4) + max_output_tokens. */
  estTokens?: number
  jobId?: string | null
  kind?: string
  /** 0 = first attempt, n = n-th retry (recorded in provider_calls). */
  attempt?: number
}

interface LaneWaiter {
  priority: number
  seq: number
  cost: number
  jobId: string | null
  enqueuedAt: number
  grant: (r: { id: number; sentAt: number }) => void
}

/** One OpenAI model: its own adaptive concurrency, token budget and queue. */
interface Lane {
  model: string
  aimd: AimdController
  budget: ModelBudget
  active: number
  queue: LaneWaiter[]
  timer: NodeJS.Timeout | null
  lastUsed: number
}

/**
 * Owns the provider slots. In automatic mode:
 * - OpenAI (1.6.1): one lane per model, because OpenAI's limits are per model — research on the
 *   small model never waits behind scripts on the large one. Each lane has AIMD concurrency
 *   (start 6, +1 after 3 successes, max 10, halve on 429) and a token budget learned from the
 *   rate-limit headers: a request is sent when its reservation (input + max_output_tokens) fits
 *   in what is left of the window, in priority order (audio > script > research). After a 429
 *   the lane pauses for the time OpenAI asks for. Waits are shown on the job in the queue.
 * - ElevenLabs: the plan's real concurrency, from the `maximum-concurrent-requests` response
 *   header when present, else from the subscription tier (ELEVEN_TIER_CONCURRENCY), else the
 *   manual value; a "too many concurrent requests" 429 lowers it by one until headers say more.
 * In manual mode the Settings values are used as-is (OpenAI: per model). Each provider also has a
 * circuit breaker for network/server failures.
 */
export class ConcurrencyGovernor {
  readonly elevenSem: PrioritySemaphore
  readonly openaiBreaker: CircuitBreaker
  readonly elevenBreaker: CircuitBreaker
  private lanes = new Map<string, Lane>()
  private seq = 0
  private eleven: { value: number; source: ElevenSource; detail: string } = { value: 3, source: 'default', detail: 'default until the plan is known' }
  private planLookup: Promise<void> | null = null
  private lastPlanLookupAt = 0
  private listeners = new Set<() => void>()
  private knownLimits: KnownLimits = {}
  private stopped = false

  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {
    const st = s.settings.get()
    this.eleven = { value: st.elevenlabs.concurrency, source: 'default', detail: 'default until the plan is known' }
    const cachedTier = s.cache.get<{ tier: string }>(ELEVEN_TIER_CACHE_KEY, ELEVEN_TIER_TTL_MS)
    if (cachedTier?.tier) this.applyTier(cachedTier.tier)
    this.knownLimits = s.cache.get<KnownLimits>(OPENAI_LIMITS_CACHE_KEY, OPENAI_LIMITS_TTL_MS) ?? {}
    this.elevenSem = new PrioritySemaphore(this.elevenLimit())
    this.openaiBreaker = new CircuitBreaker('OpenAI', { threshold: 4, cooldownMs: 30_000 }, () => this.changed())
    this.elevenBreaker = new CircuitBreaker('ElevenLabs', { threshold: 4, cooldownMs: 30_000 }, () => this.changed())
    s.settings.onChange(() => this.apply())
    providerTelemetry.onOpenAI = (info, model) => this.onOpenAIHeaders(info, model)
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

  /** Stops lane timers (shutdown); queued requests are released by their abort signals. */
  stop(): void {
    this.stopped = true
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer)
      lane.timer = null
    }
  }

  private lane(model: string): Lane {
    const key = model || 'default'
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { model: key, aimd: new AimdController({ start: 6, min: 1, max: MAX_AUTO, increaseAfter: 3 }), budget: new ModelBudget(), active: 0, queue: [], timer: null, lastUsed: 0 }
      const known = this.knownLimits[key]
      // Limits seen in an earlier session: start from a full window instead of an unlimited burst.
      if (known) lane.budget.seed(known.tpm, known.rpm)
      this.lanes.set(key, lane)
    }
    return lane
  }

  private laneLimit(lane: Lane): number {
    return this.auto ? lane.aimd.value : Math.max(1, this.s.settings.get().openai.concurrency)
  }

  /** Concurrency of the most recently used OpenAI model (what the queue header shows). */
  openaiLimit(): number {
    const lane = this.primaryLane()
    if (lane) return this.laneLimit(lane)
    return this.auto ? 6 : this.s.settings.get().openai.concurrency
  }

  private primaryLane(): Lane | undefined {
    let best: Lane | undefined
    for (const l of this.lanes.values()) if (!best || l.lastUsed > best.lastUsed) best = l
    return best
  }

  elevenLimit(): number {
    return this.auto ? Math.max(1, Math.min(MAX_AUTO, this.eleven.value)) : this.s.settings.get().elevenlabs.concurrency
  }

  apply(): void {
    this.elevenSem?.setLimit(this.elevenLimit())
    for (const lane of this.lanes?.values() ?? []) this.pump(lane)
    this.changed()
  }

  // ---------------------------------------------------------------------------
  // Telemetry
  // ---------------------------------------------------------------------------

  /** Response headers of an OpenAI request (pushed by the provider; `model` = requested model). */
  onOpenAIHeaders(info: OpenAIRateInfo, model?: string): void {
    const ctx = currentProviderCall()
    const m = model || ctx?.model || 'default'
    const lane = this.lane(m)
    lane.budget.observe(info, ctx?.sentAt ?? info.at)
    if (ctx) ctx.headers = info
    const known = this.knownLimits[m]
    if ((info.limitTokens !== null || info.limitRequests !== null) && (!known || known.tpm !== info.limitTokens || known.rpm !== info.limitRequests)) {
      this.knownLimits = { ...this.knownLimits, [m]: { tpm: info.limitTokens ?? known?.tpm ?? null, rpm: info.limitRequests ?? known?.rpm ?? null, at: new Date().toISOString() } }
      this.log.info('OpenAI limits detected', { model: m, tokensPerMinute: info.limitTokens, requestsPerMinute: info.limitRequests })
      try {
        if (this.s.db.isOpen) this.s.cache.set(OPENAI_LIMITS_CACHE_KEY, this.knownLimits)
      } catch {
        /* best effort */
      }
      this.changed()
    }
    this.pump(lane)
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

  // ---------------------------------------------------------------------------
  // OpenAI lanes
  // ---------------------------------------------------------------------------

  private emitJob(jobId: string): void {
    try {
      if (!this.s.db.isOpen) return
      const view = this.s.jobs.getView(jobId)
      if (view) this.s.events.jobChanged(view)
    } catch {
      /* the queue view is best-effort */
    }
  }

  /** Marks a job as waiting for a provider limit (shown in the queue; one log line per wait). */
  markWaiting(jobId: string | null | undefined, w: WaitingFor): void {
    if (!jobId) return
    const prev = jobWaits.get(jobId)
    if (prev && prev.reason === w.reason && Math.abs(prev.untilMs - w.untilMs) < 1_000) return
    jobWaits.set(jobId, w)
    if (!prev || prev.reason !== w.reason) {
      this.log.info(w.reason === 'rate_limit' ? 'Waiting for the OpenAI rate limit' : 'Waiting for the OpenAI token budget', { jobId, model: w.model, seconds: Math.max(0, Math.round((w.untilMs - Date.now()) / 1000)) })
    }
    this.emitJob(jobId)
  }

  clearWaiting(jobId: string | null | undefined): void {
    if (jobId && jobWaits.clear(jobId)) this.emitJob(jobId)
  }

  /** A retry after a 429 waits outside the lane; the job still shows why (called by the pipeline). */
  noteRetryWait(jobId: string | null | undefined, model: string, delayMs: number, kind: string): void {
    if (kind !== 'rate_limit' || delayMs < SHOW_WAIT_MS) return
    this.markWaiting(jobId, { provider: 'openai', reason: 'rate_limit', model, untilMs: Date.now() + delayMs })
  }

  /** Sends whatever fits: highest priority first; a request that does not fit holds the ones behind it. */
  private pump(lane: Lane): void {
    if (lane.timer) {
      clearTimeout(lane.timer)
      lane.timer = null
    }
    if (this.stopped) return
    const now = Date.now()
    while (lane.queue.length && lane.active < this.laneLimit(lane)) {
      const head = lane.queue[0]!
      const wait = lane.budget.waitMs(head.cost, now)
      if (wait > 0) {
        const reason: WaitingFor['reason'] = lane.budget.blockedUntil > now ? 'rate_limit' : 'budget'
        if (wait >= SHOW_WAIT_MS) {
          for (const w of lane.queue) this.markWaiting(w.jobId, { provider: 'openai', reason, model: lane.model, untilMs: now + wait })
        }
        lane.timer = setTimeout(() => this.pump(lane), Math.min(60_000, Math.max(25, wait)))
        lane.timer.unref?.()
        return
      }
      lane.queue.shift()
      lane.active++
      const r = lane.budget.reserve(head.cost, now)
      this.clearWaiting(head.jobId)
      head.grant(r)
    }
  }

  private acquireLane(lane: Lane, cost: number, priority: number, jobId: string | null, signal?: AbortSignal): Promise<{ id: number; sentAt: number }> {
    if (signal?.aborted) return Promise.reject(new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false }))
    return new Promise((resolve, reject) => {
      const waiter: LaneWaiter = {
        priority,
        seq: this.seq++,
        cost,
        jobId,
        enqueuedAt: Date.now(),
        grant: (r) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        }
      }
      const onAbort = (): void => {
        const i = lane.queue.indexOf(waiter)
        if (i >= 0) lane.queue.splice(i, 1)
        this.clearWaiting(jobId)
        reject(new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false }))
        this.pump(lane)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      lane.queue.push(waiter)
      lane.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      this.pump(lane)
    })
  }

  // ---------------------------------------------------------------------------
  // Guarded calls
  // ---------------------------------------------------------------------------

  /**
   * Runs one OpenAI request in its model's lane. `spec` may be a bare priority (legacy callers:
   * the "default" lane, no token estimate). Every call is recorded in provider_calls.
   */
  async withOpenAI<T>(spec: OpenAICallSpec | number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const sp: OpenAICallSpec = typeof spec === 'number' ? { model: 'default', priority: spec } : spec
    await this.openaiBreaker.waitIfOpen(signal).catch((e) => {
      throw toAppError(e)
    })
    const lane = this.lane(sp.model)
    lane.lastUsed = Date.now()
    const cost = Math.max(1, Math.round(sp.estTokens ?? 0))
    const queuedAt = Date.now()
    const reservation = await this.acquireLane(lane, cost, sp.priority, sp.jobId ?? null, signal)
    const ctx: ProviderCallContext = { model: lane.model, sentAt: reservation.sentAt, headers: null, status: null, requests: 0 }
    const started = Date.now()
    let error: AppError | null = null
    try {
      const out = await providerCallStore.run(ctx, fn)
      this.openaiBreaker.recordSuccess()
      if (this.auto) {
        const before = lane.aimd.value
        if (lane.aimd.onSuccess() !== before) this.changed()
      }
      return out
    } catch (e) {
      const err = toAppError(e)
      error = err
      if (err.kind === 'rate_limit') {
        if (this.auto) {
          lane.aimd.onRateLimit()
          this.log.info('OpenAI rate limit — lowering concurrency for this model', { model: lane.model, limit: lane.aimd.value, retryAfterMs: err.retryAfterMs ?? null })
        }
        // Hold this model's other requests for as long as OpenAI asked (they would only get 429s too).
        const pause = Math.min(120_000, Math.max(500, err.retryAfterMs ?? 1_000))
        lane.budget.blockedUntil = Math.max(lane.budget.blockedUntil, Date.now() + pause)
        this.changed()
      } else if (isTransientKind(err.kind)) {
        // 429s are handled per model above; only network/server failures pause the whole provider.
        this.openaiBreaker.recordFailure(err.message)
      }
      throw err
    } finally {
      lane.active--
      lane.budget.release(reservation.id)
      this.recordCall(sp, lane.model, ctx, started, started - queuedAt, cost, error)
      this.pump(lane)
    }
  }

  private recordCall(sp: OpenAICallSpec, model: string, ctx: ProviderCallContext, started: number, waitedMs: number, cost: number, error: AppError | null): void {
    try {
      if (!this.s.db.isOpen) return
      const h = ctx.headers
      this.s.providerCalls.record({
        provider: 'openai',
        model,
        kind: sp.kind ?? null,
        jobId: sp.jobId ?? null,
        status: ctx.status ?? (error ? (error.httpStatus ?? null) : 200),
        errorKind: error ? error.kind : null,
        latencyMs: Date.now() - started,
        waitedMs,
        estTokens: sp.estTokens ? cost : null,
        retry: sp.attempt ?? 0,
        limitRequests: h?.limitRequests ?? null,
        remainingRequests: h?.remainingRequests ?? null,
        resetRequestsMs: h?.resetRequestsMs ?? null,
        limitTokens: h?.limitTokens ?? null,
        remainingTokens: h?.remainingTokens ?? null,
        resetTokensMs: h?.resetTokensMs ?? null
      })
    } catch {
      /* the log is best-effort */
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

  /** Per-model OpenAI limits for Settings → OpenAI and the queue. */
  openaiModels(): OpenAIModelLimit[] {
    const out: OpenAIModelLimit[] = []
    const now = Date.now()
    const names = new Set([...this.lanes.keys(), ...Object.keys(this.knownLimits)])
    names.delete('default')
    for (const model of [...names].sort()) {
      const lane = this.lanes.get(model)
      const known = this.knownLimits[model]
      const snap = lane?.budget.snapshot
      const tpm = snap?.limitTokens ?? known?.tpm ?? null
      const rpm = snap?.limitRequests ?? known?.rpm ?? null
      out.push({
        model,
        concurrency: lane ? this.laneLimit(lane) : this.auto ? 6 : this.s.settings.get().openai.concurrency,
        inFlight: lane?.active ?? 0,
        waiting: lane?.queue.length ?? 0,
        tokensPerMinute: tpm,
        requestsPerMinute: rpm,
        remainingTokens: lane ? lane.budget.tokensAvailable(now) : null,
        source: tpm !== null || rpm !== null ? 'headers' : 'unknown',
        detectedAt: known?.at ?? null,
        blockedUntil: lane && lane.budget.blockedUntil > now ? new Date(lane.budget.blockedUntil).toISOString() : null
      })
    }
    return out
  }

  status(): { openai: ProviderLiveStatus; elevenlabs: ProviderLiveStatus } {
    const auto = this.auto
    const e = this.elevenSem.state()
    const ob = this.openaiBreaker.state()
    const eb = this.elevenBreaker.state()
    let inUse = 0
    let waiting = 0
    for (const l of this.lanes.values()) {
      inUse += l.active
      waiting += l.queue.length
    }
    const models = this.openaiModels()
    const primary = this.primaryLane()
    const pm = primary ? models.find((m) => m.model === primary.model) : undefined
    const detail = auto
      ? pm?.tokensPerMinute
        ? `per model, adapts to your limits (${pm.model}: ${pm.tokensPerMinute.toLocaleString('en-US')} tokens/min)`
        : 'per model, adapts to your rate limits'
      : 'set manually (per model)'
    return {
      openai: {
        limit: this.openaiLimit(),
        inUse,
        waiting,
        source: auto ? (models.some((m) => m.source === 'headers') ? 'headers' : 'adaptive') : 'manual',
        detail,
        coolingDownUntil: ob.openUntil,
        lastError: ob.lastError,
        models
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
