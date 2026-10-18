import type { JobMode, JobStatus, JobView } from '@shared/types'
import { JOB_STATUS_LABELS } from '@shared/defaults'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

export function statusTone(status: JobStatus): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'neutral'
    case 'paused':
      return 'warning'
    case 'research_review_required':
    case 'awaiting_approval':
      return 'warning'
    case 'pending':
      return 'neutral'
    case 'script_ready':
      return 'info'
    default:
      return 'accent'
  }
}

/** Sentence-case status label ("Awaiting approval", not "Awaiting Approval"). */
export function statusLabel(status: JobStatus): string {
  const raw = JOB_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

export function isActiveStatus(status: JobStatus): boolean {
  return (
    status === 'researching' ||
    status === 'writing_script' ||
    status === 'validating_script' ||
    status === 'generating_audio' ||
    status === 'saving_files'
  )
}

export function needsUser(status: JobStatus): boolean {
  return status === 'research_review_required' || status === 'awaiting_approval'
}

export function isFinished(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** Pipeline steps shown in the UI (approval is skipped visually for auto mode). */
export const PIPELINE_STEPS = ['research', 'script', 'validate', 'approval', 'audio', 'save'] as const
export type PipelineStep = (typeof PIPELINE_STEPS)[number]

export const PIPELINE_LABELS: Record<PipelineStep, string> = {
  research: 'Research',
  script: 'Script',
  validate: 'Validate',
  approval: 'Approval',
  audio: 'Audio',
  save: 'Save'
}

export type StepState = 'done' | 'current' | 'failed' | 'waiting' | 'todo' | 'skipped'

function stepIndexForStatus(status: JobStatus, resume: JobStatus | null): number {
  const s = status === 'paused' && resume ? resume : status
  switch (s) {
    case 'pending':
      return -1
    case 'researching':
    case 'research_review_required':
      return 0
    case 'writing_script':
      return 1
    case 'validating_script':
      return 2
    case 'script_ready':
    case 'awaiting_approval':
      return 3
    case 'generating_audio':
      return 4
    case 'saving_files':
      return 5
    case 'completed':
      return 6
    case 'failed':
    case 'cancelled':
    case 'paused':
      return -1
    default:
      return -1
  }
}

function stageIndex(stage: JobView['stage']): number {
  switch (stage) {
    case 'research':
      return 0
    case 'script':
      return 1
    case 'approval':
      return 3
    case 'audio':
      return 4
    case 'save':
      return 5
    case 'done':
      return 6
    default:
      return -1
  }
}

export function pipelineStates(job: Pick<JobView, 'status' | 'stage' | 'mode' | 'resumeStatus'>): StepState[] {
  const states: StepState[] = PIPELINE_STEPS.map(() => 'todo')
  const mode: JobMode = job.mode
  const skipApproval = mode === 'auto'
  const audioSkipped = mode === 'scripts_only'
  const effective = job.status === 'paused' && job.resumeStatus ? job.resumeStatus : job.status

  let idx = stepIndexForStatus(job.status, job.resumeStatus)
  if (idx < 0 && (job.status === 'failed' || job.status === 'cancelled' || job.status === 'paused')) {
    idx = stageIndex(job.stage)
  }

  if (job.status === 'completed') {
    for (let i = 0; i < states.length; i++) states[i] = 'done'
  } else {
    for (let i = 0; i < states.length; i++) {
      if (i < idx) states[i] = 'done'
      else if (i === idx) {
        if (job.status === 'failed') states[i] = 'failed'
        else if (job.status === 'cancelled') states[i] = 'skipped'
        else if (job.status === 'paused') states[i] = 'waiting'
        else if (effective === 'research_review_required' || effective === 'awaiting_approval') states[i] = 'waiting'
        else if (effective === 'script_ready') states[i] = 'done'
        else states[i] = 'current'
      }
    }
  }
  if (skipApproval && states[3] !== 'failed' && states[3] !== 'waiting') states[3] = idx > 3 || job.status === 'completed' ? 'done' : 'skipped'
  if (audioSkipped) {
    if (states[4] !== 'failed') states[4] = 'skipped'
    if (job.status === 'completed') states[5] = 'done'
  }
  return states
}

export function jobAttempts(job: JobView): string {
  const parts: string[] = []
  if (job.researchAttempts) parts.push(`R${job.researchAttempts}`)
  if (job.scriptAttempts) parts.push(`S${job.scriptAttempts}`)
  if (job.audioAttempts) parts.push(`A${job.audioAttempts}`)
  return parts.length ? parts.join(' · ') : '—'
}

export const ALL_JOB_STATUSES: JobStatus[] = [
  'pending',
  'researching',
  'research_review_required',
  'writing_script',
  'validating_script',
  'script_ready',
  'awaiting_approval',
  'generating_audio',
  'saving_files',
  'completed',
  'failed',
  'paused',
  'cancelled'
]

export const MODE_DESCRIPTIONS: Record<JobMode, string> = {
  auto: 'Research → write script → validate → generate audio → save. No stops unless the title is ambiguous or validation keeps failing.',
  review_before_voice:
    'Research → write script → validate → wait for your approval → generate audio → save. You read and edit every script before ElevenLabs characters are spent.',
  scripts_only: 'Research → write script → validate → save the script file. No audio is generated; you can voice any script later from the Scripts Library.'
}

/** Human description of what a job is doing right now, for queue rows and the detail drawer. */
export function stageText(job: JobView, extra: { modelId?: string | null; queuePaused?: boolean } = {}): string {
  const chars = job.scriptCharCount != null ? `${job.scriptCharCount.toLocaleString()} chars` : null
  switch (job.status) {
    case 'pending':
      if (job.nextRunAt && new Date(job.nextRunAt).getTime() > Date.now()) return `Waiting to retry · ${new Date(job.nextRunAt).toLocaleTimeString()}`
      return extra.queuePaused ? 'Waiting · queue is paused' : 'Waiting for a free slot'
    case 'researching':
      return job.researchAttempts > 1 ? `Researching · attempt ${job.researchAttempts}` : 'Researching the title'
    case 'research_review_required':
      return 'Needs you: choose the right title or add notes'
    case 'writing_script':
      return job.scriptAttempts > 1 ? `Rewriting script · attempt ${job.scriptAttempts}` : 'Writing the script'
    case 'validating_script':
      return ['Validating script', chars].filter(Boolean).join(' · ')
    case 'script_ready':
      return ['Script ready', chars].filter(Boolean).join(' · ')
    case 'awaiting_approval':
      return ['Needs you: review the script', chars].filter(Boolean).join(' · ')
    case 'generating_audio':
      return ['Generating audio', chars, extra.modelId ?? null].filter(Boolean).join(' · ')
    case 'saving_files':
      return 'Saving files'
    case 'completed':
      return job.mode === 'scripts_only' ? 'Script saved' : 'Script and voice saved'
    case 'failed':
      return job.lastError ? firstSentence(job.lastError.message) : `Failed at ${job.stage}`
    case 'paused':
      return job.resumeStatus ? `Paused before ${statusLabel(job.resumeStatus).toLowerCase()}` : 'Paused'
    case 'cancelled':
      return 'Cancelled'
    default:
      return statusLabel(job.status)
  }
}

/** "stage 5 of 6" for a running job (approval/audio counted only when the mode uses them). */
export function stageOrdinal(job: Pick<JobView, 'status' | 'stage' | 'mode' | 'resumeStatus'>): { index: number; total: number } | null {
  const states = pipelineStates(job)
  const total = states.filter((s) => s !== 'skipped').length
  const idx = states.findIndex((s) => s === 'current' || s === 'waiting' || s === 'failed')
  if (idx < 0) return null
  const index = states.slice(0, idx + 1).filter((s) => s !== 'skipped').length
  return { index, total }
}

/** Sentence-case mode label ("Review before voice"). */
export function modeLabel(mode: string): string {
  switch (mode) {
    case 'auto':
      return 'Fully automatic'
    case 'review_before_voice':
      return 'Review before voice'
    case 'scripts_only':
      return 'Scripts only'
    default:
      return mode.replace(/_/g, ' ')
  }
}

/** The first sentence of an error message (the row shows one clear sentence; details live in the drawer). */
export function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  const m = t.match(/^(.+?[.!?])(\s|$)/)
  return (m ? m[1]! : t).slice(0, 220)
}

export type FixKind = 'retry' | 'fix_key' | 'open_billing' | 'choose_game' | 'review_script' | 'raise_limit' | 'open_channel' | 'open_storage'

export interface FixAction {
  kind: FixKind
  label: string
  /** Settings tab / page parameters the fix opens, when it navigates. */
  provider?: 'openai' | 'elevenlabs'
}

/** The single primary fix for a failed job — every error kind gets exactly one obvious next step. */
export function fixActionFor(job: Pick<JobView, 'status' | 'stage' | 'lastError'>): FixAction | null {
  if (job.status !== 'failed' && job.status !== 'cancelled') return null
  const e = job.lastError
  if (!e || job.status === 'cancelled') return { kind: 'retry', label: 'Retry' }
  const text = `${e.message} ${e.action}`.toLowerCase()
  const provider: 'openai' | 'elevenlabs' = /elevenlabs|voice|character/.test(text) || job.stage === 'audio' ? 'elevenlabs' : 'openai'
  switch (e.kind) {
    case 'auth':
      return { kind: 'fix_key', label: 'Fix key', provider }
    case 'quota':
      return { kind: 'open_billing', label: provider === 'elevenlabs' ? 'Check ElevenLabs plan' : 'Check OpenAI billing', provider }
    case 'ambiguous':
    case 'insufficient_info':
      return { kind: 'choose_game', label: 'Choose game' }
    case 'validation':
      return { kind: 'review_script', label: 'Approve anyway…' }
    case 'spending_limit':
      return { kind: 'raise_limit', label: 'Raise limit' }
    case 'config':
      if (/voice/.test(text)) return { kind: 'open_channel', label: 'Pick a voice' }
      if (/format|template|reference/.test(text)) return { kind: 'open_channel', label: 'Open format' }
      if (/api key|key is missing/.test(text)) return { kind: 'fix_key', label: 'Fix key', provider }
      return e.retryable ? { kind: 'retry', label: 'Retry' } : { kind: 'open_channel', label: 'Open channel' }
    case 'filesystem':
      return e.retryable ? { kind: 'retry', label: 'Retry' } : { kind: 'open_storage', label: 'Choose folder' }
    default:
      return { kind: 'retry', label: 'Retry' }
  }
}
