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
  GameView,
  GameMatch,
  ReuseSavings,
  JobTimings,
  TimingSummary,
  PreflightResult,
  ReferenceScript,
  ReferenceFormat,
  StyleAnalysis,
  StyleTestResult,
  TemplateApprovalStatus,
  FixedTextBlock,
  ChannelOpening,
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
  'templates:create': { req: { channelId: string; name: string; contentType?: string; initial: TemplateVersionInput }; res: Template }
  'templates:rename': { req: { templateId: string; name: string }; res: Template }
  'templates:delete': { req: { templateId: string }; res: { ok: true } }
  'templates:versions': { req: { templateId: string }; res: TemplateVersion[] }
  'templates:getVersion': { req: { versionId: string }; res: TemplateVersion }
  'templates:addVersion': { req: { templateId: string; input: TemplateVersionInput }; res: TemplateVersion }
  'templates:setActive': { req: { channelId: string; versionId: string }; res: Channel }
  'templates:analyze': { req: { channelId: string; exampleScript: string; instructions: string }; res: TemplateAnalysis }

  // Channel Style Preservation Studio
  'references:list': { req: { templateId: string }; res: ReferenceScript[] }
  'references:add': { req: { templateId: string; title: string; text: string; sourceFormat?: ReferenceFormat; sourceFileName?: string | null }; res: ReferenceScript }
  /** Main reads TXT/MD/DOCX/PDF itself (paths come from app:selectFiles or drag-and-drop). */
  'references:importFiles': { req: { templateId: string; paths: string[] }; res: { added: ReferenceScript[]; failed: Array<{ path: string; message: string }> } }
  'references:update': { req: { id: string; title?: string; text?: string }; res: ReferenceScript }
  'references:delete': { req: { id: string }; res: { ok: true } }
  /** Deterministic fixed-text detection + OpenAI style analysis over all references of the template. */
  'style:analyze': { req: { templateId: string; instructions?: string }; res: StyleAnalysis }
  'style:lastAnalysis': { req: { templateId: string }; res: StyleAnalysis | null }
  /** Approve/reject/lock: sets the status of a version (user action only). */
  /** Fast path: the default format's locked intro/outro + the "short channel introduction" toggle. */
  'channels:getOpening': { req: { channelId: string }; res: ChannelOpening }
  /** Saves intro/outro as locked spoken blocks in a NEW version of the default format (same status). */
  'channels:setOpening': { req: { channelId: string; intro: string; outro: string; openWithChannelIntro: boolean }; res: ChannelOpening }
  'templates:setApproval': { req: { versionId: string; status: TemplateApprovalStatus }; res: TemplateVersion }
  /** Makes a format the channel's default (used when a batch does not pick one). */
  'templates:setDefault': { req: { channelId: string; templateId: string }; res: Channel }
  'templates:setFixedBlocks': { req: { versionId: string; blocks: FixedTextBlock[] }; res: TemplateVersion }
  /** Generates a test script for one title (Scripts-only, not saved to the libraries) and a compliance report. */
  'style:test': { req: { templateId: string; title: string; notes?: string }; res: StyleTestResult }
  'style:tests': { req: { templateId: string; limit?: number }; res: StyleTestResult[] }

  // Generation
  'generation:parseTitles': { req: { text: string }; res: ParsedTitles }
  'generation:importTitles': { req: { path: string }; res: ParsedTitles }
  'generation:estimate': { req: CreateBatchInput; res: BatchEstimate }
  'generation:createBatch': { req: CreateBatchInput; res: CreateBatchResult }
  /** Fast checks before a batch (keys, voices, characters, folder, disk); cached 60 s. */
  'generation:preflight': { req: CreateBatchInput; res: PreflightResult }

  // Queue
  'queue:list': { req: unknown; res: JobView[] }
  'queue:get': { req: { id: string }; res: JobView }
  'queue:stats': { req: void; res: QueueStats }
  /** Per-stage timing of one job (from its status history). */
  'queue:timings': { req: { jobId: string }; res: JobTimings }
  /** Median stage durations of recent finished jobs (optionally one batch). */
  'queue:timingSummary': { req: { batchId?: string; limit?: number }; res: TimingSummary }
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
  'queue:approveScript': { req: { jobId: string; force?: boolean }; res: JobView }
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
  'scripts:approve': { req: { scriptId: string; force?: boolean }; res: Script }
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
  'usage:savings': { req: { from?: string; to?: string }; res: ReuseSavings }

  // Game Library (1.6.0)
  'games:list': { req: { query?: string; subject?: 'game' | 'product' | 'all'; limit?: number }; res: GameView[] }
  'games:get': { req: { id: string }; res: GameView }
  'games:update': { req: { id: string; canonicalTitle?: string; userNotes?: string; pinned?: boolean }; res: GameView }
  'games:addFact': { req: { id: string; text: string }; res: GameView }
  /** Marks a fact as wrong (removed from prompts) or removes a user-added fact. */
  'games:removeFact': { req: { id: string; text: string }; res: GameView }
  'games:restoreFact': { req: { id: string; text: string }; res: GameView }
  'games:addAlias': { req: { id: string; alias: string }; res: GameView }
  'games:removeAlias': { req: { id: string; alias: string }; res: GameView }
  /** Researches the entry again (uses OpenAI credits) and keeps the user's notes, facts and aliases. */
  'games:refresh': { req: { id: string }; res: GameView }
  'games:delete': { req: { id: string }; res: { ok: true } }
  'games:export': { req: void; res: { path: string; count: number } | null }
  'games:import': { req: void; res: { added: number; merged: number } | null }
  /** Classifies typed titles against the library (exact / auto / near / none) for one channel. */
  'games:match': { req: { titles: string[]; channelId: string }; res: GameMatch[] }

  /** Copies every finished script of a batch (title above each, one below another) to the clipboard. */
  'queue:copyScripts': { req: { batchId: string }; res: { count: number; characters: number } }
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
  'settings',
  // 1.6.0 — appended so Ctrl+1 … Ctrl+0 keep their meaning; reachable from the sidebar and Ctrl+K.
  'games'
] as const

export type PageId = (typeof DASHBOARD_PAGES)[number]
