import { AsyncLocalStorage } from 'node:async_hooks'
import type { WaitingFor } from '@shared/types'
import type { OpenAIRateInfo } from './limits'

/**
 * Per-request context (1.6.1). The governor runs every provider call inside one, so the provider
 * code can attach the response headers it saw to the right model lane and provider_calls row
 * without threading ids through every request type.
 */
export interface ProviderCallContext {
  model: string
  /** When the request left our queue (the server counts it against the limit from here). */
  sentAt: number
  /** Rate-limit headers of the response (or of the error response), when there were any. */
  headers: OpenAIRateInfo | null
  /** HTTP status of the last response (200 / 429 / …) when known. */
  status: number | null
  /** HTTP requests made inside this call (a parameter fallback can add one). */
  requests: number
}

export const providerCallStore = new AsyncLocalStorage<ProviderCallContext>()

export function currentProviderCall(): ProviderCallContext | undefined {
  return providerCallStore.getStore()
}

/**
 * Jobs whose next provider request is waiting for a limit (in memory; shown in the queue).
 * JobRepo views read from here, so every job:changed payload carries the current state.
 */
class JobWaits {
  private map = new Map<string, WaitingFor>()

  get(jobId: string): WaitingFor | null {
    const w = this.map.get(jobId)
    if (!w) return null
    // A wait that is long over is no longer news (the request is about to go out).
    if (w.untilMs < Date.now() - 2_000) {
      this.map.delete(jobId)
      return null
    }
    return w
  }

  set(jobId: string, w: WaitingFor): void {
    this.map.set(jobId, w)
  }

  /** Returns true when something was cleared. */
  clear(jobId: string): boolean {
    return this.map.delete(jobId)
  }

  clearAll(): void {
    this.map.clear()
  }

  size(): number {
    return this.map.size
  }
}

export const jobWaits = new JobWaits()
