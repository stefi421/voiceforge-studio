import type { JSX } from 'react'
import { Check, X, Clock, Minus } from 'lucide-react'
import type { JobView } from '@shared/types'
import { PIPELINE_LABELS, PIPELINE_STEPS, pipelineStates } from '@/lib/jobs'

type PipelineJob = Pick<JobView, 'status' | 'stage' | 'mode' | 'resumeStatus'>

/** Compact six-segment bar for table rows. */
export function StagePipeline({ job }: { job: PipelineJob }): JSX.Element {
  const states = pipelineStates(job)
  const title = PIPELINE_STEPS.map((s, i) => `${PIPELINE_LABELS[s]}: ${states[i] ?? 'todo'}`).join('\n')
  return (
    <span className="pipeline" title={title}>
      {PIPELINE_STEPS.map((s, i) => (
        <span key={s} className={`pipeline-step ${states[i] ?? 'todo'}`} />
      ))}
    </span>
  )
}

/** Large labeled version for detail dialogs. */
export function StagePipelineLarge({ job }: { job: PipelineJob }): JSX.Element {
  const states = pipelineStates(job)
  return (
    <div className="pipeline-lg">
      {PIPELINE_STEPS.map((s, i) => {
        const st = states[i] ?? 'todo'
        return (
          <div key={s} className={`pl-step ${st}`}>
            <div className="pl-dot">
              {st === 'done' ? <Check size={12} /> : st === 'failed' ? <X size={12} /> : st === 'waiting' ? <Clock size={12} /> : st === 'skipped' ? <Minus size={12} /> : i + 1}
            </div>
            <span>{PIPELINE_LABELS[s]}</span>
          </div>
        )
      })}
    </div>
  )
}
