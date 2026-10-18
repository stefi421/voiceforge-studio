import { jobWaits } from '../../queue/callContext'
import type { Batch, Job, JobError, JobEvent, JobMode, JobOverrides, JobStage, JobStatus, JobView, QueueStats, JobTimings, StageTiming, TimingStage, TimingSummary } from '@shared/types'
import type { Database } from '../database'
import { newId, nowIso, parseJson } from '../../util/common'

interface JobRow {
  id: string
  batch_id: string
  project_id: string
  channel_id: string
  title: string
  mode: string
  status: string
  stage: string
  position: number
  research_attempts: number
  script_attempts: number
  audio_attempts: number
  research_id: string | null
  script_id: string | null
  audio_id: string | null
  last_error_json: string | null
  resume_status: string | null
  manual_research_notes: string | null
  overrides_json: string | null
  next_run_at: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  // joined
  channel_name?: string
  channel_color?: string
  channel_icon?: string
  batch_name?: string
  project_folder?: string | null
  script_char_count?: number | null
  audio_file_path?: string | null
}

export const ACTIVE_STATUSES: JobStatus[] = ['researching', 'writing_script', 'validating_script', 'generating_audio', 'saving_files']
export const USER_WAIT_STATUSES: JobStatus[] = ['research_review_required', 'awaiting_approval']
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled']

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    batchId: r.batch_id,
    projectId: r.project_id,
    channelId: r.channel_id,
    title: r.title,
    mode: r.mode as JobMode,
    status: r.status as JobStatus,
    stage: r.stage as JobStage,
    position: r.position,
    researchAttempts: r.research_attempts,
    scriptAttempts: r.script_attempts,
    audioAttempts: r.audio_attempts,
    researchId: r.research_id,
    scriptId: r.script_id,
    audioId: r.audio_id,
    lastError: parseJson<JobError | null>(r.last_error_json, null),
    resumeStatus: (r.resume_status as JobStatus | null) ?? null,
    manualResearchNotes: r.manual_research_notes,
    overrides: parseJson<JobOverrides | null>(r.overrides_json, null),
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at
  }
}

function rowToView(r: JobRow): JobView {
  return {
    ...rowToJob(r),
    channelName: r.channel_name ?? '',
    channelColor: r.channel_color ?? '#7C5CFF',
    channelIcon: r.channel_icon ?? '',
    batchName: r.batch_name ?? '',
    projectFolder: r.project_folder ?? null,
    scriptCharCount: r.script_char_count ?? null,
    audioFilePath: r.audio_file_path ?? null,
    waitingFor: jobWaits.get(r.id)
  }
}

const VIEW_SELECT = `
SELECT j.*, c.name AS channel_name, c.color AS channel_color, c.icon AS channel_icon, b.name AS batch_name,
       p.folder_path AS project_folder,
       (SELECT char_count FROM scripts s WHERE s.id = j.script_id) AS script_char_count,
       (SELECT file_path FROM audio_files a WHERE a.id = j.audio_id) AS audio_file_path
FROM jobs j
JOIN channels c ON c.id = j.channel_id
JOIN batches b ON b.id = j.batch_id
JOIN projects p ON p.id = j.project_id`

export interface JobFilter {
  batchId?: string
  channelId?: string
  status?: string[]
  search?: string
  limit?: number
  offset?: number
}

export interface NewJob {
  batchId: string
  projectId: string
  channelId: string
  title: string
  mode: JobMode
  position: number
  manualResearchNotes?: string | null
  overrides?: JobOverrides | null
  stage?: JobStage
  status?: JobStatus
}

export class JobRepo {
  constructor(private db: Database) {}

  createBatch(name: string, mode: JobMode, id = newId()): Batch {
    this.db.run('INSERT INTO batches (id, name, mode, created_at) VALUES (?, ?, ?, ?)', id, name, mode, nowIso())
    return this.getBatch(id)!
  }

