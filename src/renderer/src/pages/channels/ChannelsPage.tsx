import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, Copy, Download, Layers, Pencil, Plus, Trash, Tv, Upload } from 'lucide-react'
import type { Channel } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { channelStatus, contentTypeLabel, GROUP_LABEL, loadFormats, statusGroup, type ChannelFormat, type StatusGroup } from '@/lib/formats'
import { activeChannels, useApp } from '@/store/app'
import { useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Badge, Button, Card, ChannelIcon, Checkbox, ConfirmDialog, EmptyState, PageHeader, SearchInput } from '@/components/ui'
import { FormatStatusPill } from '@/components/FormatStatus'
import { ChannelEditor } from './ChannelEditor'

const GROUPS: StatusGroup[] = ['ready', 'provisional', 'needs_approval', 'needs_references']
const CATEGORIES: Array<{ id: Channel['category']; label: string }> = [
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'other', label: 'Other' }
]

function isGroup(v: string | undefined): v is StatusGroup {
  return GROUPS.includes(v as StatusGroup)
}

export function ChannelsPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const jobs = useApp((s) => s.jobs)
  const params = useRouter((s) => s.params)
  const setParams = useRouter((s) => s.setParams)
  const [showArchived, setShowArchived] = useState(false)
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<StatusGroup | null>(isGroup(params.status) ? params.status : null)
  const [category, setCategory] = useState<Channel['category'] | null>(null)

  useEffect(() => {
    if (isGroup(params.status)) setGroup(params.status)
  }, [params.status])

  const editId = params.edit ?? null
  const base = useMemo(() => (showArchived ? [...channels].sort((a, b) => a.position - b.position) : activeChannels(channels)), [channels, showArchived])

  const formats = useAsync(() => loadFormats(base), [base.map((c) => `${c.id}:${c.activeTemplateVersionId}:${c.updatedAt}`).join('|'), editId], { fallback: {} })
  const formatsOf = (c: Channel): ChannelFormat[] | undefined => formats.data?.[c.id]

  const groupCounts = useMemo(() => {
    const m: Record<StatusGroup, number> = { ready: 0, provisional: 0, needs_approval: 0, needs_references: 0 }
    if (!formats.data) return m
    for (const c of base) m[statusGroup(channelStatus(formats.data[c.id]))]++
    return m
  }, [base, formats.data])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return base.filter((c) => {
      if (q && !`${c.name} ${c.description}`.toLowerCase().includes(q)) return false
      if (category && c.category !== category) return false
      if (group && formats.data && statusGroup(channelStatus(formats.data[c.id])) !== group) return false
      return true
    })
  }, [base, query, category, group, formats.data])
  const filtered = list.length !== base.length || Boolean(query || group || category)

  const jobCounts = useMemo(() => {
    const m: Record<string, { active: number; failed: number }> = {}
    for (const j of Object.values(jobs)) {
      const e = (m[j.channelId] ??= { active: 0, failed: 0 })
      if (j.status === 'failed') e.failed++
      else if (j.status !== 'completed' && j.status !== 'cancelled') e.active++
    }
    return m
  }, [jobs])

  const openEditor = (id: string, tab?: string): void => setParams({ edit: id, tab })
  const closeEditor = (): void => setParams(group ? { status: group } : {})
  const pickGroup = (g: StatusGroup | null): void => {
    setGroup(g)
    setParams(g ? { status: g } : {})
  }

  const duplicate = async (c: Channel): Promise<void> => {
    setBusy(`dup:${c.id}`)
    try {
      const copy = await api.invoke('channels:duplicate', { id: c.id })
      await useApp.getState().refreshChannels()
      toast.success('Channel duplicated', copy.name)
    } catch (err) {
      toast.error('Could not duplicate channel', err)
    } finally {
      setBusy(null)
    }
  }

  const exportChannel = async (c: Channel): Promise<void> => {
    try {
      const path = await api.invoke('app:saveFileDialog', {
        title: 'Export channel',
        defaultPath: `${c.slug || c.name}.voiceforge-channel.json`,
        filters: [{ name: 'VoiceForge channel', extensions: ['json'] }]
      })
      if (!path) return
      const r = await api.invoke('channels:export', { id: c.id, path })
      toast.success('Channel exported', r.savedTo ?? path)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const importChannel = async (): Promise<void> => {
    try {
      const paths = await api.invoke('app:selectFiles', { title: 'Import channel', filters: [{ name: 'VoiceForge channel', extensions: ['json'] }] })
      const path = paths[0]
      if (!path) return
      const c = await api.invoke('channels:import', { path })
      await useApp.getState().refreshChannels()
      toast.success('Channel imported', c.name)
    } catch (err) {
      toast.error('Import failed', err)
    }
  }

  const reorder = async (c: Channel, dir: -1 | 1): Promise<void> => {
    const ordered = activeChannels(channels)
    const idx = ordered.findIndex((x) => x.id === c.id)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= ordered.length) return
    const ids = ordered.map((x) => x.id)
    const a = ids[idx]
    const b = ids[target]
    if (!a || !b) return
    ids[idx] = b
    ids[target] = a
    try {
      const updated = await api.invoke('channels:reorder', { ids })
      useApp.setState({ channels: updated })
    } catch (err) {
      toast.error('Could not reorder channels', err)
    }
  }

  const confirmDelete = async ({ checkbox }: { checkbox: boolean }): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('channels:delete', { id: deleting.id, deleteFiles: checkbox })
      await useApp.getState().refreshChannels()
      toast.success('Channel deleted', deleting.name)
      setDeleting(null)
    } catch (err) {
      toast.error('Could not delete channel', err)
    }
  }

  if (editId) {
    return <ChannelEditor key={editId} channelId={editId === 'new' ? null : editId} initialTab={params.tab} initialFormat={params.format} onClose={closeEditor} />
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="Channels"
        subtitle="Each channel keeps its own formats, voice and output folder. A format only runs unattended after you approve it."
        actions={
          <>
            <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
            <Button icon={<Upload size={14} />} onClick={importChannel}>
              Import
            </Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => openEditor('new')}>
              Add channel
            </Button>
          </>
        }
      />

      <div className="channels-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search channels…" style={{ width: 240 }} />
        <div className="filter-chips" role="group" aria-label="Filter by format status">
          <button type="button" className={`filter-chip ${group === null ? 'active' : ''}`} onClick={() => pickGroup(null)}>
            All <span className="segment-count">{base.length}</span>
          </button>
          {GROUPS.map((g) => (
            <button key={g} type="button" className={`filter-chip filter-chip-${g} ${group === g ? 'active' : ''}`} onClick={() => pickGroup(group === g ? null : g)}>
              {GROUP_LABEL[g]} <span className="segment-count">{groupCounts[g]}</span>
            </button>
          ))}
        </div>
        <div className="filter-chips" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={`filter-chip ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(category === c.id ? null : c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {base.length === 0 ? (
        <Card>
          <EmptyState icon={<Tv size={22} />} title="No channels yet" description="Create a channel to define how its scripts are written and voiced." actions={<Button variant="primary" onClick={() => openEditor('new')}>Add channel</Button>} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            compact
            icon={<Tv size={20} />}
            title="No channels match"
            description="Try another search or clear the filters."
            actions={
              <Button
                onClick={() => {
                  setQuery('')
                  setCategory(null)
                  pickGroup(null)
                }}
              >
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="channel-list">
          {list.map((c, i) => {
            const fs = formatsOf(c)
            const jc = jobCounts[c.id]
            return (
              <div key={c.id} className="channel-row">
                <button type="button" className="channel-row-main" onClick={() => openEditor(c.id)} title={`Edit ${c.name}`}>
                  <ChannelIcon icon={c.icon} color={c.color} />
                  <span className="channel-row-name">
                    <span className="strong">{c.name}</span>
                    {c.archived && <Badge>archived</Badge>}
                    <span className="xs muted">
                      {c.category} · {c.language.toUpperCase()} · {c.minChars.toLocaleString()}–{c.maxChars.toLocaleString()} chars
                    </span>
                  </span>
                </button>
                <div className="channel-row-voice">
                  <Badge tone={c.elevenVoiceId ? 'success' : 'warning'} dot>
                    {c.elevenVoiceName ?? (c.elevenVoiceId ? c.elevenVoiceId : 'No voice')}
                  </Badge>
                  {jc && (jc.active > 0 || jc.failed > 0) && (
                    <span className="xs muted">
                      {jc.active} active{jc.failed ? ` · ${jc.failed} failed` : ''}
                    </span>
                  )}
                </div>
                <div className="channel-row-formats">
                  {!fs ? (
                    <span className="xs subtle">Loading formats…</span>
                  ) : fs.length === 0 ? (
                    <FormatStatusPill status="not_configured" />
                  ) : (
                    fs.map((f) => (
                      <button key={f.template.id} type="button" className="format-link" onClick={() => setParams({ edit: c.id, tab: 'formats', format: f.template.id })} title={`${f.template.name} — open in the Formats tab`}>
                        <FormatStatusPill status={f.status} prefix={fs.length > 1 ? `${contentTypeLabel(f.template.contentType)}${f.template.formFactor === 'short' ? ' (Short)' : ''}` : undefined} />
                      </button>
                    ))
                  )}
                </div>
                <div className="channel-row-actions">
                  <Button size="sm" icon={<Layers size={12} />} onClick={() => openEditor(c.id, 'formats')}>
                    Formats
                  </Button>
                  <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} onClick={() => openEditor(c.id)} title="Edit channel" />
                  <Button size="sm" variant="ghost" iconOnly icon={<Copy size={13} />} loading={busy === `dup:${c.id}`} onClick={() => duplicate(c)} title="Duplicate" />
                  <Button size="sm" variant="ghost" iconOnly icon={<Download size={13} />} onClick={() => exportChannel(c)} title="Export" />
                  <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} onClick={() => setDeleting(c)} title="Delete" />
                  {!showArchived && !filtered && (
                    <span className="channel-row-order">
                      <Button variant="ghost" size="sm" iconOnly icon={<ArrowUp size={12} />} disabled={i === 0} onClick={() => reorder(c, -1)} title="Move up" />
                      <Button variant="ghost" size="sm" iconOnly icon={<ArrowDown size={12} />} disabled={i === list.length - 1} onClick={() => reorder(c, 1)} title="Move down" />
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        danger
        title={`Delete "${deleting?.name ?? ''}"?`}
        confirmLabel="Delete channel"
        checkboxLabel="Also delete generated files (scripts and audio on disk)"
        checkboxDefault={false}
        message={
          <>
            The channel, its formats, reference scripts and job history will be removed from the database. <strong>Project files on disk are preserved</strong> unless you tick the option below. This cannot be undone.
          </>
        }
      />
    </div>
  )
}
