import { useEffect, useMemo, useState, type JSX } from 'react'
import { BadgeCheck, GitCompare, Plus, Sparkles, Trash, Wand2 } from 'lucide-react'
import type { Template, TemplateAnalysis, TemplateVersion, TemplateVersionInput } from '@shared/types'
import { templateVersionInputSchema } from '@shared/schemas'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { formatDateTime } from '@/lib/format'
import { Alert, Badge, Button, ConfirmDialog, Dialog, DiffView, EmptyState, Field, Input, Select, SkeletonRows, Textarea } from '@/components/ui'
import { TemplateVersionForm, emptyVersion } from './TemplateVersionForm'

export interface TemplateEditorProps {
  channelId: string
  activeVersionId: string | null
  channelInstructions: string
}

type VersionDialog = { kind: 'create' } | { kind: 'addVersion'; template: Template } | null

export function TemplateEditor({ channelId, activeVersionId, channelInstructions }: TemplateEditorProps): JSX.Element {
  const templates = useAsync(() => api.invoke('templates:list', { channelId }), [channelId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const versions = useAsync(() => api.invoke('templates:versions', { templateId: selectedId ?? '' }), [selectedId], { enabled: Boolean(selectedId) })
  const [dialog, setDialog] = useState<VersionDialog>(null)
  const [prefill, setPrefill] = useState<TemplateVersionInput | null>(null)
  const [analyzeOpen, setAnalyzeOpen] = useState(false)
  const [diffPair, setDiffPair] = useState<{ a: string; b: string } | null>(null)
  const [deleting, setDeleting] = useState<Template | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [viewing, setViewing] = useState<TemplateVersion | null>(null)

  // Auto-select the template that owns the active version, else the first one.
  useEffect(() => {
    const list = templates.data
    if (!list || list.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId && list.some((t) => t.id === selectedId)) return
    const owner = list.find((t) => t.activeVersionId === activeVersionId)
    setSelectedId((owner ?? list[0])?.id ?? null)
  }, [templates.data, activeVersionId, selectedId])

  const selected = templates.data?.find((t) => t.id === selectedId) ?? null

  const setActive = async (v: TemplateVersion): Promise<void> => {
    setBusy(`active:${v.id}`)
    try {
      await api.invoke('templates:setActive', { channelId, versionId: v.id })
      await useApp.getState().refreshChannels()
      await templates.reload()
      toast.success('Active template updated', `Version ${v.version}${v.placeholder ? ' (placeholder)' : ''}`)
    } catch (err) {
      toast.error('Could not set active version', err)
    } finally {
      setBusy(null)
    }
  }

  const rename = async (t: Template): Promise<void> => {
    const name = window.prompt('Template name', t.name)
    if (!name || name.trim() === t.name) return
    try {
      await api.invoke('templates:rename', { templateId: t.id, name: name.trim() })
      await templates.reload()
    } catch (err) {
      toast.error('Could not rename template', err)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('templates:delete', { templateId: deleting.id })
      setDeleting(null)
      setSelectedId(null)
      await templates.reload()
      await useApp.getState().refreshChannels()
      toast.success('Template deleted')
    } catch (err) {
      toast.error('Could not delete template', err)
    }
  }

  const versionList = versions.data ?? []
  const versionOptions = versionList.map((v) => ({ value: v.id, label: `v${v.version}${v.placeholder ? ' (placeholder)' : ''} · ${formatDateTime(v.createdAt)}` }))

  return (
    <div className="col gap-4">
      <div className="row-between wrap">
        <div>
          <div className="section-title">Templates</div>
          <div className="section-sub">A template holds versioned system prompts and section structures. Exactly one version is active per channel.</div>
        </div>
        <div className="row">
          <Button icon={<Wand2 size={14} />} onClick={() => setAnalyzeOpen(true)}>
            Analyze pasted script
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={14} />}
            onClick={() => {
              setPrefill(null)
              setDialog({ kind: 'create' })
            }}
          >
            New template
          </Button>
        </div>
      </div>

      {templates.loading ? (
        <SkeletonRows />
      ) : (templates.data ?? []).length === 0 ? (
        <EmptyState compact icon={<Sparkles size={20} />} title="No templates" description="Create a template or analyze an approved script to generate one." />
      ) : (
        <div className="row wrap">
          {(templates.data ?? []).map((t) => (
            <button key={t.id} type="button" className={`tab ${t.id === selectedId ? 'active' : ''}`} style={{ border: '1px solid var(--border)', borderRadius: 8, margin: 0 }} onClick={() => setSelectedId(t.id)}>
              {t.name}
              {t.activeVersionId && t.activeVersionId === activeVersionId && <Badge tone="success">active</Badge>}
              <span className="xs subtle">· {t.latestVersion} ver.</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="col gap-3">
          <div className="row-between wrap">
            <div className="row">
              <span className="strong">{selected.name}</span>
              <Button size="sm" variant="ghost" onClick={() => rename(selected)}>
                Rename
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash size={12} />} onClick={() => setDeleting(selected)}>
                Delete
              </Button>
            </div>
            <div className="row">
              {versionList.length >= 2 && (
                <Button
                  size="sm"
                  icon={<GitCompare size={12} />}
                  onClick={() => {
                    const a = versionList[1]
                    const b = versionList[0]
                    if (a && b) setDiffPair({ a: a.id, b: b.id })
                  }}
                >
                  Compare versions
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                icon={<Plus size={12} />}
                onClick={() => {
                  const latest = versionList[0]
                  setPrefill(latest ? { systemPrompt: latest.systemPrompt, structure: latest.structure, exampleScript: latest.exampleScript, notes: '', placeholder: false } : null)
                  setDialog({ kind: 'addVersion', template: selected })
                }}
              >
                Add version
              </Button>
            </div>
          </div>
          {versions.loading ? (
            <SkeletonRows rows={3} />
          ) : (
            <div className="version-list">
              {versionList.map((v) => {
                const active = v.id === activeVersionId
                return (
                  <div key={v.id} className={`version-row ${active ? 'active' : ''}`}>
                    <span className="strong">v{v.version}</span>
                    {active && (
                      <Badge tone="success">
                        <BadgeCheck size={10} /> active
                      </Badge>
                    )}
                    {v.placeholder && <Badge tone="warning">placeholder</Badge>}
                    <span className="xs muted">{formatDateTime(v.createdAt)}</span>
                    <span className="xs muted">{v.structure.length} sections</span>
                    <span className="small muted truncate grow" title={v.notes}>
                      {v.notes}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>
                      View
                    </Button>
                    {!active && (
                      <Button size="sm" loading={busy === `active:${v.id}`} onClick={() => setActive(v)}>
                        Set active
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <VersionFormDialog
        state={dialog}
        prefill={prefill}
        channelId={channelId}
        onClose={() => setDialog(null)}
        onSaved={async () => {
          setDialog(null)
          await templates.reload()
          await versions.reload()
          await useApp.getState().refreshChannels()
        }}
      />

      <AnalyzeDialog
        open={analyzeOpen}
        channelId={channelId}
        instructions={channelInstructions}
        onClose={() => setAnalyzeOpen(false)}
        onUse={(input) => {
          setAnalyzeOpen(false)
          setPrefill(input)
          setDialog(selected ? { kind: 'addVersion', template: selected } : { kind: 'create' })
        }}
      />

      <Dialog open={Boolean(diffPair)} onClose={() => setDiffPair(null)} size="xl" title="Compare system prompts">
        {diffPair && (
          <>
            <div className="form-grid">
              <Field label="Older">
                <Select value={diffPair.a} onChange={(v) => setDiffPair({ ...diffPair, a: v })} options={versionOptions} />
              </Field>
              <Field label="Newer">
                <Select value={diffPair.b} onChange={(v) => setDiffPair({ ...diffPair, b: v })} options={versionOptions} />
              </Field>
            </div>
            <DiffView
              oldText={versionList.find((v) => v.id === diffPair.a)?.systemPrompt ?? ''}
              newText={versionList.find((v) => v.id === diffPair.b)?.systemPrompt ?? ''}
              oldLabel={`v${versionList.find((v) => v.id === diffPair.a)?.version ?? '?'}`}
              newLabel={`v${versionList.find((v) => v.id === diffPair.b)?.version ?? '?'}`}
            />
          </>
        )}
      </Dialog>

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} size="lg" title={viewing ? `Version ${viewing.version}` : ''} description={viewing?.notes}>
        {viewing && (
          <>
            <Field label="System prompt">
              <pre className="log-view" style={{ maxHeight: 300 }}>{viewing.systemPrompt}</pre>
            </Field>
            <Field label="Structure">
              {viewing.structure.length === 0 ? (
                <span className="small muted">No sections.</span>
              ) : (
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {viewing.structure.map((s) => (
                    <li key={s.key}>
                      <strong>{s.label}</strong> {s.required ? '' : '(optional)'} {s.aliases.length ? <span className="muted">· aliases: {s.aliases.join(', ')}</span> : null}
                      {s.guidance && <div className="xs muted">{s.guidance}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </Field>
            {viewing.exampleScript && (
              <Field label="Example script">
                <pre className="log-view" style={{ maxHeight: 220 }}>{viewing.exampleScript}</pre>
              </Field>
            )}
          </>
        )}
      </Dialog>

      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={confirmDelete} danger title={`Delete template "${deleting?.name ?? ''}"?`} message="All versions of this template are removed. If one of them is the channel's active version, generation will be blocked until you activate another." confirmLabel="Delete" />
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function VersionFormDialog({ state, prefill, channelId, onClose, onSaved }: { state: VersionDialog; prefill: TemplateVersionInput | null; channelId: string; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const [name, setName] = useState('')
  const [value, setValue] = useState<TemplateVersionInput>(emptyVersion())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (state) {
      setValue(prefill ?? emptyVersion())
      setName(state.kind === 'addVersion' ? state.template.name : '')
      setErrors({})
    }
  }, [state, prefill])

  const save = async (): Promise<void> => {
    const parsed = templateVersionInputSchema.safeParse(value)
    if (!parsed.success) {
      const errs: Record<string, string> = {}
      for (const i of parsed.error.issues) {
        const k = String(i.path[0] ?? '_')
        if (!errs[k]) errs[k] = i.message
      }
      setErrors(errs)
      return
    }
    if (state?.kind === 'create' && !name.trim()) {
      setErrors({ name: 'Template name is required' })
      return
    }
    setSaving(true)
    try {
      if (state?.kind === 'create') {
        await api.invoke('templates:create', { channelId, name: name.trim(), initial: parsed.data })
        toast.success('Template created', name.trim())
      } else if (state?.kind === 'addVersion') {
        const v = await api.invoke('templates:addVersion', { templateId: state.template.id, input: parsed.data })
        toast.success('Version added', `v${v.version} of ${state.template.name}. Remember to set it active.`)
      }
      await onSaved()
    } catch (err) {
      toast.error('Could not save template', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={Boolean(state)}
      onClose={onClose}
      size="xl"
      title={state?.kind === 'create' ? 'New template' : `Add version to "${state?.kind === 'addVersion' ? state.template.name : ''}"`}
      description="The new version is not activated automatically."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {state?.kind === 'create' ? 'Create template' : 'Add version'}
          </Button>
        </>
      }
    >
      {state?.kind === 'create' && (
        <Field label="Template name" error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Game Vault review" data-autofocus />
        </Field>
      )}
      <TemplateVersionForm value={value} onChange={setValue} errors={errors} />
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */

function AnalyzeDialog({ open, channelId, instructions, onClose, onUse }: { open: boolean; channelId: string; instructions: string; onClose: () => void; onUse: (input: TemplateVersionInput) => void }): JSX.Element {
  const [script, setScript] = useState('')
  const [instr, setInstr] = useState(instructions)
  const [result, setResult] = useState<TemplateAnalysis | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setInstr(instructions)
      setResult(null)
    }
  }, [open, instructions])

  const run = async (): Promise<void> => {
    if (script.trim().length < 50) {
      toast.warning('Paste a full script', 'At least 50 characters are needed for a useful analysis.')
      return
    }
    setBusy(true)
    try {
      const r = await api.invoke('templates:analyze', { channelId, exampleScript: script, instructions: instr })
      setResult(r)
    } catch (err) {
      toast.error('Analysis failed', err)
    } finally {
      setBusy(false)
    }
  }

  const useAsVersion = (): void => {
    if (!result) return
    onUse({
      systemPrompt: result.suggestedSystemPrompt,
      structure: result.suggestedStructure,
      exampleScript: script,
      notes: `Generated from an approved example script (${result.wordCount} words, ${result.charCount} chars). Review before activating.`,
      placeholder: false
    })
  }

  const sectionsPreview = useMemo(() => result?.suggestedStructure.map((s) => s.label).join(' → ') ?? '', [result])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Analyze an approved script"
      description="Derives a section structure and system prompt from one example. Treat the result as a draft."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button loading={busy} onClick={run} icon={<Wand2 size={14} />}>
            Analyze
          </Button>
          <Button variant="primary" disabled={!result} onClick={useAsVersion}>
            Use as new version
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Approved script" className="span-2">
          <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={10} placeholder="Paste the full approved script…" />
        </Field>
        <Field label="Writing instructions for this channel" className="span-2" hint="Pre-filled from the channel; edit if the script follows different rules.">
          <Textarea value={instr} onChange={(e) => setInstr(e.target.value)} rows={4} />
        </Field>
      </div>
      {result && (
        <div className="col gap-3">
          <Alert tone="warning" title="Caveats — read before using">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>One example cannot capture every stylistic rule of a channel; edit the suggested prompt before activating it.</li>
              {result.caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </Alert>
          <Field label="Suggested structure">
            <div className="small">{sectionsPreview || <span className="muted">No clear sections detected.</span>}</div>
          </Field>
          <Field label="Suggested system prompt">
            <pre className="log-view" style={{ maxHeight: 260 }}>{result.suggestedSystemPrompt}</pre>
          </Field>
          {result.observations.length > 0 && (
            <Field label="Observations">
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {result.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </Field>
          )}
          <div className="xs subtle">
            {result.wordCount} words · {result.charCount} characters in the example.
          </div>
        </div>
      )}
    </Dialog>
  )
}
