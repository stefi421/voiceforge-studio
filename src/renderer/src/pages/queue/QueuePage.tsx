import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight, Copy, Eraser, ListOrdered, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import type { JobStatus, JobView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue, useLocalStorage, useNow } from '@/lib/hooks'
import { ALL_JOB_STATUSES, fixActionFor, isActiveStatus, isFinished, needsUser, pipelineStates, stageOrdinal, statusLabel, modeLabel } from '@/lib/jobs'
import { formatDurationHuman, relativeTime } from '@/lib/format'
import { activeChannels, useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, PageHeader, ProgressBar, SearchInput, Select } from '@/components/ui'
import { ResearchReviewDialog } from '@/components/dialogs/ResearchReviewDialog'
import { ScriptReviewDialog } from '@/components/dialogs/ScriptReviewDialog'
import { JobRow, type JobAction } from './JobRow'
import { JobDetailDrawer } from './JobDetailDrawer'
import { BatchMedians } from '@/components/SpeedViews'

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

/** Stage-based progress for a set of jobs: finished steps / all non-skipped steps. */
function stageProgress(jobs: JobView[]): number {
  let done = 0
  let total = 0
  for (const j of jobs) {
    const states = pipelineStates(j)
    for (const s of states) {
      if (s === 'skipped') continue
      total++
      if (s === 'done' || j.status === 'completed') done++
    }
  }
  return total > 0 ? (done / total) * 100 : 0
}

interface BatchGroup {
  id: string
  name: string
  mode: string
  createdAt: string
  jobs: JobView[]
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
  const [detailId, setDetailId] = useState<string | null>(params.highlight ?? null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [removing, setRemoving] = useState<JobView | null>(null)
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>('vf.queue.collapsed', {})

  useEffect(() => {
    if (params.batchId !== undefined) setBatchId(params.batchId)
    if (params.highlight) setDetailId(params.highlight)
  }, [params.batchId, params.highlight, nonce])

  const batches = useAsync(() => api.invoke('queue:batches', undefined), [stats.total, stats.completed, stats.failed], { fallback: [] })
  const list = useAsync(() => useApp.getState().refreshJobs(batchId ? { batchId } : {}), [batchId])

  const modelByChannel = useMemo(() => Object.fromEntries(channels.map((c) => [c.id, c.elevenModelId])), [channels])

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
        return a.position - b.position || b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [jobs, batchId, channelId, group, debouncedSearch])

