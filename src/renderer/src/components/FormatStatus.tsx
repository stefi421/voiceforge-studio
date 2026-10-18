import type { JSX } from 'react'
import type { RuleProvenance, TemplateApprovalStatus } from '@shared/types'
import { PROVENANCE_LABEL, STATUS_LABEL, STATUS_TONE } from '@/lib/formats'
import { Badge } from '@/components/ui'

export function FormatStatusPill({ status, prefix }: { status: TemplateApprovalStatus; prefix?: string }): JSX.Element {
  return (
    <Badge tone={STATUS_TONE[status]} dot title={STATUS_LABEL[status]}>
      {prefix ? `${prefix} · ` : ''}
      {STATUS_LABEL[status]}
    </Badge>
  )
}

/**
 * Provenance badge. Inferred and unknown findings are deliberately quieter than confirmed
 * rules so an inference never reads like a rule.
 */
export function ProvenanceBadge({ provenance }: { provenance: RuleProvenance }): JSX.Element {
  return <span className={`prov prov-${provenance}`}>{PROVENANCE_LABEL[provenance]}</span>
}
