import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BackupInfo, ChannelInput, TemplateVersionInput } from '@shared/types'
import { channelExportSchema, type ChannelExport } from '@shared/schemas'
import type { Services } from './container'
import { atomicWriteFile, ensureDir, sha256File } from './files'
import { countWords } from '../util/common'
import { AppError } from '../util/errors'

/**
 * Backups are consistent SQLite snapshots (VACUUM INTO) with a sidecar
 * manifest. Secrets never live in the database, so a backup can be shared
 * without exposing API keys. Exports are plain JSON documents.
 */
export class BackupService {
  constructor(private s: Services) {}

  backupDir(): string {
    const configured = this.s.settings.get().storage.backupDir
    return configured && configured.trim() ? configured : path.join(this.s.paths.userData, 'backups')
  }

  async create(): Promise<BackupInfo> {
    const dir = this.backupDir()
    ensureDir(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `voiceforge-backup-${stamp}.sqlite`)
    this.s.db.backupTo(file)
    const st = await fsp.stat(file)
    const sha = await sha256File(file)
    const info: BackupInfo = { path: file, createdAt: new Date().toISOString(), bytes: st.size, sha256: sha, appVersion: this.s.appVersion }
    await atomicWriteFile(`${file}.json`, JSON.stringify({ ...info, note: 'VoiceForge Studio backup. Contains settings, channels, templates, projects, scripts metadata, usage and history. API keys are NOT included.' }, null, 2))
    this.s.backups.record(info)
    await this.prune()
    return info
  }

  async prune(): Promise<void> {
    const keep = this.s.settings.get().storage.keepBackups
    const all = this.s.backups.list()
    for (const b of all.slice(keep)) {
      await fsp.unlink(b.path).catch(() => undefined)
      await fsp.unlink(`${b.path}.json`).catch(() => undefined)
      this.s.backups.remove(b.path)
    }
  }

  list(): BackupInfo[] {
    return this.s.backups.list().filter((b) => fs.existsSync(b.path))
  }

