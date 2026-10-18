import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ElevenModel, ElevenVoice, SecretsStatus, TemplateAnalysis } from '@shared/types'
import {
  analyzeTemplateSchema,
  approvalStatusSchema,
  contentTypeSchema,
  fixedTextBlockSchema,
  referenceFormatSchema,
  channelInputSchema,
  channelPatchSchema,
  createBatchSchema,
  exportKindSchema,
  idSchema,
  jobFilterSchema,
  libraryFilterSchema,
  pathSchema,
  providerSchema,
  regenerateAudioSchema,
  resolveResearchSchema,
  secretSetSchema,
  templateVersionInputSchema,
  usageRangeSchema
} from '@shared/schemas'
import type { Services } from '../services/container'
import type { QueueEngine } from '../queue/engine'
import { GenerationService } from '../services/generation'
import { BackupService } from '../services/backup'
import { StyleService } from '../services/style'
import type { UpdateService } from '../services/updater'
import { PreflightService } from '../services/preflight'
import { ProjectService } from '../services/projects'
import { atomicWriteFile, ensureDir } from '../services/files'
import { AppError } from '../util/errors'
import { countWords } from '../util/common'
import type { IpcRegistry } from './registry'

const ELEVEN_VOICE_CACHE_MS = 6 * 60 * 60 * 1000
const ELEVEN_MODEL_CACHE_MS = 24 * 60 * 60 * 1000

export interface HandlerDeps {
  s: Services
  engine: QueueEngine
  generation: GenerationService
  backup: BackupService
  updates: UpdateService
  getWindow: () => BrowserWindow | null
  requestRestart: () => void
  /** Flushes the queue and database before the process exits (used by install-update). */
  prepareShutdown: () => Promise<void>
}

function win(deps: HandlerDeps): BrowserWindow | undefined {
  return deps.getWindow() ?? undefined
}

