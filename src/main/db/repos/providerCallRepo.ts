import type { Database } from '../database'

/** One provider request as recorded in `provider_calls` (1.6.1). */
export interface ProviderCall {
  id: number
  at: string
  provider: 'openai' | 'elevenlabs'
  model: string | null
  kind: string | null
  jobId: string | null
  /** HTTP status (200 on success); null when no response arrived (network error, cancel). */
  status: number | null
  errorKind: string | null
  latencyMs: number
  /** Time the request waited for our own per-model budget before it was sent. */
  waitedMs: number
  estTokens: number | null
  /** 0 for the first attempt, n for the n-th retry. */
  retry: number
  limitRequests: number | null
  remainingRequests: number | null
  resetRequestsMs: number | null
  limitTokens: number | null
  remainingTokens: number | null
  resetTokensMs: number | null
}

export type NewProviderCall = Omit<ProviderCall, 'id' | 'at'> & { at?: string }

interface Row {
  id: number
  at: string
  provider: string
  model: string | null
  kind: string | null
  job_id: string | null
  status: number | null
  error_kind: string | null
  latency_ms: number
  waited_ms: number
  est_tokens: number | null
  retry: number
  limit_requests: number | null
  remaining_requests: number | null
  reset_requests_ms: number | null
  limit_tokens: number | null
  remaining_tokens: number | null
  reset_tokens_ms: number | null
}

/** Newest rows kept; older ones are pruned in small batches. */
export const PROVIDER_CALLS_KEEP = 5000
const PRUNE_EVERY = 100

export class ProviderCallRepo {
  private sincePrune = 0

  constructor(
    private db: Database,
    readonly keep = PROVIDER_CALLS_KEEP
  ) {}

  record(c: NewProviderCall): void {
    if (!this.db.isOpen) return
    this.db.run(
      `INSERT INTO provider_calls (at, provider, model, kind, job_id, status, error_kind, latency_ms, waited_ms, est_tokens, retry,
         limit_requests, remaining_requests, reset_requests_ms, limit_tokens, remaining_tokens, reset_tokens_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.at ?? new Date().toISOString(),
      c.provider,
      c.model,
      c.kind,
      c.jobId,
      c.status,
      c.errorKind,
      Math.max(0, Math.round(c.latencyMs)),
      Math.max(0, Math.round(c.waitedMs)),
      c.estTokens,
      c.retry,
      c.limitRequests,
      c.remainingRequests,
      c.resetRequestsMs,
      c.limitTokens,
      c.remainingTokens,
      c.resetTokensMs
    )
    if (++this.sincePrune >= PRUNE_EVERY) this.prune()
  }

  prune(): number {
    this.sincePrune = 0
    const max = this.db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM provider_calls')?.m ?? 0
    const cutoff = max - this.keep
    if (cutoff <= 0) return 0
    const before = this.count()
    this.db.run('DELETE FROM provider_calls WHERE id <= ?', cutoff)
    return before - this.count()
  }

  count(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM provider_calls')?.c ?? 0
  }

  list(opts: { jobId?: string; limit?: number } = {}): ProviderCall[] {
    const rows = opts.jobId
      ? this.db.all<Row>('SELECT * FROM provider_calls WHERE job_id = ? ORDER BY id DESC LIMIT ?', opts.jobId, opts.limit ?? 200)
      : this.db.all<Row>('SELECT * FROM provider_calls ORDER BY id DESC LIMIT ?', opts.limit ?? 200)
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      provider: r.provider === 'elevenlabs' ? 'elevenlabs' : 'openai',
      model: r.model,
      kind: r.kind,
      jobId: r.job_id,
      status: r.status,
      errorKind: r.error_kind,
      latencyMs: r.latency_ms,
      waitedMs: r.waited_ms,
      estTokens: r.est_tokens,
      retry: r.retry,
      limitRequests: r.limit_requests,
      remainingRequests: r.remaining_requests,
      resetRequestsMs: r.reset_requests_ms,
      limitTokens: r.limit_tokens,
      remainingTokens: r.remaining_tokens,
      resetTokensMs: r.reset_tokens_ms
    }))
  }
}
