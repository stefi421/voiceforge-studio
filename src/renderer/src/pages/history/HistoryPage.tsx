import { useState, type JSX } from 'react'
import { Clock, FileDown, RefreshCw } from 'lucide-react'
import type { JobEvent } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { statusLabel } from '@/lib/jobs'
import { formatDateTime, formatTime, isoDay } from '@/lib/format'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, SearchInput, Select, StatusBadge } from '@/components/ui'

function eventTone(e: JobEvent): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  const ev = e.event.toLowerCase()
  if (ev.includes('fail') || ev.includes('error')) return 'danger'
  if (ev.includes('complete') || ev.includes('approved')) return 'success'
  if (ev.includes('pause') || ev.includes('cancel') || ev.includes('review')) return 'warning'
  if (ev.includes('start') || ev.includes('retry')) return 'info'
  return 'neutral'
}

export function HistoryPage(): JSX.Element {
  const stats = useApp((s) => s.stats)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, 200)
  const [limit, setLimit] = useState('200')
  const list = useAsync(() => api.invoke('history:list', { limit: parseInt(limit, 10), search: q || undefined }), [q, limit, stats.completed, stats.failed])
  const batches = useAsync(() => api.invoke('queue:batches', undefined), [])
  const [reportBatch, setReportBatch] = useState('')

  const exportReport = async (): Promise<void> => {
    try {
      const path = await api.invoke('app:saveFileDialog', { title: 'Export job report', defaultPath: `voiceforge-report-${isoDay(new Date())}.csv`, filters: [{ name: 'Report', extensions: ['csv', 'json', 'txt'] }] })
      if (!path) return
      await api.invoke('history:exportReport', { batchId: reportBatch || undefined, path })
      toast.success('Report exported', path)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const rows = Array.isArray(list.data) ? list.data : []
  const byDay = new Map<string, JobEvent[]>()
  for (const e of rows) {
    const d = new Date(e.at)
    const day = Number.isNaN(d.getTime()) ? 'unknown' : isoDay(d)
    const arr = byDay.get(day) ?? []
    arr.push(e)
    byDay.set(day, arr)
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="Generation History"
        subtitle="Every status transition, retry and error, newest first."
        actions={
          <>
            <Select className="filter-select" value={reportBatch} onChange={setReportBatch} options={[{ value: '', label: 'Report: all batches' }, ...(Array.isArray(batches.data) ? batches.data : []).map((b) => ({ value: b.id, label: b.name }))]} />
            <Button icon={<FileDown size={14} />} onClick={exportReport}>
              Export job report
            </Button>
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles, channels, events…" style={{ minWidth: 280 }} />
        <Select className="filter-select" value={limit} onChange={setLimit} options={['100', '200', '500', '1000', '2000'].map((n) => ({ value: n, label: `Last ${n}` }))} />
        <span className="spacer" />
        <span className="xs muted">{rows.length} events</span>
      </div>

      {list.error && (
        <Alert tone="danger" title="Could not load history" actions={<Button size="sm" onClick={() => void list.reload()}>Retry</Button>}>
          {list.error.message}
          {list.error.action ? ` — ${list.error.action}` : ''}
        </Alert>
      )}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Clock size={20} />} title={list.loading ? 'Loading…' : 'No history yet'} description="Job events are recorded as soon as a generation starts." />
        </Card>
      ) : (
        Array.from(byDay.entries()).map(([day, events]) => (
          <Card key={day} title={<span>{day === 'unknown' ? 'Unknown date' : formatDateTime(`${day}T00:00:00`).slice(0, 11)}<Badge style={{ marginLeft: 8 }}>{events.length}</Badge></span>}>
            <div className="card-body-flush">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Time</th>
                    <th>Event</th>
                    <th>Title</th>
                    <th>Channel</th>
                    <th>Transition</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="xs mono muted">{formatTime(e.at)}</td>
                      <td>
                        <Badge tone={eventTone(e)}>{e.event.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="strong truncate" style={{ maxWidth: 260 }} title={e.title}>{e.title}</td>
                      <td className="xs muted">{e.channelName}</td>
                      <td className="xs">
                        {e.fromStatus || e.toStatus ? (
                          <span className="row">
                            {e.fromStatus ? <span className="muted">{statusLabel(e.fromStatus)}</span> : null}
                            {e.fromStatus && e.toStatus ? <span className="subtle">→</span> : null}
                            {e.toStatus ? <StatusBadge status={e.toStatus} /> : null}
                          </span>
                        ) : (
                          <span className="subtle">—</span>
                        )}
                      </td>
                      <td className="xs muted selectable" style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{e.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
