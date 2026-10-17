import type { Channel, ChannelInput, Template, TemplateVersion, TemplateVersionInput } from '@shared/types'
import { DEFAULT_RESEARCH, DEFAULT_VALIDATION, DEFAULT_VOICE_SETTINGS } from '@shared/defaults'
import type { Database } from '../database'
import { newId, nowIso, parseJson, slugify, toBool } from '../../util/common'

interface ChannelRow {
  id: string
  name: string
  slug: string
  icon: string
  color: string
  description: string
  category: string
  language: string
  writing_instructions: string
  writing_style: string
  intro_requirements: string
  outro_requirements: string
  target_duration_sec: number
  min_chars: number
  max_chars: number
  pronunciation_rules_json: string
  eleven_voice_id: string | null
  eleven_voice_name: string | null
  eleven_model_id: string
  eleven_voice_settings_json: string
  output_format: string
  output_folder: string | null
  openai_model: string | null
  research_json: string
  validation_json: string
  active_template_version_id: string | null
  position: number
  archived: number
  created_at: string
  updated_at: string
}

function rowToChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    icon: r.icon,
    color: r.color,
    description: r.description,
    category: r.category as Channel['category'],
    language: r.language,
    writingInstructions: r.writing_instructions,
    writingStyle: r.writing_style,
    introRequirements: r.intro_requirements,
    outroRequirements: r.outro_requirements,
    targetDurationSec: r.target_duration_sec,
    minChars: r.min_chars,
    maxChars: r.max_chars,
    pronunciationRules: parseJson(r.pronunciation_rules_json, []),
    elevenVoiceId: r.eleven_voice_id,
    elevenVoiceName: r.eleven_voice_name,
    elevenModelId: r.eleven_model_id,
    elevenVoiceSettings: { ...DEFAULT_VOICE_SETTINGS, ...parseJson(r.eleven_voice_settings_json, {}) },
    outputFormat: r.output_format,
    outputFolder: r.output_folder,
    openaiModel: r.openai_model,
    research: { ...DEFAULT_RESEARCH, ...parseJson(r.research_json, {}) },
    validation: { ...DEFAULT_VALIDATION, ...parseJson(r.validation_json, {}) },
    activeTemplateVersionId: r.active_template_version_id,
    position: r.position,
    archived: toBool(r.archived),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

interface TemplateRow {
  id: string
  channel_id: string
  name: string
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  template_id: string
  channel_id: string
  version: number
  system_prompt: string
  structure_json: string
  example_script: string | null
  notes: string
  placeholder: number
  created_at: string
}

function rowToVersion(r: VersionRow): TemplateVersion {
  return {
    id: r.id,
    templateId: r.template_id,
    channelId: r.channel_id,
    version: r.version,
    systemPrompt: r.system_prompt,
    structure: parseJson(r.structure_json, []),
    exampleScript: r.example_script,
    notes: r.notes,
    placeholder: toBool(r.placeholder),
    createdAt: r.created_at
  }
}

export class ChannelRepo {
  constructor(private db: Database) {}

  list(includeArchived = false): Channel[] {
    const rows = includeArchived
      ? this.db.all<ChannelRow>('SELECT * FROM channels ORDER BY position ASC, created_at ASC')
      : this.db.all<ChannelRow>('SELECT * FROM channels WHERE archived = 0 ORDER BY position ASC, created_at ASC')
    return rows.map(rowToChannel)
  }

