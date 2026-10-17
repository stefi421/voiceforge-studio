import type {
  AudioFile,
  AudioStatus,
  AudioView,
  JobStatus,
  Project,
  ProjectView,
  ResearchMode,
  ResearchResult,
  Script,
  ScriptStatus,
  ScriptView,
  ValidationReport,
  VoiceSettings
} from '@shared/types'
import type { Database } from '../database'
import { newId, nowIso, parseJson, toBool } from '../../util/common'

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string
  channel_id: string
  title: string
  title_normalized: string
  folder_name: string
  folder_path: string | null
  archived: number
  created_at: string
  updated_at: string
  channel_name?: string
  channel_color?: string
  channel_icon?: string
  script_count?: number
  audio_count?: number
  latest_job_status?: string | null
  latest_audio_path?: string | null
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    channelId: r.channel_id,
    title: r.title,
    folderName: r.folder_name,
    folderPath: r.folder_path,
    archived: toBool(r.archived),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const PROJECT_VIEW = `
SELECT p.*, c.name AS channel_name, c.color AS channel_color, c.icon AS channel_icon,
  (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id) AS script_count,
  (SELECT COUNT(*) FROM audio_files a WHERE a.project_id = p.id AND a.status = 'ready') AS audio_count,
  (SELECT status FROM jobs j WHERE j.project_id = p.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_status,
  (SELECT file_path FROM audio_files a WHERE a.project_id = p.id AND a.status = 'ready' ORDER BY a.version DESC LIMIT 1) AS latest_audio_path
FROM projects p JOIN channels c ON c.id = p.channel_id`

function rowToProjectView(r: ProjectRow): ProjectView {
  return {
    ...rowToProject(r),
    channelName: r.channel_name ?? '',
    channelColor: r.channel_color ?? '#7C5CFF',
    channelIcon: r.channel_icon ?? '',
    scriptCount: r.script_count ?? 0,
    audioCount: r.audio_count ?? 0,
    latestJobStatus: (r.latest_job_status as JobStatus | null) ?? null,
    latestAudioPath: r.latest_audio_path ?? null
  }
}

export interface LibraryFilter {
  channelId?: string
  projectId?: string
  search?: string
  status?: string
  sort?: string
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
  includeArchived?: boolean
}

export class ProjectRepo {
  constructor(private db: Database) {}

  create(input: { channelId: string; title: string; titleNormalized: string; folderName: string; folderPath: string | null }, id = newId()): Project {
    const ts = nowIso()
    this.db.run(
      'INSERT INTO projects (id, channel_id, title, title_normalized, folder_name, folder_path, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      id,
      input.channelId,
      input.title,
      input.titleNormalized,
      input.folderName,
      input.folderPath,
      ts,
      ts
    )
    return this.get(id)!
  }

  get(id: string): Project | undefined {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    return r ? rowToProject(r) : undefined
  }

  getView(id: string): ProjectView | undefined {
    const r = this.db.get<ProjectRow>(`${PROJECT_VIEW} WHERE p.id = ?`, id)
    return r ? rowToProjectView(r) : undefined
  }

  findByTitle(channelId: string, titleNormalized: string): Project | undefined {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE channel_id = ? AND title_normalized = ? ORDER BY created_at ASC LIMIT 1', channelId, titleNormalized)
    return r ? rowToProject(r) : undefined
  }

  folderNameExists(channelId: string, folderName: string): boolean {
    return !!this.db.get('SELECT id FROM projects WHERE channel_id = ? AND lower(folder_name) = lower(?)', channelId, folderName)
  }

