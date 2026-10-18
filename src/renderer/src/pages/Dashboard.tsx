import { useMemo, useState, type JSX } from 'react'
import { AudioLines, CircleAlert, CircleCheck, FileText, FolderOpen, KeyRound, ListOrdered, Mic, RotateCcw, Search, Sparkles, Tv, Wand2 } from 'lucide-react'
import type { JobView } from '@shared/types'
import { api, audioUrl } from '@/lib/api'
import { useAsync, useNow } from '@/lib/hooks'
import { stageText } from '@/lib/jobs'
import { useApp, activeChannels } from '@/store/app'
import { navigate } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, AudioPlayer, Badge, Button, Card, ChannelChip, CostLabel, EmptyState, PageHeader, ProgressBar, Skeleton, Stat } from '@/components/ui'
import { formatCompact, formatDuration, formatNumber, formatPercent, relativeTime } from '@/lib/format'

export function DashboardPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const secrets = useApp((s) => s.secrets)
  const jobs = useApp((s) => s.jobs)
  const live = activeChannels(channels)
  const now = useNow(30000)

  const usage = useAsync(() => api.invoke('usage:summary', {}), [stats.completed])
  const subscription = useAsync(() => api.invoke('eleven:subscription', undefined), [secrets.elevenlabs, stats.completed], { enabled: secrets.elevenlabs })
  const scripts = useAsync(() => api.invoke('scripts:list', { limit: 5000 }), [stats.completed], { fallback: [] })
  const audio = useAsync(() => api.invoke('audio:list', { limit: 200, sort: 'createdAt', dir: 'desc' }), [stats.completed], { fallback: [] })
  const [playing, setPlaying] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const scriptCount = Array.isArray(scripts.data) ? scripts.data.length : 0
  const audioRows = useMemo(() => (Array.isArray(audio.data) ? audio.data : []), [audio.data])
  const channelsWithoutVoice = useMemo(() => live.filter((c) => !c.elevenVoiceId), [live])
  const recentAudio = useMemo(() => audioRows.filter((a) => a.status === 'ready').slice(0, 6), [audioRows])
  const needsYou = useMemo<JobView[]>(
    () =>
      Object.values(jobs)
        .filter((j) => j.status === 'awaiting_approval' || j.status === 'research_review_required' || j.status === 'failed')
        .sort((a, b) => {
          const rank = (j: JobView): number => (j.status === 'failed' ? 1 : 0)
          return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)
        })
        .slice(0, 8),
    [jobs]
  )
  const running = useMemo(() => Object.values(jobs).filter((j) => ['researching', 'writing_script', 'validating_script', 'generating_audio', 'saving_files'].includes(j.status)), [jobs])

  const loadErrors = [usage.error, scripts.error, audio.error].filter((e): e is NonNullable<typeof e> => Boolean(e))
  const checklist: Array<{ label: string; done: boolean; action: () => void }> = [
    { label: 'Add your OpenAI API key', done: secrets.openai, action: () => navigate('settings', { tab: 'openai' }) },
    { label: 'Add your ElevenLabs API key', done: secrets.elevenlabs, action: () => navigate('settings', { tab: 'elevenlabs' }) },
    {
      label: channelsWithoutVoice.length ? `Pick a voice for ${channelsWithoutVoice.map((c) => c.name).join(', ')}` : 'Every channel has a voice',
      done: channelsWithoutVoice.length === 0 && live.length > 0,
      action: () => navigate('channels', channelsWithoutVoice[0] ? { edit: channelsWithoutVoice[0].id, tab: 'voice' } : {})
    }
  ]
  const keysMissing = !secrets.openai || !secrets.elevenlabs
  const setupNeeded = checklist.some((c) => !c.done)

  const openOutput = async (): Promise<void> => {
    try {
      const info = await api.invoke('app:info', undefined)
      const r = await api.invoke('app:openPath', { path: info.outputRoot })
      if (!r.ok) toast.warning('Could not open folder', r.message)
    } catch (err) {
      toast.error('Could not open output folder', err)
    }
  }

  const retryFailed = async (): Promise<void> => {
    setRetrying(true)
    try {
      const r = await api.invoke('queue:retryFailed', {})
      toast.success('Retrying failed jobs', `${r.retried} job(s) re-queued.`)
      void useApp.getState().refreshJobs()
    } catch (err) {
      toast.error('Could not retry failed jobs', err)
    } finally {
      setRetrying(false)
    }
  }

  const retryOne = async (j: JobView): Promise<void> => {
    try {
      useApp.getState().upsertJob(await api.invoke('queue:retryJob', { id: j.id }))
      toast.success('Job re-queued', j.title)
    } catch (err) {
      toast.error('Could not retry job', err)
    }
  }

  const u = usage.data
  const sub = subscription.data
  const failedCount = needsYou.filter((j) => j.status === 'failed').length

  return (
    <div className="page fade-in">
      <PageHeader
        title="Dashboard"
        subtitle={running.length > 0 ? `${running.length} job(s) working right now · ${stats.pending} waiting` : 'Everything you need to act on, then what was made recently.'}
        actions={
          <>
            <Button icon={<FolderOpen size={14} />} onClick={openOutput}>
              Open output folder
            </Button>
            <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => navigate('generate')}>
              New generation
            </Button>
          </>
        }
      />

      {loadErrors.length > 0 && (
        <Alert tone="danger" title="Some dashboard data could not be loaded">
          {loadErrors[0]?.message}
          {loadErrors[0]?.action ? ` — ${loadErrors[0].action}` : ''}
        </Alert>
      )}

      {stats.spendingPaused && (
        <Alert tone="danger" title="Queue paused by spending limit" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'spending' })}>Review limits</Button>}>
          A local spending safeguard was reached. Raise the limit or wait for the next period, then resume the queue.
        </Alert>
      )}

      {setupNeeded && (
        <Card
          title={keysMissing ? 'Finish setting up VoiceForge Studio' : 'One more step'}
          actions={
            <Button size="sm" variant={keysMissing ? 'primary' : 'secondary'} icon={<Wand2 size={13} />} onClick={() => useApp.getState().setWizardForced(true)}>
              Open setup assistant
            </Button>
          }
        >
          <div className="needs-list">
            {checklist.map((c, i) => (
              <div key={i} className="needs-row">
                <span className={`needs-icon ${c.done ? '' : 'warning'}`}>{c.done ? <CircleCheck size={15} className="text-success" /> : <KeyRound size={14} />}</span>
                <span className={`needs-main ${c.done ? 'muted' : ''}`}>{c.label}</span>
                {!c.done && (
                  <Button size="sm" onClick={c.action}>
                    Fix
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={
          <span className="row gap-2">
            Needs you {needsYou.length > 0 && <Badge tone="warning">{needsYou.length}</Badge>}
          </span>
        }
        actions={
          failedCount > 0 ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} loading={retrying} onClick={retryFailed}>
              Retry all failed
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => navigate('queue')}>
              Open queue
            </Button>
          )
        }
      >
        {needsYou.length === 0 ? (
          <div className="all-clear">
            <CircleCheck size={16} className="text-success" />
            {running.length > 0 ? `Nothing waiting on you. ${running.length} job(s) are working in the background.` : 'Nothing waiting on you.'}
          </div>
        ) : (
          <div className="needs-list">
            {needsYou.map((j) => (
              <div key={j.id} className="needs-row">
                <span className={`needs-icon ${j.status === 'failed' ? 'danger' : 'warning'}`}>
                  {j.status === 'failed' ? <CircleAlert size={15} /> : j.status === 'awaiting_approval' ? <FileText size={14} /> : <Search size={14} />}
                </span>
                <div className="needs-main">
                  <span className="strong truncate">{j.title}</span>
                  <span className="xs muted truncate">
                    {j.channelName} · {stageText(j)} · {relativeTime(j.updatedAt, now)}
                  </span>
                </div>
                {j.status === 'failed' ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => navigate('queue', { highlight: j.id })}>
                      Details
                    </Button>
                    <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void retryOne(j)}>
                      Retry
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => navigate('queue', { highlight: j.id })}>
                    {j.status === 'awaiting_approval' ? 'Review script' : 'Choose title'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent voiceovers" actions={<Button size="sm" variant="ghost" onClick={() => navigate('audio')}>View all</Button>}>
        {audio.loading && recentAudio.length === 0 ? (
          <div style={{ padding: 16 }}>
            <Skeleton height={60} />
          </div>
        ) : recentAudio.length === 0 ? (
          <EmptyState compact icon={<Mic size={20} />} title="No voiceovers yet" description="Finished MP3 files show up here with a player." actions={<Button size="sm" onClick={() => navigate('generate')}>Start a generation</Button>} />
        ) : (
          recentAudio.map((a) => (
            <div key={a.id} className="audio-row">
              <div className="row-between">
                <div className="col" style={{ gap: 2, minWidth: 0 }}>
                  <span className="strong truncate">{a.title}</span>
                  <span className="row xs muted" style={{ gap: 6 }}>
                    <ChannelChip name={a.channelName} color={a.channelColor} />
                    <span>
                      {a.voiceName} · {formatDuration(a.durationSec)} · {relativeTime(a.createdAt, now)}
                    </span>
                  </span>
                </div>
                <div className="row gap-1">
                  <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Show file" onClick={() => void api.invoke('app:showItemInFolder', { path: a.filePath }).catch((err) => toast.error('Could not show file', err))} />
                  <Button size="sm" variant={playing === a.id ? 'secondary' : 'ghost'} onClick={() => setPlaying(playing === a.id ? null : a.id)}>
                    {playing === a.id ? 'Hide' : 'Play'}
                  </Button>
                </div>
              </div>
              {playing === a.id && <AudioPlayer src={audioUrl(a.id)} compact autoPlay />}
            </div>
          ))
        )}
      </Card>

      <div className="stat-strip">
        <Stat label="Channels" icon={<Tv size={12} />} value={live.length} sub={`${channels.length - live.length} archived`} onClick={() => navigate('channels')} />
        <Stat label="Scripts" icon={<FileText size={12} />} value={scripts.loading && scriptCount === 0 ? <Skeleton width={60} height={28} /> : formatNumber(scriptCount)} onClick={() => navigate('scripts')} />
        <Stat label="Voiceovers" icon={<AudioLines size={12} />} value={audio.loading && audioRows.length === 0 ? <Skeleton width={60} height={28} /> : formatNumber(audioRows.filter((a) => a.status === 'ready').length)} onClick={() => navigate('audio')} />
        <Stat
          label="Queue"
          icon={<ListOrdered size={12} />}
          value={stats.processing + stats.pending}
          sub={
            <span className="row gap-3">
              <span>{stats.processing} working</span>
              <span>{stats.pending} waiting</span>
              {stats.failed > 0 && <span className="text-danger">{stats.failed} failed</span>}
            </span>
          }
          onClick={() => navigate('queue')}
        />
      </div>

      <div className="grid grid-3">
        <Card title="ElevenLabs plan">
          <div className="card-body col gap-3">
            {!secrets.elevenlabs ? (
              <span className="muted small">Add an ElevenLabs key to see your plan.</span>
            ) : subscription.loading && !sub ? (
              <Skeleton height={48} />
            ) : sub ? (
              <>
                <div className="row-between small">
                  <span className="strong">{sub.tier}</span>
                  <span className="muted tnum">{formatNumber(Math.max(0, sub.characterLimit - sub.characterCount))} left</span>
                </div>
                <ProgressBar value={sub.characterCount} max={sub.characterLimit} tone={sub.characterCount / Math.max(1, sub.characterLimit) > 0.9 ? 'danger' : 'accent'} />
                <div className="xs muted tnum">
                  {formatNumber(sub.characterCount)} of {formatNumber(sub.characterLimit)} used ({formatPercent(sub.characterCount / Math.max(1, sub.characterLimit))})
                  {sub.nextResetUnix ? ` · resets ${relativeTime(new Date(sub.nextResetUnix * 1000).toISOString())}` : ''}
                </div>
              </>
            ) : (
              <span className="muted small">Plan details unavailable for this key.</span>
            )}
          </div>
        </Card>
        <Card title="OpenAI spend" actions={<Badge>estimate</Badge>}>
          <div className="card-body col gap-2">
            {usage.loading && !u ? (
              <Skeleton height={48} />
            ) : u?.openai ? (
              <>
                <div className="stat-value" style={{ fontSize: 24 }}>
                  <CostLabel usd={u.openai.estimatedCost} />
                </div>
                <div className="xs muted tnum">
                  {formatNumber(u.openai.requests)} requests · {formatCompact(u.openai.inputTokens)} in / {formatCompact(u.openai.outputTokens)} out tokens
                </div>
              </>
            ) : (
              <span className="muted small">No usage yet.</span>
            )}
          </div>
        </Card>
        <Card title="ElevenLabs usage" actions={<Badge>estimate</Badge>}>
          <div className="card-body col gap-2">
            {usage.loading && !u ? (
              <Skeleton height={48} />
            ) : u?.elevenlabs ? (
              <>
                <div className="stat-value" style={{ fontSize: 24 }}>
                  {formatCompact(u.elevenlabs.characters)} <span className="small muted">characters</span>
                </div>
                <div className="xs muted tnum">
                  {formatNumber(u.elevenlabs.requests)} requests · ≈ <CostLabel usd={u.elevenlabs.estimatedCost} /> at your pricing table
                </div>
              </>
            ) : (
              <span className="muted small">No usage yet.</span>
            )}
          </div>
        </Card>
      </div>

      {!setupNeeded && live.length > 0 && stats.total === 0 && (
        <Alert tone="info" title="Ready when you are" actions={<Button size="sm" variant="primary" onClick={() => navigate('generate')}>Start a generation</Button>}>
          <span className="row">
            Pick a channel, paste a few titles and press Generate — finished files land in your output folder.
          </span>
        </Alert>
      )}
    </div>
  )
}
