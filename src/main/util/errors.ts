import type { ErrorKind, JobError } from '@shared/types'

/** Application error carrying a classification, a user-facing action and retry hint. */
export class AppError extends Error {
  kind: ErrorKind
  action: string
  details?: string
  retryable: boolean
  retryAfterMs?: number
  code: string
  /** HTTP status of the provider response, when there was one (1.6.1, provider_calls). */
  httpStatus?: number

  constructor(kind: ErrorKind, message: string, opts: { action?: string; details?: string; retryable?: boolean; retryAfterMs?: number; code?: string; httpStatus?: number } = {}) {
    super(message)
    this.name = 'AppError'
    this.kind = kind
    this.action = opts.action ?? defaultAction(kind)
    this.details = opts.details
    this.retryable = opts.retryable ?? defaultRetryable(kind)
    this.retryAfterMs = opts.retryAfterMs
    this.code = opts.code ?? kind.toUpperCase()
    this.httpStatus = opts.httpStatus
  }

  toJobError(): JobError {
    return { kind: this.kind, message: this.message, action: this.action, details: this.details, retryable: this.retryable, at: new Date().toISOString() }
  }
}

function defaultAction(kind: ErrorKind): string {
  switch (kind) {
    case 'network':
      return 'Check your internet connection and retry the job.'
    case 'auth':
      return 'Open Settings and enter a valid API key, then use "Test connection".'
    case 'rate_limit':
      return 'The provider is rate-limiting requests. The job will retry automatically; lower concurrency in Settings if this keeps happening.'
    case 'quota':
      return 'Your provider account has insufficient credits or quota. Top up the account, then retry the job.'
    case 'provider_down':
      return 'The provider reported a server error. Retry later.'
    case 'validation':
      return 'Open the script, fix the listed issues (or regenerate), then approve it.'
    case 'ambiguous':
      return 'Choose the correct title in the Research Review dialog.'
    case 'insufficient_info':
      return 'Add manual research notes for this title, or choose a different title.'
    case 'spending_limit':
      return 'Raise or clear the spending limit in Settings → Spending, then resume the queue.'
    case 'filesystem':
      return 'Check the output folder, free disk space and permissions, then retry.'
    case 'cancelled':
      return 'The job was cancelled.'
    case 'config':
      return 'Fix the configuration in Settings or in the channel profile, then retry.'
    default:
      return 'Retry the job. If it fails again, check Settings → Advanced → Logs.'
  }
}

function defaultRetryable(kind: ErrorKind): boolean {
  return kind === 'network' || kind === 'rate_limit' || kind === 'provider_down' || kind === 'unknown'
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

export function toAppError(e: unknown, fallbackKind: ErrorKind = 'unknown'): AppError {
  if (isAppError(e)) return e
  if (e instanceof Error) {
    if (e.name === 'AbortError' || /aborted/i.test(e.message)) return new AppError('cancelled', 'The request was cancelled.', { retryable: false })
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || /fetch failed/i.test(e.message)) {
      return new AppError('network', 'Could not reach the provider (no internet connection or DNS failure).', { details: e.message })
    }
    return new AppError(fallbackKind, e.message, { details: e.stack })
  }
  return new AppError(fallbackKind, String(e))
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}
