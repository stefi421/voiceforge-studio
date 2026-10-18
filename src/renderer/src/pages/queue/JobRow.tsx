import { memo, type JSX, type MouseEvent } from 'react'
import { Ban, FolderOpen, Pause, Play, RotateCcw, Trash } from 'lucide-react'
import type { JobView } from '@shared/types'
import { jobAttempts, isActiveStatus, isFinished, needsUser, stageText } from '@/lib/jobs'
import { relativeTime } from '@/lib/format'
import { Button, ChannelChip, StagePipeline, StatusBadge } from '@/components/ui'

export type JobAction = 'pause' | 'resume' | 'retry' | 'cancel' | 'remove' | 'openFolder' | 'viewScript' | 'viewResearch' | 'review' | 'details'

export interface JobRowProps {
  job: JobView
  busy: boolean
  highlighted: boolean
  selected: boolean
  now: number
  modelId?: string | null
  queuePaused?: boolean
  onAction: (action: JobAction, job: JobView) => void
}

export const JobRow = memo(function JobRow({ job, busy, highlighted, selected, now, modelId, queuePaused, onAction }: JobRowProps): JSX.Element {
  const active = isActiveStatus(job.status)
  const canPause = job.status === 'pending' || active
  const canResume = job.status === 'paused'
  const canRetry = job.status === 'failed' || job.status === 'cancelled'
  const canCancel = !isFinished(job.status)
  const canRemove = isFinished(job.status) || job.status === 'paused'
  const waiting = needsUser(job.status)

  const stop = (e: MouseEvent): void => e.stopPropagation()

  return (
    <tr className={`job-row ${highlighted ? 'highlighted' : ''} ${selected ? 'selected' : ''}`} onClick={() => onAction('details', job)}>
      <td>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="strong truncate" title={job.title} style={{ maxWidth: 380 }}>
            {job.title}
          </span>
          <span className={`xs truncate ${job.status === 'failed' ? 'text-danger' : waiting ? 'text-warning' : 'muted'}`} title={stageText(job, { modelId, queuePaused })}>
            {stageText(job, { modelId, queuePaused })}
          </span>
          <span className="xs subtle truncate">
            {job.batchName} · {relativeTime(job.updatedAt, now)}
          </span>
        </div>
      </td>
      <td className="compact">
        <ChannelChip name={job.channelName} color={job.channelColor} icon={job.channelIcon} />
      </td>
      <td className="compact">
        <div className="col" style={{ gap: 5, alignItems: 'flex-start' }}>
          <StatusBadge status={job.status} />
          <StagePipeline job={job} />
        </div>
      </td>
      <td className="compact xs muted mono tnum" title="Research / Script / Audio attempts">
        {jobAttempts(job)}
      </td>
      <td className="actions" onClick={stop}>
        <span className="row-actions">
          {waiting && (
            <Button size="sm" variant="primary" onClick={() => onAction('review', job)} disabled={busy}>
              {job.status === 'awaiting_approval' ? 'Review' : 'Choose title'}
            </Button>
          )}
          {canRetry && (
            <Button size="sm" onClick={() => onAction('retry', job)} disabled={busy} icon={<RotateCcw size={13} />}>
              Retry
            </Button>
          )}
          {canPause && <Button size="sm" variant="ghost" iconOnly icon={<Pause size={13} />} title="Pause" disabled={busy} onClick={() => onAction('pause', job)} />}
          {canResume && <Button size="sm" variant="ghost" iconOnly icon={<Play size={13} />} title="Resume" disabled={busy} onClick={() => onAction('resume', job)} />}
          {job.projectFolder && <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Open project folder" onClick={() => onAction('openFolder', job)} />}
          {canCancel && !waiting && <Button size="sm" variant="ghost" iconOnly icon={<Ban size={13} />} title="Cancel" disabled={busy} onClick={() => onAction('cancel', job)} />}
          {canRemove && <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} title="Remove from queue" disabled={busy} onClick={() => onAction('remove', job)} />}
        </span>
      </td>
    </tr>
  )
})
