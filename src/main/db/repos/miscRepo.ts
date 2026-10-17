import type { BackupInfo, UsageEvent, UsageSummary } from '@shared/types'
import type { Database } from '../database'
import { newId, nowIso, parseJson } from '../../util/common'

export class SettingsRepo {
  constructor(private db: Database) {}

  get<T>(key: string): T | undefined {
    const r = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key)
    return r ? parseJson<T | undefined>(r.value_json, undefined) : undefined
  }

  set(key: string, value: unknown): void {
    this.db.run('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(value), nowIso())
  }

  delete(key: string): void {
    this.db.run('DELETE FROM settings WHERE key = ?', key)
  }
}

export class ProviderCacheRepo {
  constructor(private db: Database) {}

  get<T>(key: string, maxAgeMs: number): T | undefined {
    const r = this.db.get<{ value_json: string; updated_at: string }>('SELECT value_json, updated_at FROM provider_cache WHERE key = ?', key)
    if (!r) return undefined
    if (Date.now() - new Date(r.updated_at).getTime() > maxAgeMs) return undefined
    return parseJson<T | undefined>(r.value_json, undefined)
  }

  set(key: string, value: unknown): void {
    this.db.run('INSERT OR REPLACE INTO provider_cache (key, value_json, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(value), nowIso())
  }

  listFavoriteVoices(): Set<string> {
    return new Set(this.db.all<{ voice_id: string }>('SELECT voice_id FROM favorite_voices').map((r) => r.voice_id))
  }

  toggleFavoriteVoice(voiceId: string): boolean {
    const exists = this.db.get('SELECT voice_id FROM favorite_voices WHERE voice_id = ?', voiceId)
    if (exists) {
      this.db.run('DELETE FROM favorite_voices WHERE voice_id = ?', voiceId)
      return false
    }
    this.db.run('INSERT INTO favorite_voices (voice_id, created_at) VALUES (?, ?)', voiceId, nowIso())
    return true
  }
}

interface UsageRow {
  id: string
  provider: string
  kind: string
  model: string | null
  job_id: string | null
  channel_id: string | null
  project_id: string | null
  input_tokens: number
  output_tokens: number
  characters: number
  estimated_cost: number
  reported_json: string | null
  created_at: string
}

export class UsageRepo {
  constructor(private db: Database) {}

