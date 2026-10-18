import { AppError } from '../util/errors'
import { sleep } from '../util/common'

/**
 * Concurrency and resilience primitives used by the pipeline (v1.5):
 * - PrioritySemaphore: per-provider slots; later pipeline stages win ties so finished files
 *   appear early while research for later titles keeps the pipeline full.
 * - AimdController: adaptive OpenAI concurrency (additive increase, multiplicative decrease).
 * - CircuitBreaker: after K consecutive transient failures a provider is paused for a cool-down.
 * - Header parsers for OpenAI rate-limit headers and ElevenLabs concurrency headers.
 */

export interface SemaphoreState {
  limit: number
  inUse: number
  waiting: number
}

interface Waiter {
  priority: number
  seq: number
  grant: () => void
}

export class PrioritySemaphore {
  private waiters: Waiter[] = []
  private active = 0
  private seq = 0

  constructor(private limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, Math.floor(n))
    this.drain()
  }

  get currentLimit(): number {
    return this.limit
  }

  get inUse(): number {
    return this.active
  }

  state(): SemaphoreState {
    return { limit: this.limit, inUse: this.active, waiting: this.waiters.length }
  }

  /** Higher `priority` is served first; equal priorities are FIFO. */
  async acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    if (signal?.aborted) throw new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false })
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        seq: this.seq++,
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
      }
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
      this.waiters.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      this.drain()
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length) {
      const next = this.waiters.shift()!
      this.active++
      next.grant()
    }
  }
}

/** Stage priorities for provider slots: finish what is furthest along first. */
export const PRIORITY = { research: 1, script: 2, review: 2, audio: 3 } as const

// ---------------------------------------------------------------------------
// AIMD (OpenAI)
// ---------------------------------------------------------------------------

export class AimdController {
  private successStreak = 0
  value: number

  constructor(
    readonly opts: { start: number; min: number; max: number; increaseAfter: number } = { start: 4, min: 1, max: 10, increaseAfter: 5 }
  ) {
    this.value = clamp(opts.start, opts.min, opts.max)
  }

  onSuccess(): number {
    this.successStreak++
    if (this.successStreak >= this.opts.increaseAfter && this.value < this.opts.max) {
      this.value++
      this.successStreak = 0
    }
    return this.value
  }

  onRateLimit(): number {
    this.successStreak = 0
    this.value = Math.max(this.opts.min, Math.floor(this.value / 2))
    return this.value
  }

  /** Never run more requests at once than the provider says we may send right now. */
  capTo(remainingRequests: number | null): number {
    if (remainingRequests !== null && remainingRequests >= 0) this.value = clamp(Math.min(this.value, Math.max(1, remainingRequests)), this.opts.min, this.opts.max)
    return this.value
  }
}

export interface OpenAIRateInfo {
  limitRequests: number | null
  remainingRequests: number | null
  limitTokens: number | null
  remainingTokens: number | null
  resetRequestsMs: number | null
  resetTokensMs: number | null
  at: number
}

type HeaderBag = Headers | Record<string, string | string[] | undefined> | null | undefined

function header(h: HeaderBag, name: string): string | null {
  if (!h) return null
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name)
  const rec = h as Record<string, string | string[] | undefined>
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name)
  const v = key ? rec[key] : undefined
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

function num(v: string | null): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** "1s", "6m0s", "20ms", "1h2m3.5s" → milliseconds. */
export function parseDurationMs(v: string | null): number | null {
  if (!v) return null
  const trimmed = v.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  let total = 0
  let matched = false
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed))) {
    matched = true
    const n = Number(m[1])
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000
  }
  return matched ? Math.round(total) : null
}

export function parseOpenAIRateHeaders(h: HeaderBag): OpenAIRateInfo | null {
  const info: OpenAIRateInfo = {
    limitRequests: num(header(h, 'x-ratelimit-limit-requests')),
    remainingRequests: num(header(h, 'x-ratelimit-remaining-requests')),
    limitTokens: num(header(h, 'x-ratelimit-limit-tokens')),
    remainingTokens: num(header(h, 'x-ratelimit-remaining-tokens')),
    resetRequestsMs: parseDurationMs(header(h, 'x-ratelimit-reset-requests')),
    resetTokensMs: parseDurationMs(header(h, 'x-ratelimit-reset-tokens')),
    at: Date.now()
  }
  return info.limitRequests === null && info.remainingRequests === null && info.remainingTokens === null ? null : info
}

/**
 * How long OpenAI asks us to wait after a 429 (1.6.1): `retry-after-ms`, then `retry-after`
 * (seconds or an HTTP date), then the token/request window reset the headers report.
 */
