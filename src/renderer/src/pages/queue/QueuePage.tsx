import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Eraser, ListOrdered, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import type { JobStatus, JobView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue, useNow } from '@/lib/hooks'
import { ALL_JOB_STATUSES, isActiveStatus, needsUser, statusLabel } from '@/lib/jobs'
import { formatDurationHuman } from '@/lib/format'
import { activeChannels, useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, ProgressBar, SearchInput, Select } from '@/components/ui'
import { ResearchReviewDialog } from '@/components/dialogs/ResearchReviewDialog'
import { ScriptReviewDialog } from '@/components/dialogs/ScriptReviewDialog'
import { JobRow, type JobAction } from './JobRow'

type StatusGroup = 'all' | 'active' | 'needs_you' | 'failed' | 'completed' | 'paused' | JobStatus

const GROUPS: Array<{ value: StatusGroup; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active (pending + processing)' },
  { value: 'needs_you', label: 'Needs you' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
  { value: 'paused', label: 'Paused' },
  ...ALL_JOB_STATUSES.map((s) => ({ value: s as StatusGroup, label: `— ${statusLabel(s)}` }))
]

function matchesGroup(job: JobView, g: StatusGroup): boolean {
  switch (g) {
    case 'all':
      return true
    case 'active':
      return job.status === 'pending' || isActiveStatus(job.status) || job.status === 'script_ready'
    case 'needs_you':
      return needsUser(job.status)
    case 'failed':
      return job.status === 'failed'
    case 'completed':
      return job.status === 'completed'
    case 'paused':
      return job.status === 'paused'
    default:
      return job.status === g
  }
}

export function QueuePage(): JSX.Element {
  const params = useRouter((s) => s.params)
  const nonce = useRouter((s) => s.nonce)
  const jobs = useApp((s) => s.jobs)
  const stats = useApp((s) => s.stats)
  const channels = useApp((s) => s.channels)
  const now = useNow(15000)

  const [batchId, setBatchId] = useState<string>(params.batchId ?? '')
  const [channelId, setChannelId] = useState('')
  const [group, setGroup] = useState<StatusGroup>('all')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 200)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [globalBusy, setGlobalBusy] = useState<string | null>(null)
  const [reviewJob, setReviewJob] = useState<JobView | null>(null)
  const [researchJob, setResearchJob] = useState<{ job: JobView; readOnly: boolean } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [removing, setRemoving] = useState<JobView | null>(null)

  useEffect(() => {
    if (params.batchId !== undefined) setBatchId(params.batchId)
  }, [params.batchId, nonce])

  const batches = useAsync(() => api.invoke('queue:batches', undefined), [stats.total])
  const list = useAsync(() => useApp.getState().refreshJobs(batchId ? { batchId } : {}), [batchId])

  const rows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return Object.values(jobs)
      .filter((j) => !batchId || j.batchId === batchId)
      .filter((j) => !channelId || j.channelId === channelId)
      .filter((j) => matchesGroup(j, group))
      .filter((j) => !q || j.title.toLowerCase().includes(q) || j.batchName.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = needsUser(a.status) ? 0 : 1
        const bp = needsUser(b.status) ? 0 : 1
        if (ap !== bp) return ap - bp
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [jobs, batchId, channelId, group, debouncedSearch])

  // Keep dialogs in sync with live updates.
  useEffect(() => {
    if (reviewJob) {
      const fresh = jobs[reviewJob.id]
      if (fresh && fresh.status !== 'awaiting_approval') setReviewJob(null)
    }
    if (researchJob && !researchJob.readOnly) {
      const fresh = jobs[researchJob.job.id]
      if (fresh && fresh.status !== 'research_review_required') setResearchJob(null)
    }
  }, [jobs, reviewJob, researchJob])

  const scoped = useMemo(() => {
    const all = Object.values(jobs).filter((j) => !batchId || j.batchId === batchId)
    const count = (f: (j: JobView) => boolean): number => all.filter(f).length
    return {
      total: all.length,
      completed: count((j) => j.status === 'completed'),
      processing: count((j) => isActiveStatus(j.status)),
      pending: count((j) => j.status === 'pending'),
      failed: count((j) => j.status === 'failed'),
      awaiting: count((j) => needsUser(j.status))
    }
  }, [jobs, batchId])

  const onAction = useCallback(
    async (action: JobAction, job: JobView) => {
      const run = async (fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
        setBusyId(job.id)
        try {
          await fn()
          if (okMsg) toast.success(okMsg, job.title)
        } catch (err) {
          toast.error(`Could not ${action} job`, err)
        } finally {
          setBusyId(null)
        }
      }
      const upsert = useApp.getState().upsertJob
      switch (action) {
        case 'pause':
          return run(async () => upsert(await api.invoke('queue:pauseJob', { id: job.id })))
        case 'resume':
          return run(async () => upsert(await api.invoke('queue:resumeJob', { id: job.id })))
        case 'retry':
          return run(async () => upsert(await api.invoke('queue:retryJob', { id: job.id })), 'Job re-queued')
        case 'cancel':
          return run(async () => upsert(await api.invoke('queue:cancelJob', { id: job.id })))
        case 'remove':
          setRemoving(job)
          return
        case 'openFolder':
          if (job.projectFolder) {
            const r = await api.invoke('app:openPath', { path: job.projectFolder })
            if (!r.ok) toast.warning('Could not open folder', r.message)
          }
          return
        case 'viewScript':
          setReviewJob(job)
          return
        case 'viewResearch':
          setResearchJob({ job, readOnly: true })
          return
        case 'review':
          if (job.status === 'awaiting_approval') setReviewJob(job)
          else setResearchJob({ job, readOnly: false })
          return
      }
    },
    []
  )

  const globalAction = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setGlobalBusy(key)
    try {
      const msg = await fn()
      toast.success(msg)
    } catch (err) {
      toast.error('Queue action failed', err)
    } finally {
      setGlobalBusy(null)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return
    try {
      await api.invoke('queue:removeJob', { id: removing.id })
      useApp.getState().removeJob(removing.id)
      setRemoving(null)
    } catch (err) {
      toast.error('Could not remove job', err)
    }
  }

  const batchOptions = [{ value: '', label: 'All batches' }, ...(Array.isArray(batches.data) ? batches.data : []).map((b) => ({ value: b.id, label: `${b.name} (${b.completed}/${b.total}${b.failed ? `, ${b.failed} failed` : ''})` }))]
  const channelOptions = [{ value: '', label: 'All channels' }, ...activeChannels(channels).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` }))]
  const pct = scoped.total > 0 ? (scoped.completed / scoped.total) * 100 : 0

  return (
    <div className="page fade-in">
      <PageHeader
        title="Queue"
        subtitle="Live status of every job. Rows update automatically."
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh
            </Button>
            {stats.queuePaused ? (
              <Button variant="primary" icon={<Play size={14} />} loading={globalBusy === 'resume'} onClick={() => globalAction('resume', async () => { useApp.setState({ stats: await api.invoke('queue:resumeAll', undefined) }); return 'Queue resumed' })}>
                Resume queue
              </Button>
            ) : (
              <Button icon={<Pause size={14} />} loading={globalBusy === 'pause'} onClick={() => globalAction('pause', async () => { useApp.setState({ stats: await api.invoke('queue:pauseAll', undefined) }); return 'Queue paused' })}>
                Pause queue
              </Button>
            )}
            <Button icon={<RotateCcw size={14} />} disabled={scoped.failed === 0} loading={globalBusy === 'retry'} onClick={() => globalAction('retry', async () => { const r = await api.invoke('queue:retryFailed', batchId ? { batchId } : {}); await list.reload(); return `${r.retried} failed job(s) re-queued` })}>
              Retry failed{scoped.failed ? ` (${scoped.failed})` : ''}
            </Button>
            <Button variant="ghost" icon={<Eraser size={14} />} onClick={() => setConfirmClear(true)}>
              Clear finished
            </Button>
          </>
        }
      />

      {stats.spendingPaused && (
        <Alert tone="danger" title="Paused by spending limit">
          A local daily or monthly spend limit was reached. Adjust it in Settings → Spending, then resume the queue.
        </Alert>
      )}
      {stats.queuePaused && !stats.spendingPaused && <Alert tone="warning">The queue is paused. Pending jobs will not start until you resume.</Alert>}

      <Card padded="sm">
        <div className="row wrap" style={{ gap: 20 }}>
          <Summary label="Total" value={scoped.total} />
          <Summary label="Completed" value={scoped.completed} tone="success" />
          <Summary label="Processing" value={scoped.processing} tone="accent" />
          <Summary label="Pending" value={scoped.pending} />
          <Summary label="Failed" value={scoped.failed} tone="danger" />
          <Summary label="Awaiting you" value={scoped.awaiting} tone="warning" />
          <div className="grow" />
          <div className="col" style={{ minWidth: 220, gap: 4 }}>
            <div className="row-between xs muted">
              <span>{Math.round(pct)}% done</span>
              <span>{stats.estimatedSecondsRemaining != null && stats.estimatedSecondsRemaining > 0 ? `~${formatDurationHuman(stats.estimatedSecondsRemaining)} remaining` : stats.processing > 0 ? 'estimating…' : 'idle'}</span>
            </div>
            <ProgressBar value={pct} tone={scoped.failed > 0 && scoped.processing === 0 && scoped.pending === 0 ? 'warning' : 'accent'} />
          </div>
        </div>
      </Card>

      <div className="toolbar">
        <Select className="filter-select" value={batchId} onChange={setBatchId} options={batchOptions} />
        <Select className="filter-select" value={channelId} onChange={setChannelId} options={channelOptions} />
        <Select className="filter-select" value={group} onChange={(v) => setGroup(v as StatusGroup)} options={GROUPS} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles…" style={{ minWidth: 220 }} />
        <span className="spacer" />
        <span className="xs muted">{rows.length} shown</span>
      </div>

      {list.error && <Alert tone="danger" title="Could not load queue">{list.error.message}</Alert>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Channel</th>
              <th>Status · Research → Script → Validate → Approval → Audio → Save</th>
              <th>Attempts</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 0 }}>
                  <EmptyState icon={<ListOrdered size={20} />} title={list.loading ? 'Loading…' : 'No jobs match'} description={Object.keys(jobs).length === 0 ? 'Start a generation to see jobs here.' : 'Try a different batch, channel or status filter.'} actions={Object.keys(jobs).length === 0 && !list.loading ? <Button variant="primary" onClick={() => navigate('generate')}>Start a generation</Button> : undefined} />
                </td>
              </tr>
            ) : (
              rows.map((j) => <JobRow key={j.id} job={j} busy={busyId === j.id} highlighted={params.highlight === j.id} now={now} onAction={onAction} />)
            )}
          </tbody>
        </table>
      </div>

      <ScriptReviewDialog job={reviewJob} onClose={() => setReviewJob(null)} />
      <ResearchReviewDialog job={researchJob?.job ?? null} readOnly={researchJob?.readOnly} onClose={() => setResearchJob(null)} />

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear finished jobs?"
        message={`Completed and cancelled jobs${batchId ? ' in this batch' : ''} are removed from the queue view. Projects, scripts and audio files are kept.`}
        confirmLabel="Clear"
        onConfirm={async () => {
          try {
            const r = await api.invoke('queue:clearFinished', batchId ? { batchId } : {})
            toast.success(`${r.removed} job(s) cleared`)
            setConfirmClear(false)
            useApp.setState((s) => {
              const next: Record<string, JobView> = {}
              for (const j of Object.values(s.jobs)) {
                const finished = j.status === 'completed' || j.status === 'cancelled'
                if (!(finished && (!batchId || j.batchId === batchId))) next[j.id] = j
              }
              return { jobs: next }
            })
            await list.reload()
          } catch (err) {
            toast.error('Could not clear finished jobs', err)
          }
        }}
      />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={confirmRemove} title={`Remove "${removing?.title ?? ''}" from the queue?`} message="The job record is deleted. The project and any files already generated are kept." confirmLabel="Remove" danger />
    </div>
  )
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' | 'warning' | 'accent' }): JSX.Element {
  return (
    <div className="col" style={{ gap: 0 }}>
      <span className="small muted">{label}</span>
      <span className="row">
        <span className="stat-value" style={{ fontSize: 22 }}>
          {value}
        </span>
        {tone && value > 0 && <Badge tone={tone} dot>{''}</Badge>}
      </span>
    </div>
  )
}
