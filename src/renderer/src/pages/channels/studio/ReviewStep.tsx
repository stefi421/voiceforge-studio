import { useState, type JSX } from 'react'
import { ArrowRight, BadgeCheck, ChevronDown, ChevronRight, History, Plus, RotateCcw, Save, ShieldCheck, Undo2, X } from 'lucide-react'
import type { FixedTextBlock, FixedTextKind, Template, TemplateApprovalStatus, TemplateVersion, TemplateVersionInput } from '@shared/types'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { allowsAuto, STATUS_LABEL } from '@/lib/formats'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, ConfirmDialog, Dialog, Field, Select, StringListEditor, Switch, Textarea } from '@/components/ui'
import { FormatStatusPill } from '@/components/FormatStatus'
import { StructureEditor } from '../TemplateVersionForm'
import { FixedBlockRow } from './AnalyzeStep'
import type { FormatDraft } from './FormatWorkspace'

export interface ReviewStepProps {
  channelId: string
  template: Template
  versions: TemplateVersion[]
  active: TemplateVersion | null
  draft: FormatDraft
  draftDirty: boolean
  onDraftChange: (d: FormatDraft) => void
  onResetDraft: () => void
  onChanged: () => Promise<void>
  onGoToTest: () => void
}

const KIND_OPTIONS: Array<{ value: FixedTextKind; label: string }> = [
  { value: 'intro', label: 'Intro' },
  { value: 'outro', label: 'Outro' },
  { value: 'heading', label: 'Heading' },
  { value: 'transition', label: 'Transition' },
  { value: 'cta', label: 'Call to action' },
  { value: 'other', label: 'Other' }
]

function newBlockId(): string {
  return `blk_${Math.random().toString(36).slice(2, 10)}`
}

function toInput(d: FormatDraft, status: TemplateApprovalStatus): TemplateVersionInput {
  return {
    systemPrompt: d.systemPrompt,
    structure: d.structure,
    exampleScript: d.exampleScript,
    notes: d.notes || 'Saved from the format review.',
    placeholder: false,
    approvalStatus: status,
    fixedBlocks: d.fixedBlocks,
    findings: d.findings,
    confirmedRules: d.confirmedRules,
    unverified: d.unverified,
    headingsSpoken: d.headingsSpoken,
    referenceSetVersion: d.referenceSetVersion
  }
}

function versionToInput(v: TemplateVersion, note: string): TemplateVersionInput {
  return {
    systemPrompt: v.systemPrompt,
    structure: v.structure,
    exampleScript: v.exampleScript,
    notes: note,
    placeholder: v.placeholder,
    approvalStatus: v.referenceSetVersion == null && !v.placeholder ? 'provisional' : 'awaiting_approval',
    fixedBlocks: v.fixedBlocks,
    findings: v.findings,
    confirmedRules: v.confirmedRules,
    unverified: v.unverified,
    headingsSpoken: v.headingsSpoken,
    referenceSetVersion: v.referenceSetVersion
  }
}

