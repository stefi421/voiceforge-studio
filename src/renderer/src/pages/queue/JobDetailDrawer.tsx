import { useMemo, useState, type JSX } from 'react'
import { Ban, ExternalLink, FileText, FolderOpen, Pause, Play, RotateCcw } from 'lucide-react'
import type { JobView } from '@shared/types'
import { api, audioUrl } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { isFinished, needsUser, stageText } from '@/lib/jobs'
import { formatDateTime, formatDuration, formatNumber, formatPercent, relativeTime } from '@/lib/format'
import { useApp } from '@/store/app'
import { Alert, AudioPlayer, Badge, Button, ChannelChip, Drawer, KeyValue, SkeletonRows, StagePipelineLarge, StatusBadge } from '@/components/ui'
import { NarrationToggle, narrationOf, ScriptProvenance, type ScriptView } from '@/components/ScriptMeta'
import { ValidationIssues } from '@/components/dialogs/ScriptReviewDialog'
import type { JobAction } from './JobRow'
import { JobTimingPanel } from '@/components/SpeedViews'

export interface JobDetailDrawerProps {
  job: JobView | null
  onClose: () => void
  onAction: (action: JobAction, job: JobView) => void
}

/**
 * Right-side drawer with everything about one job: pipeline, research summary,
 * script preview + validation, audio player, event timeline, error with action.
 */