  /** Validates a backup and stages it; the main process swaps the database on restart. */
  async stageRestore(file: string): Promise<string> {
    if (!fs.existsSync(file)) throw new AppError('filesystem', 'Backup file not found.', { retryable: false })
    const head = Buffer.alloc(16)
    const fd = await fsp.open(file, 'r')
    try {
      await fd.read(head, 0, 16, 0)
    } finally {
      await fd.close()
    }
    if (head.toString('utf8', 0, 15) !== 'SQLite format 3') throw new AppError('config', 'The selected file is not a SQLite backup.', { retryable: false })
    const manifestPath = `${file}.json`
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as { sha256?: string }
        if (manifest.sha256) {
          const actual = await sha256File(file)
          if (actual !== manifest.sha256) throw new AppError('config', 'Backup checksum mismatch — the file is corrupted or was modified.', { retryable: false })
        }
      } catch (err) {
        if (err instanceof AppError) throw err
      }
    }
    const staged = path.join(this.s.paths.userData, 'restore-pending.sqlite')
    await fsp.copyFile(file, staged)
    return staged
  }

  // ---- exports ---------------------------------------------------------------

  exportChannel(channelId: string): ChannelExport {
    const channel = this.s.channels.get(channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const { id, slug, createdAt, updatedAt, activeTemplateVersionId, position, ...rest } = channel
    void id
    void slug
    void createdAt
    void updatedAt
    void position
    const defaultTemplate = activeTemplateVersionId ? this.s.channels.getVersion(activeTemplateVersionId)?.templateId : undefined
    const templates = this.s.channels
      .listTemplates(channelId)
      .sort((a, b) => (a.id === defaultTemplate ? -1 : b.id === defaultTemplate ? 1 : 0))
      .map((t) => {
        const versions = this.s.channels.listVersions(t.id).sort((a, b) => a.version - b.version)
        const active = versions.find((v) => v.id === t.activeVersionId)
        return {
          name: t.name,
          contentType: t.contentType,
          versions: versions.map((v) => ({
            version: v.version,
            systemPrompt: v.systemPrompt,
            structure: v.structure,
            exampleScript: v.exampleScript,
            notes: v.notes,
            placeholder: v.placeholder,
            approvalStatus: v.approvalStatus,
            fixedBlocks: v.fixedBlocks,
            findings: v.findings,
            confirmedRules: v.confirmedRules,
            unverified: v.unverified,
            headingsSpoken: v.headingsSpoken,
            referenceSetVersion: v.referenceSetVersion
          })),
          activeVersion: active ? active.version : null,
          references: this.s.channels.listReferences(t.id).map((r) => ({ title: r.title, text: r.text, sourceFormat: r.sourceFormat, sourceFileName: r.sourceFileName }))
        }
      })
    const input: ChannelInput = { ...rest, activeTemplateVersionId: null }
    return { format: 'voiceforge-channel', version: 1, channel: input, templates }
  }

  importChannel(json: string): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new AppError('config', 'The file is not valid JSON.', { retryable: false })
    }
    const result = channelExportSchema.safeParse(parsed)
    if (!result.success) throw new AppError('config', `The file is not a VoiceForge channel export: ${result.error.issues[0]?.message ?? 'invalid'}`, { retryable: false })
    const data = result.data
    return this.s.db.transaction(() => {
      let name = data.channel.name
      let i = 2
      while (this.s.channels.getByName(name)) name = `${data.channel.name} (${i++})`
      const channel = this.s.channels.create({ ...(data.channel as ChannelInput), name, activeTemplateVersionId: null })
      let first = true
      for (const t of data.templates) {
        if (!t.versions.length) continue
        const [firstVersion, ...others] = t.versions
        const created = this.s.channels.createTemplate(channel.id, t.name, firstVersion as TemplateVersionInput, t.contentType)
        const versionIds = new Map<number, string>([[firstVersion!.version, created.version.id]])
        for (const v of others) versionIds.set(v.version, this.s.channels.addVersion(created.template.id, v as TemplateVersionInput).id)
        // The export carries the user's own earlier approvals; keep them instead of resetting to "awaiting approval".
        for (const v of t.versions) {
          const id = versionIds.get(v.version)
          if (id && v.approvalStatus && v.approvalStatus !== this.s.channels.getVersion(id)?.approvalStatus) this.s.channels.setVersionStatus(id, v.approvalStatus)
        }
        for (const r of t.references ?? []) {
          this.s.channels.addReference({ channelId: channel.id, templateId: created.template.id, title: r.title, text: r.text, sourceFormat: r.sourceFormat, sourceFileName: r.sourceFileName, charCount: r.text.length, wordCount: countWords(r.text) })
        }
        const activeId = t.activeVersion !== null && versionIds.has(t.activeVersion) ? versionIds.get(t.activeVersion)! : created.version.id
        this.s.channels.setActiveVersion(channel.id, activeId)
        if (first) this.s.channels.setDefaultTemplate(channel.id, created.template.id)
        first = false
      }
      return channel.id
    })
  }

  exportData(kind: string): string {
    const channels = this.s.channels.list(true).map((c) => this.exportChannel(c.id))
    const payload: Record<string, unknown> = { format: 'voiceforge-export', version: 1, kind, exportedAt: new Date().toISOString(), appVersion: this.s.appVersion }
    if (kind === 'configuration' || kind === 'all') payload.settings = this.s.settings.get()
    if (kind === 'channels' || kind === 'templates' || kind === 'all') payload.channels = channels
    if (kind === 'projects' || kind === 'all') {
      payload.projects = this.s.projects.list({ includeArchived: true, limit: 100000 }).map((p) => ({
        ...p,
        scripts: this.s.scripts.versions(p.id).map(({ text, ...rest }) => ({ ...rest, text })),
        audio: this.s.audio.versions(p.id)
      }))
    }
    if (kind === 'history' || kind === 'all') {
      payload.history = this.s.jobs.listEvents({ limit: 100000 })
      payload.usage = this.s.usage.list(100000)
    }
    return JSON.stringify(payload, null, 2)
  }

  importData(json: string): { channels: number; templates: number } {
    let parsed: { format?: string; channels?: unknown[]; settings?: unknown }
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new AppError('config', 'The file is not valid JSON.', { retryable: false })
    }
    if (parsed.format === 'voiceforge-channel') {
      this.importChannel(json)
      return { channels: 1, templates: 1 }
    }
    if (parsed.format !== 'voiceforge-export') throw new AppError('config', 'Not a VoiceForge export file.', { retryable: false })
    let channels = 0
    let templates = 0
    for (const c of parsed.channels ?? []) {
      this.importChannel(JSON.stringify(c))
      channels++
      templates += ((c as { templates?: unknown[] }).templates ?? []).length
    }
    if (parsed.settings) {
      const { spending, generation, openai, elevenlabs, general } = parsed.settings as Record<string, unknown>
      this.s.settings.update({ spending, generation, openai, elevenlabs, general })
    }
    return { channels, templates }
  }
}
