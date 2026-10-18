import { useEffect, useState, type DragEvent, type JSX } from 'react'
import { ArrowRight, ClipboardPaste, Eye, FilePlus2, Pencil, Trash, Upload } from 'lucide-react'
import type { ReferenceFormat, ReferenceScript, Template } from '@shared/types'
import { api } from '@/lib/api'
import { basename, formatNumber, wordCount } from '@/lib/format'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, SkeletonRows, Textarea } from '@/components/ui'

export interface ReferencesStepProps {
  template: Template
  refs: ReferenceScript[]
  loading: boolean
  minChars: number
  maxChars: number
  onChanged: () => Promise<void>
  onNext: () => void
}

const FORMAT_LABEL: Record<ReferenceFormat, string> = { paste: 'Pasted', txt: 'TXT', md: 'Markdown', docx: 'Word', pdf: 'PDF' }

export function ReferencesStep({ template, refs, loading, minChars, maxChars, onChanged, onNext }: ReferencesStepProps): JSX.Element {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: 'add' } | { mode: 'edit' | 'view'; ref: ReferenceScript } | null>(null)
  const [deleting, setDeleting] = useState<ReferenceScript | null>(null)

  const importPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    setBusy('import')
    try {
      const r = await api.invoke('references:importFiles', { templateId: template.id, paths })
      if (r.added.length) toast.success(`${r.added.length} reference script${r.added.length === 1 ? '' : 's'} added`, r.added.map((a) => a.title).join(', '))
      for (const f of r.failed) toast.error(`Could not import ${basename(f.path)}`, f.message)
      await onChanged()
    } catch (err) {
      toast.error('Import failed', err)
    } finally {
      setBusy(null)
    }
  }

  const chooseFiles = async (): Promise<void> => {
    try {
      const paths = await api.invoke('app:selectFiles', {
        title: 'Import approved reference scripts',
        multiple: true,
        filters: [
          { name: 'Scripts', extensions: ['txt', 'md', 'markdown', 'docx', 'pdf'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      await importPaths(paths)
    } catch (err) {
      toast.error('Could not open the file picker', err)
    }
  }

  // Dropped files: the sandboxed renderer cannot see file paths, so text files are read here
  // and sent as text; Word/PDF need the file picker (main parses those).
  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    let added = 0
    let needsPicker = 0
    setBusy('import')
    try {
      for (const file of files) {
        const name = file.name.toLowerCase()
        const fmt: ReferenceFormat | null = name.endsWith('.txt') ? 'txt' : name.endsWith('.md') || name.endsWith('.markdown') ? 'md' : null
        if (!fmt) {
          needsPicker++
          continue
        }
        const text = (await file.text()).trim()
        if (!text) continue
        await api.invoke('references:add', { templateId: template.id, title: file.name.replace(/\.[^.]+$/, ''), text, sourceFormat: fmt, sourceFileName: file.name })
        added++
      }
      if (added) toast.success(`${added} reference script${added === 1 ? '' : 's'} added`)
      if (needsPicker) toast.info('Use "Choose files" for Word and PDF', 'Dropped .docx/.pdf files have to go through the file picker so the app can read them.')
      await onChanged()
    } catch (err) {
      toast.error('Import failed', err)
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('references:delete', { id: deleting.id })
      setDeleting(null)
      await onChanged()
      toast.success('Reference removed', deleting.title)
    } catch (err) {
      toast.error('Could not remove reference', err)
    }
  }

  const n = refs.length

  return (
    <div className="col gap-4">
      <div>
        <div className="section-title">Approved reference scripts</div>
        <div className="section-sub">
          Add scripts you already approved for this format. They are the only source of the structure, fixed intro/outro and style — nothing is invented when they are missing. 3–5 scripts are recommended; one example is not enough to confirm a rule.
        </div>
      </div>

      <div
        className={`ref-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Upload size={18} />
        <div className="col" style={{ gap: 2 }}>
          <span className="strong">Drop .txt or .md files here</span>
          <span className="xs muted">Word (.docx) and PDF: use Choose files. Each file becomes one reference.</span>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <Button icon={<FilePlus2 size={14} />} loading={busy === 'import'} onClick={chooseFiles}>
            Choose files
          </Button>
          <Button icon={<ClipboardPaste size={14} />} onClick={() => setEditor({ mode: 'add' })}>
            Paste a script
          </Button>
        </div>
      </div>

      {loading && n === 0 ? (
        <SkeletonRows rows={3} />
      ) : n === 0 ? (
        <EmptyState compact icon={<FilePlus2 size={20} />} title="No references yet" description="Import at least three approved scripts so repeated intro/outro text and the section order can be detected reliably." />
      ) : (
        <div className="ref-list">
          {refs.map((r) => {
            const out = r.charCount > maxChars || r.charCount < minChars
            return (
              <div key={r.id} className="ref-row">
                <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="strong truncate">{r.title}</span>
                  <span className="xs muted tnum">
                    {formatNumber(r.charCount)} chars · {formatNumber(r.wordCount)} words
                    {r.sourceFileName ? ` · ${r.sourceFileName}` : ''}
                  </span>
                </div>
                <Badge>{FORMAT_LABEL[r.sourceFormat] ?? r.sourceFormat}</Badge>
                {out && (
                  <Badge tone="warning" title={`Channel limits: ${formatNumber(minChars)}–${formatNumber(maxChars)} characters`}>
                    outside channel length
                  </Badge>
                )}
                <Button size="sm" variant="ghost" iconOnly icon={<Eye size={13} />} title="View" onClick={() => setEditor({ mode: 'view', ref: r })} />
                <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} title="Edit" onClick={() => setEditor({ mode: 'edit', ref: r })} />
                <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} title="Remove" onClick={() => setDeleting(r)} />
              </div>
            )
          })}
        </div>
      )}

      {n > 0 && n < 3 && (
        <Alert tone="info">
          {n === 1 ? 'With one reference' : 'With two references'} the analysis can only mark patterns as <em>inferred</em>. Add {3 - n} more to let it confirm what repeats consistently.
        </Alert>
      )}

      <div className="row-between">
        <span className="xs subtle">Changing the reference set creates a new reference set version; scripts record which set they were written with.</span>
        <Button variant="primary" icon={<ArrowRight size={14} />} disabled={n === 0} onClick={onNext}>
          Continue to analysis
        </Button>
      </div>

      <ReferenceDialog
        state={editor}
        templateId={template.id}
        onClose={() => setEditor(null)}
        onSaved={async () => {
          setEditor(null)
          await onChanged()
        }}
      />
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={confirmDelete} danger title={`Remove "${deleting?.title ?? ''}"?`} message="The reference is removed from this format. Versions already saved keep the rules they were built with." confirmLabel="Remove" />
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function ReferenceDialog({ state, templateId, onClose, onSaved }: { state: { mode: 'add' } | { mode: 'edit' | 'view'; ref: ReferenceScript } | null; templateId: string; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const viewOnly = state?.mode === 'view'

  useEffect(() => {
    if (!state) return
    if (state.mode === 'add') {
      setTitle('')
      setText('')
    } else {
      setTitle(state.ref.title)
      setText(state.ref.text)
    }
  }, [state])

  const valid = title.trim().length > 0 && text.trim().length >= 50

  const save = async (): Promise<void> => {
    if (!state || !valid) return
    setSaving(true)
    try {
      if (state.mode === 'add') {
        await api.invoke('references:add', { templateId, title: title.trim(), text: text.trim(), sourceFormat: 'paste', sourceFileName: null })
        toast.success('Reference added', title.trim())
      } else {
        await api.invoke('references:update', { id: state.ref.id, title: title.trim(), text: text.trim() })
        toast.success('Reference updated', title.trim())
      }
      await onSaved()
    } catch (err) {
      toast.error('Could not save reference', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={Boolean(state)}
      onClose={onClose}
      size="xl"
      title={state?.mode === 'add' ? 'Paste an approved script' : state?.mode === 'edit' ? 'Edit reference' : title}
      description={state?.mode === 'add' ? 'Paste the script exactly as it was approved, including headings if your scripts have them.' : undefined}
      footer={
        viewOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!valid} onClick={save}>
              {state?.mode === 'add' ? 'Add reference' : 'Save'}
            </Button>
          </>
        )
      }
    >
      {viewOnly ? (
        <pre className="ref-view">{text}</pre>
      ) : (
        <>
          <Field label="Title" hint="Usually the game or product the script was about.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Emberward" data-autofocus maxLength={160} />
          </Field>
          <Field label="Script" hint={text.trim().length > 0 && text.trim().length < 50 ? 'At least 50 characters are needed.' : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} className="script-editor" placeholder="Paste the full approved script…" spellCheck={false} />
          </Field>
          <div className="xs muted tnum">
            {formatNumber(text.length)} characters · {formatNumber(wordCount(text))} words
          </div>
        </>
      )}
    </Dialog>
  )
}
