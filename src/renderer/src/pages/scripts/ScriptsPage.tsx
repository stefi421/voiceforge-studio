import { useEffect, useMemo, useState, type JSX } from 'react'
import { Copy, FileText, FolderOutput, RefreshCw } from 'lucide-react'
import type { ScriptStatus, ScriptView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { activeChannels, useApp } from '@/store/app'
import { useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { formatDateTime, formatDuration, formatNumber, relativeTime } from '@/lib/format'
import { Badge, Button, ChannelChip, Checkbox, EmptyState, PageHeader, SearchInput, Select, Table, type Column } from '@/components/ui'
import { ScriptDrawer } from './ScriptDrawer'

const STATUSES: ScriptStatus[] = ['draft', 'validated', 'approved', 'rejected', 'invalid']

function statusTone(s: ScriptStatus): 'success' | 'danger' | 'info' | 'neutral' | 'warning' {
  if (s === 'approved') return 'success'
  if (s === 'validated') return 'info'
  if (s === 'invalid' || s === 'rejected') return 'danger'
  return 'neutral'
}

export function ScriptsPage(): JSX.Element {
  const params = useRouter((s) => s.params)
  const nonce = useRouter((s) => s.nonce)
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, 200)
  const [channelId, setChannelId] = useState('')
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(params.scriptId ?? null)

  useEffect(() => {
    if (params.scriptId) setOpenId(params.scriptId)
  }, [params.scriptId, nonce])

  const list = useAsync(
    () => api.invoke('scripts:list', { search: q || undefined, channelId: channelId || undefined, status: status || undefined, limit: 5000, sort: 'createdAt', dir: 'desc' }),
    [q, channelId, status, stats.completed]
  )
  const rows = list.data ?? []

  const columns = useMemo<Column<ScriptView>[]>(
    () => [
      { id: 'title', header: 'Title', sortValue: (r) => r.title, render: (r) => <span className="strong truncate" style={{ maxWidth: 320, display: 'inline-block' }} title={r.title}>{r.title}</span> },
      { id: 'channel', header: 'Channel', sortValue: (r) => r.channelName, render: (r) => <ChannelChip name={r.channelName} color={r.channelColor} /> },
      { id: 'created', header: 'Created', sortValue: (r) => r.createdAt, render: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
      { id: 'tpl', header: 'Template', sortValue: (r) => r.templateVersionNumber ?? -1, render: (r) => (r.templateVersionNumber != null ? `v${r.templateVersionNumber}` : '—') },
      { id: 'chars', header: 'Chars', align: 'right', sortValue: (r) => r.charCount, render: (r) => formatNumber(r.charCount) },
      { id: 'words', header: 'Words', align: 'right', sortValue: (r) => r.wordCount, render: (r) => formatNumber(r.wordCount) },
      { id: 'dur', header: 'Est.', align: 'right', sortValue: (r) => r.estimatedDurationSec, render: (r) => formatDuration(r.estimatedDurationSec) },
      { id: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
      { id: 'ver', header: 'Ver', align: 'right', sortValue: (r) => r.version, render: (r) => `v${r.version}` }
    ],
    []
  )

  const toggle = (id: string, v: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  const exportSelected = async (): Promise<void> => {
    const items = rows.filter((r) => selected.has(r.id))
    if (items.length === 0) return
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Export scripts to folder' })
      if (!dir) return
      let ok = 0
      for (const s of items) {
        const safe = s.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120)
        try {
          await api.invoke('scripts:export', { scriptId: s.id, path: `${dir}/${safe} (v${s.version}).txt` })
          ok++
        } catch (err) {
          toast.error(`Could not export "${s.title}"`, err)
        }
      }
      toast.success(`Exported ${ok} of ${items.length} scripts`, dir)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const copySelected = async (): Promise<void> => {
    const items = rows.filter((r) => selected.has(r.id))
    if (items.length === 0) return
    const text = items.map((s) => `=== ${s.title} (v${s.version}) ===\n\n${s.text}`).join('\n\n\n')
    await api.invoke('app:copyToClipboard', { text })
    toast.success(`Copied ${items.length} script(s) to clipboard`)
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="Scripts Library"
        subtitle="Every generated script, with versions and validation reports."
        actions={
          <>
            {selected.size > 0 && (
              <>
                <Button icon={<Copy size={14} />} onClick={copySelected}>
                  Copy {selected.size}
                </Button>
                <Button icon={<FolderOutput size={14} />} onClick={exportSelected}>
                  Export {selected.size} to folder
                </Button>
              </>
            )}
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles or text…" style={{ minWidth: 260 }} />
        <Select className="filter-select" value={channelId} onChange={setChannelId} options={[{ value: '', label: 'All channels' }, ...activeChannels(channels).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` }))]} />
        <Select className="filter-select" value={status} onChange={setStatus} options={[{ value: '', label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s, label: s }))]} />
        <span className="spacer" />
        <span className="xs muted">{rows.length} scripts</span>
      </div>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpenId(r.id)}
        leading={{
          header: <Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} />,
          render: (r) => <Checkbox checked={selected.has(r.id)} onChange={(v) => toggle(r.id, v)} />
        }}
        emptyState={<EmptyState icon={<FileText size={20} />} title={list.loading ? 'Loading…' : 'No scripts yet'} description="Scripts appear here as soon as a job finishes writing." />}
      />
      <ScriptDrawer scriptId={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
    </div>
  )
}
