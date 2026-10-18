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
  /** Run an additional AI review pass for unsupported claims (only when Settings → Generation → AI fact check is on). */
  aiReviewPass: boolean
  /**
   * When the format has no locked intro, the writer opens with a short spoken introduction that
   * names the channel and the title (variable wording). Off = no opening instruction at all.
   */
  openWithChannelIntro: boolean
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
  /**
   * The content type this template produces for its channel ("review", "gameplay",
   * "unboxing", "short_review", …). A channel can own several templates — one per content
   * type — and they never overwrite each other. Unique per channel.
   */
  contentType: string
  createdAt: string
  updatedAt: string
  latestVersion: number
  activeVersionId: string | null
  /** Approval status of the active version (denormalised for lists). */
  approvalStatus: TemplateApprovalStatus
  referenceCount: number
}

// ---------------------------------------------------------------------------
// Channel Style Preservation Studio
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a channel format. Only `approved` and `test_passed` are eligible for
 * unattended ("Fully automatic") production. `provisional` = built from rules the user
 * stated in writing but not yet checked against approved reference scripts: usable in
 * Review-before-voice / Scripts-only with a warning. Everything else blocks generation.
 */
export type TemplateApprovalStatus =
  | 'not_configured'
  | 'references_imported'
  | 'template_extracted'
  | 'awaiting_approval'
  | 'provisional'
  | 'approved'
  | 'test_passed'
  | 'test_failed'

/** Where a rule came from. An inference is never shown or treated as a confirmed rule. */
export type RuleProvenance = 'user_confirmed' | 'consistent' | 'inferred' | 'unknown'

export type FixedTextKind = 'intro' | 'outro' | 'heading' | 'transition' | 'cta' | 'other'

/** Exactly repeated text detected across references (or entered by the user). */
export interface FixedTextBlock {
  id: string
  kind: FixedTextKind
  text: string
  /** Locked blocks must appear verbatim; only the user can lock/unlock. */
  locked: boolean
  provenance: RuleProvenance
  /** False for headings/labels that are kept in Script.txt but not read by ElevenLabs. */
  spoken: boolean
  /** How many reference scripts contain it verbatim (0 when typed by the user). */
  occurrences: number
  /**
   * Intro/outro only: the block is a whole paragraph of its own — the script's first
   * (intro) or last (outro) paragraph must equal it exactly. Set by the reference pack.
   */
  wholeParagraph?: boolean
}

export interface StyleFinding {
  /** One of the 20 analysis aspects, e.g. "opening_wording", "sentence_length". */
  aspect: string
  finding: string
  provenance: RuleProvenance
  /** Short quote from a reference supporting the finding (never a URL). */
  evidence: string | null
}

export type ReferenceFormat = 'paste' | 'txt' | 'md' | 'docx' | 'pdf'

export interface ReferenceScript {
  id: string
  channelId: string
  templateId: string
  title: string
  text: string
  sourceFormat: ReferenceFormat
  sourceFileName: string | null
  charCount: number
  wordCount: number
  createdAt: string
}

export interface ReferenceStats {
  count: number
  minChars: number
  maxChars: number
  avgChars: number
  avgWords: number
  avgDurationSec: number
}

export interface StyleAnalysis {
  templateId: string
  /** Increments whenever the reference set changes; recorded on scripts. */
  referenceSetVersion: number
  stats: ReferenceStats
  findings: StyleFinding[]
  fixedBlocks: FixedTextBlock[]
  suggestedStructure: ScriptSection[]
  suggestedSystemPrompt: string
  /** Things the analysis could not determine (shown as UNVERIFIED). */
  unknowns: string[]
  caveats: string[]
  analyzedAt: string
}

export type ComplianceVerdict = 'pass' | 'fail' | 'warning' | 'not_applicable'

export interface ComplianceCheck {
  key: 'sections' | 'order' | 'intro' | 'outro' | 'fixed_text' | 'length' | 'prohibited' | 'style' | 'claims'
  label: string
  verdict: ComplianceVerdict
  details: string[]
}

/** Result of a style test (Part 7/8 of the channel spec). No similarity percentages. */
export interface StyleTestResult {
  id: string
  templateId: string
  templateVersionId: string
  title: string
  scriptText: string
  checks: ComplianceCheck[]
  passed: boolean
  createdAt: string
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
  approvalStatus: TemplateApprovalStatus
  /** Verbatim intro/outro/headings; locked ones are enforced by the validator. */
  fixedBlocks: FixedTextBlock[]
  /** Analysis findings saved with this version (provenance kept). */
  findings: StyleFinding[]
  /** Rules the user stated in writing for this format (one per line). */
  confirmedRules: string
  /** Items still to verify against references (shown as UNVERIFIED). */
  unverified: string[]
  /** Whether section headings are read aloud. False = kept in Script.txt, stripped for ElevenLabs. */
  headingsSpoken: boolean
  /** Reference set this version was built from (null = written by hand / from the spec). */
  referenceSetVersion: number | null
  approvedAt: string | null
  createdAt: string
}

