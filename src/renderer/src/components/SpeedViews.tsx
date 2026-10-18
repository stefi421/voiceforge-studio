import { useEffect, useState, type JSX } from 'react'
import { api } from '@/lib/api'
import { CheckCircle2, CircleAlert, CircleX, Loader2 } from 'lucide-react'
import type { JobTimings, PreflightCheck, PreflightResult, ProviderLiveStatus, TimingStage, TimingSummary } from '@shared/types'

// ---------------------------------------------------------------------------
// Pre-flight checklist (confirm dialog)
// ---------------------------------------------------------------------------

const PF_ICON: Record<PreflightCheck['status'], JSX.Element> = {
  ok: <CheckCircle2 size={15} aria-hidden />,
  warning: <CircleAlert size={15} aria-hidden />,
  error: <CircleX size={15} aria-hidden />
}

export function PreflightChecklist({ result, loading }: { result: PreflightResult | null; loading: boolean }): JSX.Element {
  if (loading && !result) {
    return (
      <div className="pf-list" aria-busy="true">
        <div className="pf-row pf-loading">
          <Loader2 size={15} className="spin" aria-hidden />
          <span>Checking keys, voices, credits and the output folder…</span>
        </div>
      </div>
    )
  }
  if (!result) return <></>
  return (
    <ul className="pf-list" aria-label="Pre-flight checks">
      {result.checks.map((c, i) => (
        <li key={`${c.key}-${i}`} className={`pf-row pf-${c.status}`}>
          <span className="pf-icon">{PF_ICON[c.status]}</span>
          <span className="pf-text">
            <span className="pf-label">{c.label}</span>
            <span className="pf-message">{c.message}</span>
            {c.status !== 'ok' && c.action && <span className="pf-action">{c.action}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

export const TIMING_LABEL: Record<TimingStage, string> = {
  research: 'Research',
  script: 'Script',
  validate: 'Checks',
  audio: 'Voice',
  save: 'Save',
  waiting: 'Waiting'
}

const TIMING_ORDER: TimingStage[] = ['research', 'script', 'validate', 'audio', 'save', 'waiting']

export function formatSeconds(s: number): string {
  if (!(s > 0)) return '0s'
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 90) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m}m ${r}s` : `${m}m`
}

/** Horizontal bar: one segment per stage, widths proportional to time. */
export function TimingBar({ totals, compact }: { totals: Record<TimingStage, number>; compact?: boolean }): JSX.Element {
  const total = TIMING_ORDER.reduce((n, k) => n + (totals[k] ?? 0), 0)
  if (!(total > 0)) return <div className="timing-bar timing-empty" />
  return (
    <div className={`timing-bar${compact ? ' timing-compact' : ''}`} role="img" aria-label={TIMING_ORDER.filter((k) => totals[k] > 0).map((k) => `${TIMING_LABEL[k]} ${formatSeconds(totals[k])}`).join(', ')}>
      {TIMING_ORDER.filter((k) => totals[k] > 0).map((k) => (
        <span key={k} className={`timing-seg t-${k}`} style={{ flexGrow: totals[k] }} title={`${TIMING_LABEL[k]} · ${formatSeconds(totals[k])}`} />
      ))}
    </div>
  )
}

export function TimingLegend({ totals, showZero }: { totals: Record<TimingStage, number>; showZero?: boolean }): JSX.Element {
  return (
    <div className="timing-legend">
      {TIMING_ORDER.filter((k) => showZero || totals[k] > 0).map((k) => (
        <span key={k} className="timing-key">
          <span className={`timing-dot t-${k}`} aria-hidden />
          {TIMING_LABEL[k]} <span className="tabular">{formatSeconds(totals[k])}</span>
        </span>
      ))}
    </div>
  )
}

export function JobTimingPanel({ timings }: { timings: JobTimings | null }): JSX.Element {
  if (!timings || !timings.segments.length) return <div className="small muted">Timing appears after the first stage finishes.</div>
  return (
    <div className="timing-panel">
      <TimingBar totals={timings.totals} />
      <TimingLegend totals={timings.totals} />
      <div className="xs subtle">Total {formatSeconds(timings.totalSeconds)} · time waiting for you (approval, choosing a game) is not counted.</div>
    </div>
  )
}

/** "Research 32s · Script 41s · Voice 18s (median)" */
export function medianLine(sum: TimingSummary | null): string | null {
  if (!sum || sum.samples === 0) return null
  const m = sum.medians
  const parts = [`Research ${formatSeconds(m.research)}`, `Script ${formatSeconds(m.script + m.validate)}`]
  if (m.audio > 0) parts.push(`Voice ${formatSeconds(m.audio)}`)
  return `${parts.join(' · ')} (median of ${sum.samples})`
}

// ---------------------------------------------------------------------------
// Live provider slots
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<ProviderLiveStatus['source'], string> = {
  headers: 'from your plan',
  plan: 'from your plan',
  adaptive: 'adapts automatically',
  manual: 'set manually',
  default: 'until your plan is known'
}

export function ProviderSlots({ name, status }: { name: string; status: ProviderLiveStatus | undefined }): JSX.Element {
  if (!status) return <span className="small muted">{name}: —</span>
  const cooling = status.coolingDownUntil ? Math.max(0, Math.round((new Date(status.coolingDownUntil).getTime() - Date.now()) / 1000)) : 0
  return (
    <div className="slots-row">
      <span className="slots-name">{name}</span>
      <span className="slots-value tabular">{status.limit} at once</span>
      <span className="slots-source">{SOURCE_LABEL[status.source]}{status.detail && status.source !== 'manual' && status.source !== 'default' ? ` · ${status.detail}` : ''}</span>
      <span className="slots-live tabular" title="Requests running now / waiting for a slot">
        {status.inUse} running{status.waiting ? ` · ${status.waiting} waiting` : ''}
      </span>
      {cooling > 0 && <span className="slots-cooling">pausing {cooling}s after repeated errors</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Batch header medians (fetched when the done-count changes)
// ---------------------------------------------------------------------------

export function BatchMedians({ batchId, doneCount }: { batchId: string; doneCount: number }): JSX.Element | null {
  const [sum, setSum] = useState<TimingSummary | null>(null)
  useEffect(() => {
    if (doneCount === 0) return
    let live = true
    api
      .invoke('queue:timingSummary', { batchId })
      .then((r) => {
        if (live) setSum(r)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [batchId, doneCount])
  const line = medianLine(sum)
  return line ? <span className="batch-medians tabular">{line}</span> : null
}

// ---------------------------------------------------------------------------
// Usage → "Where time goes"
// ---------------------------------------------------------------------------

const GOES_COLOR: Record<TimingStage, string> = {
  research: 'var(--info)',
  script: 'var(--accent)',
  validate: 'var(--violet)',
  audio: 'var(--teal)',
  save: 'var(--amber)',
  waiting: 'var(--border-strong)'
}

export function WhereTimeGoes({ summary }: { summary: TimingSummary | null }): JSX.Element {
  if (!summary || summary.samples === 0) return <div className="small muted">Finish a few titles and this shows which stage takes the most time.</div>
  const stages = TIMING_ORDER.filter((k) => summary.medians[k] > 0)
  const top = stages.reduce<TimingStage | null>((a, k) => (a === null || summary.share[k] > summary.share[a] ? k : a), null)
  return (
    <div className="col gap-3">
      <div className="time-goes">
        {stages.map((k) => (
          <FragmentRow key={k} label={TIMING_LABEL[k]} share={summary.share[k]} seconds={summary.medians[k]} color={GOES_COLOR[k]} />
        ))}
      </div>
      <div className="xs subtle">
        Median of the last {summary.samples} finished title{summary.samples === 1 ? '' : 's'}: {formatSeconds(summary.medianTotalSeconds)} per title
        {top ? ` · most time goes to ${TIMING_LABEL[top].toLowerCase()} (${Math.round(summary.share[top] * 100)}%)` : ''}. Several titles run at once, so a batch finishes much faster than titles × this.
      </div>
    </div>
  )
}

function FragmentRow({ label, share, seconds, color }: { label: string; share: number; seconds: number; color: string }): JSX.Element {
  return (
    <>
      <span>{label}</span>
      <span className="time-goes-track">
        <span className="time-goes-fill" style={{ display: 'block', width: `${Math.max(2, Math.round(share * 100))}%`, background: color }} />
      </span>
      <span className="time-goes-value tabular">{formatSeconds(seconds)}</span>
    </>
  )
}
