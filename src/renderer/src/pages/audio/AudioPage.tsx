import { useMemo, useState, type JSX } from 'react'
import { AudioLines, Copy, Download, FolderOpen, Mic, Play, RefreshCw, Trash } from 'lucide-react'
import type { AudioView } from '@shared/types'
import { api, audioUrl } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { activeChannels, useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { basename, formatBytes, formatDateTime, formatDuration, formatNumber, relativeTime } from '@/lib/format'
import { navigate } from '@/store/router'
import { Alert, AudioPlayer, Badge, Button, ChannelChip, ConfirmDialog, Dialog, EmptyState, PageHeader, SearchInput, Select, Table, type Column } from '@/components/ui'
import { RegenerateAudioDialog, type RegenerateAudioTarget } from '@/components/dialogs/RegenerateAudioDialog'

export function AudioPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, 200)
  const [channelId, setChannelId] = useState('')
  const [status, setStatus] = useState('')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [regen, setRegen] = useState<RegenerateAudioTarget | null>(null)
  const [deleting, setDeleting] = useState<AudioView | null>(null)
  const [versionsOf, setVersionsOf] = useState<AudioView | null>(null)

  const list = useAsync(
    () => api.invoke('audio:list', { search: q || undefined, channelId: channelId || undefined, status: status || undefined, limit: 5000, sort: 'createdAt', dir: 'desc' }),
    [q, channelId, status, stats.completed]
  )
  const rows = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data])
  const versions = useAsync(() => api.invoke('audio:versions', { projectId: versionsOf?.projectId ?? '' }), [versionsOf?.projectId], { enabled: Boolean(versionsOf) })

  const showInFolder = (a: AudioView): void => void api.invoke('app:showItemInFolder', { path: a.filePath })
  const copyPath = (a: AudioView): void => void api.invoke('app:copyToClipboard', { text: a.filePath }).then(() => toast.success('Path copied', a.filePath))
  const exportAudio = async (a: AudioView): Promise<void> => {
    try {
      const ext = a.outputFormat.startsWith('pcm') ? 'wav' : 'mp3'
      const path = await api.invoke('app:saveFileDialog', { title: 'Export audio', defaultPath: basename(a.filePath) || `${a.title}.${ext}`, filters: [{ name: 'Audio', extensions: [ext] }] })
      if (!path) return
      await api.invoke('audio:export', { audioId: a.id, path })
      toast.success('Audio exported', path)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const confirmDelete = async ({ checkbox }: { checkbox: boolean }): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('audio:delete', { audioId: deleting.id, deleteFile: checkbox })
      toast.success('Audio deleted', deleting.title)
      setDeleting(null)
      if (playingId === deleting.id) setPlayingId(null)
      await list.reload()
    } catch (err) {
      toast.error('Could not delete audio', err)
    }
  }

  const columns = useMemo<Column<AudioView>[]>(
    () => [
      {
        id: 'title',
        header: 'Title',
        sortValue: (r) => r.title,
        render: (r) => (
          <div className="col" style={{ gap: 4, minWidth: 260 }}>
            <span className="strong truncate" title={r.title}>{r.title}</span>
            {playingId === r.id && <AudioPlayer src={audioUrl(r.id)} compact autoPlay onOpenFolder={() => showInFolder(r)} onExport={() => void exportAudio(r)} />}
          </div>
        )
      },
      { id: 'channel', header: 'Channel', sortValue: (r) => r.channelName, render: (r) => <ChannelChip name={r.channelName} color={r.channelColor} /> },
      { id: 'voice', header: 'Voice', sortValue: (r) => r.voiceName, render: (r) => <span title={r.voiceId}>{r.voiceName}</span> },
      { id: 'model', header: 'Model', sortValue: (r) => r.modelId, render: (r) => <span className="xs mono muted">{r.modelId}</span> },
      { id: 'dur', header: 'Duration', align: 'right', sortValue: (r) => r.durationSec ?? -1, render: (r) => formatDuration(r.durationSec) },
      { id: 'size', header: 'Size', align: 'right', sortValue: (r) => r.bytes, render: (r) => formatBytes(r.bytes) },
      { id: 'chars', header: 'Chars', align: 'right', sortValue: (r) => r.characters, render: (r) => formatNumber(r.characters) },
      { id: 'date', header: 'Date', sortValue: (r) => r.createdAt, render: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
      { id: 'ver', header: 'Ver', align: 'right', sortValue: (r) => r.version, render: (r) => <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setVersionsOf(r) }}>v{r.version}</button> },
      { id: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <Badge tone={r.status === 'ready' ? 'success' : r.status === 'failed' ? 'danger' : 'accent'} dot pulse={r.status === 'generating'}>{r.status}</Badge> },
      {
        id: 'actions',
        header: '',
        align: 'right',
        render: (r) => (
          <span className="row-actions">
            <Button size="sm" variant={playingId === r.id ? 'secondary' : 'ghost'} iconOnly icon={<Play size={13} />} title="Play" disabled={r.status !== 'ready'} onClick={() => setPlayingId(playingId === r.id ? null : r.id)} />
            <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Show in folder" onClick={() => showInFolder(r)} />
            <Button size="sm" variant="ghost" iconOnly icon={<Copy size={13} />} title="Copy path" onClick={() => copyPath(r)} />
            <Button size="sm" variant="ghost" iconOnly icon={<Download size={13} />} title="Export" disabled={r.status !== 'ready'} onClick={() => void exportAudio(r)} />
            <Button size="sm" variant="ghost" iconOnly icon={<Mic size={13} />} title="Regenerate with a different voice" onClick={() => setRegen({ projectId: r.projectId, scriptId: r.scriptId, title: r.title, channelId: r.channelId, characters: r.characters })} />
            <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} title="Delete" onClick={() => setDeleting(r)} />
          </span>
        )
      }
    ],
    [playingId]
  )

  return (
    <div className="page fade-in">
      <PageHeader
        title="Audio"
        subtitle="Generated voiceovers. Click a row's play button for the inline player."
        actions={
          <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
            Refresh
          </Button>
        }
      />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles…" style={{ minWidth: 260 }} />
        <Select className="filter-select" value={channelId} onChange={setChannelId} options={[{ value: '', label: 'All channels' }, ...activeChannels(channels).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` }))]} />
        <Select
          className="filter-select"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'ready', label: 'Ready' },
            { value: 'generating', label: 'Generating' },
            { value: 'failed', label: 'Failed' }
          ]}
        />
        <span className="spacer" />
        <span className="xs muted">{rows.length} files</span>
      </div>
      {list.error && (
        <Alert tone="danger" title="Could not load audio library" actions={<Button size="sm" onClick={() => void list.reload()}>Retry</Button>}>
          {list.error.message}
          {list.error.action ? ` — ${list.error.action}` : ''}
        </Alert>
      )}
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} emptyState={<EmptyState icon={<AudioLines size={20} />} title={list.loading ? 'Loading…' : 'No audio yet'} description="Finished voiceovers appear here with a player, versions and export." actions={!list.loading && <Button variant="primary" onClick={() => navigate('generate')}>Start a generation</Button>} />} />

      <RegenerateAudioDialog target={regen} onClose={() => setRegen(null)} onDone={() => void list.reload()} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        danger
        title={`Delete audio for "${deleting?.title ?? ''}" (v${deleting?.version ?? ''})?`}
        message="The audio record is removed from the library. The file on disk is kept unless you tick the option below."
        checkboxLabel="Also delete the file from disk"
        checkboxDefault={false}
        confirmLabel="Delete"
      />

      <Dialog open={Boolean(versionsOf)} onClose={() => setVersionsOf(null)} size="md" title={versionsOf ? `Audio versions · ${versionsOf.title}` : ''}>
        <div className="version-list">
          {(Array.isArray(versions.data) ? versions.data : []).map((v) => (
            <div key={v.id} className={`version-row ${v.id === versionsOf?.id ? 'active' : ''}`}>
              <span className="strong">v{v.version}</span>
              <Badge tone={v.status === 'ready' ? 'success' : v.status === 'failed' ? 'danger' : 'accent'}>{v.status}</Badge>
              <span className="xs muted">{v.voiceName}</span>
              <span className="xs muted">{v.modelId}</span>
              <span className="xs muted">{formatDuration(v.durationSec)} · {formatBytes(v.bytes)}</span>
              <span className="xs muted grow">{formatDateTime(v.createdAt)}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Show in folder" onClick={() => showInFolder(v)} />
              <Button size="sm" variant="ghost" iconOnly icon={<Play size={13} />} title="Play" disabled={v.status !== 'ready'} onClick={() => { setVersionsOf(null); setPlayingId(v.id) }} />
            </div>
          ))}
          {versions.loading && <span className="muted small">Loading…</span>}
        </div>
      </Dialog>
    </div>
  )
}