export interface TemplateVersionInput {
  systemPrompt: string
  structure: ScriptSection[]
  exampleScript: string | null
  notes: string
  placeholder?: boolean
  approvalStatus?: TemplateApprovalStatus
  fixedBlocks?: FixedTextBlock[]
  findings?: StyleFinding[]
  confirmedRules?: string
  unverified?: string[]
  headingsSpoken?: boolean
  referenceSetVersion?: number | null
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
  /** Template (content type / format) chosen for this job; defaults to the channel's default format. */
  templateId?: string
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

export type OutputLayout = 'folders' | 'flat'

export interface Project {
  id: string
  channelId: string
  /** The title the user entered (or explicitly chose); used for the folder name. */
  title: string
  /** Official title as identified by research, shown next to the user's title; never renames the folder. */
  canonicalTitle: string | null
  folderName: string
  folderPath: string | null
  /** Layout the project's finished files are published with (fixed when the project is created). */
  layout: OutputLayout
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
  /** 0–100: finished stages across all unfinished+finished jobs in the current view, so the bar moves inside a job too. */
  progressPercent: number
  /** Live provider slots (v1.5). */
  providers?: { openai: ProviderLiveStatus; elevenlabs: ProviderLiveStatus }
  /** Set when an auth/quota problem stopped the queue (one notification instead of N failures). */
  providerBlocked?: { provider: 'openai' | 'elevenlabs'; message: string; action: string; at: string } | null
}

export interface ProviderLiveStatus {
  /** Requests allowed at once right now. */
  limit: number
  inUse: number
  waiting: number
  /** Where the limit comes from: response headers, the plan, adaptive control, or Settings. */
  source: 'headers' | 'plan' | 'adaptive' | 'manual' | 'default'
  detail: string
  /** Circuit breaker: new requests pause until this time after repeated transient failures. */
  coolingDownUntil: string | null
  lastError: string | null
}

export type TimingStage = 'research' | 'script' | 'validate' | 'audio' | 'save' | 'waiting'

export interface StageTiming {
  stage: TimingStage
  startedAt: string
  endedAt: string
  seconds: number
  detail: string | null
}

export interface JobTimings {
  jobId: string
  segments: StageTiming[]
  /** Seconds per stage (sum of segments). */
  totals: Record<TimingStage, number>
  totalSeconds: number
}

export interface TimingSummary {
  /** Number of finished jobs the medians are based on. */
  samples: number
  medians: Record<TimingStage, number>
  /** Share of the median total per stage, 0–1. */
  share: Record<TimingStage, number>
  medianTotalSeconds: number
}

export type PreflightStatus = 'ok' | 'warning' | 'error'

export interface PreflightCheck {
  key: 'openai_key' | 'eleven_key' | 'voices' | 'characters' | 'output_folder' | 'disk_space' | 'format'
  label: string
  status: PreflightStatus
  message: string
  action?: string
  /** True when "Start anyway" may bypass this failure. */
  overridable: boolean
}

export interface PreflightResult {
  checks: PreflightCheck[]
  /** False when an error that cannot be overridden is present. */
  canStart: boolean
  /** True when only overridable errors block (offer "Start anyway"). */
  needsOverride: boolean
  checkedAt: string
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
  /** True when the user approved the script despite remaining validation errors ("force approve"). */
  approvedWithIssues: boolean
  /** Clean narration sent to ElevenLabs (non-spoken headings/metadata removed). */
  narrationText: string
  templateId: string | null
  contentType: string | null
  referenceSetVersion: number | null
  researchId: string | null
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
  /** Rough wall-clock time for the whole batch with the current concurrency settings. */
  estimatedSeconds: number
  warnings: string[]
}

/** Quick per-channel opening settings (fast path to the default format's locked intro/outro). */
export interface ChannelOpening {
  channelId: string
  templateId: string | null
  versionId: string | null
  intro: string
  outro: string
  openWithChannelIntro: boolean
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
    /** Set when the first-run setup wizard has been completed or skipped. */
    onboardingCompleted: boolean
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
    /** Split one voiceover into up to N parts generated at the same time (1 = one request). */
    parallelParts: number
  }
  generation: {
    defaultMode: JobMode
    maxConcurrentJobs: number
    /** Learn safe concurrency from the providers (plan limits, rate-limit headers) instead of the manual values. */
    autoTuneConcurrency: boolean
    maxRewriteAttempts: number
    maxStageRetries: number
    validationStrictness: 'relaxed' | 'standard' | 'strict'
    /**
     * Characters a script may exceed the channel maximum by and still pass as a warning
     * (relaxed/standard only; 'strict' never tolerates overshoot). 0 disables the tolerance.
     */
    lengthToleranceChars: number
    /** Extra OpenAI fact-check request per script (slower). Off by default since 1.3.0. */
    aiReviewPass: boolean
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
    /**
     * `folders`: <Channel>/<Title>/Script.txt + Voice.mp3 (default).
     * `flat`: <Channel>/<Title>.txt + <Title>.mp3 — handy for sending files on.
     * Only finished files are placed in the output folder; drafts, research and metadata stay in app data.
     */
    outputLayout: OutputLayout
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
  updates: {
    /** Check GitHub Releases for a newer version shortly after launch. */
    checkOnStartup: boolean
    /** GitHub repository that publishes releases (electron-builder `latest.yml` + installer). */
    owner: string
    repo: string
    allowPrerelease: boolean
  }
}

export type UpdateState = 'idle' | 'checking' | 'available' | 'not_available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  latestVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  /** 0–100 while downloading. */
  progressPercent: number | null
  bytesPerSecond: number | null
  error: string | null
  checkedAt: string | null
  feed: { owner: string; repo: string }
  /** Portable builds cannot self-replace; the UI offers the download page instead. */
  portable: boolean
  releaseUrl: string | null
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
  /** Template (content type) to use; defaults to the channel's active template. */
  templateId?: string | null
  /** Skip overridable pre-flight failures (e.g. not enough ElevenLabs characters). */
  startAnyway?: boolean
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
  'update:status': UpdateStatus
}

export type MainEventName = keyof MainEvents
