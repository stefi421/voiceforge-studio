import { useEffect, useMemo, useState, type JSX } from 'react'
import { Download, Gamepad2, RefreshCw, Upload } from 'lucide-react'
import type { GameView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { formatDateTime, formatNumber, relativeTime } from '@/lib/format'
import { Alert, Badge, Button, EmptyState, PageHeader, SearchInput, Select, Table, type Column } from '@/components/ui'
import { GameDrawer } from './GameDrawer'

export function releaseLabel(g: Pick<GameView, 'releaseStatus' | 'releaseDate'>): string {
  const status = g.releaseStatus === 'early_access' ? 'Early access' : g.releaseStatus === 'unreleased' ? 'Unreleased' : g.releaseStatus === 'released' ? 'Released' : ''
  return [status, g.releaseDate].filter(Boolean).join(' · ') || '—'
}

export function GamesPage(): JSX.Element {
  const params = useRouter((s) => s.params)
  const nonce = useRouter((s) => s.nonce)
  const stats = useApp((s) => s.stats)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, 200)
  const [subject, setSubject] = useState<'all' | 'game' | 'product'>('all')
  const [openId, setOpenId] = useState<string | null>(params.gameId ?? null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (params.gameId) setOpenId(params.gameId)
  }, [params.gameId, nonce])

  const list = useAsync(() => api.invoke('games:list', { query: q || undefined, subject }), [q, subject, stats.completed])
  const rows = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data])

  const columns = useMemo<Column<GameView>[]>(
    () => [
      {
        id: 'title',
        header: 'Title',
        sortValue: (r) => r.canonicalTitle.toLowerCase(),
        render: (r) => (
          <span className="row gap-1" style={{ minWidth: 0 }}>
            <span className="strong truncate" style={{ maxWidth: 320 }} title={r.canonicalTitle}>
              {r.canonicalTitle}
            </span>
            {r.mayBeOutdated && <Badge tone="warning" title="Unreleased when researched and the release date has passed — consider Refresh.">May be outdated</Badge>}
            {r.pinned && <Badge tone="info">Pinned</Badge>}
          </span>
        )
      },
      { id: 'type', header: 'Type', sortValue: (r) => r.subjectType, render: (r) => <span className="small muted">{r.subjectType === 'product' ? 'Product' : 'Game'}</span> },
      { id: 'dev', header: 'Developer', sortValue: (r) => r.developer, render: (r) => <span className="small truncate" style={{ maxWidth: 180, display: 'inline-block' }}>{r.developer || '—'}</span> },
      { id: 'release', header: 'Release', sortValue: (r) => r.releaseDate, render: (r) => <span className="small">{releaseLabel(r)}</span> },
      { id: 'researched', header: 'Researched', sortValue: (r) => r.researchedAt, render: (r) => <span title={formatDateTime(r.researchedAt)}>{relativeTime(r.researchedAt)}</span> },
      { id: 'uses', header: 'Reused', align: 'right', sortValue: (r) => r.useCount, render: (r) => formatNumber(r.useCount) },
      { id: 'scripts', header: 'Scripts', align: 'right', sortValue: (r) => r.scriptCount, render: (r) => formatNumber(r.scriptCount) },
      { id: 'channels', header: 'Channels', align: 'right', sortValue: (r) => r.channels.length, render: (r) => <span title={r.channels.map((c) => c.channelName).join(', ')}>{r.channels.length}</span> }
    ],
    []
  )

  const doExport = async (): Promise<void> => {
    setBusy('export')
    try {
      const res = await api.invoke('games:export', undefined)
      if (res) toast.success(`Exported ${res.count} saved ${res.count === 1 ? 'entry' : 'entries'}`, res.path)
    } catch (err) {
      toast.error('Export failed', err)
    } finally {
      setBusy(null)
    }
  }
  const doImport = async (): Promise<void> => {
    setBusy('import')
    try {
      const res = await api.invoke('games:import', undefined)
      if (res) {
        toast.success('Saved games imported', `${res.added} added, ${res.merged} merged with existing entries`)
        void list.reload()
      }
    } catch (err) {
      toast.error('Import failed', err)
    } finally {
      setBusy(null)
    }
  }

  const totalReuses = rows.reduce((n, r) => n + r.useCount, 0)

  return (
    <div className="page fade-in">
      <PageHeader
        title="Games"
        subtitle="Every game or product is researched once and the facts are reused for every later script, on every channel — no research credits."
        actions={
          <>
            <Button icon={<Upload size={14} />} loading={busy === 'import'} onClick={() => void doImport()}>
              Import
            </Button>
            <Button icon={<Download size={14} />} loading={busy === 'export'} disabled={rows.length === 0} onClick={() => void doExport()}>
              Export
            </Button>
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh list
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles and aliases…" style={{ minWidth: 260 }} />
        <Select
          className="filter-select"
          value={subject}
          onChange={(v) => setSubject(v as typeof subject)}
          options={[
            { value: 'all', label: 'Games and products' },
            { value: 'game', label: 'Games' },
            { value: 'product', label: 'Products' }
          ]}
        />
        <span className="spacer" />
        <span className="xs muted">
          {rows.length} saved · reused {formatNumber(totalReuses)} {totalReuses === 1 ? 'time' : 'times'}
        </span>
      </div>
      {list.error && (
        <Alert tone="danger" title="Could not load saved games" actions={<Button size="sm" onClick={() => void list.reload()}>Retry</Button>}>
          {list.error.message}
        </Alert>
      )}
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpenId(r.id)}
        emptyState={
          <EmptyState
            icon={<Gamepad2 size={20} />}
            title={list.loading ? 'Loading…' : q ? 'No saved game matches' : 'No saved research yet'}
            description={q ? 'Try another spelling — aliases are searched too.' : 'The first time you generate a script for a game, its research is saved here and reused next time (also on other channels).'}
            actions={!list.loading && !q && <Button variant="primary" onClick={() => navigate('generate')}>Start a generation</Button>}
          />
        }
      />
      <GameDrawer gameId={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
    </div>
  )
}
