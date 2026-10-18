import { useState, type JSX } from 'react'
import { CircleCheck, CircleMinus, CircleX, FlaskConical, TriangleAlert } from 'lucide-react'
import type { ComplianceCheck, ComplianceVerdict, StyleTestResult, Template, TemplateVersion } from '@shared/types'
import { api } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, EmptyState, Field, Input, ProgressBar, SkeletonRows, Textarea } from '@/components/ui'

export interface TestStepProps {
  template: Template
  active: TemplateVersion | null
  tests: StyleTestResult[]
  loading: boolean
  onTested: () => Promise<void>
  onGoToReview: () => void
}

const VERDICT_LABEL: Record<ComplianceVerdict, string> = { pass: 'Pass', fail: 'Fail', warning: 'Check', not_applicable: 'Not applicable' }

function VerdictIcon({ v }: { v: ComplianceVerdict }): JSX.Element {
  if (v === 'pass') return <CircleCheck size={16} className="text-success" />
  if (v === 'fail') return <CircleX size={16} className="text-danger" />
  if (v === 'warning') return <TriangleAlert size={16} className="text-warning" />
  return <CircleMinus size={16} className="subtle" />
}

export function TestStep({ template, active, tests, loading, onTested, onGoToReview }: TestStepProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [shownId, setShownId] = useState<string | null>(null)

  const shown = tests.find((t) => t.id === shownId) ?? tests[0] ?? null

  const run = async (): Promise<void> => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const r = await api.invoke('style:test', { templateId: template.id, title: title.trim(), notes: notes.trim() || undefined })
      setShownId(r.id)
      await onTested()
      if (r.passed) toast.success('Style test passed', r.title)
      else toast.warning('Style test found problems', 'See the checklist for what to fix.')
    } catch (err) {
      toast.error('Style test failed to run', err)
    } finally {
      setBusy(false)
    }
  }

  if (!active) {
    return <EmptyState icon={<FlaskConical size={22} />} title="Nothing to test yet" description="Save and approve a version of this format first; the test runs against the active version." actions={<Button variant="primary" onClick={onGoToReview}>Go to review</Button>} />
  }

  return (
    <div className="col gap-4">
      <div>
        <div className="section-title">Style test</div>
        <div className="section-sub">
          Generates one script with the active version (v{active.version}) and checks it against the format: sections, order, locked intro and outro, length, prohibited content, and style deviations. Test scripts are not added to your libraries and no audio is generated. Uses research and writing credits for one title.
        </div>
      </div>

      <div className="form-grid">
        <Field label="Game or product">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Emberward"
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
          />
        </Field>
        <Field label="Notes for the writer (optional)" hint="Your own gameplay or testing notes, if the format needs them.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
      <div className="row">
        <Button variant="primary" icon={<FlaskConical size={14} />} loading={busy} disabled={!title.trim()} onClick={run}>
          Run style test
        </Button>
        {busy && <span className="xs muted">Researching and writing… this takes about a minute.</span>}
      </div>
      {busy && <ProgressBar value={0} indeterminate />}

      {loading && tests.length === 0 ? (
        <SkeletonRows rows={3} />
      ) : !shown ? (
        <EmptyState compact icon={<FlaskConical size={20} />} title="No tests yet" description="Run a test with a title you know well so you can judge the result." />
      ) : (
        <div className="test-layout">
          <div className="col gap-3">
            <div className="row-between">
              <div className="col" style={{ gap: 2 }}>
                <span className="strong">{shown.title}</span>
                <span className="xs muted">{formatDateTime(shown.createdAt)}</span>
              </div>
              <Badge tone={shown.passed ? 'success' : 'danger'} dot>
                {shown.passed ? 'Passed' : 'Failed'}
              </Badge>
            </div>
            <ul className="compliance-list">
              {shown.checks.map((c) => (
                <ComplianceRow key={c.key} check={c} />
              ))}
            </ul>
            <Alert tone="info">This checklist reports rule compliance only. It does not claim the script is identical to your earlier scripts; read it yourself before approving the format for unattended use.</Alert>
          </div>
          <div className="col gap-2">
            <div className="row-between">
              <span className="field-label">Generated script</span>
              <span className="xs muted tnum">{formatNumber(shown.scriptText.length)} characters</span>
            </div>
            <pre className="ref-view test-script">{shown.scriptText || '—'}</pre>
          </div>
        </div>
      )}

      {tests.length > 1 && (
        <section className="col gap-2">
          <div className="section-title">Earlier tests</div>
          <div className="version-list">
            {tests.map((t) => (
              <button key={t.id} type="button" className={`version-row version-row-btn ${t.id === shown?.id ? 'active' : ''}`} onClick={() => setShownId(t.id)}>
                <Badge tone={t.passed ? 'success' : 'danger'} dot>
                  {t.passed ? 'Passed' : 'Failed'}
                </Badge>
                <span className="strong truncate grow">{t.title}</span>
                <span className="xs muted">{t.checks.filter((c) => c.verdict === 'fail').length} failed checks</span>
                <span className="xs muted">{formatDateTime(t.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ComplianceRow({ check }: { check: ComplianceCheck }): JSX.Element {
  return (
    <li className={`compliance-row compliance-${check.verdict}`}>
      <VerdictIcon v={check.verdict} />
      <div className="col grow" style={{ gap: 2 }}>
        <div className="row-between">
          <span className="strong small">{check.label}</span>
          <span className="xs muted">{VERDICT_LABEL[check.verdict]}</span>
        </div>
        {check.details.length > 0 && (
          <ul className="compliance-details">
            {check.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}