export function retryAfterFromHeaders(h: HeaderBag): number | undefined {
  const ms = num(header(h, 'retry-after-ms'))
  if (ms !== null && ms >= 0) return ms
  const ra = header(h, 'retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const date = Date.parse(ra)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  const info = parseOpenAIRateHeaders(h)
  if (!info) return undefined
  const waits: number[] = []
  if (info.remainingTokens !== null && info.remainingTokens <= 0 && info.resetTokensMs !== null) waits.push(info.resetTokensMs)
  if (info.remainingRequests !== null && info.remainingRequests <= 0 && info.resetRequestsMs !== null) waits.push(info.resetRequestsMs)
  if (!waits.length && info.resetTokensMs !== null) waits.push(info.resetTokensMs)
  return waits.length ? Math.max(...waits) : undefined
}

// ---------------------------------------------------------------------------
// Per-model token budget (OpenAI, 1.6.1)
// ---------------------------------------------------------------------------

interface Reservation {
  cost: number
  sentAt: number
}

/**
 * OpenAI limits are per model: tokens per minute (TPM) and requests per minute (RPM). OpenAI
 * counts a request against TPM when it arrives, at (input tokens + max_output_tokens). This keeps
 * an estimate of what is left: the last response headers (remaining / reset), refilled linearly
 * up to the limit, minus the reservations of requests sent after the request those headers
 * belong to (the server had not counted them yet). Until the first headers arrive nothing is
 * limited — the limits are learned, never guessed.
 */
export class ModelBudget {
  private snap: (OpenAIRateInfo & { sentAt: number }) | null = null
  private inflight = new Map<number, Reservation>()
  /** Finished requests the latest headers may not include yet. */
  private settled: Reservation[] = []
  private nextId = 1
  private lastSentAt = 0
  /** Requests pause until here after a 429. */
  blockedUntil = 0

  get snapshot(): (OpenAIRateInfo & { sentAt: number }) | null {
    return this.snap
  }

  /** Seeds a full bucket from limits seen in an earlier session. */
  seed(limitTokens: number | null, limitRequests: number | null, now = Date.now()): void {
    if (this.snap || (!limitTokens && !limitRequests)) return
    this.snap = { limitTokens, remainingTokens: limitTokens, resetTokensMs: 0, limitRequests, remainingRequests: limitRequests, resetRequestsMs: 0, at: now, sentAt: 0 }
  }

  /** Response headers of a request sent at `sentAt`. Older information than what we have is ignored. */
  observe(info: OpenAIRateInfo, sentAt: number): void {
    if (this.snap && sentAt < this.snap.sentAt) return
    // Keep known limits when a response omits one of them.
    const prev = this.snap
    this.snap = {
      ...info,
      limitTokens: info.limitTokens ?? prev?.limitTokens ?? null,
      limitRequests: info.limitRequests ?? prev?.limitRequests ?? null,
      sentAt
    }
    this.settled = this.settled.filter((r) => r.sentAt > sentAt)
  }

  private pending(): { tokens: number; requests: number } {
    const after = this.snap?.sentAt ?? 0
    let tokens = 0
    let requests = 0
    for (const r of this.inflight.values()) {
      if (r.sentAt > after) {
        tokens += r.cost
        requests++
      }
    }
    for (const r of this.settled) {
      if (r.sentAt > after) {
        tokens += r.cost
        requests++
      }
    }
    return { tokens, requests }
  }

  private static refill(limit: number | null, remaining: number | null, resetMs: number | null, elapsed: number): { value: number; ratePerMs: number } | null {
    if (limit === null || remaining === null) return null
    const missing = Math.max(0, limit - remaining)
    // The reset header is the time until the window is full again; fall back to a per-minute window.
    const ratePerMs = resetMs && resetMs > 0 && missing > 0 ? missing / resetMs : limit / 60_000
    return { value: Math.min(limit, remaining + ratePerMs * Math.max(0, elapsed)), ratePerMs }
  }

  /** Estimated tokens available now (null = unknown). */
  tokensAvailable(now = Date.now()): number | null {
    const s = this.snap
    if (!s) return null
    const r = ModelBudget.refill(s.limitTokens, s.remainingTokens, s.resetTokensMs, now - s.at)
    return r ? Math.floor(r.value - this.pending().tokens) : null
  }

  requestsAvailable(now = Date.now()): number | null {
    const s = this.snap
    if (!s) return null
    const r = ModelBudget.refill(s.limitRequests, s.remainingRequests, s.resetRequestsMs, now - s.at)
    return r ? Math.floor(r.value - this.pending().requests) : null
  }

  get inFlight(): number {
    return this.inflight.size
  }

  /**
   * Milliseconds until a request of `cost` tokens fits (0 = send now). A request larger than the
   * whole limit is let through alone with a full bucket (OpenAI then decides).
   */
  waitMs(cost: number, now = Date.now()): number {
    const blocked = Math.max(0, this.blockedUntil - now)
    const s = this.snap
    if (!s) return blocked
    const pend = this.pending()
    let wait = 0
    const t = ModelBudget.refill(s.limitTokens, s.remainingTokens, s.resetTokensMs, now - s.at)
    if (t && s.limitTokens) {
      const need = Math.min(cost, s.limitTokens) + pend.tokens - t.value
      if (need > 0) wait = Math.max(wait, need / t.ratePerMs)
    }
    const r = ModelBudget.refill(s.limitRequests, s.remainingRequests, s.resetRequestsMs, now - s.at)
    if (r && s.limitRequests) {
      const need = 1 + pend.requests - r.value
      if (need > 0) wait = Math.max(wait, need / r.ratePerMs)
    }
    return Math.max(blocked, Math.ceil(wait))
  }

  /** Reserves `cost` tokens; `sentAt` is strictly increasing so headers can be ordered exactly. */
  reserve(cost: number, now = Date.now()): { id: number; sentAt: number } {
    const id = this.nextId++
    const sentAt = Math.max(now, this.lastSentAt + 0.001)
    this.lastSentAt = sentAt
    this.inflight.set(id, { cost: Math.max(0, cost), sentAt })
    return { id, sentAt }
  }

  release(id: number): void {
    const r = this.inflight.get(id)
    if (!r) return
    this.inflight.delete(id)
    if (!this.snap || r.sentAt > this.snap.sentAt) this.settled.push(r)
    if (this.settled.length > 500) this.settled.splice(0, this.settled.length - 500)
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs concurrency
// ---------------------------------------------------------------------------

export interface ElevenConcurrencyInfo {
  current: number | null
  maximum: number | null
  at: number
}

export function parseElevenConcurrencyHeaders(h: HeaderBag): ElevenConcurrencyInfo | null {
  const current = num(header(h, 'current-concurrent-requests'))
  const maximum = num(header(h, 'maximum-concurrent-requests'))
  return current === null && maximum === null ? null : { current, maximum, at: Date.now() }
}

/**
 * Concurrency per plan from the ElevenLabs models page, "Concurrency and priority" table
 * (https://elevenlabs.io/docs/overview/models, checked 2026-10-18). The "Multilingual v2"
 * column applies to the quality models (v2/v3/v4); Flash models allow twice as many.
 * Free 2/4 · Starter 3/6 · Creator 5/10 · Pro 10/20 · Scale 15/30 · Business 15/30.
 * The live `maximum-concurrent-requests` response header always takes precedence.
 */
export const ELEVEN_TIER_CONCURRENCY: Array<{ match: RegExp; quality: number; flash: number }> = [
  { match: /^free/i, quality: 2, flash: 4 },
  { match: /^starter/i, quality: 3, flash: 6 },
  { match: /^creator/i, quality: 5, flash: 10 },
  { match: /^pro/i, quality: 10, flash: 20 },
  { match: /^(scale|growing_business)/i, quality: 15, flash: 30 },
  { match: /^business/i, quality: 15, flash: 30 },
  { match: /^enterprise/i, quality: 15, flash: 30 }
]

export function elevenConcurrencyForTier(tier: string | null | undefined, modelId: string): number | null {
  if (!tier) return null
  const row = ELEVEN_TIER_CONCURRENCY.find((r) => r.match.test(tier.trim()))
  if (!row) return null
  return /flash|turbo/i.test(modelId) ? row.flash : row.quality
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface BreakerState {
  open: boolean
  openUntil: string | null
  consecutiveFailures: number
  lastError: string | null
}

export class CircuitBreaker {
  private failures = 0
  private openUntilMs = 0
  private lastError: string | null = null

  constructor(
    readonly name: string,
    readonly opts: { threshold: number; cooldownMs: number } = { threshold: 4, cooldownMs: 30_000 },
    private onChange?: () => void
  ) {}

  /** Transient failures (network / 5xx / timeouts / rate limits) count; everything else does not. */
  recordFailure(message: string): void {
    this.failures++
    this.lastError = message
    if (this.failures >= this.opts.threshold && Date.now() >= this.openUntilMs) {
      this.openUntilMs = Date.now() + this.opts.cooldownMs
      this.onChange?.()
    }
  }

  recordSuccess(): void {
    const wasOpen = this.failures >= this.opts.threshold
    this.failures = 0
    this.lastError = null
    if (wasOpen) {
      this.openUntilMs = 0
      this.onChange?.()
    }
  }

  isOpen(now = Date.now()): boolean {
    return now < this.openUntilMs
  }

  state(): BreakerState {
    const open = this.isOpen()
    return { open, openUntil: open ? new Date(this.openUntilMs).toISOString() : null, consecutiveFailures: this.failures, lastError: this.lastError }
  }

  /** Waits out an open breaker (abortable). After the cool-down one request is let through to probe. */
  async waitIfOpen(signal?: AbortSignal): Promise<void> {
    while (this.isOpen()) {
      await sleep(Math.min(1000, Math.max(50, this.openUntilMs - Date.now())), signal)
    }
  }
}

export function isTransientKind(kind: string): boolean {
  return kind === 'network' || kind === 'provider_down' || kind === 'rate_limit'
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

// ---------------------------------------------------------------------------
// Provider telemetry (providers push response headers; the pipeline's governor listens)
// ---------------------------------------------------------------------------

export const providerTelemetry: {
  /** `model` is the model the request asked for (limits are per model). */
  onOpenAI: ((info: OpenAIRateInfo, model?: string) => void) | null
  onEleven: ((info: ElevenConcurrencyInfo) => void) | null
} = { onOpenAI: null, onEleven: null }
