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
  onOpenAI: ((info: OpenAIRateInfo) => void) | null
  onEleven: ((info: ElevenConcurrencyInfo) => void) | null
} = { onOpenAI: null, onEleven: null }
