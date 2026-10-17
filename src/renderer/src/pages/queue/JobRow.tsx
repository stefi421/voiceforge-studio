import { memo, type JSX } from 'react'
import { Ban, Eye, FileSearch, FolderOpen, Pause, Play, RotateCcw, Trash } from 'lucide-react'
import type { JobView } from '@shared/types'
import { jobAttempts, isFinished, needsUser } from '@/lib/jobs'
import { relativeTime } from '@/lib/format'
import { Button, ChannelChip, StagePipeline, StatusBadge } from '@/components/ui'

export type JobAction = 'pause' | 'resume' | 'retry' | 'cancel' | 'remove' | 'openFolder' | 'viewScript' | 'viewResearch' | 'review'

export interface JobRowProps {
  job: JobView
  busy: boolean
  highlighted: boolean
  now: number
  onAction: (action: JobAction, job: JobView) => void
}

export const JobRow = memo(function JobRow({ job, busy, highlighted, now, onAction }: JobRowProps): JSX.Element {
  const active = job.status === 'researching' || job.status === 'writing_script' || job.status === 'validating_script' || job.status === 'generating_audio' || job.status === 'saving_files'
  const canPause = job.status === 'pending' || active
  const canResume = job.status === 'paused'
  const canRetry = job.status === 'failed' || job.status === 'cancelled'
  const canCancel = !isFinished(job.status)
  const canRemove = isFinished(job.status) || job.status === 'paused'
  const waiting = needsUser(job.status)

  return (
    <tr className={highlighted ? 'selected' : undefined}>
      <td>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="strong truncate" title={job.title} style={{ maxWidth: 360 }}>
            {job.title}
          </span>
          <span className="xs muted truncate">
            {job.batchName} · {relativeTime(job.updatedAt, now)}
            {job.scriptCharCount != null ? ` · ${job.scriptCharCount.toLocaleString()} chars` : ''}
          </span>
          {job.lastError && (
            <details className="job-error">
              <summary>
                {job.lastError.kind}: {job.lastError.message}
              </summary>
              <div className="mt-2 selectable">
                <div>
                  <strong>What to do:</strong> {job.lastError.action}
                </div>
                {job.lastError.details && <pre className="pre-wrap mt-2" style={{ margin: 0, fontSize: 11 }}>{job.lastError.details}</pre>}
                <div className="xs subtle mt-2">
                  {relativeTime(job.lastError.at, now)} · {job.lastError.retryable ? 'retryable' : 'not retryable automatically'}
                </div>
              </div>
            </details>
          )}
        </div>
      </td>
      <td className="compact">
        <ChannelChip name={job.channelName} color={job.channelColor} icon={job.channelIcon} />
      </td>
      <td className="compact">
        <div className="col" style={{ gap: 4 }}>
          <StatusBadge status={job.status} />
          <StagePipeline job={job} />
        </div>
      </td>
      <td className="compact xs muted mono" title="Research / Script / Audio attempts">
        {jobAttempts(job)}
      </td>
      <td className="actions">
        <span className="row-actions">
          {waiting && (
            <Button size="sm" variant="primary" onClick={() => onAction('review', job)} disabled={busy}>
              {job.status === 'awaiting_approval' ? 'Review script' : 'Resolve'}
            </Button>
          )}
          {canPause && <Button size="sm" variant="ghost" iconOnly icon={<Pause size={13} />} title="Pause" disabled={busy} onClick={() => onAction('pause', job)} />}
          {canResume && <Button size="sm" variant="ghost" iconOnly icon={<Play size={13} />} title="Resume" disabled={busy} onClick={() => onAction('resume', job)} />}
          {canRetry && <Button size="sm" variant="ghost" iconOnly icon={<RotateCcw size={13} />} title="Retry" disabled={busy} onClick={() => onAction('retry', job)} />}
          {job.scriptId && <Button size="sm" variant="ghost" iconOnly icon={<Eye size={13} />} title="View script" onClick={() => onAction('viewScript', job)} />}
          {job.researchId && <Button size="sm" variant="ghost" iconOnly icon={<FileSearch size={13} />} title="View research" onClick={() => onAction('viewResearch', job)} />}
          {job.projectFolder && <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Open project folder" onClick={() => onAction('openFolder', job)} />}
          {canCancel && !waiting && <Button size="sm" variant="ghost" iconOnly icon={<Ban size={13} />} title="Cancel" disabled={busy} onClick={() => onAction('cancel', job)} />}
          {canRemove && <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} title="Remove from queue" disabled={busy} onClick={() => onAction('remove', job)} />}
        </span>
      </td>
    </tr>
  )
})
