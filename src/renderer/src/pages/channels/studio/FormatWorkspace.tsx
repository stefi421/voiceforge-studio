import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check, FileStack, FlaskConical, ScanSearch, ShieldCheck, Star, Trash } from 'lucide-react'
import type { FixedTextBlock, ScriptSection, StyleAnalysis, StyleFinding, Template, TemplateVersion } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { allowsAuto, contentTypeLabel, normalizeStatus, normalizeVersion } from '@/lib/formats'
import { Alert, Badge, Button, SkeletonRows } from '@/components/ui'
import { FormatLength } from './FormatLength'
import { FormatStatusPill } from '@/components/FormatStatus'
import { ReferencesStep } from './ReferencesStep'
import { AnalyzeStep } from './AnalyzeStep'
import { ReviewStep } from './ReviewStep'
import { TestStep } from './TestStep'

export type StepId = 'references' | 'analyze' | 'review' | 'test'

/** The editable format that "Save as new version" writes. */
export interface FormatDraft {
  systemPrompt: string
  structure: ScriptSection[]
  fixedBlocks: FixedTextBlock[]
  findings: StyleFinding[]
  confirmedRules: string
  unverified: string[]
  headingsSpoken: boolean
  referenceSetVersion: number | null
  exampleScript: string | null
  notes: string
}

export function draftFromVersion(v: TemplateVersion | null): FormatDraft {
  return {
    systemPrompt: v?.systemPrompt ?? '',
    structure: v ? v.structure.map((s) => ({ ...s, aliases: [...s.aliases] })) : [],
    fixedBlocks: v ? v.fixedBlocks.map((b) => ({ ...b })) : [],
    findings: v ? [...v.findings] : [],
    confirmedRules: v?.confirmedRules ?? '',
    unverified: v ? [...v.unverified] : [],
    headingsSpoken: v?.headingsSpoken ?? false,
    referenceSetVersion: v?.referenceSetVersion ?? null,
    exampleScript: v?.exampleScript ?? null,
    notes: ''
  }
}

export interface FormatWorkspaceProps {
  channelId: string
  channelName: string
  template: Template
  isDefault: boolean
  channelInstructions: string
  minChars: number
  maxChars: number
  targetDurationSec?: number
  onChanged: () => Promise<void>
  onDelete: () => void
}

