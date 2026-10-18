import { sleep } from './common'
import { AppError, toAppError } from './errors'

export interface RetryOptions {
  maxRetries: number
  /** Retries allowed for rate-limit errors (default: maxRetries); each honours Retry-After. */
  maxRateLimitRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, delayMs: number, err: AppError) => void
  /** Random source (injectable for deterministic tests). */
  random?: () => number
}

/** Exponential backoff with full jitter; honours Retry-After when the error carries it. */
export function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(maxDelayMs, retryAfterMs + Math.floor(random() * 500))
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
  return Math.floor(random() * exp) + Math.floor(baseDelayMs / 2)
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 60000
  const random = opts.random ?? Math.random
  let attempt = 0
  let rateLimited = 0
  let other = 0
  while (true) {
    try {
      if (opts.signal?.aborted) throw new AppError('cancelled', 'Cancelled before the request started.', { retryable: false })
      return await fn(attempt)
    } catch (e) {
      const err = toAppError(e)
      if (!err.retryable || opts.signal?.aborted) throw err
      const isRateLimit = err.kind === 'rate_limit'
      if (isRateLimit ? rateLimited >= (opts.maxRateLimitRetries ?? opts.maxRetries) : other >= opts.maxRetries) throw err
      if (opts.maxRateLimitRetries === undefined && attempt >= opts.maxRetries) throw err
      if (isRateLimit) rateLimited++
      else other++
      const delay = computeBackoffMs(isRateLimit ? rateLimited - 1 : other - 1, base, max, random, err.retryAfterMs)
      opts.onRetry?.(attempt + 1, delay, err)
      await sleep(delay, opts.signal)
      attempt++
    }
  }
}

/** Simple counting semaphore used for per-provider concurrency limits. */
export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0

  constructor(private limit: number) {}

  setLimit(n: number): void {
    this.limit = Math.max(1, n)
    this.drain()
  }

  get inUse(): number {
    return this.active
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false })
    await new Promise<void>((resolve, reject) => {
      const tryAcquire = (): void => {
        if (this.active < this.limit) {
          this.active++
          signal?.removeEventListener('abort', onAbort)
          resolve()
        } else {
          this.queue.push(tryAcquire)
        }
      }
      const onAbort = (): void => {
        const i = this.queue.indexOf(tryAcquire)
        if (i >= 0) this.queue.splice(i, 1)
        reject(new AppError('cancelled', 'Cancelled while waiting for a free slot.', { retryable: false }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      tryAcquire()
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
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift()!
      next()
    }
  }
}
