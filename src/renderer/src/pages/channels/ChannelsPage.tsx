import { useMemo, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, Copy, Download, FileText, Pencil, Plus, Trash, Tv, Upload } from 'lucide-react'
import type { Channel } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { activeChannels, useApp } from '@/store/app'
import { useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Badge, Button, Card, ChannelIcon, Checkbox, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui'
import { ChannelEditor } from './ChannelEditor'

export function ChannelsPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const jobs = useApp((s) => s.jobs)
  const params = useRouter((s) => s.params)
  const setParams = useRouter((s) => s.setParams)
  const [showArchived, setShowArchived] = useState(false)
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const editId = params.edit ?? null
  const list = useMemo(() => (showArchived ? [...channels].sort((a, b) => a.position - b.position) : activeChannels(channels)), [channels, showArchived])

  // Template status per channel (placeholder / missing).
  const templateStatus = useAsync(async () => {
    const out: Record<string, { placeholder: boolean; missing: boolean; name: string | null }> = {}
    await Promise.all(
      channels.map(async (c) => {
        if (!c.activeTemplateVersionId) {
          out[c.id] = { placeholder: false, missing: true, name: null }
          return
        }
        try {
          const v = await api.invoke('templates:getVersion', { versionId: c.activeTemplateVersionId })
          const ts = await api.invoke('templates:list', { channelId: c.id })
          out[c.id] = { placeholder: v.placeholder, missing: false, name: ts.find((t) => t.id === v.templateId)?.name ?? null }
        } catch {
          out[c.id] = { placeholder: false, missing: true, name: null }
        }
      })
    )
    return out
  }, [channels.map((c) => `${c.id}:${c.activeTemplateVersionId}`).join('|')])

  const jobCounts = useMemo(() => {
    const m: Record<string, { active: number; failed: number; total: number }> = {}
    for (const j of Object.values(jobs)) {
      const e = (m[j.channelId] ??= { active: 0, failed: 0, total: 0 })
      e.total++
      if (j.status === 'failed') e.failed++
      else if (j.status !== 'completed' && j.status !== 'cancelled') e.active++
    }
    return m
  }, [jobs])

  const openEditor = (id: string, tab?: string): void => setParams({ edit: id, tab })
  const closeEditor = (): void => setParams({})

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
    return <ChannelEditor channelId={editId === 'new' ? null : editId} initialTab={params.tab} onClose={closeEditor} />
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="Channels"
        subtitle="Each channel carries its own writing rules, template, voice and output folder."
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

      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<Tv size={22} />} title="No channels yet" description="Create a channel to define how its scripts are written and voiced." actions={<Button variant="primary" onClick={() => openEditor('new')}>Add channel</Button>} />
        </Card>
      ) : (
        <div className="grid grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {list.map((c, i) => {
            const ts = templateStatus.data?.[c.id]
            const jc = jobCounts[c.id]
            return (
              <Card key={c.id} padded>
                <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
                  <ChannelIcon icon={c.icon} color={c.color} size="lg" />
                  <div className="col grow" style={{ gap: 2 }}>
                    <div className="row">
                      <span className="strong" style={{ fontSize: 15 }}>
                        {c.name}
                      </span>
                      {c.archived && <Badge>archived</Badge>}
                    </div>
                    <span className="xs muted">
                      {c.category} · {c.language.toUpperCase()} · {c.minChars.toLocaleString()}–{c.maxChars.toLocaleString()} chars
                    </span>
                    <span className="small muted" style={{ marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {c.description || 'No description.'}
                    </span>
                  </div>
                  {!showArchived && (
                    <div className="col" style={{ gap: 0 }}>
                      <Button variant="ghost" size="sm" iconOnly icon={<ArrowUp size={12} />} disabled={i === 0} onClick={() => reorder(c, -1)} title="Move up" />
                      <Button variant="ghost" size="sm" iconOnly icon={<ArrowDown size={12} />} disabled={i === list.length - 1} onClick={() => reorder(c, 1)} title="Move down" />
                    </div>
                  )}
                </div>
                <div className="row wrap mt-3" style={{ gap: 6 }}>
                  <Badge tone={c.elevenVoiceId ? 'success' : 'warning'} dot>
                    {c.elevenVoiceName ?? (c.elevenVoiceId ? c.elevenVoiceId : 'No voice')}
                  </Badge>
                  {ts ? (
                    ts.missing ? (
                      <Badge tone="danger">no template</Badge>
                    ) : ts.placeholder ? (
                      <Badge tone="warning" title={ts.name ?? ''}>placeholder template</Badge>
                    ) : (
                      <Badge tone="info" title={ts.name ?? ''}>template ready</Badge>
                    )
                  ) : (
                    <Badge>template…</Badge>
                  )}
                  {jc && jc.total > 0 && (
                    <Badge title={`${jc.total} jobs loaded`}>
                      {jc.active} active{jc.failed ? ` · ${jc.failed} failed` : ''}
                    </Badge>
                  )}
                </div>
                <div className="row wrap mt-4" style={{ gap: 4 }}>
                  <Button size="sm" variant="primary" icon={<Pencil size={12} />} onClick={() => openEditor(c.id)}>
                    Edit
                  </Button>
                  <Button size="sm" icon={<FileText size={12} />} onClick={() => openEditor(c.id, 'templates')}>
                    Templates
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} loading={busy === `dup:${c.id}`} onClick={() => duplicate(c)}>
                    Duplicate
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => exportChannel(c)}>
                    Export
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash size={12} />} onClick={() => setDeleting(c)} style={{ marginLeft: 'auto' }}>
                    Delete
                  </Button>
                </div>
              </Card>
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
            The channel, its templates and its job history will be removed from the database. <strong>Project files on disk are preserved</strong> unless you tick the option below. This cannot be undone.
          </>
        }
      />
    </div>
  )
}
