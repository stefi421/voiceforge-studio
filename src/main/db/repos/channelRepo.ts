import type { Channel, ChannelInput, FixedTextBlock, ReferenceScript, ReferenceFormat, StyleAnalysis, StyleFinding, StyleTestResult, Template, TemplateApprovalStatus, TemplateVersion, TemplateVersionInput } from '@shared/types'
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
  content_type: string
  active_version_id: string | null
  reference_set_version: number
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
  approval_status: string
  fixed_blocks_json: string
  findings_json: string
  confirmed_rules: string
  unverified_json: string
  headings_spoken: number
  reference_set_version: number | null
  approved_at: string | null
  created_at: string
}

/** Statuses that allow unattended ("Fully automatic") production. */
export const PRODUCTION_STATUSES: TemplateApprovalStatus[] = ['approved', 'test_passed']
/** Statuses that allow Review-before-voice / Scripts-only with a warning. */
export const SUPERVISED_STATUSES: TemplateApprovalStatus[] = ['provisional', 'awaiting_approval', 'template_extracted', 'test_failed']

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
    approvalStatus: (r.approval_status ?? 'provisional') as TemplateApprovalStatus,
    fixedBlocks: parseJson<FixedTextBlock[]>(r.fixed_blocks_json, []),
    findings: parseJson<StyleFinding[]>(r.findings_json, []),
    confirmedRules: r.confirmed_rules ?? '',
    unverified: parseJson<string[]>(r.unverified_json, []),
    headingsSpoken: toBool(r.headings_spoken ?? 0),
    referenceSetVersion: r.reference_set_version ?? null,
    approvedAt: r.approved_at ?? null,
    createdAt: r.created_at
  }
}

interface ReferenceRow {
  id: string
  channel_id: string
  template_id: string
  title: string
  text: string
  source_format: string
  source_file_name: string | null
  char_count: number
  word_count: number
  created_at: string
}

