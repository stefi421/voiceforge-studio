import { useMemo, useState, type JSX } from 'react'
import { AudioLines, FileText, FolderOpen, KeyRound, ListOrdered, Mic, Plus, RotateCcw, Sparkles, TriangleAlert, Tv } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp, activeChannels } from '@/store/app'
import { navigate } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, AudioPlayer, Badge, Button, Card, ChannelChip, CostLabel, EmptyState, PageHeader, ProgressBar, Skeleton, Stat, StatusBadge } from '@/components/ui'
import { formatCompact, formatDuration, formatNumber, formatPercent, relativeTime } from '@/lib/format'
import { audioUrl } from '@/lib/api'

export function DashboardPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const secrets = useApp((s) => s.secrets)
  const live = activeChannels(channels)

  const usage = useAsync(() => api.invoke('usage:summary', {}), [])
  const subscription = useAsync(() => api.invoke('eleven:subscription', undefined), [secrets.elevenlabs], { enabled: secrets.elevenlabs })
  const projects = useAsync(() => api.invoke('projects:list', { limit: 8, sort: 'updatedAt', dir: 'desc' }), [stats.completed], { fallback: [] })
  const scripts = useAsync(() => api.invoke('scripts:list', { limit: 5000 }), [stats.completed], { fallback: [] })
  const audio = useAsync(() => api.invoke('audio:list', { limit: 5000, sort: 'createdAt', dir: 'desc' }), [stats.completed], { fallback: [] })
  const [playing, setPlaying] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const projectRows = useMemo(() => (Array.isArray(projects.data) ? projects.data : []), [projects.data])
  const scriptCount = Array.isArray(scripts.data) ? scripts.data.length : 0
  const audioRows = useMemo(() => (Array.isArray(audio.data) ? audio.data : []), [audio.data])
  const channelsWithoutVoice = useMemo(() => live.filter((c) => !c.elevenVoiceId), [live])
  const recentAudio = useMemo(() => audioRows.filter((a) => a.status === 'ready').slice(0, 6), [audioRows])
  const loadErrors = [usage.error, projects.error, scripts.error, audio.error].filter((e): e is NonNullable<typeof e> => Boolean(e))
  const checklist: Array<{ label: string; done: boolean; action: () => void }> = [
    { label: 'Add your OpenAI API key', done: secrets.openai, action: () => navigate('settings', { tab: 'openai' }) },
    { label: 'Add your ElevenLabs API key', done: secrets.elevenlabs, action: () => navigate('settings', { tab: 'elevenlabs' }) },
    {
      label: channelsWithoutVoice.length ? `Pick a voice for ${channelsWithoutVoice.length} channel(s): ${channelsWithoutVoice.map((c) => c.name).join(', ')}` : 'Every channel has a voice',
      done: channelsWithoutVoice.length === 0 && live.length > 0,
      action: () => navigate('channels', channelsWithoutVoice[0] ? { edit: channelsWithoutVoice[0].id, tab: 'voice' } : {})
    }
  ]
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

  const u = usage.data
  const sub = subscription.data

  return (
    <div className="page fade-in">
      <PageHeader
        title="Dashboard"
        subtitle="Overview of channels, queue and estimated usage"
        actions={
          <>
            <Button icon={<FolderOpen size={14} />} onClick={openOutput}>
              Open output folder
            </Button>
            <Button icon={<Plus size={14} />} onClick={() => navigate('channels', { edit: 'new' })}>
              Add channel
            </Button>
            {stats.failed > 0 && (
              <Button icon={<RotateCcw size={14} />} loading={retrying} onClick={retryFailed}>
                Resume failed ({stats.failed})
              </Button>
            )}
            <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => navigate('generate')}>
              Generate new voiceovers
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

      {setupNeeded && (
        <Alert tone="warning" title="Finish setting up VoiceForge Studio">
          <div className="checklist mt-2">
            {checklist.map((c, i) => (
              <div key={i} className={`checklist-item ${c.done ? 'done' : ''}`}>
                {c.done ? <span className="text-success">✓</span> : <KeyRound size={13} />}
                <span className="grow">{c.label}</span>
                {!c.done && (
                  <Button size="sm" onClick={c.action}>
                    Fix
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Alert>
      )}

      <div className="grid grid-4">
        <Stat label="Channels" icon={<Tv size={12} />} value={live.length} sub={`${channels.length - live.length} archived`} onClick={() => navigate('channels')} />
        <Stat label="Scripts generated" icon={<FileText size={12} />} value={scripts.loading ? <Skeleton width={60} height={28} /> : formatNumber(scriptCount)} onClick={() => navigate('scripts')} />
        <Stat
          label="Voiceovers completed"
          icon={<AudioLines size={12} />}
          value={audio.loading ? <Skeleton width={60} height={28} /> : formatNumber(audioRows.filter((a) => a.status === 'ready').length)}
          onClick={() => navigate('audio')}
        />
        <Stat
          label="Queue"
          icon={<ListOrdered size={12} />}
          value={
            <span className="row gap-3" style={{ fontSize: 'inherit' }}>
              <span title="Active">{stats.processing}</span>
              <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                active
              </span>
            </span>
          }
          sub={
            <span className="row gap-3">
              <span>{stats.pending} pending</span>
              <span className={stats.failed ? 'text-danger' : ''}>{stats.failed} failed</span>
              {stats.awaitingUser > 0 && <span className="text-warning">{stats.awaitingUser} need you</span>}
            </span>
          }
          onClick={() => navigate('queue')}
        />
      </div>

      <div className="grid grid-3">
        <Card title="OpenAI usage" actions={<Badge>estimate</Badge>}>
          <div className="card-body col gap-3">
            {usage.loading ? (
              <Skeleton height={48} />
            ) : u?.openai ? (
              <>
                <div className="stat-value" style={{ fontSize: 24 }}>
                  <CostLabel usd={u.openai.estimatedCost} />
                </div>
                <div className="xs muted">
                  {formatNumber(u.openai.requests)} requests · {formatCompact(u.openai.inputTokens)} in / {formatCompact(u.openai.outputTokens)} out tokens
                </div>
                <div className="xs subtle">All-time, estimated from your pricing table.</div>
              </>
            ) : (
              <span className="muted small">No usage yet.</span>
            )}
          </div>
        </Card>
        <Card title="ElevenLabs usage" actions={<Badge>estimate</Badge>}>
          <div className="card-body col gap-3">
            {usage.loading ? (
              <Skeleton height={48} />
            ) : u?.elevenlabs ? (
              <>
                <div className="stat-value" style={{ fontSize: 24 }}>
                  <CostLabel usd={u.elevenlabs.estimatedCost} />
                </div>
                <div className="xs muted">
                  {formatNumber(u.elevenlabs.requests)} requests · {formatNumber(u.elevenlabs.characters)} characters
                </div>
                <div className="xs subtle">All-time, estimated from your pricing table.</div>
              </>
            ) : (
              <span className="muted small">No usage yet.</span>
            )}
          </div>
        </Card>
        <Card title="ElevenLabs subscription">
          <div className="card-body col gap-3">
            {!secrets.elevenlabs ? (
              <span className="muted small">Add an ElevenLabs key to see your plan.</span>
            ) : subscription.loading ? (
              <Skeleton height={48} />
            ) : sub ? (
              <>
                <div className="row-between small">
                  <span className="strong">{sub.tier}</span>
                  <span className="muted">{sub.status}</span>
                </div>
                <ProgressBar value={sub.characterCount} max={sub.characterLimit} tone={sub.characterCount / Math.max(1, sub.characterLimit) > 0.9 ? 'danger' : 'accent'} />
                <div className="xs muted">
                  {formatNumber(sub.characterCount)} / {formatNumber(sub.characterLimit)} characters used ({formatPercent(sub.characterCount / Math.max(1, sub.characterLimit))})
                  {sub.nextResetUnix ? ` · resets ${relativeTime(new Date(sub.nextResetUnix * 1000).toISOString())}` : ''}
                </div>
              </>
            ) : (
              <span className="muted small">Subscription details unavailable.</span>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Recent projects" actions={<Button size="sm" variant="ghost" onClick={() => navigate('projects')}>View all</Button>}>
          <div className="card-body-flush">
            {projects.loading ? (
              <div style={{ padding: 16 }}>
                <Skeleton height={60} />
              </div>
            ) : projectRows.length === 0 ? (
              <EmptyState compact icon={<FolderOpen size={20} />} title="No projects yet" description="Every title you generate becomes a project with its script and audio files." />
            ) : (
              projectRows.slice(0, 8).map((p) => (
                <div key={p.id} className="row-between" style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)' }}>
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="strong truncate">{p.title}</span>
                    <span className="row xs muted">
                      <ChannelChip name={p.channelName} color={p.channelColor} icon={p.channelIcon} />
                      <span>
                        {p.scriptCount} script(s) · {p.audioCount} audio
                      </span>
                      <span>· {relativeTime(p.updatedAt)}</span>
                    </span>
                  </div>
                  {p.latestJobStatus && <StatusBadge status={p.latestJobStatus} />}
                </div>
              ))
            )}
          </div>
        </Card>
        <Card title="Recent audio" actions={<Button size="sm" variant="ghost" onClick={() => navigate('audio')}>View all</Button>}>
          <div className="card-body-flush">
            {audio.loading ? (
              <div style={{ padding: 16 }}>
                <Skeleton height={60} />
              </div>
            ) : recentAudio.length === 0 ? (
              <EmptyState compact icon={<Mic size={20} />} title="No voiceovers yet" description="Generated MP3 files will appear here with a quick player." />
            ) : (
              recentAudio.map((a) => (
                <div key={a.id} className="col" style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', gap: 6 }}>
                  <div className="row-between">
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="strong truncate">{a.title}</span>
                      <span className="xs muted">
                        {a.channelName} · {a.voiceName} · {formatDuration(a.durationSec)} · {relativeTime(a.createdAt)}
                      </span>
                    </div>
                    <Button size="sm" variant={playing === a.id ? 'secondary' : 'ghost'} onClick={() => setPlaying(playing === a.id ? null : a.id)}>
                      {playing === a.id ? 'Hide' : 'Play'}
                    </Button>
                  </div>
                  {playing === a.id && <AudioPlayer src={audioUrl(a.id)} compact autoPlay onOpenFolder={() => void api.invoke('app:showItemInFolder', { path: a.filePath })} />}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {stats.spendingPaused && (
        <Alert tone="danger" title="Queue paused by spending limit" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'spending' })}>Review limits</Button>}>
          <span className="row">
            <TriangleAlert size={12} /> A local spending safeguard was reached. Raise the limit or wait for the next period, then resume the queue.
          </span>
        </Alert>
      )}
    </div>
  )
}
