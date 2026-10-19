import { useEffect, useState, type JSX } from 'react'
import { Layers, Plus } from 'lucide-react'
import type { Template } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { contentTypeLabel, normalizeStatus, STATUS_LABEL } from '@/lib/formats'
import { slugify } from '@/lib/format'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Button, ConfirmDialog, Dialog, EmptyState, Field, Input, SkeletonRows } from '@/components/ui'
import { FormatStatusPill } from '@/components/FormatStatus'
import { FormatWorkspace } from './FormatWorkspace'

export interface StyleStudioProps {
  channelId: string
  channelName: string
  activeVersionId: string | null
  channelInstructions: string
  initialTemplateId?: string | undefined
  minChars: number
  maxChars: number
  targetDurationSec?: number
}

/**
 * Channel Style Preservation Studio: one workspace per content type ("format").
 * Formats never overwrite each other; each keeps its own references, versions and tests.
 */
export function StyleStudio({ channelId, channelName, activeVersionId, channelInstructions, initialTemplateId, minChars, maxChars, targetDurationSec = 300 }: StyleStudioProps): JSX.Element {
  const templates = useAsync(() => api.invoke('templates:list', { channelId }), [channelId], { fallback: [] })
  const [selectedId, setSelectedId] = useState<string | null>(initialTemplateId ?? null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<Template | null>(null)

  const list = (templates.data ?? []).filter((t) => t.channelId === channelId)

  useEffect(() => {
    if (list.length === 0) return
    if (selectedId && list.some((t) => t.id === selectedId)) return
    const owner = list.find((t) => t.activeVersionId === activeVersionId)
    setSelectedId((owner ?? list[0])?.id ?? null)
  }, [list, activeVersionId, selectedId])

  const selected = list.find((t) => t.id === selectedId) ?? null

  const refresh = async (): Promise<void> => {
    await templates.reload()
    await useApp.getState().refreshChannels()
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('templates:delete', { templateId: deleting.id })
      setDeleting(null)
      setSelectedId(null)
      await refresh()
      toast.success('Format deleted', deleting.name)
    } catch (err) {
      toast.error('Could not delete format', err)
    }
  }

  return (
    <div className="studio">
      <aside className="studio-formats">
        <div className="studio-formats-head">
          <span className="section-title">Formats</span>
          <Button size="sm" variant="ghost" iconOnly icon={<Plus size={14} />} onClick={() => setAdding(true)} title="Add content type" />
        </div>
        {templates.loading && list.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : list.length === 0 ? (
          <div className="xs muted" style={{ padding: '4px 2px' }}>
            No formats yet.
          </div>
        ) : (
          <div className="studio-format-list" role="tablist" aria-label="Content types">
            {list.map((t) => {
              const st = normalizeStatus(t.approvalStatus)
              const isDefault = Boolean(activeVersionId && t.activeVersionId === activeVersionId)
              return (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === selectedId} className={`studio-format ${t.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(t.id)} title={STATUS_LABEL[st]}>
                  <span className="studio-format-name">
                    {contentTypeLabel(t.contentType)}
                    {contentTypeLabel(t.contentType) !== 'Short' && <span className="xs subtle"> · {t.formFactor === 'short' ? 'Short' : 'Long'}</span>}
                    {isDefault && <span className="xs subtle"> · default</span>}
                  </span>
                  <span className="xs muted truncate">{t.name}</span>
                  <FormatStatusPill status={st} />
                </button>
              )
            })}
          </div>
        )}
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
          Add content type
        </Button>
        <p className="xs subtle" style={{ margin: 0 }}>
          Use one format per kind of video (for example Review and Gameplay). Formats never overwrite each other.
        </p>
      </aside>

      <section className="studio-main">
        {selected ? (
          <FormatWorkspace
            key={selected.id}
            channelId={channelId}
            channelName={channelName}
            template={selected}
            isDefault={Boolean(activeVersionId && selected.activeVersionId === activeVersionId)}
            channelInstructions={channelInstructions}
            minChars={minChars}
            maxChars={maxChars}
            targetDurationSec={targetDurationSec}
            onChanged={refresh}
            onDelete={() => setDeleting(selected)}
          />
        ) : !templates.loading ? (
          <EmptyState
            icon={<Layers size={22} />}
            title="Add this channel's first format"
            description="A format is one kind of script this channel publishes. Import 3–5 approved scripts for it and the app extracts the structure for you to approve."
            actions={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                Add content type
              </Button>
            }
          />
        ) : null}
      </section>

      <AddFormatDialog
        open={adding}
        channelId={channelId}
        channelName={channelName}
        existing={list}
        onClose={() => setAdding(false)}
        onCreated={async (t) => {
          setAdding(false)
          await refresh()
          setSelectedId(t.id)
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        danger
        title={`Delete the "${deleting ? contentTypeLabel(deleting.contentType) : ''}" format?`}
        message="Its versions, reference scripts and test results are removed. Scripts and audio already generated with it stay untouched. If it is the channel's default format, another format becomes the default."
        confirmLabel="Delete format"
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */

const SUGGESTED_TYPES = ['review', 'gameplay', 'unboxing', 'full_review', 'short_review', 'product_overview', 'first_impressions']

function AddFormatDialog({ open, channelId, channelName, existing, onClose, onCreated }: { open: boolean; channelId: string; channelName: string; existing: Template[]; onClose: () => void; onCreated: (t: Template) => Promise<void> }): JSX.Element {
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setLabel('')
      setKey('')
      setKeyTouched(false)
    }
  }, [open])

  const finalKey = (keyTouched ? key : slugify(label).replace(/-/g, '_')) || ''
  const taken = existing.some((t) => (t.contentType ?? '') === finalKey)
  const valid = Boolean(label.trim()) && Boolean(finalKey) && !taken

  const create = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    try {
      const t = await api.invoke('templates:create', {
        channelId,
        name: `${channelName} — ${label.trim()}`,
        contentType: finalKey,
        initial: {
          systemPrompt: '',
          structure: [],
          exampleScript: null,
          notes: 'Created empty. Import approved reference scripts to extract the format.',
          placeholder: true,
          approvalStatus: 'not_configured'
        }
      })
      toast.success('Format added', `${label.trim()} — import reference scripts next.`)
      await onCreated(t)
    } catch (err) {
      toast.error('Could not add format', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a content type"
      description="Each content type gets its own references, structure and approval."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={create}>
            Add format
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Shown in pickers, e.g. Review, Gameplay, Unboxing, Short review.">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Review"
          data-autofocus
          maxLength={60}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
      </Field>
      <Field label="Key" hint="Stable identifier stored on every script." error={taken ? 'This channel already has a format with this key.' : undefined}>
        <Input
          className="mono"
          value={finalKey}
          onChange={(e) => {
            setKeyTouched(true)
            setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_'))
          }}
          invalid={taken}
          maxLength={40}
        />
      </Field>
      <div className="row wrap" style={{ gap: 6 }}>
        {SUGGESTED_TYPES.filter((s) => !existing.some((t) => t.contentType === s)).map((s) => (
          <button
            key={s}
            type="button"
            className="filter-chip"
            onClick={() => {
              setLabel(contentTypeLabel(s))
              setKey(s)
              setKeyTouched(true)
            }}
          >
            {contentTypeLabel(s)}
          </button>
        ))}
      </div>
    </Dialog>
  )
}
