import type {
  AppInfo,
  AppSettings,
  AudioView,
  BackupInfo,
  Batch,
  BatchEstimate,
  Channel,
  ChannelInput,
  ConnectionTestResult,
  CreateBatchInput,
  CreateBatchResult,
  ElevenModel,
  ElevenSubscription,
  ElevenVoice,
  JobEvent,
  JobView,
  OpenAIModelInfo,
  ParsedTitles,
  ProjectView,
  QueueStats,
  ResearchResult,
  Script,
  ScriptView,
  SecretsStatus,
  Template,
  TemplateAnalysis,
  TemplateVersion,
  TemplateVersionInput,
  UpdateStatus,
  UsageSummary,
  ValidationReport
} from './types'

/**
 * The full list of request/response pairs the renderer may invoke.
 * The preload script exposes exactly these through `window.vf`.
 * Main registers one handler per key and validates the payload with zod.
 */
export interface IpcContract {
  // App
  'app:info': { req: void; res: AppInfo }
  'app:openPath': { req: { path: string }; res: { ok: boolean; message?: string } }
  'app:showItemInFolder': { req: { path: string }; res: void }
  'app:selectFolder': { req: { title?: string; defaultPath?: string }; res: string | null }
  'app:selectFiles': {
    req: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multiple?: boolean }
    res: string[]
  }
  'app:saveFileDialog': { req: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }; res: string | null }
  'app:copyToClipboard': { req: { text: string }; res: void }
  'app:readClipboard': { req: void; res: string }
  'app:openLogs': { req: void; res: void }
  'app:readRecentLogs': { req: { lines?: number }; res: string[] }
  'app:dbIntegrityCheck': { req: void; res: { ok: boolean; details: string } }
  'app:resetSettings': { req: void; res: AppSettings }

  // Updates (electron-updater, GitHub Releases, user-initiated download + install)
  'updates:status': { req: void; res: UpdateStatus }
  'updates:check': { req: void; res: UpdateStatus }
  'updates:download': { req: void; res: UpdateStatus }
  'updates:install': { req: void; res: { ok: boolean; message?: string } }

  // Settings & secrets
  'settings:get': { req: void; res: AppSettings }
  'settings:update': { req: unknown; res: AppSettings }
  'secrets:status': { req: void; res: SecretsStatus }
  'secrets:set': { req: { provider: 'openai' | 'elevenlabs'; value: string }; res: SecretsStatus }
  'secrets:clear': { req: { provider: 'openai' | 'elevenlabs' }; res: SecretsStatus }

  // Providers
  'openai:test': { req: void; res: ConnectionTestResult }
  'openai:listModels': { req: void; res: OpenAIModelInfo[] }
  'eleven:test': { req: void; res: ConnectionTestResult }
  'eleven:listVoices': { req: { refresh?: boolean }; res: ElevenVoice[] }
  'eleven:listModels': { req: { refresh?: boolean }; res: ElevenModel[] }
  'eleven:subscription': { req: void; res: ElevenSubscription | null }
  'eleven:toggleFavorite': { req: { voiceId: string }; res: ElevenVoice[] }
  'eleven:previewVoice': { req: { voiceId: string }; res: { url: string | null } }

  // Channels
  'channels:list': { req: { includeArchived?: boolean }; res: Channel[] }
  'channels:get': { req: { id: string }; res: Channel }
  'channels:create': { req: ChannelInput; res: Channel }
  'channels:update': { req: { id: string; patch: Partial<ChannelInput> }; res: Channel }
  'channels:delete': { req: { id: string; deleteFiles: boolean }; res: { ok: true } }
  'channels:duplicate': { req: { id: string }; res: Channel }
  'channels:export': { req: { id: string; path?: string }; res: { json: string; savedTo: string | null } }
  'channels:import': { req: { json?: string; path?: string }; res: Channel }
  'channels:reorder': { req: { ids: string[] }; res: Channel[] }

  // Templates
  'templates:list': { req: { channelId: string }; res: Template[] }
  'templates:create': { req: { channelId: string; name: string; initial: TemplateVersionInput }; res: Template }
  'templates:rename': { req: { templateId: string; name: string }; res: Template }
  'templates:delete': { req: { templateId: string }; res: { ok: true } }
  'templates:versions': { req: { templateId: string }; res: TemplateVersion[] }
  'templates:getVersion': { req: { versionId: string }; res: TemplateVersion }
  'templates:addVersion': { req: { templateId: string; input: TemplateVersionInput }; res: TemplateVersion }
  'templates:setActive': { req: { channelId: string; versionId: string }; res: Channel }
  'templates:analyze': { req: { channelId: string; exampleScript: string; instructions: string }; res: TemplateAnalysis }

  // Generation
  'generation:parseTitles': { req: { text: string }; res: ParsedTitles }
  'generation:importTitles': { req: { path: string }; res: ParsedTitles }
  'generation:estimate': { req: CreateBatchInput; res: BatchEstimate }
  'generation:createBatch': { req: CreateBatchInput; res: CreateBatchResult }

  // Queue
  'queue:list': { req: unknown; res: JobView[] }
  'queue:get': { req: { id: string }; res: JobView }
  'queue:stats': { req: void; res: QueueStats }
  'queue:batches': { req: void; res: Batch[] }
  'queue:pauseAll': { req: void; res: QueueStats }
  'queue:resumeAll': { req: void; res: QueueStats }
  'queue:pauseJob': { req: { id: string }; res: JobView }
  'queue:resumeJob': { req: { id: string }; res: JobView }
  'queue:retryJob': { req: { id: string }; res: JobView }
  'queue:cancelJob': { req: { id: string }; res: JobView }
  'queue:removeJob': { req: { id: string }; res: { ok: true } }
  'queue:retryFailed': { req: { batchId?: string }; res: { retried: number } }
  'queue:clearFinished': { req: { batchId?: string }; res: { removed: number } }
  'queue:reorder': { req: { ids: string[] }; res: JobView[] }
  'queue:resolveResearch': {
    req: { jobId: string; candidateIndex?: number; manualTitle?: string; manualNotes?: string }
    res: JobView
  }
  'queue:approveScript': { req: { jobId: string }; res: JobView }
  'queue:rejectScript': { req: { jobId: string; feedback: string }; res: JobView }
  'queue:regenerateScript': { req: { jobId: string; feedback?: string }; res: JobView }
  'queue:regenerateAudio': { req: unknown; res: JobView }
  'queue:getResearch': { req: { jobId: string }; res: ResearchResult | null }

  // Scripts
  'scripts:list': { req: unknown; res: ScriptView[] }
  'scripts:get': { req: { id: string }; res: ScriptView }
  'scripts:versions': { req: { projectId: string }; res: Script[] }
  'scripts:saveEdit': { req: { projectId: string; text: string; baseScriptId?: string }; res: Script }
  'scripts:restore': { req: { scriptId: string }; res: Script }
  'scripts:validate': { req: { scriptId: string }; res: ValidationReport }
  'scripts:approve': { req: { scriptId: string }; res: Script }
  'scripts:export': { req: { scriptId: string; path: string }; res: { ok: true } }

  // Audio
  'audio:list': { req: unknown; res: AudioView[] }
  'audio:get': { req: { id: string }; res: AudioView }
  'audio:versions': { req: { projectId: string }; res: AudioView[] }
  'audio:export': { req: { audioId: string; path: string }; res: { ok: true } }
  'audio:delete': { req: { audioId: string; deleteFile: boolean }; res: { ok: true } }

  // Projects
  'projects:list': { req: unknown; res: ProjectView[] }
  'projects:get': { req: { id: string }; res: ProjectView }
  'projects:rename': { req: { id: string; title: string }; res: ProjectView }
  'projects:archive': { req: { id: string; archived: boolean }; res: ProjectView }
  'projects:openFolder': { req: { id: string }; res: { ok: boolean; message?: string } }
  'projects:export': { req: { id: string; destinationDir: string }; res: { path: string } }
  'projects:delete': { req: { id: string; deleteFiles: boolean }; res: { ok: true } }

  // History / usage / backups
  'history:list': { req: { limit?: number; jobId?: string; search?: string }; res: JobEvent[] }
  'history:exportReport': { req: { batchId?: string; path: string }; res: { ok: true } }
  'usage:summary': { req: { from?: string; to?: string }; res: UsageSummary }
  'backup:create': { req: void; res: BackupInfo }
  'backup:list': { req: void; res: BackupInfo[] }
  'backup:restore': { req: { path: string }; res: { ok: true; restartRequired: true } }
  'backup:exportData': { req: { kind: string; path: string }; res: { ok: true } }
  'backup:importData': { req: { path: string }; res: { channels: number; templates: number } }
}

export type IpcChannelName = keyof IpcContract
export type IpcReq<K extends IpcChannelName> = IpcContract[K]['req']
export type IpcRes<K extends IpcChannelName> = IpcContract[K]['res']

/** Shape of a failed invoke; thrown as an Error in the renderer. */
export interface IpcErrorPayload {
  code: string
  message: string
  action?: string
  details?: string
}

export const DASHBOARD_PAGES = [
  'dashboard',
  'generate',
  'channels',
  'queue',
  'scripts',
  'audio',
  'projects',
  'history',
  'usage',
  'settings'
] as const

export type PageId = (typeof DASHBOARD_PAGES)[number]