export function FormatWorkspace({ channelId, channelName, template, isDefault, channelInstructions, minChars: channelMin, maxChars: channelMax, targetDurationSec = 300, onChanged, onDelete }: FormatWorkspaceProps): JSX.Element {
  // 1.7.0: the format's own length window (shorts) wins over the channel default.
  const minChars = template.minChars ?? channelMin
  const maxChars = Math.max(template.maxChars ?? channelMax, minChars)
  const versions = useAsync(async () => (await api.invoke('templates:versions', { templateId: template.id })).map(normalizeVersion).sort((a, b) => b.version - a.version), [template.id], { fallback: [] })
  const refs = useAsync(() => api.invoke('references:list', { templateId: template.id }), [template.id], { fallback: [] })
  const analysis = useAsync(() => api.invoke('style:lastAnalysis', { templateId: template.id }), [template.id], { fallback: null })
  const tests = useAsync(() => api.invoke('style:tests', { templateId: template.id, limit: 10 }), [template.id], { fallback: [] })

  const versionList = versions.data ?? []
  const active = versionList.find((v) => v.id === template.activeVersionId) ?? null
  const latest = versionList[0] ?? null
  const status = normalizeStatus(active?.approvalStatus ?? template.approvalStatus)
  const refCount = (refs.data ?? []).length
  const lastTest = (tests.data ?? [])[0] ?? null

  const done: Record<StepId, boolean> = {
    references: refCount > 0,
    analyze: Boolean(analysis.data),
    review: allowsAuto(status),
    test: Boolean(lastTest?.passed)
  }
  const approved = allowsAuto(status)
  const firstOpen: StepId = !approved && !done.references ? 'references' : !approved && !done.analyze ? 'analyze' : !approved ? 'review' : 'test'
  const stepParam = useRouter((st) => st.params.step)
  const isStep = (v: string | undefined): v is StepId => v === 'references' || v === 'analyze' || v === 'review' || v === 'test'
  const [step, setStep] = useState<StepId | null>(isStep(stepParam) ? stepParam : null)
  useEffect(() => {
    if (isStep(stepParam)) setStep(stepParam)
  }, [stepParam])
  const current = step ?? firstOpen

  // The draft is seeded from the newest version; the Analyze step can replace parts of it.
  const [draft, setDraft] = useState<FormatDraft | null>(null)
  const [makingDefault, setMakingDefault] = useState(false)
  const effectiveDraft = useMemo(() => draft ?? draftFromVersion(latest), [draft, latest])

  const applyAnalysis = (a: StyleAnalysis, edited: { structure: ScriptSection[]; systemPrompt: string; fixedBlocks: FixedTextBlock[] }): void => {
    const base = effectiveDraft
    setDraft({
      ...base,
      systemPrompt: edited.systemPrompt,
      structure: edited.structure,
      fixedBlocks: edited.fixedBlocks,
      findings: a.findings,
      unverified: Array.from(new Set([...a.unknowns, ...base.unverified])),
      referenceSetVersion: a.referenceSetVersion,
      notes: `Extracted from ${a.stats.count} reference script(s), reference set v${a.referenceSetVersion}.`
    })
    setStep('review')
  }

  const reloadAll = async (): Promise<void> => {
    await Promise.all([versions.reload(), refs.reload(), analysis.reload(), tests.reload()])
    await onChanged()
  }

  const steps: Array<{ id: StepId; label: string; sub: string; icon: JSX.Element }> = [
    { id: 'references', label: 'References', sub: refCount ? `${refCount} script${refCount === 1 ? '' : 's'}` : '3–5 recommended', icon: <FileStack size={15} /> },
    { id: 'analyze', label: 'Analyze', sub: analysis.data ? `set v${analysis.data.referenceSetVersion}` : 'Not run yet', icon: <ScanSearch size={15} /> },
    { id: 'review', label: 'Review & approve', sub: status === 'not_configured' || status === 'references_imported' ? 'Nothing to approve yet' : latest && !allowsAuto(latest.approvalStatus) && latest.approvalStatus !== 'provisional' ? `v${latest.version} waiting` : active ? `v${active.version} active` : 'No version', icon: <ShieldCheck size={15} /> },
    { id: 'test', label: 'Test', sub: lastTest ? (lastTest.passed ? 'Last test passed' : 'Last test failed') : 'Not tested', icon: <FlaskConical size={15} /> }
  ]

  return (
    <div className="col gap-4">
      <div className="studio-head">
        <div className="col" style={{ gap: 2 }}>
          <div className="row gap-2">
            <span className="studio-title">{contentTypeLabel(template.contentType)}</span>
            <Badge tone={template.formFactor === 'short' ? 'accent' : 'neutral'}>{template.formFactor === 'short' ? 'Short form' : 'Long form'}</Badge>
            <FormatStatusPill status={status} />
            {isDefault && <span className="xs muted">default format</span>}
          </div>
          <span className="xs muted">
            {template.name} · key <code className="inline-code">{template.contentType}</code>
            {active ? ` · active v${active.version}` : ''}
            {latest && active && latest.id !== active.id ? ` · v${latest.version} waiting for approval` : ''}
          </span>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {!isDefault && (
            <Button
              size="sm"
              icon={<Star size={12} />}
              loading={makingDefault}
              disabled={!template.activeVersionId}
              title={template.activeVersionId ? 'New generations for this channel use this format unless you pick another' : 'Save a version first'}
              onClick={async () => {
                setMakingDefault(true)
                try {
                  await api.invoke('templates:setDefault', { channelId, templateId: template.id })
                  toast.success('Default format changed', `${contentTypeLabel(template.contentType)} is now the default for ${channelName}.`)
                  await onChanged()
                } catch (err) {
                  toast.error('Could not change the default format', err)
                } finally {
                  setMakingDefault(false)
                }
              }}
            >
              Make default
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Trash size={12} />} onClick={onDelete}>
            Delete format
          </Button>
        </div>
      </div>

      <FormatLength template={template} channelMinChars={channelMin} channelMaxChars={channelMax} channelTargetSec={targetDurationSec} onChanged={onChanged} />

      {status === 'provisional' && (
        <Alert tone="warning" title="Provisional format">
          Built from the rules you wrote down for {channelName}, not yet checked against approved scripts. It runs in Review before voice and Scripts only; import references and approve the extracted format to unlock Fully automatic.
        </Alert>
      )}

      <ol className="stepper" aria-label="Format setup steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button type="button" className={`stepper-step ${current === s.id ? 'active' : ''} ${done[s.id] ? 'done' : ''}`} onClick={() => setStep(s.id)} aria-current={current === s.id ? 'step' : undefined}>
              <span className="stepper-num">{done[s.id] ? <Check size={12} /> : i + 1}</span>
              <span className="stepper-text">
                <span className="stepper-label">
                  {s.icon}
                  {s.label}
                </span>
                <span className="stepper-sub">{s.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {versions.loading && versionList.length === 0 ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          {current === 'references' && (
            <ReferencesStep
              template={template}
              refs={refs.data ?? []}
              loading={refs.loading}
              minChars={minChars}
              maxChars={maxChars}
              onChanged={async () => {
                await refs.reload()
                await onChanged()
              }}
              onNext={() => setStep('analyze')}
            />
          )}
          {current === 'analyze' && (
            <AnalyzeStep
              template={template}
              refCount={refCount}
              analysis={analysis.data ?? null}
              channelInstructions={channelInstructions}
              onAnalyzed={async () => {
                await analysis.reload()
                await onChanged()
              }}
              onUse={applyAnalysis}
              onGoToReferences={() => setStep('references')}
            />
          )}
          {current === 'review' && (
            <ReviewStep
              channelId={channelId}
              template={template}
              versions={versionList}
              active={active}
              draft={effectiveDraft}
              draftDirty={draft !== null}
              onDraftChange={setDraft}
              onResetDraft={() => setDraft(null)}
              onChanged={async () => {
                setDraft(null)
                await reloadAll()
              }}
              onGoToTest={() => setStep('test')}
            />
          )}
          {current === 'test' && (
            <TestStep
              template={template}
              active={active}
              tests={tests.data ?? []}
              loading={tests.loading}
              onTested={async () => {
                await tests.reload()
                await versions.reload()
                await onChanged()
              }}
              onGoToReview={() => setStep('review')}
            />
          )}
        </>
      )}
    </div>
  )
}