  const groups = useMemo<BatchGroup[]>(() => {
    const byBatch = new Map<string, BatchGroup>()
    const meta = new Map((Array.isArray(batches.data) ? batches.data : []).map((b) => [b.id, b]))
    for (const j of rows) {
      let g = byBatch.get(j.batchId)
      if (!g) {
        const m = meta.get(j.batchId)
        g = { id: j.batchId, name: j.batchName, mode: m?.mode ?? j.mode, createdAt: m?.createdAt ?? j.createdAt, jobs: [] }
        byBatch.set(j.batchId, g)
      }
      g.jobs.push(j)
    }
    return Array.from(byBatch.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [rows, batches.data])

  // Keep dialogs in sync with live updates.
  useEffect(() => {
    if (reviewJob) {
      // Close only when the job moved on since the dialog opened. Comparing against
      // 'awaiting_approval' closed the dialog instantly for a failed-validation job ("Approve
      // anyway") or a finished one ("View script").
      const fresh = jobs[reviewJob.id]
      if (fresh && fresh.status !== reviewJob.status) setReviewJob(null)
    }
    if (researchJob && !researchJob.readOnly) {
      const fresh = jobs[researchJob.job.id]
      if (fresh && fresh.status !== 'research_review_required') setResearchJob(null)
    }
  }, [jobs, reviewJob, researchJob])

  const scopedJobs = useMemo(() => Object.values(jobs).filter((j) => !batchId || j.batchId === batchId), [jobs, batchId])
  const scoped = useMemo(() => {
    const count = (f: (j: JobView) => boolean): number => scopedJobs.filter(f).length
    return {
      total: scopedJobs.length,
      completed: count((j) => j.status === 'completed'),
      processing: count((j) => isActiveStatus(j.status)),
      pending: count((j) => j.status === 'pending'),
      failed: count((j) => j.status === 'failed'),
      awaiting: count((j) => needsUser(j.status))
    }
  }, [scopedJobs])

  const onAction = useCallback(async (action: JobAction, job: JobView) => {
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
      case 'fix': {
        const fix = fixActionFor(job)
        switch (fix?.kind) {
          case 'fix_key':
          case 'open_billing':
            return navigate('settings', { tab: fix.provider ?? 'openai' })
          case 'raise_limit':
            return navigate('settings', { tab: 'spending' })
          case 'open_storage':
            return navigate('settings', { tab: 'storage' })
          case 'open_channel':
            return navigate('channels', { edit: job.channelId, tab: /voice/i.test(fix.label) ? 'voice' : 'formats' })
          case 'choose_game':
            setResearchJob({ job, readOnly: false })
            return
          case 'review_script':
            setReviewJob(job)
            return
          default:
            return run(async () => upsert(await api.invoke('queue:retryJob', { id: job.id })), 'Job re-queued')
        }
      }
      case 'cancel':
        return run(async () => upsert(await api.invoke('queue:cancelJob', { id: job.id })))
      case 'remove':
        setRemoving(job)
        return
      case 'openFolder':
        if (job.projectFolder) {
          try {
            const r = await api.invoke('app:openPath', { path: job.projectFolder })
            if (!r.ok) toast.warning('Could not open folder', r.message)
          } catch (err) {
            toast.error('Could not open folder', err)
          }
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
      case 'details':
        setDetailId(job.id)
        return
    }
  }, [])

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

  const copyScripts = async (g: BatchGroup): Promise<void> => {
    setGlobalBusy(`copy:${g.id}`)
    try {
      const r = await api.invoke('queue:copyScripts', { batchId: g.id })
      toast.success(`Copied ${r.count} ${r.count === 1 ? 'script' : 'scripts'}`, 'Each title is above its script, one below another — paste anywhere.')
    } catch (err) {
      toast.error('Could not copy the scripts', err)
    } finally {
      setGlobalBusy(null)
    }
  }

  const batchAction = async (g: BatchGroup, kind: 'pause' | 'resume' | 'retry'): Promise<void> => {
    setGlobalBusy(`${kind}:${g.id}`)
    try {
      const upsert = useApp.getState().upsertJob
      if (kind === 'retry') {
        const r = await api.invoke('queue:retryFailed', { batchId: g.id })
        await list.reload()
        toast.success(`${r.retried} failed job(s) re-queued`, g.name)
        return
      }
      const targets = g.jobs.filter((j) => (kind === 'pause' ? j.status === 'pending' || isActiveStatus(j.status) : j.status === 'paused'))
      for (const j of targets) upsert(await api.invoke(kind === 'pause' ? 'queue:pauseJob' : 'queue:resumeJob', { id: j.id }))
      toast.success(kind === 'pause' ? `Paused ${targets.length} job(s)` : `Resumed ${targets.length} job(s)`, g.name)
    } catch (err) {
      toast.error(`Could not ${kind} batch`, err)
    } finally {
      setGlobalBusy(null)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return
    try {
      await api.invoke('queue:removeJob', { id: removing.id })
      useApp.getState().removeJob(removing.id)
      if (detailId === removing.id) setDetailId(null)
      setRemoving(null)
    } catch (err) {
      toast.error('Could not remove job', err)
    }
  }

  const batchOptions = [{ value: '', label: 'All batches' }, ...(Array.isArray(batches.data) ? batches.data : []).map((b) => ({ value: b.id, label: `${b.name} (${b.completed}/${b.total}${b.failed ? `, ${b.failed} failed` : ''})` }))]
  const channelOptions = [{ value: '', label: 'All channels' }, ...activeChannels(channels).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` }))]

  const pct = batchId ? stageProgress(scopedJobs) : stats.progressPercent > 0 || stats.processing === 0 ? stats.progressPercent : stageProgress(scopedJobs)
  const running = scopedJobs.filter((j) => isActiveStatus(j.status))
  const ordinal = running[0] ? stageOrdinal(running[0]) : null
  const etaText =
    stats.estimatedSecondsRemaining != null && stats.estimatedSecondsRemaining > 0
      ? `about ${formatDurationHuman(stats.estimatedSecondsRemaining)} left`
      : running.length > 0
        ? ordinal
          ? `working · stage ${ordinal.index} of ${ordinal.total}`
          : 'working'
        : scoped.pending > 0
          ? stats.queuePaused
            ? 'paused'
            : 'waiting to start'
          : scoped.awaiting > 0
            ? 'waiting for you'
            : 'idle'

  // '__first' (smoke tests) opens the first visible row.
  const detailJob = detailId === '__first' ? (rows[0] ?? null) : detailId ? (jobs[detailId] ?? null) : null

  return (
    <div className="page fade-in">
      <PageHeader
        title="Queue"
        subtitle="Every job, grouped by batch. Click a row for the full story."
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh
            </Button>
            {stats.queuePaused ? (
              <Button
                variant="primary"
                icon={<Play size={14} />}
                loading={globalBusy === 'resume'}
                onClick={() =>
                  globalAction('resume', async () => {
                    useApp.setState({ stats: await api.invoke('queue:resumeAll', undefined) })
                    return 'Queue resumed'
                  })
                }
              >
                Resume queue
              </Button>
            ) : (
              <Button
                icon={<Pause size={14} />}
                loading={globalBusy === 'pause'}
                onClick={() =>
                  globalAction('pause', async () => {
                    useApp.setState({ stats: await api.invoke('queue:pauseAll', undefined) })
                    return 'Queue paused'
                  })
                }
              >
                Pause queue
              </Button>
            )}
            <Button
              icon={<RotateCcw size={14} />}
              disabled={scoped.failed === 0}
              loading={globalBusy === 'retry'}
              onClick={() =>
                globalAction('retry', async () => {
                  const r = await api.invoke('queue:retryFailed', batchId ? { batchId } : {})
                  await list.reload()
                  return `${r.retried} failed job(s) re-queued`
                })
              }
            >
              Retry failed{scoped.failed ? ` (${scoped.failed})` : ''}
            </Button>
            <Button variant="ghost" icon={<Eraser size={14} />} onClick={() => setConfirmClear(true)}>
              Clear finished
            </Button>
          </>
        }
      />

      {stats.spendingPaused && (
        <Alert tone="danger" title="Paused by spending limit" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'spending' })}>Review limits</Button>}>
          A local daily or monthly spend limit was reached. Raise it in Settings → Spending, then resume the queue.
        </Alert>
      )}
      {stats.providerBlocked && (
        <Alert
          tone="danger"
          title={stats.providerBlocked.provider === 'openai' ? 'Stopped: OpenAI needs attention' : 'Stopped: ElevenLabs needs attention'}
          actions={
            <Button size="sm" onClick={() => navigate('settings', { tab: stats.providerBlocked!.provider === 'openai' ? 'openai' : 'elevenlabs' })}>
              Open settings
            </Button>
          }
        >
          {stats.providerBlocked.message} {stats.providerBlocked.action} Other jobs were kept and continue when you resume the queue.
        </Alert>
      )}
      {(() => {
        const cooling = (['openai', 'elevenlabs'] as const).filter((k) => {
          const until = stats.providers?.[k]?.coolingDownUntil
          return until && new Date(until).getTime() > now
        })
        if (!cooling.length) return null
        return (
          <Alert tone="warning" title="Short pause">
            {cooling.map((k) => (k === 'openai' ? 'OpenAI' : 'ElevenLabs')).join(' and ')} returned several errors in a row, so new requests wait about{' '}
            {Math.max(1, Math.round((Math.max(...cooling.map((k) => new Date(stats.providers![k]!.coolingDownUntil!).getTime())) - now) / 1000))}s before trying again. Running jobs are not lost.
          </Alert>
        )
      })()}
      {stats.queuePaused && !stats.spendingPaused && !stats.providerBlocked && <Alert tone="warning">The queue is paused. Pending jobs will not start until you resume.</Alert>}

      <div className="queue-summary">
        <div className="queue-summary-stats">
          <Summary label="Total" value={scoped.total} />
          <Summary label="Completed" value={scoped.completed} tone="success" />
          <Summary label="Working" value={scoped.processing} tone="accent" />
          <Summary label="Waiting" value={scoped.pending} />
          <Summary label="Needs you" value={scoped.awaiting} tone="warning" />
          <Summary label="Failed" value={scoped.failed} tone="danger" />
        </div>
        <div className="queue-summary-progress">
          <div className="row-between xs muted">
            <span className="tnum">{Math.round(pct)}% done</span>
            <span>{etaText}</span>
          </div>
          <ProgressBar value={pct} tone={scoped.failed > 0 && scoped.processing === 0 && scoped.pending === 0 ? 'warning' : 'accent'} indeterminate={running.length > 0 && pct === 0} />
        </div>
      </div>

      <div className="toolbar">
        <Select className="filter-select" value={batchId} onChange={setBatchId} options={batchOptions} />
        <Select className="filter-select" value={channelId} onChange={setChannelId} options={channelOptions} />
        <Select className="filter-select" value={group} onChange={(v) => setGroup(v as StatusGroup)} options={GROUPS} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles…" style={{ minWidth: 220 }} />
        <span className="spacer" />
        <span className="xs muted">{rows.length} shown</span>
      </div>

      {list.error && <Alert tone="danger" title="Could not load queue">{list.error.message}</Alert>}

      {groups.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<ListOrdered size={20} />}
            title={list.loading ? 'Loading…' : Object.keys(jobs).length === 0 ? 'Nothing in the queue yet' : 'No jobs match these filters'}
            description={Object.keys(jobs).length === 0 ? 'Start a generation and every title shows up here with live progress.' : 'Try a different batch, channel or status filter.'}
            actions={Object.keys(jobs).length === 0 && !list.loading ? <Button variant="primary" onClick={() => navigate('generate')}>Start a generation</Button> : undefined}
          />
        </div>
      ) : (
        groups.map((g) => {
          const isCollapsed = Boolean(collapsed[g.id])
          const gDone = g.jobs.filter((j) => j.status === 'completed').length
          const gFailed = g.jobs.filter((j) => j.status === 'failed').length
          const gNeeds = g.jobs.filter((j) => needsUser(j.status)).length
          const gActive = g.jobs.some((j) => isActiveStatus(j.status) || j.status === 'pending')
          const gPaused = g.jobs.some((j) => j.status === 'paused')
          const gPct = stageProgress(g.jobs)
          const finished = g.jobs.every((j) => isFinished(j.status))
          return (
            <section key={g.id} className={`batch-group ${isCollapsed ? 'collapsed' : ''}`}>
              <header className="batch-header" onClick={() => setCollapsed({ ...collapsed, [g.id]: !isCollapsed })}>
                <span className="batch-chevron">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
                <div className="batch-title">
                  <span className="strong truncate" title={g.name}>
                    {g.name}
                  </span>
                  <span className="xs muted">
                    {modeLabel(g.mode)} · {relativeTime(g.createdAt, now)} · {gDone}/{g.jobs.length} done
                    {gFailed ? ` · ${gFailed} failed` : ''}
                    {gNeeds ? ` · ${gNeeds} need you` : ''}
                  </span>
                  <BatchMedians batchId={g.id} doneCount={gDone} />
                </div>
                <div className="batch-progress">
                  <ProgressBar value={gPct} tone={finished ? (gFailed ? 'warning' : 'success') : 'accent'} />
                </div>
                <div className="row gap-1" onClick={(e) => e.stopPropagation()}>
                  {gNeeds > 0 && <Badge tone="warning">{gNeeds} need you</Badge>}
                  {gDone > 0 && (
                    <Button size="sm" variant="ghost" icon={<Copy size={12} />} loading={globalBusy === `copy:${g.id}`} onClick={() => void copyScripts(g)} title="Copy every finished script of this batch, each with its title above it">
                      Copy all scripts
                    </Button>
                  )}
                  {gFailed > 0 && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} loading={globalBusy === `retry:${g.id}`} onClick={() => void batchAction(g, 'retry')}>
                      Retry failed
                    </Button>
                  )}
                  {gActive && (
                    <Button size="sm" variant="ghost" icon={<Pause size={12} />} loading={globalBusy === `pause:${g.id}`} onClick={() => void batchAction(g, 'pause')}>
                      Pause batch
                    </Button>
                  )}
                  {gPaused && (
                    <Button size="sm" variant="ghost" icon={<Play size={12} />} loading={globalBusy === `resume:${g.id}`} onClick={() => void batchAction(g, 'resume')}>
                      Resume batch
                    </Button>
                  )}
                </div>
              </header>
              {!isCollapsed && (
                <div className="table-wrap batch-table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Channel</th>
                        <th>Status · research → script → validate → approval → audio → save</th>
                        <th>Attempts</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.jobs.map((j) => (
                        <JobRow key={j.id} job={j} busy={busyId === j.id} highlighted={params.highlight === j.id} selected={detailId === j.id} now={now} modelId={modelByChannel[j.channelId]} queuePaused={stats.queuePaused} onAction={onAction} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })
      )}

      <JobDetailDrawer job={detailJob} onClose={() => setDetailId(null)} onAction={onAction} />
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
    <div className={`queue-stat ${tone && value > 0 ? `queue-stat-${tone}` : ''}`}>
      <span className="queue-stat-value tnum">{value}</span>
      <span className="queue-stat-label">{label}</span>
    </div>
  )
}