  record(e: Omit<UsageEvent, 'id' | 'createdAt'>): UsageEvent {
    const id = newId()
    const ts = nowIso()
    this.db.run(
      `INSERT INTO usage_events (id, provider, kind, model, job_id, channel_id, project_id, input_tokens, output_tokens, characters, estimated_cost, reported_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      e.provider,
      e.kind,
      e.model,
      e.jobId,
      e.channelId,
      e.projectId,
      e.inputTokens,
      e.outputTokens,
      e.characters,
      e.estimatedCost,
      e.reported ? JSON.stringify(e.reported) : null,
      ts
    )
    return { ...e, id, createdAt: ts }
  }

  spendSince(fromIso: string): number {
    return this.db.get<{ s: number | null }>('SELECT SUM(estimated_cost) AS s FROM usage_events WHERE created_at >= ?', fromIso)?.s ?? 0
  }

  summary(fromIso: string, toIso: string): UsageSummary {
    const base = 'FROM usage_events u WHERE u.created_at >= ? AND u.created_at <= ?'
    const oa = this.db.get<{ n: number; i: number | null; o: number | null; c: number | null }>(
      `SELECT COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(estimated_cost) AS c ${base} AND provider = 'openai'`,
      fromIso,
      toIso
    )
    const el = this.db.get<{ n: number; ch: number | null; c: number | null }>(
      `SELECT COUNT(*) AS n, SUM(characters) AS ch, SUM(estimated_cost) AS c ${base} AND provider = 'elevenlabs'`,
      fromIso,
      toIso
    )
    const byChannel = this.db.all<{ channel_id: string; channel_name: string | null; jobs: number; oc: number | null; ec: number | null }>(
      `SELECT u.channel_id, c.name AS channel_name, COUNT(DISTINCT u.job_id) AS jobs,
        SUM(CASE WHEN u.provider = 'openai' THEN u.estimated_cost ELSE 0 END) AS oc,
        SUM(CASE WHEN u.provider = 'elevenlabs' THEN u.estimated_cost ELSE 0 END) AS ec
       FROM usage_events u LEFT JOIN channels c ON c.id = u.channel_id
       WHERE u.created_at >= ? AND u.created_at <= ? AND u.channel_id IS NOT NULL
       GROUP BY u.channel_id ORDER BY (oc + ec) DESC`,
      fromIso,
      toIso
    )
    const byProject = this.db.all<{ project_id: string; title: string | null; channel_name: string | null; oc: number | null; ec: number | null }>(
      `SELECT u.project_id, p.title AS title, c.name AS channel_name,
        SUM(CASE WHEN u.provider = 'openai' THEN u.estimated_cost ELSE 0 END) AS oc,
        SUM(CASE WHEN u.provider = 'elevenlabs' THEN u.estimated_cost ELSE 0 END) AS ec
       FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN channels c ON c.id = p.channel_id
       WHERE u.created_at >= ? AND u.created_at <= ? AND u.project_id IS NOT NULL GROUP BY u.project_id ORDER BY (oc + ec) DESC LIMIT 100`,
      fromIso,
      toIso
    )
    const daily = this.db.all<{ day: string; oc: number | null; ec: number | null; n: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
        SUM(CASE WHEN provider = 'openai' THEN estimated_cost ELSE 0 END) AS oc,
        SUM(CASE WHEN provider = 'elevenlabs' THEN estimated_cost ELSE 0 END) AS ec, COUNT(*) AS n
       ${base} GROUP BY day ORDER BY day ASC`,
      fromIso,
      toIso
    )
    const monthly = this.db.all<{ month: string; oc: number | null; ec: number | null; n: number }>(
      `SELECT substr(created_at, 1, 7) AS month,
        SUM(CASE WHEN provider = 'openai' THEN estimated_cost ELSE 0 END) AS oc,
        SUM(CASE WHEN provider = 'elevenlabs' THEN estimated_cost ELSE 0 END) AS ec, COUNT(*) AS n
       FROM usage_events GROUP BY month ORDER BY month DESC LIMIT 24`
    )
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(startOfDay)
    startOfMonth.setDate(1)
    return {
      range: { from: fromIso, to: toIso },
      openai: { requests: oa?.n ?? 0, inputTokens: oa?.i ?? 0, outputTokens: oa?.o ?? 0, estimatedCost: oa?.c ?? 0 },
      elevenlabs: { requests: el?.n ?? 0, characters: el?.ch ?? 0, estimatedCost: el?.c ?? 0 },
      byChannel: byChannel.map((r) => ({ channelId: r.channel_id, channelName: r.channel_name ?? '(deleted channel)', jobs: r.jobs, openaiCost: r.oc ?? 0, elevenCost: r.ec ?? 0 })),
      byProject: byProject.map((r) => ({ projectId: r.project_id, title: r.title ?? '(deleted project)', channelName: r.channel_name ?? '', openaiCost: r.oc ?? 0, elevenCost: r.ec ?? 0 })),
      daily: daily.map((r) => ({ day: r.day, openaiCost: r.oc ?? 0, elevenCost: r.ec ?? 0, requests: r.n })),
      monthly: monthly.map((r) => ({ month: r.month, openaiCost: r.oc ?? 0, elevenCost: r.ec ?? 0, requests: r.n })),
      todaySpend: this.spendSince(startOfDay.toISOString()),
      monthSpend: this.spendSince(startOfMonth.toISOString()),
      estimatesLabel:
        'All costs are local estimates computed from the pricing table in Settings. Provider-reported token and character counts are stored when the API returns them; dollar amounts are never provider-reported.'
    }
  }

  list(limit = 500): UsageEvent[] {
    return this.db.all<UsageRow>('SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      provider: r.provider as UsageEvent['provider'],
      kind: r.kind,
      model: r.model,
      jobId: r.job_id,
      channelId: r.channel_id,
      projectId: r.project_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      characters: r.characters,
      estimatedCost: r.estimated_cost,
      reported: parseJson<Record<string, unknown> | null>(r.reported_json, null),
      createdAt: r.created_at
    }))
  }
}

export class BackupRepo {
  constructor(private db: Database) {}

  record(info: BackupInfo): void {
    this.db.run('INSERT OR REPLACE INTO backups (path, created_at, bytes, sha256, app_version) VALUES (?, ?, ?, ?, ?)', info.path, info.createdAt, info.bytes, info.sha256, info.appVersion)
  }

  list(): BackupInfo[] {
    return this.db
      .all<{ path: string; created_at: string; bytes: number; sha256: string; app_version: string }>('SELECT * FROM backups ORDER BY created_at DESC')
      .map((r) => ({ path: r.path, createdAt: r.created_at, bytes: r.bytes, sha256: r.sha256, appVersion: r.app_version }))
  }

  remove(path: string): void {
    this.db.run('DELETE FROM backups WHERE path = ?', path)
  }
}