export function ReviewStep({ channelId, template, versions, active, draft, draftDirty, onDraftChange, onResetDraft, onChanged, onGoToTest }: ReviewStepProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [showStructure, setShowStructure] = useState(false)
  const [adding, setAdding] = useState<{ kind: FixedTextKind; text: string } | null>(null)
  const [viewing, setViewing] = useState<TemplateVersion | null>(null)
  const [confirmApprove, setConfirmApprove] = useState<TemplateVersion | null>(null)

  const set = (p: Partial<FormatDraft>): void => onDraftChange({ ...draft, ...p })
  const latest = versions[0] ?? null
  const pending = latest && !allowsAuto(latest.approvalStatus) && latest.approvalStatus !== 'not_configured' ? latest : null
  const lockedIntro = draft.fixedBlocks.filter((b) => b.locked && b.kind === 'intro')
  const lockedOutro = draft.fixedBlocks.filter((b) => b.locked && b.kind === 'outro')
  const lockedOther = draft.fixedBlocks.filter((b) => b.locked && b.kind !== 'intro' && b.kind !== 'outro')

  const saveVersion = async (): Promise<void> => {
    if (!draft.systemPrompt.trim() && draft.structure.length === 0) {
      toast.warning('Nothing to save yet', 'Run the analysis or write the master prompt and structure first.')
      return
    }
    setBusy('save')
    try {
      const status: TemplateApprovalStatus = draft.referenceSetVersion == null ? 'provisional' : 'awaiting_approval'
      const v = await api.invoke('templates:addVersion', { templateId: template.id, input: toInput(draft, status) })
      toast.success(`Version ${v.version} saved`, 'It is not active yet. Approve it below to start using it.')
      await onChanged()
    } catch (err) {
      toast.error('Could not save the version', err)
    } finally {
      setBusy(null)
    }
  }

  const approve = async (v: TemplateVersion): Promise<void> => {
    setBusy(`approve:${v.id}`)
    try {
      await api.invoke('templates:setApproval', { versionId: v.id, status: 'approved' })
      await api.invoke('templates:setActive', { channelId, versionId: v.id })
      toast.success(`Version ${v.version} approved`, 'New jobs for this format use it. Fully automatic generation is now available.')
      setConfirmApprove(null)
      await onChanged()
    } catch (err) {
      toast.error('Could not approve the version', err)
    } finally {
      setBusy(null)
    }
  }

  const reject = async (v: TemplateVersion): Promise<void> => {
    setBusy(`reject:${v.id}`)
    try {
      await api.invoke('templates:setApproval', { versionId: v.id, status: 'template_extracted' })
      toast.info(`Version ${v.version} sent back`, 'Edit the format and save a new version.')
      await onChanged()
    } catch (err) {
      toast.error('Could not update the version', err)
    } finally {
      setBusy(null)
    }
  }

  const restore = async (v: TemplateVersion): Promise<void> => {
    setBusy(`restore:${v.id}`)
    try {
      const nv = await api.invoke('templates:addVersion', { templateId: template.id, input: versionToInput(v, `Restored from version ${v.version}.`) })
      toast.success(`Version ${v.version} restored as v${nv.version}`, 'Approve it to make it active again.')
      await onChanged()
    } catch (err) {
      toast.error('Could not restore the version', err)
    } finally {
      setBusy(null)
    }
  }

  const toggleBlock = (id: string, patch: Partial<FixedTextBlock>): void => set({ fixedBlocks: draft.fixedBlocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) })

  return (
    <div className="col gap-4">
      <div>
        <div className="section-title">Review and approve</div>
        <div className="section-sub">Saving creates a new version and never changes the active one. Strict, fully automatic generation is enabled only after you approve a version; until then this format runs only with your review, if at all.</div>
      </div>

      {pending && (
        <div className="approve-card">
          <ShieldCheck size={18} />
          <div className="col grow" style={{ gap: 2 }}>
            <span className="strong">Version {pending.version} is waiting for your decision</span>
            <span className="xs muted">
              {STATUS_LABEL[pending.approvalStatus]} · saved {formatDateTime(pending.createdAt)} · {pending.structure.length} sections · {pending.fixedBlocks.filter((b) => b.locked).length} locked text block(s)
            </span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setViewing(pending)}>
            View
          </Button>
          <Button size="sm" icon={<Undo2 size={12} />} loading={busy === `reject:${pending.id}`} onClick={() => reject(pending)} disabled={pending.approvalStatus === 'template_extracted'}>
            Reject
          </Button>
          <Button size="sm" variant="primary" icon={<BadgeCheck size={12} />} loading={busy === `approve:${pending.id}`} onClick={() => setConfirmApprove(pending)}>
            Approve
          </Button>
        </div>
      )}

      {active && allowsAuto(active.approvalStatus) && !pending && (
        <Alert tone="success" title={`Version ${active.version} is approved and active`} actions={<Button size="sm" icon={<ArrowRight size={12} />} onClick={onGoToTest}>Run a style test</Button>}>
          {active.approvedAt ? `Approved ${formatDateTime(active.approvedAt)}. ` : ''}Edits below become a new version that needs approval again.
        </Alert>
      )}

      {draftDirty && (
        <Alert tone="info" title="Unsaved changes" actions={<Button size="sm" variant="ghost" onClick={onResetDraft}>Discard</Button>}>
          The format below includes changes from the analysis or your edits. Save it as a new version to approve it.
        </Alert>
      )}

      <div className="review-grid">
        <section className="review-panel">
          <div className="review-panel-title">Locked text</div>
          <div className="col gap-3">
            <LockedPreview label="Introduction" blocks={lockedIntro} />
            <LockedPreview label="Conclusion" blocks={lockedOutro} />
            {lockedOther.length > 0 && <LockedPreview label="Other fixed text" blocks={lockedOther} />}
          </div>
        </section>
        <section className="review-panel">
          <div className="review-panel-title">Structure</div>
          {draft.structure.length === 0 ? (
            <span className="small muted">No sections defined.</span>
          ) : (
            <ol className="structure-preview">
              {draft.structure.map((s) => (
                <li key={s.key}>
                  <span className="strong">{s.label || s.key}</span>
                  {!s.required && <span className="xs muted"> (optional)</span>}
                  {s.aliases.length > 0 && <span className="xs muted"> · also “{s.aliases.join('”, “')}”</span>}
                </li>
              ))}
            </ol>
          )}
          <Switch checked={draft.headingsSpoken} onChange={(v) => set({ headingsSpoken: v })} label="Headings are read aloud" description="Off: headings stay in Script.txt and are removed from the narration sent to ElevenLabs." />
        </section>
      </div>

      <Field label="Confirmed rules" hint="Rules you confirm for this format, one per line. These are enforced and shown to the writer as rules.">
        <Textarea value={draft.confirmedRules} onChange={(e) => set({ confirmedRules: e.target.value })} rows={5} placeholder={'Maximum 4,700 characters\nNever use the term "AAA"\nNo URLs or citations in narration'} />
      </Field>

      <Field label="Still unverified" hint="Kept visible until you confirm or remove them. Unverified items are never presented to the writer as rules.">
        <StringListEditor values={draft.unverified} onChange={(unverified) => set({ unverified })} placeholder="e.g. Exact wording of the outro" addLabel="Add item" />
      </Field>

      <section className="col gap-2">
        <div className="row-between">
          <div className="section-title">Fixed text blocks</div>
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding({ kind: 'intro', text: '' })}>
            Add fixed text
          </Button>
        </div>
        {draft.fixedBlocks.length === 0 ? (
          <span className="small muted">No fixed text. Lock repeated intro/outro sentences after analysing your references, or add them yourself.</span>
        ) : (
          <div className="fixed-list">
            {draft.fixedBlocks.map((b) => (
              <div key={b.id} className="fixed-block-wrap">
                <FixedBlockRow block={b} onToggleLock={() => toggleBlock(b.id, { locked: !b.locked })} onToggleSpoken={() => toggleBlock(b.id, { spoken: !b.spoken })} />
                {b.occurrences === 0 && <Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} title="Remove" onClick={() => set({ fixedBlocks: draft.fixedBlocks.filter((x) => x.id !== b.id) })} />}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="col gap-2">
        <button type="button" className="gen-advanced-toggle" onClick={() => setShowStructure(!showStructure)}>
          {showStructure ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Edit sections
        </button>
        {showStructure && <StructureEditor sections={draft.structure} onChange={(structure) => set({ structure })} />}
        <button type="button" className="gen-advanced-toggle" onClick={() => setShowPrompt(!showPrompt)}>
          {showPrompt ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Master prompt
          <span className="xs muted">{draft.systemPrompt ? `${draft.systemPrompt.length.toLocaleString()} characters` : 'empty'}</span>
        </button>
        {showPrompt && <Textarea mono value={draft.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} rows={16} />}
      </section>

      <Field label="Version notes" hint="What changed and why. Shown in the version history.">
        <Textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} />
      </Field>

      <div className="row-between">
        <span className="xs subtle">{draft.referenceSetVersion != null ? `Built from reference set v${draft.referenceSetVersion}.` : 'Not built from references — the saved version will be provisional.'}</span>
        <Button variant="primary" icon={<Save size={14} />} loading={busy === 'save'} onClick={saveVersion}>
          Save as new version
        </Button>
      </div>

      <section className="col gap-2">
        <div className="section-title row gap-2">
          <History size={14} /> Version history
        </div>
        {versions.length === 0 ? (
          <span className="small muted">No versions yet.</span>
        ) : (
          <div className="version-list">
            {versions.map((v) => {
              const isActive = v.id === active?.id
              return (
                <div key={v.id} className={`version-row ${isActive ? 'active' : ''}`}>
                  <span className="strong">v{v.version}</span>
                  {isActive && <Badge tone="success">active</Badge>}
                  <FormatStatusPill status={v.approvalStatus} />
                  <span className="xs muted">{formatDateTime(v.createdAt)}</span>
                  <span className="small muted truncate grow" title={v.notes}>
                    {v.notes}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>
                    View
                  </Button>
                  {!isActive && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} loading={busy === `restore:${v.id}`} onClick={() => restore(v)} title="Copy this version into a new version">
                      Restore
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <AddBlockDialog
        state={adding}
        onChange={setAdding}
        onAdd={(kind, text) => {
          set({ fixedBlocks: [...draft.fixedBlocks, { id: newBlockId(), kind, text, locked: true, provenance: 'user_confirmed', spoken: kind !== 'heading', occurrences: 0 }] })
          setAdding(null)
        }}
      />
      <VersionDialog version={viewing} active={active} onClose={() => setViewing(null)} onChanged={onChanged} />
      <ConfirmDialog
        open={Boolean(confirmApprove)}
        onClose={() => setConfirmApprove(null)}
        onConfirm={async () => {
          if (confirmApprove) await approve(confirmApprove)
        }}
        title={`Approve version ${confirmApprove?.version ?? ''}?`}
        confirmLabel="Approve and activate"
        message={
          <>
            New jobs for this format will follow it exactly: {confirmApprove?.structure.length ?? 0} sections, {confirmApprove?.fixedBlocks.filter((b) => b.locked).length ?? 0} locked text block(s). Fully automatic generation becomes available. Scripts already generated keep the version they were written with.
          </>
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function LockedPreview({ label, blocks }: { label: string; blocks: FixedTextBlock[] }): JSX.Element {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="xs muted">{label}</span>
      {blocks.length === 0 ? (
        <span className="small subtle">Not locked — the writer follows the references' style but may vary the wording.</span>
      ) : (
        blocks.map((b) => (
          <blockquote key={b.id} className="fixed-block-text locked">
            {b.text}
          </blockquote>
        ))
      )}
    </div>
  )
}

function AddBlockDialog({ state, onChange, onAdd }: { state: { kind: FixedTextKind; text: string } | null; onChange: (s: { kind: FixedTextKind; text: string } | null) => void; onAdd: (kind: FixedTextKind, text: string) => void }): JSX.Element {
  return (
    <Dialog
      open={Boolean(state)}
      onClose={() => onChange(null)}
      title="Add fixed text"
      description="Typed text is marked as confirmed by you and locked: every script must contain it verbatim."
      footer={
        <>
          <Button variant="ghost" onClick={() => onChange(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!state?.text.trim()} onClick={() => state && onAdd(state.kind, state.text.trim())}>
            Add and lock
          </Button>
        </>
      }
    >
      {state && (
        <>
          <Field label="Kind">
            <Select value={state.kind} onChange={(v) => onChange({ ...state, kind: v as FixedTextKind })} options={KIND_OPTIONS} />
          </Field>
          <Field label="Exact text">
            <Textarea value={state.text} onChange={(e) => onChange({ ...state, text: e.target.value })} rows={5} data-autofocus placeholder="Paste the sentence exactly as it appears in your approved scripts." />
          </Field>
        </>
      )}
    </Dialog>
  )
}

function VersionDialog({ version, active, onClose, onChanged }: { version: TemplateVersion | null; active: TemplateVersion | null; onClose: () => void; onChanged: () => Promise<void> }): JSX.Element {
  const [blocks, setBlocks] = useState<FixedTextBlock[] | null>(null)
  const [saving, setSaving] = useState(false)
  const current = blocks ?? version?.fixedBlocks ?? []

  const saveLocks = async (): Promise<void> => {
    if (!version || !blocks) return
    setSaving(true)
    try {
      const saved = await api.invoke('templates:setFixedBlocks', { versionId: version.id, blocks })
      // Changing locks on an approved version creates a new version that needs approval again.
      if (saved.id !== version.id) toast.success(`Saved as version ${saved.version}`, 'Version ' + version.version + ' stays approved and active; approve the new version to use the changed locks.')
      else toast.success('Locks updated', `Version ${version.version}`)
      setBlocks(null)
      await onChanged()
      onClose()
    } catch (err) {
      toast.error('Could not update locks', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={Boolean(version)}
      onClose={() => {
        setBlocks(null)
        onClose()
      }}
      size="xl"
      title={version ? `Version ${version.version}${version.id === active?.id ? ' (active)' : ''}` : ''}
      description={version?.notes}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setBlocks(null)
              onClose()
            }}
          >
            Close
          </Button>
          {blocks && (
            <Button variant="primary" loading={saving} onClick={saveLocks}>
              Save lock changes
            </Button>
          )}
        </>
      }
    >
      {version && (
        <div className="col gap-3">
          <div className="row gap-2">
            <FormatStatusPill status={version.approvalStatus} />
            <span className="xs muted">
              {formatDateTime(version.createdAt)}
              {version.referenceSetVersion != null ? ` · reference set v${version.referenceSetVersion}` : ' · not built from references'}
              {version.approvedAt ? ` · approved ${formatDateTime(version.approvedAt)}` : ''}
            </span>
          </div>
          {version.confirmedRules && (
            <Field label="Confirmed rules">
              <pre className="ref-view small">{version.confirmedRules}</pre>
            </Field>
          )}
          {version.unverified.length > 0 && (
            <Field label="Unverified">
              <ul className="unverified-list">
                {version.unverified.map((u, i) => (
                  <li key={i}>
                    <span className="unverified-tag">Unverified</span> {u}
                  </li>
                ))}
              </ul>
            </Field>
          )}
          <Field label="Fixed text" hint={allowsAuto(version.approvalStatus) ? 'This version is approved: lock changes are saved as a new version that needs approval.' : 'Locking or unlocking here changes this version directly.'}>
            {current.length === 0 ? (
              <span className="small muted">None.</span>
            ) : (
              <div className="fixed-list">
                {current.map((b) => (
                  <FixedBlockRow key={b.id} block={b} onToggleLock={() => setBlocks(current.map((x) => (x.id === b.id ? { ...x, locked: !x.locked } : x)))} onToggleSpoken={() => setBlocks(current.map((x) => (x.id === b.id ? { ...x, spoken: !x.spoken } : x)))} />
                ))}
              </div>
            )}
          </Field>
          <Field label="Structure">
            {version.structure.length === 0 ? (
              <span className="small muted">No sections.</span>
            ) : (
              <ol className="structure-preview">
                {version.structure.map((s) => (
                  <li key={s.key}>
                    <span className="strong">{s.label}</span> {!s.required && <span className="xs muted">(optional)</span>}
                    {s.guidance && <div className="xs muted">{s.guidance}</div>}
                  </li>
                ))}
              </ol>
            )}
          </Field>
          <Field label="Master prompt">
            <pre className="log-view" style={{ maxHeight: 280 }}>{version.systemPrompt || '—'}</pre>
          </Field>
        </div>
      )}
    </Dialog>
  )
}