export function JobDetailDrawer({ job, onClose, onAction }: JobDetailDrawerProps): JSX.Element {
  const jobId = job?.id ?? null
  const scriptId = job?.scriptId ?? null
  const audioId = job?.audioId ?? null
  const channel = useApp((s) => (job ? s.channels.find((c) => c.id === job.channelId) : undefined))

  const research = useAsync(() => api.invoke('queue:getResearch', { jobId: jobId ?? '' }), [jobId, job?.researchId], { enabled: Boolean(jobId && job?.researchId) })
  const script = useAsync(() => api.invoke('scripts:get', { id: scriptId ?? '' }), [scriptId], { enabled: Boolean(scriptId) })
  const [scriptView, setScriptView] = useState<ScriptView>('script')
  const audio = useAsync(() => api.invoke('audio:get', { id: audioId ?? '' }), [audioId], { enabled: Boolean(audioId) })
  const timings = useAsync(() => api.invoke('queue:timings', { jobId: jobId ?? '' }), [jobId, job?.updatedAt], { enabled: Boolean(jobId) })
  const events = useAsync(() => api.invoke('history:list', { jobId: jobId ?? '', limit: 200 }), [jobId, job?.updatedAt], { enabled: Boolean(jobId), fallback: [] })

  const eventRows = useMemo(() => (Array.isArray(events.data) ? [...events.data].sort((a, b) => b.at.localeCompare(a.at)) : []), [events.data])
  const r = research.data
  const d = r?.data

  if (!job) return <Drawer open={false} onClose={onClose} title="" />

  const active = !isFinished(job.status) && job.status !== 'paused'
  const waiting = needsUser(job.status)

  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={job.title}
      description={
        <span className="row wrap gap-1">
          <ChannelChip name={job.channelName} color={job.channelColor} icon={job.channelIcon} />
          <span>· {job.batchName}</span>
          <span>· started {job.startedAt ? relativeTime(job.startedAt) : 'not yet'}</span>
        </span>
      }
      headerExtra={<StatusBadge status={job.status} />}
      footer={
        <>
          {job.projectFolder && (
            <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => onAction('openFolder', job)}>
              Open folder
            </Button>
          )}
          <div className="grow" />
          {waiting && (
            <Button variant="primary" onClick={() => onAction('review', job)}>
              {job.status === 'awaiting_approval' ? 'Review script' : 'Choose title'}
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && (
            <Button variant="primary" icon={<RotateCcw size={13} />} onClick={() => onAction('retry', job)}>
              Retry from {job.stage}
            </Button>
          )}
          {job.status === 'paused' && (
            <Button variant="primary" icon={<Play size={13} />} onClick={() => onAction('resume', job)}>
              Resume
            </Button>
          )}
          {active && !waiting && (
            <Button icon={<Pause size={13} />} onClick={() => onAction('pause', job)}>
              Pause
            </Button>
          )}
          {!isFinished(job.status) && !waiting && (
            <Button variant="danger-soft" icon={<Ban size={13} />} onClick={() => onAction('cancel', job)}>
              Cancel
            </Button>
          )}
        </>
      }
    >
      <div className="col gap-4">
        <section className="detail-section">
          <StagePipelineLarge job={job} />
          <div className="small muted mt-2">{stageText(job, { modelId: channel?.elevenModelId })}</div>
        </section>

        {job.lastError && (
          <Alert tone={job.status === 'failed' ? 'danger' : 'warning'} title={`${job.lastError.kind}: ${job.lastError.message}`}>
            {job.lastError.action && (
              <div>
                <strong>What to do:</strong> {job.lastError.action}
              </div>
            )}
            {job.lastError.details && <pre className="pre-wrap mt-2 selectable" style={{ margin: 0, fontSize: 11 }}>{job.lastError.details}</pre>}
            <div className="xs subtle mt-2">
              {relativeTime(job.lastError.at)} · {job.lastError.retryable ? 'retried automatically when possible' : 'needs your attention'}
            </div>
          </Alert>
        )}

        {job.researchId && (
          <section className="detail-section">
            <div className="detail-title">
              Research
              {r && (
                <span className="row gap-1">
                  <Badge tone={r.status === 'confirmed' ? 'success' : r.status === 'manual' ? 'info' : 'warning'}>{r.status}</Badge>
                  {d && <Badge>{formatPercent(d.confidence)} confidence</Badge>}
                  <Badge>{r.sources.length} {r.sources.length === 1 ? "source" : "sources"}</Badge>
                </span>
              )}
            </div>
            {research.loading ? (
              <SkeletonRows rows={4} />
            ) : research.error ? (
              <Alert tone="warning">{research.error.message}</Alert>
            ) : d ? (
              <div className="col gap-3">
                <KeyValue
                  items={[
                    { key: 'Title', value: d.canonicalTitle || '—' },
                    { key: d.subjectType === 'product' ? 'Maker' : 'Developer', value: d.developer || '—' },
                    { key: 'Publisher', value: d.publisher || '—' },
                    { key: 'Genre', value: d.genre || '—' },
                    { key: 'Release', value: `${d.releaseStatus}${d.releaseDate ? ` · ${d.releaseDate}` : ''}` },
                    { key: 'Platforms', value: d.platforms.length ? d.platforms.join(', ') : '—' }
                  ]}
                />
                {d.summary && <p className="small" style={{ margin: 0 }}>{d.summary}</p>}
                {d.uncertainFacts.length > 0 && (
                  <details>
                    <summary className="small muted">{d.uncertainFacts.length} uncertain fact(s)</summary>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {d.uncertainFacts.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {r && r.sources.length > 0 && (
                  <details>
                    <summary className="small muted">Sources</summary>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {r.sources.slice(0, 20).map((s, i) => (
                        <li key={i} className="truncate">
                          <ExternalLink size={10} /> {s.title || s.url}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => onAction('viewResearch', job)}>
                    Full research
                  </Button>
                </div>
              </div>
            ) : (
              <span className="small muted">No research data stored for this job.</span>
            )}
          </section>
        )}

        {job.scriptId && (
          <section className="detail-section">
            <div className="detail-title">
              Script
              {script.data && (
                <span className="row gap-1">
                  <Badge>v{script.data.version}</Badge>
                  <Badge>{formatNumber(script.data.charCount)} chars</Badge>
                  <Badge tone={script.data.validation?.ok ? 'success' : script.data.validation ? 'warning' : 'neutral'}>{script.data.status}</Badge>
                </span>
              )}
            </div>
            {script.loading ? (
              <SkeletonRows rows={5} />
            ) : script.data ? (
              <div className="col gap-3">
                <div className="row wrap" style={{ gap: 6 }}>
                  <ScriptProvenance script={script.data} />
                </div>
                <NarrationToggle value={scriptView} onChange={setScriptView} />
                {(() => {
                  const body = scriptView === 'narration' ? narrationOf(script.data) : script.data.text
                  return (
                    <pre className="script-preview">
                      {body.slice(0, 1200)}
                      {body.length > 1200 ? '\n…' : ''}
                    </pre>
                  )
                })()}
                {script.data.validation && !script.data.validation.ok && <ValidationIssues report={script.data.validation} />}
                <div className="row">
                  <Button size="sm" icon={<FileText size={13} />} onClick={() => onAction('viewScript', job)}>
                    Open script
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        )}

        {job.audioId && (
          <section className="detail-section">
            <div className="detail-title">
              Voiceover
              {audio.data && (
                <span className="row gap-1">
                  <Badge>{audio.data.voiceName}</Badge>
                  <Badge>{audio.data.modelId}</Badge>
                  <Badge>{formatDuration(audio.data.durationSec)}</Badge>
                </span>
              )}
            </div>
            {audio.data ? <AudioPlayer src={audioUrl(audio.data.id)} onOpenFolder={() => void api.invoke('app:showItemInFolder', { path: audio.data?.filePath ?? '' })} /> : audio.loading ? <SkeletonRows rows={2} /> : null}
          </section>
        )}

        <section className="detail-section">
          <div className="detail-title">Where the time went</div>
          <JobTimingPanel timings={timings.data ?? null} />
        </section>

        <section className="detail-section">
          <div className="detail-title">Timeline</div>
          {events.loading && eventRows.length === 0 ? (
            <SkeletonRows rows={4} />
          ) : eventRows.length === 0 ? (
            <span className="small muted">No events recorded yet.</span>
          ) : (
            <ol className="timeline">
              {eventRows.map((e) => (
                <li key={e.id} className="timeline-item">
                  <span className="timeline-time" title={formatDateTime(e.at)}>
                    {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="timeline-body">
                    <span className="strong">{e.event.replace(/_/g, ' ')}</span>
                    {e.detail && <span className="muted"> — {e.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Drawer>
  )
}