  getBatch(id: string): Batch | undefined {
    const r = this.db.get<{ id: string; name: string; mode: string; created_at: string; total: number; completed: number; failed: number }>(
      `SELECT b.*, (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id) AS total,
              (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id AND status = 'completed') AS completed,
              (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id AND status = 'failed') AS failed
       FROM batches b WHERE b.id = ?`,
      id
    )
    if (!r) return undefined
    return { id: r.id, name: r.name, mode: r.mode as JobMode, createdAt: r.created_at, total: r.total, completed: r.completed, failed: r.failed }
  }

  listBatches(): Batch[] {
    const rows = this.db.all<{ id: string; name: string; mode: string; created_at: string; total: number; completed: number; failed: number }>(
      `SELECT b.*, (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id) AS total,
              (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id AND status = 'completed') AS completed,
              (SELECT COUNT(*) FROM jobs WHERE batch_id = b.id AND status = 'failed') AS failed
       FROM batches b ORDER BY b.created_at DESC LIMIT 200`
    )
    return rows.map((r) => ({ id: r.id, name: r.name, mode: r.mode as JobMode, createdAt: r.created_at, total: r.total, completed: r.completed, failed: r.failed }))
  }

  create(input: NewJob, id = newId()): Job {
    const ts = nowIso()
    this.db.run(
      `INSERT INTO jobs (id, batch_id, project_id, channel_id, title, mode, status, stage, position, manual_research_notes, overrides_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.batchId,
      input.projectId,
      input.channelId,
      input.title,
      input.mode,
      input.status ?? 'pending',
      input.stage ?? 'research',
      input.position,
      input.manualResearchNotes ?? null,
      input.overrides ? JSON.stringify(input.overrides) : null,
      ts,
      ts
    )
    this.addEvent(id, 'created', null, input.status ?? 'pending', null)
    return this.get(id)!
  }

  get(id: string): Job | undefined {
    const r = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
    return r ? rowToJob(r) : undefined
  }

  getView(id: string): JobView | undefined {
    const r = this.db.get<JobRow>(`${VIEW_SELECT} WHERE j.id = ?`, id)
    return r ? rowToView(r) : undefined
  }

  list(filter: JobFilter = {}): JobView[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.batchId) {
      where.push('j.batch_id = ?')
      params.push(filter.batchId)
    }
    if (filter.channelId) {
      where.push('j.channel_id = ?')
      params.push(filter.channelId)
    }
    if (filter.status && filter.status.length) {
      where.push(`j.status IN (${filter.status.map(() => '?').join(',')})`)
      params.push(...filter.status)
    }
    if (filter.search) {
      where.push('(j.title LIKE ? OR c.name LIKE ?)')
      params.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const sql = `${VIEW_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY j.created_at DESC, j.position ASC LIMIT ? OFFSET ?`
    params.push(filter.limit ?? 500, filter.offset ?? 0)
    return this.db.all<JobRow>(sql, ...params).map(rowToView)
  }

  listByStatus(statuses: JobStatus[]): Job[] {
    if (!statuses.length) return []
    return this.db
      .all<JobRow>(`SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC, position ASC`, ...statuses)
      .map(rowToJob)
  }

  /** Jobs ready to run: pending (or scheduled) with no active lease. */
  nextRunnable(limit: number): Job[] {
    const now = nowIso()
    return this.db
      .all<JobRow>(
        `SELECT * FROM jobs WHERE status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         ORDER BY CASE stage WHEN 'save' THEN 0 WHEN 'audio' THEN 1 WHEN 'approval' THEN 1 WHEN 'script' THEN 2 ELSE 3 END ASC,
                  created_at ASC, position ASC LIMIT ?`,
        now,
        now,
        limit
      )
      .map(rowToJob)
  }

  /** Atomically claim a job for a worker. Returns false if another worker already owns it. */
  claim(id: string, owner: string, leaseMs: number): boolean {
    const now = nowIso()
    const exp = new Date(Date.now() + leaseMs).toISOString()
    const res = this.db.run(
      `UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      owner,
      exp,
      now,
      id,
      now
    )
    return Number(res.changes) === 1
  }

  heartbeat(id: string, owner: string, leaseMs: number): void {
    const exp = new Date(Date.now() + leaseMs).toISOString()
    this.db.run('UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?', exp, id, owner)
  }

  release(id: string): void {
    this.db.run('UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?', id)
  }

  releaseAll(): void {
    this.db.run('UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL')
  }

  setStatus(id: string, status: JobStatus, extra: Partial<{ stage: JobStage; event: string; detail: string | null; resumeStatus: JobStatus | null }> = {}): Job {
    const current = this.get(id)
    if (!current) throw new Error(`Job not found: ${id}`)
    const ts = nowIso()
    const stage = extra.stage ?? current.stage
    const startedAt = current.startedAt ?? (status === 'pending' ? null : ts)
    const completedAt = status === 'completed' || status === 'failed' || status === 'cancelled' ? ts : null
    this.db.run(
      `UPDATE jobs SET status = ?, stage = ?, updated_at = ?, started_at = ?, completed_at = ?, resume_status = ? WHERE id = ?`,
      status,
      stage,
      ts,
      startedAt,
      completedAt,
      extra.resumeStatus === undefined ? current.resumeStatus : extra.resumeStatus,
      id
    )
    if (current.status !== status || extra.event) {
      this.addEvent(id, extra.event ?? 'status', current.status, status, extra.detail ?? null)
    }
    return this.get(id)!
  }

  update(
    id: string,
    patch: Partial<{
      researchId: string | null
      scriptId: string | null
      audioId: string | null
      lastError: JobError | null
      nextRunAt: string | null
      manualResearchNotes: string | null
      overrides: JobOverrides | null
      researchAttempts: number
      scriptAttempts: number
      audioAttempts: number
      stage: JobStage
      title: string
    }>
  ): Job {
    const current = this.get(id)
    if (!current) throw new Error(`Job not found: ${id}`)
    const m = { ...current, ...patch }
    this.db.run(
      `UPDATE jobs SET research_id=?, script_id=?, audio_id=?, last_error_json=?, next_run_at=?, manual_research_notes=?, overrides_json=?,
        research_attempts=?, script_attempts=?, audio_attempts=?, stage=?, title=?, updated_at=? WHERE id=?`,
      m.researchId,
      m.scriptId,
      m.audioId,
      m.lastError ? JSON.stringify(m.lastError) : null,
      m.nextRunAt,
      m.manualResearchNotes,
      m.overrides ? JSON.stringify(m.overrides) : null,
      m.researchAttempts,
      m.scriptAttempts,
      m.audioAttempts,
      m.stage,
      m.title,
      nowIso(),
      id
    )
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.run('DELETE FROM jobs WHERE id = ?', id)
  }

  reorder(ids: string[]): void {
    this.db.transaction(() => ids.forEach((id, i) => this.db.run('UPDATE jobs SET position = ? WHERE id = ?', i, id)))
  }

  stats(queuePaused: boolean, spendingPaused: boolean, estimatedSecondsRemaining: number | null): QueueStats {
    const rows = this.db.all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status')
    const by: Record<string, number> = {}
    for (const r of rows) by[r.status] = r.c
    const sum = (list: string[]): number => list.reduce((a, s) => a + (by[s] ?? 0), 0)
    return {
      total: sum(Object.keys(by)),
      pending: by.pending ?? 0,
      processing: sum(ACTIVE_STATUSES),
      awaitingUser: sum([...USER_WAIT_STATUSES, 'script_ready']),
      completed: by.completed ?? 0,
      failed: by.failed ?? 0,
      paused: by.paused ?? 0,
      cancelled: by.cancelled ?? 0,
      queuePaused,
      spendingPaused,
      estimatedSecondsRemaining,
      progressPercent: 0
    }
  }

  /** Jobs that still have automatic work to do (used for progress + ETA), plus their finished batch siblings. */
  listForProgress(): Array<Pick<Job, 'id' | 'batchId' | 'status' | 'stage' | 'mode'>> {
    return this.db
      .all<{ id: string; batch_id: string; status: string; stage: string; mode: string }>(
        `SELECT id, batch_id, status, stage, mode FROM jobs WHERE batch_id IN (
           SELECT DISTINCT batch_id FROM jobs WHERE status NOT IN ('completed', 'failed', 'cancelled'))`
      )
      .map((r) => ({ id: r.id, batchId: r.batch_id, status: r.status as JobStatus, stage: r.stage as JobStage, mode: r.mode as JobMode }))
  }

  /**
   * Observed seconds spent in each active status, taken from the job history
   * (time between entering the status and the next status change). Newest 200
   * samples per status; the caller computes medians.
   */
  stageDurationSamples(): Record<string, number[]> {
    const rows = this.db.all<{ status: string; secs: number }>(
      `SELECT to_status AS status, (julianday(next_at) - julianday(at)) * 86400 AS secs FROM (
         SELECT job_id, to_status, at, LEAD(at) OVER (PARTITION BY job_id ORDER BY id) AS next_at
         FROM job_events WHERE to_status IS NOT NULL
       ) WHERE next_at IS NOT NULL AND to_status IN ('researching', 'writing_script', 'validating_script', 'generating_audio', 'saving_files')
       ORDER BY at DESC LIMIT 1000`
    )
    const out: Record<string, number[]> = {}
    for (const r of rows) {
      if (!(r.secs > 0) || r.secs > 3600) continue
      const list = (out[r.status] ??= [])
      if (list.length < 200) list.push(r.secs)
    }
    return out
  }

  /** Per-stage timing of one job, derived from its status history (v1.5). */
  timings(jobId: string): JobTimings {
    const events = this.db.all<{ to_status: string | null; event: string; detail: string | null; at: string }>(
      'SELECT to_status, event, detail, at FROM job_events WHERE job_id = ? ORDER BY id ASC',
      jobId
    )
    return buildTimings(jobId, events)
  }

  /** Median stage durations of the most recent finished jobs (optionally one batch). */
  timingSummary(opts: { batchId?: string; limit?: number } = {}): TimingSummary {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50))
    const ids = opts.batchId
      ? this.db.all<{ id: string }>(`SELECT id FROM jobs WHERE batch_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT ?`, opts.batchId, limit)
      : this.db.all<{ id: string }>(`SELECT id FROM jobs WHERE status = 'completed' ORDER BY updated_at DESC LIMIT ?`, limit)
    const per: Record<TimingStage, number[]> = { research: [], script: [], validate: [], audio: [], save: [], waiting: [] }
    const totals: number[] = []
    for (const { id } of ids) {
      const t = this.timings(id)
      for (const k of TIMING_STAGES) per[k].push(t.totals[k])
      totals.push(t.totalSeconds)
    }
    const median = (list: number[]): number => {
      if (!list.length) return 0
      const sorted = [...list].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
    }
    const medians = Object.fromEntries(TIMING_STAGES.map((k) => [k, Math.round(median(per[k]) * 10) / 10])) as Record<TimingStage, number>
    const work = TIMING_STAGES.reduce((n, k) => n + medians[k], 0)
    const share = Object.fromEntries(TIMING_STAGES.map((k) => [k, work > 0 ? medians[k] / work : 0])) as Record<TimingStage, number>
    return { samples: ids.length, medians, share, medianTotalSeconds: Math.round(median(totals) * 10) / 10 }
  }

  countForProject(projectId: string, statuses?: JobStatus[]): number {
    if (statuses?.length) {
      return (
        this.db.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM jobs WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(',')})`,
          projectId,
          ...statuses
        )?.c ?? 0
      )
    }
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM jobs WHERE project_id = ?', projectId)?.c ?? 0
  }

  addEvent(jobId: string, event: string, from: JobStatus | null, to: JobStatus | null, detail: string | null): void {
    this.db.run('INSERT INTO job_events (job_id, event, from_status, to_status, detail, at) VALUES (?, ?, ?, ?, ?, ?)', jobId, event, from, to, detail, nowIso())
  }

  listEvents(opts: { limit?: number; jobId?: string; search?: string } = {}): JobEvent[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (opts.jobId) {
      where.push('e.job_id = ?')
      params.push(opts.jobId)
    }
    if (opts.search) {
      where.push('(j.title LIKE ? OR e.event LIKE ? OR e.detail LIKE ?)')
      params.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`)
    }
    params.push(opts.limit ?? 300)
    const rows = this.db.all<{
      id: number
      job_id: string
      title: string | null
      channel_name: string | null
      event: string
      from_status: string | null
      to_status: string | null
      detail: string | null
      at: string
    }>(
      `SELECT e.*, j.title AS title, c.name AS channel_name FROM job_events e
       LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN channels c ON c.id = j.channel_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ?`,
      ...params
    )
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      title: r.title ?? '(removed job)',
      channelName: r.channel_name ?? '',
      event: r.event,
      fromStatus: (r.from_status as JobStatus | null) ?? null,
      toStatus: (r.to_status as JobStatus | null) ?? null,
      detail: r.detail,
      at: r.at
    }))
  }

  /** Average wall-clock seconds of completed jobs (for ETA). */
  averageCompletionSeconds(): number | null {
    const r = this.db.get<{ avg: number | null }>(
      `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) AS avg FROM jobs
       WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL`
    )
    return r?.avg ?? null
  }
}