  list(filter: LibraryFilter = {}): ProjectView[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (!filter.includeArchived) where.push('p.archived = 0')
    if (filter.channelId) {
      where.push('p.channel_id = ?')
      params.push(filter.channelId)
    }
    if (filter.search) {
      where.push('p.title LIKE ?')
      params.push(`%${filter.search}%`)
    }
    params.push(filter.limit ?? 1000, filter.offset ?? 0)
    return this.db
      .all<ProjectRow>(`${PROJECT_VIEW} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, ...params)
      .map(rowToProjectView)
  }

  listByChannel(channelId: string): Project[] {
    return this.db.all<ProjectRow>('SELECT * FROM projects WHERE channel_id = ?', channelId).map(rowToProject)
  }

  update(id: string, patch: Partial<{ title: string; titleNormalized: string; folderName: string; folderPath: string | null; archived: boolean }>): Project {
    const cur = this.get(id)
    if (!cur) throw new Error(`Project not found: ${id}`)
    this.db.run(
      'UPDATE projects SET title = ?, title_normalized = ?, folder_name = ?, folder_path = ?, archived = ?, updated_at = ? WHERE id = ?',
      patch.title ?? cur.title,
      patch.titleNormalized ?? (this.db.get<ProjectRow>('SELECT title_normalized FROM projects WHERE id = ?', id)?.title_normalized ?? ''),
      patch.folderName ?? cur.folderName,
      patch.folderPath === undefined ? cur.folderPath : patch.folderPath,
      (patch.archived ?? cur.archived) ? 1 : 0,
      nowIso(),
      id
    )
    return this.get(id)!
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id)
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM jobs WHERE project_id = ?', id)
      this.db.run('DELETE FROM audio_files WHERE project_id = ?', id)
      this.db.run('DELETE FROM scripts WHERE project_id = ?', id)
      this.db.run('DELETE FROM research_results WHERE project_id = ?', id)
      this.db.run('DELETE FROM projects WHERE id = ?', id)
    })
  }

  recent(limit: number): ProjectView[] {
    return this.db.all<ProjectRow>(`${PROJECT_VIEW} WHERE p.archived = 0 ORDER BY p.updated_at DESC LIMIT ?`, limit).map(rowToProjectView)
  }
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

interface ResearchRow {
  id: string
  job_id: string
  project_id: string
  status: string
  data_json: string
  sources_json: string
  model: string | null
  mode: string
  created_at: string
}

function rowToResearch(r: ResearchRow): ResearchResult {
  return {
    id: r.id,
    jobId: r.job_id,
    projectId: r.project_id,
    status: r.status as ResearchResult['status'],
    data: parseJson(r.data_json, {} as ResearchResult['data']),
    sources: parseJson(r.sources_json, []),
    model: r.model,
    mode: r.mode as ResearchMode,
    createdAt: r.created_at
  }
}

export class ResearchRepo {
  constructor(private db: Database) {}

  create(input: Omit<ResearchResult, 'id' | 'createdAt'>, id = newId()): ResearchResult {
    this.db.run(
      'INSERT INTO research_results (id, job_id, project_id, status, data_json, sources_json, model, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.jobId,
      input.projectId,
      input.status,
      JSON.stringify(input.data),
      JSON.stringify(input.sources),
      input.model,
      input.mode,
      nowIso()
    )
    return this.get(id)!
  }

  get(id: string): ResearchResult | undefined {
    const r = this.db.get<ResearchRow>('SELECT * FROM research_results WHERE id = ?', id)
    return r ? rowToResearch(r) : undefined
  }

  latestForJob(jobId: string): ResearchResult | undefined {
    const r = this.db.get<ResearchRow>('SELECT * FROM research_results WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', jobId)
    return r ? rowToResearch(r) : undefined
  }

  latestConfirmedForProject(projectId: string): ResearchResult | undefined {
    const r = this.db.get<ResearchRow>(
      "SELECT * FROM research_results WHERE project_id = ? AND status IN ('confirmed','manual') ORDER BY created_at DESC LIMIT 1",
      projectId
    )
    return r ? rowToResearch(r) : undefined
  }

  cacheGet(cacheKey: string, maxAgeMs: number): ResearchResult | undefined {
    const row = this.db.get<{ research_id: string; created_at: string }>('SELECT research_id, created_at FROM research_cache WHERE cache_key = ?', cacheKey)
    if (!row) return undefined
    if (Date.now() - new Date(row.created_at).getTime() > maxAgeMs) return undefined
    return this.get(row.research_id)
  }

  cacheSet(cacheKey: string, researchId: string): void {
    this.db.run('INSERT OR REPLACE INTO research_cache (cache_key, research_id, created_at) VALUES (?, ?, ?)', cacheKey, researchId, nowIso())
  }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

interface ScriptRow {
  id: string
  project_id: string
  job_id: string | null
  version: number
  template_version_id: string | null
  template_version_number: number | null
  text: string
  char_count: number
  word_count: number
  estimated_duration_sec: number
  status: string
  source: string
  model: string | null
  validation_json: string | null
  file_path: string | null
  created_at: string
  title?: string
  channel_id?: string
  channel_name?: string
  channel_color?: string
}

function rowToScript(r: ScriptRow): Script {
  return {
    id: r.id,
    projectId: r.project_id,
    jobId: r.job_id,
    version: r.version,
    templateVersionId: r.template_version_id,
    templateVersionNumber: r.template_version_number,
    text: r.text,
    charCount: r.char_count,
    wordCount: r.word_count,
    estimatedDurationSec: r.estimated_duration_sec,
    status: r.status as ScriptStatus,
    source: r.source as Script['source'],
    model: r.model,
    validation: parseJson<ValidationReport | null>(r.validation_json, null),
    filePath: r.file_path,
    createdAt: r.created_at
  }
}

function rowToScriptView(r: ScriptRow): ScriptView {
  return { ...rowToScript(r), title: r.title ?? '', channelId: r.channel_id ?? '', channelName: r.channel_name ?? '', channelColor: r.channel_color ?? '#7C5CFF' }
}

const SCRIPT_VIEW = `SELECT s.*, p.title AS title, p.channel_id AS channel_id, c.name AS channel_name, c.color AS channel_color
  FROM scripts s JOIN projects p ON p.id = s.project_id JOIN channels c ON c.id = p.channel_id`

const SCRIPT_SORTS: Record<string, string> = {
  created: 's.created_at',
  title: 'p.title',
  channel: 'c.name',
  chars: 's.char_count',
  words: 's.word_count',
  duration: 's.estimated_duration_sec',
  status: 's.status',
  version: 's.version'
}

export class ScriptRepo {
  constructor(private db: Database) {}

  create(
    input: Omit<Script, 'id' | 'version' | 'createdAt' | 'charCount' | 'wordCount'> & { charCount: number; wordCount: number },
    id = newId()
  ): Script {
    return this.db.transaction(() => {
      const next = (this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM scripts WHERE project_id = ?', input.projectId)?.m ?? 0) + 1
      this.db.run(
        `INSERT INTO scripts (id, project_id, job_id, version, template_version_id, template_version_number, text, char_count, word_count,
          estimated_duration_sec, status, source, model, validation_json, file_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.jobId,
        next,
        input.templateVersionId,
        input.templateVersionNumber,
        input.text,
        input.charCount,
        input.wordCount,
        input.estimatedDurationSec,
        input.status,
        input.source,
        input.model,
        input.validation ? JSON.stringify(input.validation) : null,
        input.filePath,
        nowIso()
      )
      this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), input.projectId)
      return this.get(id)!
    })
  }

  get(id: string): Script | undefined {
    const r = this.db.get<ScriptRow>('SELECT * FROM scripts WHERE id = ?', id)
    return r ? rowToScript(r) : undefined
  }

  getView(id: string): ScriptView | undefined {
    const r = this.db.get<ScriptRow>(`${SCRIPT_VIEW} WHERE s.id = ?`, id)
    return r ? rowToScriptView(r) : undefined
  }

  versions(projectId: string): Script[] {
    return this.db.all<ScriptRow>('SELECT * FROM scripts WHERE project_id = ? ORDER BY version DESC', projectId).map(rowToScript)
  }

  latestForProject(projectId: string): Script | undefined {
    const r = this.db.get<ScriptRow>('SELECT * FROM scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1', projectId)
    return r ? rowToScript(r) : undefined
  }

  list(filter: LibraryFilter = {}): ScriptView[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.channelId) {
      where.push('p.channel_id = ?')
      params.push(filter.channelId)
    }
    if (filter.projectId) {
      where.push('s.project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.status) {
      where.push('s.status = ?')
      params.push(filter.status)
    }
    if (filter.search) {
      where.push('(p.title LIKE ? OR s.text LIKE ?)')
      params.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const sort = SCRIPT_SORTS[filter.sort ?? 'created'] ?? 's.created_at'
    const dir = filter.dir === 'asc' ? 'ASC' : 'DESC'
    params.push(filter.limit ?? 1000, filter.offset ?? 0)
    return this.db
      .all<ScriptRow>(`${SCRIPT_VIEW} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, ...params)
      .map(rowToScriptView)
  }

  count(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM scripts')?.c ?? 0
  }

  update(id: string, patch: Partial<{ status: ScriptStatus; validation: ValidationReport | null; filePath: string | null; text: string }>): Script {
    const cur = this.get(id)
    if (!cur) throw new Error(`Script not found: ${id}`)
    const m = { ...cur, ...patch }
    this.db.run(
      'UPDATE scripts SET status = ?, validation_json = ?, file_path = ?, text = ? WHERE id = ?',
      m.status,
      m.validation ? JSON.stringify(m.validation) : null,
      m.filePath,
      m.text,
      id
    )
    return this.get(id)!
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

interface AudioRow {
  id: string
  project_id: string
  script_id: string
  job_id: string | null
  version: number
  file_path: string
  voice_id: string
  voice_name: string
  model_id: string
  voice_settings_json: string
  output_format: string
  bytes: number
  duration_sec: number | null
  sha256: string | null
  characters: number
  chunk_count: number
  status: string
  created_at: string
  title?: string
  channel_id?: string
  channel_name?: string
  channel_color?: string
}

function rowToAudio(r: AudioRow): AudioFile {
  return {
    id: r.id,
    projectId: r.project_id,
    scriptId: r.script_id,
    jobId: r.job_id,
    version: r.version,
    filePath: r.file_path,
    voiceId: r.voice_id,
    voiceName: r.voice_name,
    modelId: r.model_id,
    voiceSettings: parseJson<VoiceSettings>(r.voice_settings_json, {}),
    outputFormat: r.output_format,
    bytes: r.bytes,
    durationSec: r.duration_sec,
    sha256: r.sha256,
    characters: r.characters,
    chunkCount: r.chunk_count,
    status: r.status as AudioStatus,
    createdAt: r.created_at
  }
}

function rowToAudioView(r: AudioRow): AudioView {
  return { ...rowToAudio(r), title: r.title ?? '', channelId: r.channel_id ?? '', channelName: r.channel_name ?? '', channelColor: r.channel_color ?? '#7C5CFF' }
}

const AUDIO_VIEW = `SELECT a.*, p.title AS title, p.channel_id AS channel_id, c.name AS channel_name, c.color AS channel_color
  FROM audio_files a JOIN projects p ON p.id = a.project_id JOIN channels c ON c.id = p.channel_id`

const AUDIO_SORTS: Record<string, string> = {
  created: 'a.created_at',
  title: 'p.title',
  channel: 'c.name',
  voice: 'a.voice_name',
  model: 'a.model_id',
  duration: 'a.duration_sec',
  size: 'a.bytes',
  version: 'a.version'
}

export class AudioRepo {
  constructor(private db: Database) {}

  create(input: Omit<AudioFile, 'id' | 'version' | 'createdAt'>, id = newId()): AudioFile {
    return this.db.transaction(() => {
      const next = (this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM audio_files WHERE project_id = ?', input.projectId)?.m ?? 0) + 1
      this.db.run(
        `INSERT INTO audio_files (id, project_id, script_id, job_id, version, file_path, voice_id, voice_name, model_id, voice_settings_json,
          output_format, bytes, duration_sec, sha256, characters, chunk_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.scriptId,
        input.jobId,
        next,
        input.filePath,
        input.voiceId,
        input.voiceName,
        input.modelId,
        JSON.stringify(input.voiceSettings),
        input.outputFormat,
        input.bytes,
        input.durationSec,
        input.sha256,
        input.characters,
        input.chunkCount,
        input.status,
        nowIso()
      )
      this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), input.projectId)
      return this.get(id)!
    })
  }

  get(id: string): AudioFile | undefined {
    const r = this.db.get<AudioRow>('SELECT * FROM audio_files WHERE id = ?', id)
    return r ? rowToAudio(r) : undefined
  }

  getView(id: string): AudioView | undefined {
    const r = this.db.get<AudioRow>(`${AUDIO_VIEW} WHERE a.id = ?`, id)
    return r ? rowToAudioView(r) : undefined
  }

  versions(projectId: string): AudioView[] {
    return this.db.all<AudioRow>(`${AUDIO_VIEW} WHERE a.project_id = ? ORDER BY a.version DESC`, projectId).map(rowToAudioView)
  }

  nextVersion(projectId: string): number {
    return (this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM audio_files WHERE project_id = ?', projectId)?.m ?? 0) + 1
  }

  list(filter: LibraryFilter = {}): AudioView[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.channelId) {
      where.push('p.channel_id = ?')
      params.push(filter.channelId)
    }
    if (filter.projectId) {
      where.push('a.project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.status) {
      where.push('a.status = ?')
      params.push(filter.status)
    }
    if (filter.search) {
      where.push('(p.title LIKE ? OR a.voice_name LIKE ?)')
      params.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const sort = AUDIO_SORTS[filter.sort ?? 'created'] ?? 'a.created_at'
    const dir = filter.dir === 'asc' ? 'ASC' : 'DESC'
    params.push(filter.limit ?? 1000, filter.offset ?? 0)
    return this.db
      .all<AudioRow>(`${AUDIO_VIEW} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, ...params)
      .map(rowToAudioView)
  }

  countReady(): number {
    return this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM audio_files WHERE status = 'ready'")?.c ?? 0
  }

  recent(limit: number): AudioView[] {
    return this.db.all<AudioRow>(`${AUDIO_VIEW} WHERE a.status = 'ready' ORDER BY a.created_at DESC LIMIT ?`, limit).map(rowToAudioView)
  }

  update(id: string, patch: Partial<Pick<AudioFile, 'status' | 'bytes' | 'durationSec' | 'sha256' | 'filePath' | 'chunkCount'>>): AudioFile {
    const cur = this.get(id)
    if (!cur) throw new Error(`Audio not found: ${id}`)
    const m = { ...cur, ...patch }
    this.db.run(
      'UPDATE audio_files SET status = ?, bytes = ?, duration_sec = ?, sha256 = ?, file_path = ?, chunk_count = ? WHERE id = ?',
      m.status,
      m.bytes,
      m.durationSec,
      m.sha256,
      m.filePath,
      m.chunkCount,
      id
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM audio_files WHERE id = ?', id)
  }
}
