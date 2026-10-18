import type { JSX } from 'react'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import type { ValidationReport } from '@shared/types'
import { formatNumber } from '@/lib/format'
import { Alert } from '@/components/ui'

/** Validation report split into errors (block automatic approval) and warnings (informational). */
export function ValidationIssues({ report }: { report: ValidationReport | null }): JSX.Element | null {
  if (!report) return null
  const errors = report.issues.filter((i) => i.severity === 'error')
  const warnings = report.issues.filter((i) => i.severity !== 'error')
  if (errors.length === 0 && warnings.length === 0) {
    return (
      <Alert tone="success">
        Validation passed.
        {report.sectionsFound.length > 0 ? ` Sections found: ${report.sectionsFound.join(', ')}.` : ''}
      </Alert>
    )
  }
  return (
    <div className="issue-list">
      {errors.length > 0 && (
        <>
          <div className="issue-group-title">
            {errors.length} error{errors.length === 1 ? '' : 's'} — must be fixed, or approved anyway on purpose
          </div>
          {errors.map((i, idx) => (
            <div key={`e${idx}`} className="issue issue-error">
              <CircleAlert size={14} className="text-danger" />
              <span>
                {i.message} <span className="issue-code">{i.code}</span>
              </span>
            </div>
          ))}
        </>
      )}
      {warnings.length > 0 && (
        <>
          <div className="issue-group-title">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'} — worth a look, does not block
          </div>
          {warnings.map((i, idx) => (
            <div key={`w${idx}`} className="issue issue-warning">
              <TriangleAlert size={14} className="text-warning" />
              <span>
                {i.message} <span className="issue-code">{i.code}</span>
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

export function countIssues(report: ValidationReport | null): { errors: number; warnings: number } {
  if (!report) return { errors: 0, warnings: 0 }
  return {
    errors: report.issues.filter((i) => i.severity === 'error').length,
    warnings: report.issues.filter((i) => i.severity !== 'error').length
  }
}

/** Live character counter against a channel's min/max window. */
export function CharCounter({ chars, min, max }: { chars: number; min: number; max: number }): JSX.Element {
  const state = chars > max ? 'over' : chars < min ? 'under' : 'ok'
  const span = Math.max(1, max)
  const pct = Math.min(100, (chars / span) * 100)
  const delta = state === 'over' ? `${formatNumber(chars - max)} over` : state === 'under' ? `${formatNumber(min - chars)} short` : 'in range'
  return (
    <span className={`char-counter ${state}`} title={`Channel window: ${formatNumber(min)}–${formatNumber(max)} characters`}>
      <span className="char-counter-value">{formatNumber(chars)}</span>
      <span className="muted">/ {formatNumber(max)}</span>
      <span className="char-counter-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="xs muted">{delta}</span>
    </span>
  )
}