const TIMING_STAGES: TimingStage[] = ['research', 'script', 'validate', 'audio', 'save', 'waiting']

const STATUS_TO_TIMING: Partial<Record<string, TimingStage>> = {
  researching: 'research',
  writing_script: 'script',
  validating_script: 'validate',
  generating_audio: 'audio',
  saving_files: 'save',
  pending: 'waiting',
  script_ready: 'waiting'
}

/**
 * Turns a job's status events into stage segments. Each status lasts until the next status
 * event; time spent waiting for the user (approval, research choice) or paused is excluded,
 * and the clock stops at completed/failed/cancelled.
 */
export function buildTimings(jobId: string, events: Array<{ to_status: string | null; event: string; detail: string | null; at: string }>): JobTimings {
  const segments: StageTiming[] = []
  const transitions = events.filter((e) => e.to_status)
  for (let i = 0; i < transitions.length; i++) {
    const cur = transitions[i]!
    const stage = STATUS_TO_TIMING[cur.to_status!]
    if (!stage) continue
    const next = transitions[i + 1]
    if (!next) break // still running: not counted until it ends
    const seconds = (new Date(next.at).getTime() - new Date(cur.at).getTime()) / 1000
    if (!(seconds >= 0) || seconds > 6 * 3600) continue
    const last = segments[segments.length - 1]
    if (last && last.stage === stage && last.endedAt === cur.at) {
      last.endedAt = next.at
      last.seconds = Math.round((last.seconds + seconds) * 10) / 10
    } else {
      segments.push({ stage, startedAt: cur.at, endedAt: next.at, seconds: Math.round(seconds * 10) / 10, detail: cur.detail })
    }
  }
  // Leading "waiting" before anything started (queued behind other titles) is real waiting too, keep it.
  const totals = Object.fromEntries(TIMING_STAGES.map((k) => [k, 0])) as Record<TimingStage, number>
  for (const seg of segments) totals[seg.stage] = Math.round((totals[seg.stage] + seg.seconds) * 10) / 10
  const totalSeconds = Math.round(segments.reduce((n, x) => n + x.seconds, 0) * 10) / 10
  return { jobId, segments, totals, totalSeconds }
}