  get(id: string): Channel | undefined {
    const r = this.db.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id)
    return r ? rowToChannel(r) : undefined
  }

  getByName(name: string): Channel | undefined {
    const r = this.db.get<ChannelRow>('SELECT * FROM channels WHERE lower(name) = lower(?)', name)
    return r ? rowToChannel(r) : undefined
  }

  count(): number {
    return (this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM channels WHERE archived = 0')?.c as number) ?? 0
  }

  private uniqueSlug(base: string, excludeId?: string): string {
    let slug = slugify(base)
    let i = 2
    while (true) {
      const existing = this.db.get<{ id: string }>('SELECT id FROM channels WHERE slug = ?', slug)
      if (!existing || existing.id === excludeId) return slug
      slug = `${slugify(base)}-${i++}`
    }
  }

  create(input: ChannelInput, id = newId()): Channel {
    const ts = nowIso()
    const position = input.position ?? ((this.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM channels')?.m ?? -1) + 1)
    this.db.run(
      `INSERT INTO channels (id, name, slug, icon, color, description, category, language, writing_instructions, writing_style,
        intro_requirements, outro_requirements, target_duration_sec, min_chars, max_chars, pronunciation_rules_json,
        eleven_voice_id, eleven_voice_name, eleven_model_id, eleven_voice_settings_json, output_format, output_folder, openai_model,
        research_json, validation_json, active_template_version_id, position, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      this.uniqueSlug(input.name),
      input.icon,
      input.color,
      input.description,
      input.category,
      input.language,
      input.writingInstructions,
      input.writingStyle,
      input.introRequirements,
      input.outroRequirements,
      input.targetDurationSec,
      input.minChars,
      input.maxChars,
      JSON.stringify(input.pronunciationRules),
      input.elevenVoiceId,
      input.elevenVoiceName,
      input.elevenModelId,
      JSON.stringify(input.elevenVoiceSettings),
      input.outputFormat,
      input.outputFolder,
      input.openaiModel,
      JSON.stringify(input.research),
      JSON.stringify(input.validation),
      input.activeTemplateVersionId ?? null,
      position,
      input.archived ? 1 : 0,
      ts,
      ts
    )
    return this.get(id)!
  }

  update(id: string, patch: Partial<ChannelInput>): Channel {
    const current = this.get(id)
    if (!current) throw new Error(`Channel not found: ${id}`)
    const merged: Channel = { ...current, ...patch, id, updatedAt: nowIso() } as Channel
    this.db.run(
      `UPDATE channels SET name=?, slug=?, icon=?, color=?, description=?, category=?, language=?, writing_instructions=?, writing_style=?,
        intro_requirements=?, outro_requirements=?, target_duration_sec=?, min_chars=?, max_chars=?, pronunciation_rules_json=?,
        eleven_voice_id=?, eleven_voice_name=?, eleven_model_id=?, eleven_voice_settings_json=?, output_format=?, output_folder=?, openai_model=?,
        research_json=?, validation_json=?, active_template_version_id=?, position=?, archived=?, updated_at=? WHERE id=?`,
      merged.name,
      patch.name && patch.name !== current.name ? this.uniqueSlug(merged.name, id) : current.slug,
      merged.icon,
      merged.color,
      merged.description,
      merged.category,
      merged.language,
      merged.writingInstructions,
      merged.writingStyle,
      merged.introRequirements,
      merged.outroRequirements,
      merged.targetDurationSec,
      merged.minChars,
      merged.maxChars,
      JSON.stringify(merged.pronunciationRules),
      merged.elevenVoiceId,
      merged.elevenVoiceName,
      merged.elevenModelId,
      JSON.stringify(merged.elevenVoiceSettings),
      merged.outputFormat,
      merged.outputFolder,
      merged.openaiModel,
      JSON.stringify(merged.research),
      JSON.stringify(merged.validation),
      merged.activeTemplateVersionId,
      merged.position,
      merged.archived ? 1 : 0,
      merged.updatedAt,
      id
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM channels WHERE id = ?', id)
  }

  reorder(ids: string[]): void {
    this.db.transaction(() => {
      ids.forEach((id, i) => this.db.run('UPDATE channels SET position = ? WHERE id = ?', i, id))
    })
  }

  // ---- templates -----------------------------------------------------------

  listTemplates(channelId: string): Template[] {
    const rows = this.db.all<TemplateRow>('SELECT * FROM templates WHERE channel_id = ? ORDER BY created_at ASC', channelId)
    const channel = this.get(channelId)
    return rows.map((r) => this.templateRowToTemplate(r, channel?.activeTemplateVersionId ?? null))
  }

  private templateRowToTemplate(r: TemplateRow, activeVersionId: string | null): Template {
    const latest = this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM template_versions WHERE template_id = ?', r.id)?.m ?? 0
    const active = activeVersionId
      ? this.db.get<{ id: string }>('SELECT id FROM template_versions WHERE template_id = ? AND id = ?', r.id, activeVersionId)
      : undefined
    return {
      id: r.id,
      channelId: r.channel_id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      latestVersion: latest,
      activeVersionId: active ? active.id : null
    }
  }

  getTemplate(templateId: string): Template | undefined {
    const r = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
    if (!r) return undefined
    const channel = this.get(r.channel_id)
    return this.templateRowToTemplate(r, channel?.activeTemplateVersionId ?? null)
  }

  createTemplate(channelId: string, name: string, initial: TemplateVersionInput): { template: Template; version: TemplateVersion } {
    return this.db.transaction(() => {
      const id = newId()
      const ts = nowIso()
      this.db.run('INSERT INTO templates (id, channel_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, channelId, name, ts, ts)
      const version = this.addVersion(id, initial)
      return { template: this.getTemplate(id)!, version }
    })
  }

  renameTemplate(templateId: string, name: string): Template {
    this.db.run('UPDATE templates SET name = ?, updated_at = ? WHERE id = ?', name, nowIso(), templateId)
    return this.getTemplate(templateId)!
  }

  deleteTemplate(templateId: string): void {
    this.db.transaction(() => {
      const t = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
      if (!t) return
      const channel = this.get(t.channel_id)
      if (channel?.activeTemplateVersionId) {
        const belongs = this.db.get<{ id: string }>(
          'SELECT id FROM template_versions WHERE id = ? AND template_id = ?',
          channel.activeTemplateVersionId,
          templateId
        )
        if (belongs) this.db.run('UPDATE channels SET active_template_version_id = NULL, updated_at = ? WHERE id = ?', nowIso(), channel.id)
      }
      this.db.run('DELETE FROM templates WHERE id = ?', templateId)
    })
  }

  listVersions(templateId: string): TemplateVersion[] {
    return this.db
      .all<VersionRow>('SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC', templateId)
      .map(rowToVersion)
  }

  getVersion(versionId: string): TemplateVersion | undefined {
    const r = this.db.get<VersionRow>('SELECT * FROM template_versions WHERE id = ?', versionId)
    return r ? rowToVersion(r) : undefined
  }

  addVersion(templateId: string, input: TemplateVersionInput): TemplateVersion {
    return this.db.transaction(() => {
      const t = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
      if (!t) throw new Error(`Template not found: ${templateId}`)
      const next = (this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM template_versions WHERE template_id = ?', templateId)?.m ?? 0) + 1
      const id = newId()
      this.db.run(
        `INSERT INTO template_versions (id, template_id, channel_id, version, system_prompt, structure_json, example_script, notes, placeholder, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        templateId,
        t.channel_id,
        next,
        input.systemPrompt,
        JSON.stringify(input.structure),
        input.exampleScript,
        input.notes,
        input.placeholder ? 1 : 0,
        nowIso()
      )
      this.db.run('UPDATE templates SET updated_at = ? WHERE id = ?', nowIso(), templateId)
      return this.getVersion(id)!
    })
  }

  setActiveVersion(channelId: string, versionId: string): Channel {
    const v = this.getVersion(versionId)
    if (!v) throw new Error(`Template version not found: ${versionId}`)
    if (v.channelId !== channelId) throw new Error('Template version belongs to another channel')
    this.db.run('UPDATE channels SET active_template_version_id = ?, updated_at = ? WHERE id = ?', versionId, nowIso(), channelId)
    return this.get(channelId)!
  }
}