function rowToReference(r: ReferenceRow): ReferenceScript {
  return {
    id: r.id,
    channelId: r.channel_id,
    templateId: r.template_id,
    title: r.title,
    text: r.text,
    sourceFormat: r.source_format as ReferenceFormat,
    sourceFileName: r.source_file_name,
    charCount: r.char_count,
    wordCount: r.word_count,
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
    return this.db.all<TemplateRow>('SELECT * FROM templates WHERE channel_id = ? ORDER BY created_at ASC, rowid ASC', channelId).map((r) => this.templateRowToTemplate(r))
  }

  private templateRowToTemplate(r: TemplateRow): Template {
    const latest = this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM template_versions WHERE template_id = ?', r.id)?.m ?? 0
    const active = r.active_version_id ? this.db.get<VersionRow>('SELECT * FROM template_versions WHERE template_id = ? AND id = ?', r.id, r.active_version_id) : undefined
    const statusRow = active ?? this.db.get<VersionRow>('SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1', r.id)
    const referenceCount = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM reference_scripts WHERE template_id = ?', r.id)?.c ?? 0
    return {
      id: r.id,
      channelId: r.channel_id,
      name: r.name,
      contentType: r.content_type,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      latestVersion: latest,
      activeVersionId: active ? active.id : null,
      approvalStatus: statusRow ? ((statusRow.approval_status ?? 'provisional') as TemplateApprovalStatus) : 'not_configured',
      referenceCount
    }
  }

  getTemplate(templateId: string): Template | undefined {
    const r = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
    return r ? this.templateRowToTemplate(r) : undefined
  }

  getTemplateByContentType(channelId: string, contentType: string): Template | undefined {
    const r = this.db.get<TemplateRow>('SELECT * FROM templates WHERE channel_id = ? AND content_type = ?', channelId, contentType)
    return r ? this.templateRowToTemplate(r) : undefined
  }

  /** Template that owns the channel's default (active) version, if any. */
  defaultTemplate(channelId: string): Template | undefined {
    const ch = this.get(channelId)
    if (ch?.activeTemplateVersionId) {
      const v = this.getVersion(ch.activeTemplateVersionId)
      if (v) return this.getTemplate(v.templateId)
    }
    return this.listTemplates(channelId)[0]
  }

  private uniqueContentType(channelId: string, base: string): string {
    const clean = (base || 'review').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'review'
    let ct = clean
    let i = 2
    while (this.db.get<{ id: string }>('SELECT id FROM templates WHERE channel_id = ? AND content_type = ?', channelId, ct)) ct = `${clean}_${i++}`
    return ct
  }

  createTemplate(channelId: string, name: string, initial: TemplateVersionInput, contentType?: string): { template: Template; version: TemplateVersion } {
    return this.db.transaction(() => {
      const id = newId()
      const ts = nowIso()
      const ct = this.uniqueContentType(channelId, contentType ?? 'review')
      this.db.run('INSERT INTO templates (id, channel_id, name, content_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, channelId, name, ct, ts, ts)
      const version = this.addVersion(id, initial)
      this.db.run('UPDATE templates SET active_version_id = ? WHERE id = ?', version.id, id)
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
        const belongs = this.db.get<{ id: string }>('SELECT id FROM template_versions WHERE id = ? AND template_id = ?', channel.activeTemplateVersionId, templateId)
        if (belongs) {
          const other = this.db.get<{ active_version_id: string | null }>('SELECT active_version_id FROM templates WHERE channel_id = ? AND id <> ? AND active_version_id IS NOT NULL ORDER BY created_at ASC LIMIT 1', t.channel_id, templateId)
          this.db.run('UPDATE channels SET active_template_version_id = ?, updated_at = ? WHERE id = ?', other?.active_version_id ?? null, nowIso(), channel.id)
        }
      }
      this.db.run('DELETE FROM templates WHERE id = ?', templateId)
    })
  }

  listVersions(templateId: string): TemplateVersion[] {
    return this.db.all<VersionRow>('SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC', templateId).map(rowToVersion)
  }

  getVersion(versionId: string): TemplateVersion | undefined {
    const r = this.db.get<VersionRow>('SELECT * FROM template_versions WHERE id = ?', versionId)
    return r ? rowToVersion(r) : undefined
  }

  /** Active version of a template (falls back to its latest version). */
  activeVersionOf(templateId: string): TemplateVersion | undefined {
    const t = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
    if (!t) return undefined
    if (t.active_version_id) {
      const v = this.getVersion(t.active_version_id)
      if (v) return v
    }
    return this.listVersions(templateId)[0]
  }

  addVersion(templateId: string, input: TemplateVersionInput): TemplateVersion {
    return this.db.transaction(() => {
      const t = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId)
      if (!t) throw new Error(`Template not found: ${templateId}`)
      const next = (this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM template_versions WHERE template_id = ?', templateId)?.m ?? 0) + 1
      const id = newId()
      // A new version never starts approved: only an explicit user action approves (Rule 11 / Step 6).
      let status: TemplateApprovalStatus = input.approvalStatus ?? (input.placeholder ? 'not_configured' : 'awaiting_approval')
      if (status === 'approved' || status === 'test_passed') status = 'awaiting_approval'
      this.db.run(
        `INSERT INTO template_versions (id, template_id, channel_id, version, system_prompt, structure_json, example_script, notes, placeholder,
          approval_status, fixed_blocks_json, findings_json, confirmed_rules, unverified_json, headings_spoken, reference_set_version, approved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        templateId,
        t.channel_id,
        next,
        input.systemPrompt,
        JSON.stringify(input.structure),
        input.exampleScript,
        input.notes,
        input.placeholder ? 1 : 0,
        status,
        JSON.stringify(input.fixedBlocks ?? []),
        JSON.stringify(input.findings ?? []),
        input.confirmedRules ?? '',
        JSON.stringify(input.unverified ?? []),
        input.headingsSpoken ? 1 : 0,
        input.referenceSetVersion ?? null,
        null,
        nowIso()
      )
      this.db.run('UPDATE templates SET updated_at = ? WHERE id = ?', nowIso(), templateId)
      return this.getVersion(id)!
    })
  }

  /**
   * Sets a version active inside its template. It also becomes the channel's default
   * format when the channel has no default yet or the default already belongs to this template.
   */
  setActiveVersion(channelId: string, versionId: string): Channel {
    const v = this.getVersion(versionId)
    if (!v) throw new Error(`Template version not found: ${versionId}`)
    if (v.channelId !== channelId) throw new Error('Template version belongs to another channel')
    this.db.transaction(() => {
      this.db.run('UPDATE templates SET active_version_id = ?, updated_at = ? WHERE id = ?', versionId, nowIso(), v.templateId)
      const ch = this.get(channelId)
      const currentDefault = ch?.activeTemplateVersionId ? this.getVersion(ch.activeTemplateVersionId) : undefined
      if (!currentDefault || currentDefault.templateId === v.templateId) {
        this.db.run('UPDATE channels SET active_template_version_id = ?, updated_at = ? WHERE id = ?', versionId, nowIso(), channelId)
      }
    })
    return this.get(channelId)!
  }

  /** Makes a template the channel's default format (its active version becomes the channel default). */
  setDefaultTemplate(channelId: string, templateId: string): Channel {
    const v = this.activeVersionOf(templateId)
    if (!v || v.channelId !== channelId) throw new Error('Template not found for channel')
    this.db.run('UPDATE channels SET active_template_version_id = ?, updated_at = ? WHERE id = ?', v.id, nowIso(), channelId)
    return this.get(channelId)!
  }

  setVersionStatus(versionId: string, status: TemplateApprovalStatus): TemplateVersion {
    const approvedAt = status === 'approved' ? nowIso() : null
    if (approvedAt) this.db.run('UPDATE template_versions SET approval_status = ?, approved_at = ? WHERE id = ?', status, approvedAt, versionId)
    else this.db.run('UPDATE template_versions SET approval_status = ? WHERE id = ?', status, versionId)
    return this.getVersion(versionId)!
  }

  setVersionFixedBlocks(versionId: string, blocks: FixedTextBlock[]): TemplateVersion {
    this.db.run('UPDATE template_versions SET fixed_blocks_json = ? WHERE id = ?', JSON.stringify(blocks), versionId)
    return this.getVersion(versionId)!
  }

  // ---- reference scripts ---------------------------------------------------

  referenceSetVersion(templateId: string): number {
    return this.db.get<{ v: number }>('SELECT reference_set_version AS v FROM templates WHERE id = ?', templateId)?.v ?? 0
  }

  private bumpReferenceSet(templateId: string): void {
    this.db.run('UPDATE templates SET reference_set_version = reference_set_version + 1, updated_at = ? WHERE id = ?', nowIso(), templateId)
  }

  listReferences(templateId: string): ReferenceScript[] {
    return this.db.all<ReferenceRow>('SELECT * FROM reference_scripts WHERE template_id = ? ORDER BY created_at ASC, rowid ASC', templateId).map(rowToReference)
  }

  countReferences(templateId: string): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM reference_scripts WHERE template_id = ?', templateId)?.c ?? 0
  }

  getReference(id: string): ReferenceScript | undefined {
    const r = this.db.get<ReferenceRow>('SELECT * FROM reference_scripts WHERE id = ?', id)
    return r ? rowToReference(r) : undefined
  }

  addReference(input: Omit<ReferenceScript, 'id' | 'createdAt'>): ReferenceScript {
    const id = newId()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO reference_scripts (id, channel_id, template_id, title, text, source_format, source_file_name, char_count, word_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.channelId,
        input.templateId,
        input.title,
        input.text,
        input.sourceFormat,
        input.sourceFileName,
        input.charCount,
        input.wordCount,
        nowIso()
      )
      this.bumpReferenceSet(input.templateId)
    })
    return this.getReference(id)!
  }

  updateReference(id: string, patch: { title?: string; text?: string; charCount?: number; wordCount?: number }): ReferenceScript {
    const cur = this.getReference(id)
    if (!cur) throw new Error(`Reference not found: ${id}`)
    const m = { ...cur, ...patch }
    this.db.transaction(() => {
      this.db.run('UPDATE reference_scripts SET title = ?, text = ?, char_count = ?, word_count = ? WHERE id = ?', m.title, m.text, m.charCount, m.wordCount, id)
      if (patch.text !== undefined && patch.text !== cur.text) this.bumpReferenceSet(cur.templateId)
    })
    return this.getReference(id)!
  }

  deleteReference(id: string): void {
    const cur = this.getReference(id)
    if (!cur) return
    this.db.transaction(() => {
      this.db.run('DELETE FROM reference_scripts WHERE id = ?', id)
      this.bumpReferenceSet(cur.templateId)
    })
  }

  // ---- analyses & tests ------------------------------------------------------

  saveAnalysis(a: StyleAnalysis): void {
    this.db.run('INSERT OR REPLACE INTO style_analyses (template_id, data_json, created_at) VALUES (?, ?, ?)', a.templateId, JSON.stringify(a), nowIso())
  }

  lastAnalysis(templateId: string): StyleAnalysis | null {
    const r = this.db.get<{ data_json: string }>('SELECT data_json FROM style_analyses WHERE template_id = ?', templateId)
    return r ? parseJson<StyleAnalysis | null>(r.data_json, null) : null
  }

  saveStyleTest(t: StyleTestResult): void {
    this.db.run(
      'INSERT INTO style_tests (id, template_id, template_version_id, title, script_text, checks_json, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      t.id,
      t.templateId,
      t.templateVersionId,
      t.title,
      t.scriptText,
      JSON.stringify(t.checks),
      t.passed ? 1 : 0,
      t.createdAt
    )
  }

  listStyleTests(templateId: string, limit = 20): StyleTestResult[] {
    return this.db
      .all<{ id: string; template_id: string; template_version_id: string; title: string; script_text: string; checks_json: string; passed: number; created_at: string }>(
        'SELECT * FROM style_tests WHERE template_id = ? ORDER BY created_at DESC LIMIT ?',
        templateId,
        limit
      )
      .map((r) => ({ id: r.id, templateId: r.template_id, templateVersionId: r.template_version_id, title: r.title, scriptText: r.script_text, checks: parseJson(r.checks_json, []), passed: toBool(r.passed), createdAt: r.created_at }))
  }
}