export function registerHandlers(reg: IpcRegistry, deps: HandlerDeps): void {
  const { s, engine, generation, backup } = deps
  const projectsSvc = new ProjectService(s)
  const pipeline = engine.pipeline

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  reg.handle('app:info', null, () => ({
    version: s.appVersion,
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    platform: process.platform,
    userDataPath: s.paths.userData,
    dbPath: s.db.path,
    logsPath: s.paths.logs,
    outputRoot: s.paths.outputRoot(),
    secretsBackend: s.secrets.backend
  }))

  const openPathSchema = z.object({ path: pathSchema })
  reg.handle('app:openPath', openPathSchema, async ({ path: p }) => {
    // Web links (release pages, provider dashboards) go to the system browser; everything else is a local path.
    if (/^https:\/\/(github\.com|platform\.openai\.com|elevenlabs\.io)\//i.test(p)) {
      await shell.openExternal(p)
      return { ok: true }
    }
    if (/^[a-z]+:\/\//i.test(p)) return { ok: false, message: 'Only GitHub, OpenAI and ElevenLabs links can be opened from the app.' }
    if (!fs.existsSync(p)) {
      ensureDir(p)
    }
    const err = await shell.openPath(p)
    return err ? { ok: false, message: err } : { ok: true }
  })
  reg.handle('app:showItemInFolder', openPathSchema, ({ path: p }) => {
    if (!fs.existsSync(p)) throw new AppError('filesystem', 'The file no longer exists at that location.', { retryable: false })
    shell.showItemInFolder(p)
  })
  reg.handle('app:selectFolder', z.object({ title: z.string().optional(), defaultPath: z.string().optional() }), async (opts) => {
    const res = await dialog.showOpenDialog(win(deps)!, { title: opts.title, defaultPath: opts.defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  const filterSchema = z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional()
  reg.handle('app:selectFiles', z.object({ title: z.string().optional(), filters: filterSchema, multiple: z.boolean().optional() }), async (opts) => {
    const res = await dialog.showOpenDialog(win(deps)!, { title: opts.title, filters: opts.filters, properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'] })
    return res.canceled ? [] : res.filePaths
  })
  reg.handle('app:saveFileDialog', z.object({ title: z.string().optional(), defaultPath: z.string().optional(), filters: filterSchema }), async (opts) => {
    const res = await dialog.showSaveDialog(win(deps)!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })
    return res.canceled ? null : (res.filePath ?? null)
  })
  reg.handle('app:copyToClipboard', z.object({ text: z.string().max(5_000_000) }), ({ text }) => clipboard.writeText(text))
  reg.handle('app:readClipboard', null, () => clipboard.readText())
  reg.handle('app:openLogs', null, async () => {
    await shell.openPath(s.paths.logs)
  })
  reg.handle('app:readRecentLogs', z.object({ lines: z.number().int().min(1).max(2000).optional() }), ({ lines }) => s.logger.readRecent(lines ?? 200))
  reg.handle('app:dbIntegrityCheck', null, () => s.db.integrityCheck())
  reg.handle('app:resetSettings', null, () => {
    const next = s.settings.reset()
    s.events.emit('settings:changed', next)
    return next
  })

  // ---------------------------------------------------------------------------
  // Updates (user-initiated; see services/updater.ts)
  // ---------------------------------------------------------------------------
  reg.handle('updates:status', null, () => deps.updates.getStatus())
  reg.handle('updates:check', null, () => deps.updates.check())
  reg.handle('updates:download', null, () => deps.updates.download())
  reg.handle('updates:install', null, () => deps.updates.install(deps.prepareShutdown))

  // ---------------------------------------------------------------------------
  // Settings & secrets
  // ---------------------------------------------------------------------------

  reg.handle('settings:get', null, () => s.settings.get())
  reg.handle('settings:update', null, (patch) => {
    const next = s.settings.update(patch)
    s.logger.setLevel(next.advanced.logLevel)
    s.events.emit('settings:changed', next)
    return next
  })
  const secretsStatus = (): SecretsStatus => s.secrets.status()
  reg.handle('secrets:status', null, secretsStatus)
  reg.handle('secrets:set', secretSetSchema, ({ provider, value }) => {
    s.secrets.set(provider, value)
    s.providers.reset()
    const st = secretsStatus()
    s.events.emit('secrets:changed', st)
    return st
  })
  reg.handle('secrets:clear', z.object({ provider: providerSchema }), ({ provider }) => {
    s.secrets.clear(provider)
    s.providers.reset()
    const st = secretsStatus()
    s.events.emit('secrets:changed', st)
    return st
  })

  // ---------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------

  reg.handle('openai:test', null, () => s.providers.openai().testConnection())
  reg.handle('openai:listModels', null, async () => {
    const cached = s.cache.get<Array<{ id: string; created: number }>>('openai_models', ELEVEN_MODEL_CACHE_MS)
    if (cached) return cached
    const models = await s.providers.openai().listModels()
    s.cache.set('openai_models', models)
    return models
  })
  reg.handle('eleven:test', null, () => s.providers.eleven().testConnection())
  const withFavorites = (voices: ElevenVoice[]): ElevenVoice[] => {
    const fav = s.cache.listFavoriteVoices()
    return voices.map((v) => ({ ...v, favorite: fav.has(v.voiceId) })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  }
  reg.handle('eleven:listVoices', z.object({ refresh: z.boolean().optional() }), async ({ refresh }) => {
    if (!refresh) {
      const cached = s.cache.get<ElevenVoice[]>('eleven_voices', ELEVEN_VOICE_CACHE_MS)
      if (cached) return withFavorites(cached)
    }
    const voices = await s.providers.eleven().listVoices()
    s.cache.set('eleven_voices', voices)
    return withFavorites(voices)
  })
  reg.handle('eleven:listModels', z.object({ refresh: z.boolean().optional() }), async ({ refresh }) => {
    if (!refresh) {
      const cached = s.cache.get<ElevenModel[]>('eleven_models', ELEVEN_MODEL_CACHE_MS)
      if (cached) return cached
    }
    const models = await s.providers.eleven().listModels()
    s.cache.set('eleven_models', models)
    return models
  })
  reg.handle('eleven:subscription', null, () => s.providers.eleven().getSubscription())
  reg.handle('eleven:toggleFavorite', z.object({ voiceId: z.string().min(1).max(120) }), ({ voiceId }) => {
    s.cache.toggleFavoriteVoice(voiceId)
    const cached = s.cache.get<ElevenVoice[]>('eleven_voices', ELEVEN_VOICE_CACHE_MS) ?? []
    return withFavorites(cached)
  })
  reg.handle('eleven:previewVoice', z.object({ voiceId: z.string().min(1).max(120) }), ({ voiceId }) => {
    const cached = s.cache.get<ElevenVoice[]>('eleven_voices', ELEVEN_VOICE_CACHE_MS) ?? []
    const v = cached.find((x) => x.voiceId === voiceId)
    return { url: v?.previewUrl ? `vfmedia://preview/${encodeURIComponent(voiceId)}` : null }
  })

  // ---------------------------------------------------------------------------
  // Channels & templates
  // ---------------------------------------------------------------------------

  reg.handle('channels:list', z.object({ includeArchived: z.boolean().optional() }), ({ includeArchived }) => s.channels.list(!!includeArchived))
  reg.handle('channels:get', z.object({ id: idSchema }), ({ id }) => {
    const c = s.channels.get(id)
    if (!c) throw new AppError('config', 'Channel not found.', { retryable: false })
    return c
  })
  reg.handle('channels:create', channelInputSchema, (input) => s.channels.create(input))
  reg.handle('channels:update', z.object({ id: idSchema, patch: channelPatchSchema }), ({ id, patch }) => s.channels.update(id, patch))
  reg.handle('channels:delete', z.object({ id: idSchema, deleteFiles: z.boolean() }), async ({ id, deleteFiles }) => {
    const channel = s.channels.get(id)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const active = s.jobs.list({ channelId: id, status: ['pending', 'researching', 'writing_script', 'validating_script', 'generating_audio', 'saving_files'] })
    if (active.length) throw new AppError('config', `${active.length} job(s) for this channel are still running or queued.`, { action: 'Cancel or finish them first.', retryable: false })
    const projects = s.projects.listByChannel(id)
    s.db.transaction(() => {
      for (const p of projects) s.projects.delete(p.id)
      s.channels.delete(id)
    })
    if (deleteFiles) {
      // channelRoot always appends the sanitised channel name, so this is never a drive or the output root itself.
      const root = projectsSvc.channelRoot(channel)
      if (fs.existsSync(root) && path.basename(root).length > 0 && path.dirname(root) !== root) await fsp.rm(root, { recursive: true, force: true })
    }
    return { ok: true as const }
  })
  reg.handle('channels:duplicate', z.object({ id: idSchema }), ({ id }) => {
    const exported = backup.exportChannel(id)
    exported.channel.name = `${exported.channel.name} (copy)`
    const newId = backup.importChannel(JSON.stringify(exported))
    return s.channels.get(newId)!
  })
  reg.handle('channels:export', z.object({ id: idSchema, path: pathSchema.optional() }), async ({ id, path: p }) => {
    const json = JSON.stringify(backup.exportChannel(id), null, 2)
    if (p) await atomicWriteFile(p, json)
    return { json, savedTo: p ?? null }
  })
  reg.handle('channels:import', z.object({ json: z.string().max(5_000_000).optional(), path: pathSchema.optional() }), async ({ json, path: p }) => {
    const text = json ?? (p ? await fsp.readFile(p, 'utf8') : '')
    if (!text) throw new AppError('config', 'Nothing to import.', { retryable: false })
    const newId = backup.importChannel(text)
    return s.channels.get(newId)!
  })
  reg.handle('channels:reorder', z.object({ ids: z.array(idSchema).max(500) }), ({ ids }) => {
    s.channels.reorder(ids)
    return s.channels.list(true)
  })

  reg.handle('templates:list', z.object({ channelId: idSchema }), ({ channelId }) => s.channels.listTemplates(channelId))
  reg.handle('templates:create', z.object({ channelId: idSchema, name: z.string().trim().min(1).max(120), contentType: contentTypeSchema.optional(), initial: templateVersionInputSchema }), ({ channelId, name, contentType, initial }) => {
    if (!s.channels.get(channelId)) throw new AppError('config', 'Channel not found.', { retryable: false })
    const { template, version } = s.channels.createTemplate(channelId, name, initial, contentType)
    const channel = s.channels.get(channelId)
    if (channel && !channel.activeTemplateVersionId) s.channels.setActiveVersion(channelId, version.id)
    return s.channels.getTemplate(template.id)!
  })
  reg.handle('templates:rename', z.object({ templateId: idSchema, name: z.string().trim().min(1).max(120) }), ({ templateId, name }) => s.channels.renameTemplate(templateId, name))
  reg.handle('templates:delete', z.object({ templateId: idSchema }), ({ templateId }) => {
    s.channels.deleteTemplate(templateId)
    return { ok: true as const }
  })
  reg.handle('templates:versions', z.object({ templateId: idSchema }), ({ templateId }) => s.channels.listVersions(templateId))
  reg.handle('templates:getVersion', z.object({ versionId: idSchema }), ({ versionId }) => {
    const v = s.channels.getVersion(versionId)
    if (!v) throw new AppError('config', 'Template version not found.', { retryable: false })
    return v
  })
  reg.handle('templates:addVersion', z.object({ templateId: idSchema, input: templateVersionInputSchema }), ({ templateId, input }) => {
    if (!s.channels.getTemplate(templateId)) throw new AppError('config', 'Format not found.', { retryable: false, code: 'FORMAT_NOT_FOUND' })
    // New versions never start approved (Rule 11); a version built from an analysis waits for approval.
    return s.channels.addVersion(templateId, input.referenceSetVersion != null && !input.approvalStatus ? { ...input, approvalStatus: 'awaiting_approval' } : input)
  })
  reg.handle('templates:setActive', z.object({ channelId: idSchema, versionId: idSchema }), ({ channelId, versionId }) => s.channels.setActiveVersion(channelId, versionId))
  reg.handle('templates:analyze', analyzeTemplateSchema, async ({ channelId, exampleScript, instructions }): Promise<TemplateAnalysis> => {
    const channel = s.channels.get(channelId)
    if (!channel) throw new AppError('config', 'Channel not found.', { retryable: false })
    const settings = s.settings.get()
    const model = channel.openaiModel || settings.openai.defaultModel
    const res = await s.providers.openai().analyzeTemplate({ channel, exampleScript, instructions, model })
    s.usage.record({
      provider: 'openai',
      kind: 'template_analysis',
      model: res.model,
      jobId: null,
      channelId,
      projectId: null,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      characters: 0,
      estimatedCost: 0,
      reported: res.usage.reported ?? null
    })
    const caveats = [
      'One example cannot capture every stylistic rule. Review the suggested prompt and sections, and add the rules you know (fixed intro/outro sentences, length limits, forbidden words) before activating the version.',
      ...res.caveats
    ]
    return {
      suggestedStructure: res.sections,
      suggestedSystemPrompt: res.systemPrompt,
      observations: res.observations,
      charCount: exampleScript.length,
      wordCount: countWords(exampleScript),
      caveats
    }
  })

  // ---------------------------------------------------------------------------
  // Channel Style Preservation Studio
  // ---------------------------------------------------------------------------

  const style = new StyleService(s)
  reg.handle('references:list', z.object({ templateId: idSchema }), ({ templateId }) => s.channels.listReferences(templateId))
  reg.handle(
    'references:add',
    z.object({ templateId: idSchema, title: z.string().max(200), text: z.string().max(400_000), sourceFormat: referenceFormatSchema.optional(), sourceFileName: z.string().max(260).nullable().optional() }),
    (input) => style.addReference(input)
  )
  reg.handle('references:importFiles', z.object({ templateId: idSchema, paths: z.array(pathSchema).min(1).max(30) }), ({ templateId, paths }) => style.importFiles(templateId, paths))
  reg.handle('references:update', z.object({ id: idSchema, title: z.string().max(200).optional(), text: z.string().max(400_000).optional() }), ({ id, ...patch }) => style.updateReference(id, patch))
  reg.handle('references:delete', z.object({ id: idSchema }), ({ id }) => {
    style.deleteReference(id)
    return { ok: true as const }
  })
  reg.handle('style:analyze', z.object({ templateId: idSchema, instructions: z.string().max(20000).optional() }), ({ templateId, instructions }) => style.analyze(templateId, instructions ?? ''))
  reg.handle('style:lastAnalysis', z.object({ templateId: idSchema }), ({ templateId }) => s.channels.lastAnalysis(templateId))
  reg.handle('channels:getOpening', z.object({ channelId: idSchema }), ({ channelId }) => style.getOpening(channelId))
  reg.handle('channels:setOpening', z.object({ channelId: idSchema, intro: z.string().max(4000), outro: z.string().max(4000), openWithChannelIntro: z.boolean() }), (o) =>
    style.setOpening(o.channelId, o)
  )
  reg.handle('templates:setApproval', z.object({ versionId: idSchema, status: approvalStatusSchema }), ({ versionId, status }) => style.setApproval(versionId, status))
  reg.handle('templates:setDefault', z.object({ channelId: idSchema, templateId: idSchema }), ({ channelId, templateId }) => {
    const t = s.channels.getTemplate(templateId)
    if (!t || t.channelId !== channelId) throw new AppError('config', 'Format not found for this channel.', { retryable: false, code: 'FORMAT_NOT_FOUND' })
    return s.channels.setDefaultTemplate(channelId, templateId)
  })
  reg.handle('templates:setFixedBlocks', z.object({ versionId: idSchema, blocks: z.array(fixedTextBlockSchema).max(100) }), ({ versionId, blocks }) => style.setFixedBlocks(versionId, blocks))
  reg.handle('style:test', z.object({ templateId: idSchema, title: z.string().trim().min(1).max(200), notes: z.string().max(20000).optional() }), ({ templateId, title, notes }) => style.runTest(templateId, title, notes))
  reg.handle('style:tests', z.object({ templateId: idSchema, limit: z.number().int().min(1).max(100).optional() }), ({ templateId, limit }) => s.channels.listStyleTests(templateId, limit ?? 20))

  // ---------------------------------------------------------------------------
  // Generation & queue
  // ---------------------------------------------------------------------------

  reg.handle('generation:parseTitles', z.object({ text: z.string().max(2_000_000) }), ({ text }) => generation.parseTitles(text))
  reg.handle('generation:importTitles', z.object({ path: pathSchema }), ({ path: p }) => generation.importTitles(p))
  reg.handle('generation:estimate', createBatchSchema, (input) => generation.estimate(input))
  const preflight = new PreflightService(s, generation)
  reg.handle('generation:preflight', createBatchSchema, (input) => preflight.run(input))
  // The UI shows the pre-flight checklist first; here it is enforced again (cached, so cheap).
  reg.handle('generation:createBatch', createBatchSchema, async (input) => {
    await preflight.assertCanStart(input)
    return generation.createBatch(input)
  })

  reg.handle('queue:list', jobFilterSchema, (filter) => s.jobs.list(filter))
  reg.handle('queue:get', z.object({ id: idSchema }), ({ id }) => {
    const j = s.jobs.getView(id)
    if (!j) throw new AppError('config', 'Job not found.', { retryable: false })
    return j
  })
  reg.handle('queue:stats', null, () => engine.stats())
  reg.handle('queue:timings', z.object({ jobId: idSchema }), ({ jobId }) => s.jobs.timings(jobId))
  reg.handle('queue:timingSummary', z.object({ batchId: idSchema.optional(), limit: z.number().int().min(1).max(500).optional() }), (q) => s.jobs.timingSummary(q))
  reg.handle('queue:batches', null, () => s.jobs.listBatches())
  reg.handle('queue:pauseAll', null, () => engine.pauseAll())
  reg.handle('queue:resumeAll', null, () => engine.resumeAll())
  const idOnly = z.object({ id: idSchema })
  const view = (id: string) => {
    const v = s.jobs.getView(id)
    if (!v) throw new AppError('config', 'Job not found.', { retryable: false })
    return v
  }
  reg.handle('queue:pauseJob', idOnly, ({ id }) => {
    engine.pauseJob(id)
    return view(id)
  })
  reg.handle('queue:resumeJob', idOnly, ({ id }) => {
    engine.resumeJob(id)
    return view(id)
  })
  reg.handle('queue:retryJob', idOnly, ({ id }) => {
    engine.retryJob(id)
    return view(id)
  })
  reg.handle('queue:cancelJob', idOnly, ({ id }) => {
    engine.cancelJob(id)
    return view(id)
  })
  reg.handle('queue:removeJob', idOnly, ({ id }) => {
    engine.removeJob(id)
    return { ok: true as const }
  })
  reg.handle('queue:retryFailed', z.object({ batchId: idSchema.optional() }), ({ batchId }) => ({ retried: engine.retryFailed(batchId) }))
  reg.handle('queue:clearFinished', z.object({ batchId: idSchema.optional() }), ({ batchId }) => ({ removed: engine.clearFinished(batchId) }))
  reg.handle('queue:reorder', z.object({ ids: z.array(idSchema).max(5000) }), ({ ids }) => {
    s.jobs.reorder(ids)
    return s.jobs.list({ limit: 2000 })
  })
  reg.handle('queue:resolveResearch', resolveResearchSchema, ({ jobId, candidateIndex, manualTitle, manualNotes }) => {
    engine.resolveResearch(jobId, { candidateIndex, manualTitle, manualNotes })
    return view(jobId)
  })
  reg.handle('queue:approveScript', z.object({ jobId: idSchema, force: z.boolean().optional() }), ({ jobId, force }) => {
    engine.approveScript(jobId, !!force)
    return view(jobId)
  })
  reg.handle('queue:rejectScript', z.object({ jobId: idSchema, feedback: z.string().max(5000) }), ({ jobId, feedback }) => {
    engine.rejectScript(jobId, feedback)
    return view(jobId)
  })
  reg.handle('queue:regenerateScript', z.object({ jobId: idSchema, feedback: z.string().max(5000).optional() }), ({ jobId, feedback }) => {
    engine.regenerateScript(jobId, feedback)
    return view(jobId)
  })
  reg.handle('queue:regenerateAudio', regenerateAudioSchema, (input) => {
    const settings = s.settings.get()
    if (settings.generation.confirmExpensiveRegeneration && !input.confirmedCost) {
      const script = input.scriptId ? s.scripts.get(input.scriptId) : s.scripts.latestForProject(input.projectId)
      const chars = script?.charCount ?? 0
      const cost = (chars / 1000) * settings.spending.pricing.elevenlabsPer1kChars
      throw new AppError('config', `Regenerating this voiceover will use about ${chars.toLocaleString()} ElevenLabs characters (≈ $${cost.toFixed(2)} estimated).`, {
        action: 'Confirm the regeneration to continue.',
        retryable: false,
        code: 'CONFIRM_COST'
      })
    }
    const job = engine.regenerateAudio(input)
    return view(job.id)
  })
  reg.handle('queue:getResearch', z.object({ jobId: idSchema }), ({ jobId }) => {
    const job = s.jobs.get(jobId)
    if (!job) throw new AppError('config', 'Job not found.', { retryable: false })
    return (job.researchId ? s.research.get(job.researchId) : undefined) ?? s.research.latestForJob(jobId) ?? null
  })

  // ---------------------------------------------------------------------------
  // Scripts
  // ---------------------------------------------------------------------------

  reg.handle('scripts:list', libraryFilterSchema, (f) => s.scripts.list(f))
  reg.handle('scripts:get', idOnly, ({ id }) => {
    const sc = s.scripts.getView(id)
    if (!sc) throw new AppError('config', 'Script not found.', { retryable: false })
    return sc
  })
  reg.handle('scripts:versions', z.object({ projectId: idSchema }), ({ projectId }) => s.scripts.versions(projectId))
  reg.handle('scripts:saveEdit', z.object({ projectId: idSchema, text: z.string().min(1).max(200000), baseScriptId: idSchema.optional() }), ({ projectId, text, baseScriptId }) =>
    pipeline.saveManualScript(projectId, text, baseScriptId)
  )
  reg.handle('scripts:restore', z.object({ scriptId: idSchema }), ({ scriptId }) => {
    const sc = s.scripts.get(scriptId)
    if (!sc) throw new AppError('config', 'Script not found.', { retryable: false })
    return pipeline.saveManualScript(sc.projectId, sc.text, sc.id)
  })
  reg.handle('scripts:validate', z.object({ scriptId: idSchema }), ({ scriptId }) => pipeline.revalidate(scriptId))
  reg.handle('scripts:approve', z.object({ scriptId: idSchema, force: z.boolean().optional() }), ({ scriptId, force }) => {
    const sc = s.scripts.get(scriptId)
    if (!sc) throw new AppError('config', 'Script not found.', { retryable: false })
    const report = pipeline.revalidate(scriptId)
    if (!report.ok && !force) {
      const errs = report.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')
      throw new AppError('validation', `The script still has validation errors: ${errs}`, { action: 'Fix the listed issues, or approve anyway to use the script as it is.', retryable: false, code: 'APPROVE_NEEDS_FORCE' })
    }
    if (!report.ok) s.logger.log('warn', 'scripts', 'Script force-approved with validation errors', { scriptId, errors: report.issues.filter((i) => i.severity === 'error').map((i) => i.code) })
    return s.scripts.update(scriptId, { status: 'approved', approvedWithIssues: !report.ok })
  })
  reg.handle('scripts:export', z.object({ scriptId: idSchema, path: pathSchema }), async ({ scriptId, path: p }) => {
    const sc = s.scripts.get(scriptId)
    if (!sc) throw new AppError('config', 'Script not found.', { retryable: false })
    await atomicWriteFile(p, sc.text + '\n')
    return { ok: true as const }
  })

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  reg.handle('audio:list', libraryFilterSchema, (f) => s.audio.list(f))
  reg.handle('audio:get', idOnly, ({ id }) => {
    const a = s.audio.getView(id)
    if (!a) throw new AppError('config', 'Audio not found.', { retryable: false })
    return a
  })
  reg.handle('audio:versions', z.object({ projectId: idSchema }), ({ projectId }) => s.audio.versions(projectId))
  reg.handle('audio:export', z.object({ audioId: idSchema, path: pathSchema }), async ({ audioId, path: p }) => {
    const a = s.audio.get(audioId)
    if (!a) throw new AppError('config', 'Audio not found.', { retryable: false })
    if (!fs.existsSync(a.filePath)) throw new AppError('filesystem', 'The audio file is missing on disk.', { retryable: false })
    await fsp.copyFile(a.filePath, p)
    return { ok: true as const }
  })
  reg.handle('audio:delete', z.object({ audioId: idSchema, deleteFile: z.boolean() }), async ({ audioId, deleteFile }) => {
    const a = s.audio.get(audioId)
    if (!a) throw new AppError('config', 'Audio not found.', { retryable: false })
    if (deleteFile && fs.existsSync(a.filePath)) await fsp.unlink(a.filePath)
    s.audio.delete(audioId)
    return { ok: true as const }
  })

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  reg.handle('projects:list', libraryFilterSchema.extend({ includeArchived: z.boolean().optional() }), (f) => s.projects.list(f))
  reg.handle('projects:get', idOnly, ({ id }) => {
    const p = s.projects.getView(id)
    if (!p) throw new AppError('config', 'Project not found.', { retryable: false })
    return p
  })
  reg.handle('projects:rename', z.object({ id: idSchema, title: z.string().trim().min(1).max(200) }), ({ id, title }) => {
    projectsSvc.rename(id, title)
    return s.projects.getView(id)!
  })
  reg.handle('projects:archive', z.object({ id: idSchema, archived: z.boolean() }), ({ id, archived }) => {
    s.projects.update(id, { archived })
    return s.projects.getView(id)!
  })
  reg.handle('projects:openFolder', idOnly, async ({ id }) => {
    const p = s.projects.get(id)
    if (!p) throw new AppError('config', 'Project not found.', { retryable: false })
    const dir = projectsSvc.ensureFolder(p)
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err } : { ok: true }
  })
  reg.handle('projects:export', z.object({ id: idSchema, destinationDir: pathSchema }), async ({ id, destinationDir }) => {
    const p = s.projects.get(id)
    if (!p) throw new AppError('config', 'Project not found.', { retryable: false })
    const dest = path.join(destinationDir, p.folderName)
    if (p.layout === 'flat') {
      // Flat layout shares the channel folder: export only this project's finished files.
      await fsp.mkdir(dest, { recursive: true })
      const files = [...s.scripts.versions(id).map((x) => x.filePath), ...s.audio.versions(id).map((a) => a.filePath)].filter((f): f is string => !!f && projectsSvc.isPublishedFile(p, f) && fs.existsSync(f))
      for (const f of new Set(files)) await fsp.copyFile(f, path.join(dest, path.basename(f)))
      return { path: dest }
    }
    const src = projectsSvc.ensureFolder(p)
    await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false })
    return { path: dest }
  })
  reg.handle('projects:delete', z.object({ id: idSchema, deleteFiles: z.boolean() }), async ({ id, deleteFiles }) => {
    const p = s.projects.get(id)
    if (!p) throw new AppError('config', 'Project not found.', { retryable: false })
    const dir = projectsSvc.folderFor(p)
    const published = [...s.scripts.versions(id).map((x) => x.filePath), ...s.audio.versions(id).map((a) => a.filePath)].filter((f): f is string => !!f && projectsSvc.isPublishedFile(p, f))
    const work = path.join(s.paths.userData, 'projects', p.id)
    s.projects.delete(id)
    // Drafts/metadata in app data always go with the project.
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined)
    if (deleteFiles) {
      if (p.layout === 'flat') {
        // Never remove the shared channel folder — only this project's own files.
        for (const f of new Set(published)) await fsp.unlink(f).catch(() => undefined)
      } else if (fs.existsSync(dir)) {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    }
    return { ok: true as const }
  })

  // ---------------------------------------------------------------------------
  // History, usage, backups
  // ---------------------------------------------------------------------------

  reg.handle('history:list', z.object({ limit: z.number().int().min(1).max(5000).optional(), jobId: idSchema.optional(), search: z.string().max(200).optional() }), (o) => s.jobs.listEvents(o))
  reg.handle('history:exportReport', z.object({ batchId: idSchema.optional(), path: pathSchema }), async ({ batchId, path: p }) => {
    const jobs = s.jobs.list({ batchId, limit: 5000 })
    const header = ['Title', 'Channel', 'Batch', 'Status', 'Stage', 'Mode', 'Research attempts', 'Script attempts', 'Audio attempts', 'Script chars', 'Audio file', 'Last error', 'Created', 'Completed']
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [header.map(esc).join(',')]
    for (const j of jobs) {
      lines.push([j.title, j.channelName, j.batchName, j.status, j.stage, j.mode, j.researchAttempts, j.scriptAttempts, j.audioAttempts, j.scriptCharCount ?? '', j.audioFilePath ?? '', j.lastError?.message ?? '', j.createdAt, j.completedAt ?? ''].map(esc).join(','))
    }
    await atomicWriteFile(p, '﻿' + lines.join('\r\n') + '\r\n')
    return { ok: true as const }
  })
  reg.handle('usage:summary', usageRangeSchema, ({ from, to }) => {
    // Date-only values ("2026-10-17") are treated as whole local days.
    const dayStart = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toISOString() : d)
    const dayEnd = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T23:59:59.999`).toISOString() : d)
    const toIso = to ? dayEnd(to) : new Date().toISOString()
    const fromIso = from ? dayStart(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    return s.usage.summary(fromIso, toIso)
  })
  reg.handle('usage:savings', usageRangeSchema, ({ from, to }) => {
    const dayStart = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toISOString() : d)
    const dayEnd = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T23:59:59.999`).toISOString() : d)
    const toIso = to ? dayEnd(to) : new Date().toISOString()
    const fromIso = from ? dayStart(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const r = s.reuse.summary(fromIso, toIso)
    return {
      range: { from: fromIso, to: toIso },
      researchCallsAvoided: r.research,
      estimatedTokensSaved: r.tokens,
      elevenCharactersSaved: r.characters,
      audioFilesReused: r.files,
      audioPartsReused: r.parts,
      estimatedUsdSaved: Math.round(r.usd * 10000) / 10000,
      estimatesLabel: 'Estimates — based on typical research size and your configured prices.'
    }
  })

  // ---- Game Library (1.6.0) -------------------------------------------------
  const library = engine.pipeline.library
  const gameText = z.string().trim().min(1).max(2000)
  const gameView = (id: string) => library.view(library.require(id))
  reg.handle(
    'games:list',
    z.object({ query: z.string().max(200).optional(), subject: z.enum(['game', 'product', 'all']).optional(), limit: z.number().int().min(1).max(5000).optional() }),
    (q) => s.games.list({ subject: q.subject ?? 'all', query: q.query, limit: q.limit }).map((g) => library.view(g))
  )
  reg.handle('games:get', idOnly, ({ id }) => gameView(id))
  reg.handle(
    'games:update',
    z.object({ id: idSchema, canonicalTitle: z.string().trim().min(1).max(300).optional(), userNotes: z.string().max(20000).optional(), pinned: z.boolean().optional() }),
    ({ id, canonicalTitle, userNotes, pinned }) => {
      library.require(id)
      // Renaming keeps the old name as an alias (GameRepo.update), so it still matches typed titles.
      s.games.update(id, { ...(canonicalTitle ? { canonicalTitle } : {}), ...(userNotes !== undefined ? { userNotes } : {}), ...(pinned !== undefined ? { pinned } : {}) })
      return gameView(id)
    }
  )
  reg.handle('games:addFact', z.object({ id: idSchema, text: gameText }), ({ id, text }) => library.view(library.addFact(id, text)))
  reg.handle('games:removeFact', z.object({ id: idSchema, text: gameText }), ({ id, text }) => library.view(library.removeFact(id, text)))
  reg.handle('games:restoreFact', z.object({ id: idSchema, text: gameText }), ({ id, text }) => library.view(library.restoreFact(id, text)))
  reg.handle('games:addAlias', z.object({ id: idSchema, alias: z.string().trim().min(1).max(300) }), ({ id, alias }) => library.view(library.addAlias(id, alias)))
  reg.handle('games:removeAlias', z.object({ id: idSchema, alias: z.string().trim().min(1).max(300) }), ({ id, alias }) => {
    library.require(id)
    s.games.removeAlias(id, alias)
    return gameView(id)
  })
  reg.handle('games:refresh', idOnly, async ({ id }) => library.view(await library.refresh(id)))
  reg.handle('games:delete', idOnly, ({ id }) => {
    library.require(id)
    s.games.delete(id)
    return { ok: true as const }
  })
  reg.handle('games:export', null, async () => {
    const res = await dialog.showSaveDialog(win(deps)!, {
      title: 'Export saved games',
      defaultPath: path.join(app.getPath('documents'), `voiceforge-games-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    return { path: res.filePath, count: library.exportToFile(res.filePath) }
  })
  reg.handle('games:import', null, async () => {
    const res = await dialog.showOpenDialog(win(deps)!, { title: 'Import saved games', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    const file = res.filePaths[0]
    if (res.canceled || !file) return null
    let raw: unknown
    try {
      raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      throw new AppError('config', 'The file is not valid JSON.', { retryable: false })
    }
    return library.importJson(raw)
  })
  reg.handle('games:match', z.object({ titles: z.array(z.string().max(300)).max(5000), channelId: idSchema }), ({ titles, channelId }) => {
    const channel = s.channels.get(channelId)
    if (!channel) return titles.map((title) => ({ title, kind: 'none' as const, gameId: null, canonicalTitle: null, candidates: [] }))
    return library.matchMany(titles, channel.category)
  })
  reg.handle('queue:copyScripts', z.object({ batchId: idSchema }), ({ batchId }) => {
    const jobs = s.jobs
      .list({ batchId, status: ['completed'], limit: 2000 })
      .slice()
      .sort((a, b) => a.position - b.position)
    const blocks: string[] = []
    for (const j of jobs) {
      const script = (j.scriptId ? s.scripts.get(j.scriptId) : undefined) ?? s.scripts.latestForProject(j.projectId)
      if (!script || !script.text.trim()) continue
      blocks.push(`${j.title}\n\n${script.text.trim()}`)
    }
    if (!blocks.length) throw new AppError('config', 'No finished scripts in this batch yet.', { retryable: false, code: 'NO_SCRIPTS' })
    const text = blocks.join('\n\n\n')
    clipboard.writeText(text)
    return { count: blocks.length, characters: text.length }
  })
  reg.handle('backup:create', null, () => backup.create())
  reg.handle('backup:list', null, () => backup.list())
  reg.handle('backup:restore', z.object({ path: pathSchema }), async ({ path: p }) => {
    await backup.stageRestore(p)
    deps.requestRestart()
    return { ok: true as const, restartRequired: true as const }
  })
  reg.handle('backup:exportData', z.object({ kind: exportKindSchema, path: pathSchema }), async ({ kind, path: p }) => {
    await atomicWriteFile(p, backup.exportData(kind))
    return { ok: true as const }
  })
  reg.handle('backup:importData', z.object({ path: pathSchema }), async ({ path: p }) => backup.importData(await fsp.readFile(p, 'utf8')))

  void app
}

