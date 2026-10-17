/**
 * Shared domain types used by the main process, preload bridge and renderer.
 * Keep this file free of runtime imports (types only) so both tsconfigs can consume it.
 */

// ---------------------------------------------------------------------------
// Channels & templates
// ---------------------------------------------------------------------------

export type ContentCategory = 'gaming' | 'tech' | 'other'

export interface ScriptSection {
  /** Stable key, e.g. "gameplay" */
  key: string
  /** Heading as it appears in the script, e.g. "Gameplay" */
  label: string
  /** Validation fails when a required section is missing. */
  required: boolean
  /** Alternative headings accepted by the validator (case-insensitive). */
  aliases: string[]
  /** Guidance for the writer about what belongs in this section. */
  guidance: string
}

export interface PronunciationRule {
  /** Text as written in the script */
  from: string
  /** Replacement sent to ElevenLabs (e.g. phonetic spelling) */
  to: string
}

export interface VoiceSettings {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

export type ResearchMode = 'openai_web_search' | 'model_knowledge' | 'manual'

export interface ResearchSettings {
  enabled: boolean
  mode: ResearchMode
  /** Minimum confidence (0-1) required to continue automatically. */
  minConfidence: number
  searchContextSize: 'low' | 'medium' | 'high'
  /** Stop and ask when the title is ambiguous. */
  askOnAmbiguity: boolean
  /** Extra guidance appended to the research prompt (e.g. "prefer Steam store page"). */
  extraInstructions: string
}

export interface ValidationRules {
  /** Fail when the text contains URLs. */
  forbidUrls: boolean
  /** Fail on citation markers such as [1], (source: ...) */
  forbidCitations: boolean
  /** Fail on markdown markers (#, **, bullets). */
  forbidMarkdown: boolean
  /** Require every required section to appear in the declared order. */
  enforceSectionOrder: boolean
  /** Run an additional AI review pass for unsupported claims. */
  aiReviewPass: boolean
  /** Maximum automatic rewrite attempts when validation fails. */
  maxRewriteAttempts: number
  /** Words per minute used for duration estimates. */
  wordsPerMinute: number
  /** Language code the script must be in (e.g. "en"). */
  language: string
  /** Case-insensitive, whole-word phrases that must not appear. */
  forbiddenPhrases: string[]
  /** Whether section headings are spoken (kept in TTS text) or stripped before TTS. */
  narrateSectionHeadings: boolean
}

export interface Channel {
  id: string
  name: string
  slug: string
  icon: string
  color: string
  description: string
  category: ContentCategory
  language: string
  writingInstructions: string
  writingStyle: string
  introRequirements: string
  outroRequirements: string
  targetDurationSec: number
  minChars: number
  maxChars: number
  pronunciationRules: PronunciationRule[]
  elevenVoiceId: string | null
  elevenVoiceName: string | null
  elevenModelId: string
  elevenVoiceSettings: VoiceSettings
  outputFormat: string
  /** Per-channel override of the root output folder (null = global default). */
  outputFolder: string | null
  /** Per-channel OpenAI model override (null = global default). */
  openaiModel: string | null
  research: ResearchSettings
  validation: ValidationRules
  activeTemplateVersionId: string | null
  /** Sort order in the sidebar / pickers. */
  position: number
  archived: boolean
  createdAt: string
  updatedAt: string
}

export type ChannelInput = Omit<Channel, 'id' | 'slug' | 'createdAt' | 'updatedAt' | 'position' | 'activeTemplateVersionId'> &
  Partial<Pick<Channel, 'activeTemplateVersionId' | 'position'>>

export interface Template {
  id: string
  channelId: string
  name: string
  createdAt: string
  updatedAt: string
  latestVersion: number
  activeVersionId: string | null
}

export interface TemplateVersion {
  id: string
  templateId: string
  channelId: string
  version: number
  /** The system prompt sent to the model (channel voice, rules, do/don't). */
  systemPrompt: string
  /** Ordered sections the script must contain. */
  structure: ScriptSection[]
  /** An approved example script used as a style reference. */
  exampleScript: string | null
  /** Human notes about the version (changelog). */
  notes: string
  /** When true, the template is considered a placeholder awaiting the approved text. */
  placeholder: boolean
  createdAt: string
}

export interface TemplateVersionInput {
  systemPrompt: string
  structure: ScriptSection[]
  exampleScript: string | null
  notes: string
  placeholder?: boolean
}

export interface TemplateAnalysis {
  suggestedStructure: ScriptSection[]
  suggestedSystemPrompt: string
  observations: string[]
  charCount: number
  wordCount: number
  caveats: string[]
}

// ---------------------------------------------------------------------------
// Jobs, batches, projects
// ---------------------------------------------------------------------------

export type JobMode = 'auto' | 'review_before_voice' | 'scripts_only'

export type JobStatus =
  | 'pending'
  | 'researching'
  | 'research_review_required'
  | 'writing_script'
  | 'validating_script'
  | 'script_ready'
  | 'awaiting_approval'
  | 'generating_audio'
  | 'saving_files'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'

export type JobStage = 'research' | 'script' | 'approval' | 'audio' | 'save' | 'done'

export type ErrorKind =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'provider_down'
  | 'validation'
  | 'ambiguous'
  | 'insufficient_info'
  | 'spending_limit'
  | 'filesystem'
  | 'cancelled'
  | 'config'
  | 'unknown'

export interface JobError {
  kind: ErrorKind
  message: string
  /** What the user can do about it. */
  action: string
  /** Provider / stack details (never contains secrets). */
  details?: string
  retryable: boolean
  at: string
}

export interface Job {
  id: string
  batchId: string
  projectId: string
  channelId: string
  title: string
  mode: JobMode
  status: JobStatus
  stage: JobStage
  position: number
  researchAttempts: number
  scriptAttempts: number
  audioAttempts: number
  researchId: string | null
  scriptId: string | null
  audioId: string | null
  lastError: JobError | null
  /** Status before the job was paused, so resume can continue from the right place. */
  resumeStatus: JobStatus | null
  manualResearchNotes: string | null
  /** Per-job overrides (used by "regenerate audio with another voice" and script feedback). */
  overrides: JobOverrides | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface JobOverrides {
  voiceId?: string
  voiceName?: string
  modelId?: string
  voiceSettings?: VoiceSettings
  scriptFeedback?: string
  /** Use this exact script version instead of generating one (audio regeneration). */
  useScriptId?: string
}

export interface JobView extends Job {
  channelName: string
  channelColor: string
  channelIcon: string
  batchName: string
  projectFolder: string | null
  scriptCharCount: number | null
  audioFilePath: string | null
}

export interface Batch {
  id: string
  name: string
  mode: JobMode
  createdAt: string
  total: number
  completed: number
  failed: number
}

export interface Project {
  id: string
  channelId: string
  title: string
  folderName: string
  folderPath: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectView extends Project {
  channelName: string
  channelColor: string
  channelIcon: string
  scriptCount: number
  audioCount: number
  latestJobStatus: JobStatus | null
  latestAudioPath: string | null
}

export interface QueueStats {
  total: number
  pending: number
  processing: number
  awaitingUser: number
  completed: number
  failed: number
  paused: number
  cancelled: number
  queuePaused: boolean
  spendingPaused: boolean
  estimatedSecondsRemaining: number | null
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ReleaseStatus = 'released' | 'early_access' | 'unreleased' | 'unknown'

export interface ResearchCandidate {
  title: string
  developer: string
  year: string
  note: string
}

export interface ResearchSource {
  title: string
  url: string
}

export interface ResearchData {
  subjectType: 'game' | 'product'
  canonicalTitle: string
  developer: string
  publisher: string
  genre: string
  releaseStatus: ReleaseStatus
  releaseDate: string
  platforms: string[]
  summary: string
  gameplayMechanics: string[]
  combatSystems: string
  explorationSystems: string
  multiplayer: string
  keyMechanics: string[]
  technicalInfo: string[]
  specifications: string[]
  confirmedFacts: string[]
  uncertainFacts: string[]
  confidence: number
  ambiguityCandidates: ResearchCandidate[]
  insufficientReason: string
}

export interface ResearchResult {
  id: string
  jobId: string
  projectId: string
  status: 'confirmed' | 'ambiguous' | 'insufficient' | 'manual'
  data: ResearchData
  sources: ResearchSource[]
  model: string | null
  mode: ResearchMode
  createdAt: string
}

// ---------------------------------------------------------------------------
// Scripts & audio
// ---------------------------------------------------------------------------

export type ScriptStatus = 'draft' | 'validated' | 'approved' | 'rejected' | 'invalid'

export interface ValidationIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
  charCount: number
  wordCount: number
  estimatedDurationSec: number
  sectionsFound: string[]
  checkedAt: string
}

export interface Script {
  id: string
  projectId: string
  jobId: string | null
  version: number
  templateVersionId: string | null
  templateVersionNumber: number | null
  text: string
  charCount: number
  wordCount: number
  estimatedDurationSec: number
  status: ScriptStatus
  source: 'ai' | 'manual' | 'rewrite'
  model: string | null
  validation: ValidationReport | null
  filePath: string | null
  createdAt: string
}

export interface ScriptView extends Script {
  title: string
  channelId: string
  channelName: string
  channelColor: string
}

export type AudioStatus = 'generating' | 'ready' | 'failed'

export interface AudioFile {
  id: string
  projectId: string
  scriptId: string
  jobId: string | null
  version: number
  filePath: string
  voiceId: string
  voiceName: string
  modelId: string
  voiceSettings: VoiceSettings
  outputFormat: string
  bytes: number
  durationSec: number | null
  sha256: string | null
  characters: number
  chunkCount: number
  status: AudioStatus
  createdAt: string
}

export interface AudioView extends AudioFile {
  title: string
  channelId: string
  channelName: string
  channelColor: string
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ElevenVoice {
  voiceId: string
  name: string
  category: string
  description: string
  previewUrl: string | null
  labels: Record<string, string>
  favorite: boolean
}

export interface ElevenModel {
  modelId: string
  name: string
  description: string
  canDoTextToSpeech: boolean
  canUseStyle: boolean
  canUseSpeakerBoost: boolean
  maxCharacters: number | null
  languages: string[]
}

export interface ElevenSubscription {
  tier: string
  characterCount: number
  characterLimit: number
  nextResetUnix: number | null
  status: string
}

export interface OpenAIModelInfo {
  id: string
  created: number
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  details?: string
}

// ---------------------------------------------------------------------------
// Usage & costs
// ---------------------------------------------------------------------------

export interface PricingConfig {
  /** USD per 1M tokens per model id; "default" is used when a model is missing. */
  openai: Record<string, { input: number; output: number }>
  /** USD per 1,000 ElevenLabs characters (depends on the user's plan). */
  elevenlabsPer1kChars: number
  currency: 'USD'
}

export interface UsageEvent {
  id: string
  provider: 'openai' | 'elevenlabs'
  kind: string
  model: string | null
  jobId: string | null
  channelId: string | null
  projectId: string | null
  inputTokens: number
  outputTokens: number
  characters: number
  estimatedCost: number
  reported: Record<string, unknown> | null
  createdAt: string
}

export interface UsageSummary {
  range: { from: string; to: string }
  openai: { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }
  elevenlabs: { requests: number; characters: number; estimatedCost: number }
  byChannel: Array<{ channelId: string; channelName: string; jobs: number; openaiCost: number; elevenCost: number }>
  byProject: Array<{ projectId: string; title: string; channelName: string; openaiCost: number; elevenCost: number }>
  daily: Array<{ day: string; openaiCost: number; elevenCost: number; requests: number }>
  monthly: Array<{ month: string; openaiCost: number; elevenCost: number; requests: number }>
  todaySpend: number
  monthSpend: number
  estimatesLabel: string
}

export interface BatchEstimate {
  jobs: number
  estimatedOpenAICost: number
  estimatedElevenCost: number
  estimatedTotal: number
  estimatedCharacters: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light' | 'system'

export interface AppSettings {
  general: {
    theme: Theme
    language: 'en' | 'sr'
    launchAtStartup: boolean
    notifications: boolean
    outputRoot: string | null
    autoOpenFolderOnBatchComplete: boolean
  }
  openai: {
    defaultModel: string
    researchModel: string
    reviewModel: string
    temperature: number
    maxOutputTokens: number
    timeoutMs: number
    maxRetries: number
    concurrency: number
    reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  }
  elevenlabs: {
    defaultModelId: string
    defaultOutputFormat: string
    timeoutMs: number
    maxRetries: number
    concurrency: number
    /** Chunk size override (chars). 0 = use model limit. */
    maxCharsPerRequest: number
  }
  generation: {
    defaultMode: JobMode
    maxConcurrentJobs: number
    maxRewriteAttempts: number
    maxStageRetries: number
    validationStrictness: 'relaxed' | 'standard' | 'strict'
    duplicateDetection: boolean
    largeBatchWarningThreshold: number
    confirmExpensiveRegeneration: boolean
  }
  spending: {
    dailyLimitUsd: number | null
    monthlyLimitUsd: number | null
    pricing: PricingConfig
  }
  storage: {
    backupDir: string | null
    autoBackupEveryHours: number
    keepBackups: number
    cleanupTempFiles: boolean
  }
  sync: {
    enabled: boolean
    provider: 'none' | 'supabase'
    status: 'not_configured'
  }
  advanced: {
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    manualE2EMode: boolean
  }
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
  userDataPath: string
  dbPath: string
  logsPath: string
  outputRoot: string
  secretsBackend: string
}

export interface SecretsStatus {
  openai: boolean
  elevenlabs: boolean
  backend: string
  encryptionAvailable: boolean
}

// ---------------------------------------------------------------------------
// History & backups
// ---------------------------------------------------------------------------

export interface JobEvent {
  id: number
  jobId: string
  title: string
  channelName: string
  event: string
  fromStatus: JobStatus | null
  toStatus: JobStatus | null
  detail: string | null
  at: string
}

export interface BackupInfo {
  path: string
  createdAt: string
  bytes: number
  sha256: string
  appVersion: string
}

// ---------------------------------------------------------------------------
// Generation input
// ---------------------------------------------------------------------------

export interface TitleEntry {
  title: string
  channelId: string | null
}

export interface ParsedTitles {
  titles: string[]
  duplicatesRemoved: string[]
  blankLinesRemoved: number
}

export interface CreateBatchInput {
  name?: string
  channelId: string
  mode: JobMode
  entries: TitleEntry[]
  /** When true, titles that already have a completed project in the channel are skipped. */
  skipExisting: boolean
  manualResearchNotes?: Record<string, string>
}

export interface CreateBatchResult {
  batchId: string
  jobIds: string[]
  skipped: string[]
}

// ---------------------------------------------------------------------------
// Events pushed from main to renderer
// ---------------------------------------------------------------------------

export type AppNotification = {
  id: string
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  at: string
}

export interface MainEvents {
  'job:changed': JobView
  'queue:stats': QueueStats
  'batch:completed': { batchId: string; name: string; completed: number; failed: number }
  notification: AppNotification
  'settings:changed': AppSettings
  'secrets:changed': SecretsStatus
}

export type MainEventName = keyof MainEvents
