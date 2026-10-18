import type {
  Channel,
  ConnectionTestResult,
  ElevenModel,
  ElevenSubscription,
  ElevenVoice,
  OpenAIModelInfo,
  ResearchData,
  ResearchSettings,
  ReferenceScript,
  ResearchSource,
  ScriptSection,
  StyleFinding,
  TemplateVersion,
  ValidationIssue,
  VoiceSettings
} from '@shared/types'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  reported?: Record<string, unknown>
}

export interface ResearchRequest {
  title: string
  category: Channel['category']
  settings: ResearchSettings
  model: string
  manualNotes?: string | null
  signal?: AbortSignal
  /** Per-call timeout (v1.5: research 120 s). */
  timeoutMs?: number
}

export interface ResearchResponse {
  data: ResearchData
  sources: ResearchSource[]
  usage: TokenUsage
  model: string
}

export interface ScriptRequest {
  channel: Channel
  template: TemplateVersion
  title: string
  research: ResearchData | null
  researchSources: ResearchSource[]
  model: string
  temperature: number
  maxOutputTokens: number
  reasoningEffort: string
  /** For rewrites: the previous script and the issues to fix. */
  previousScript?: string
  issues?: string
  feedback?: string
  /** Final "tighten" pass: cut exactly this many characters from the previous script. */
  tighten?: { cut: number; target: number; max: number }
  /** Approved reference scripts for the format (most recent first, already truncated). */
  references?: Array<Pick<ReferenceScript, 'title' | 'text'>>
  /** All references of the format, used only to derive the skeleton's paragraph counts (not sent as text). */
  skeletonReferences?: Array<Pick<ReferenceScript, 'text'>>
  /** Provider prompt-cache key; identical for every title of one format version. */
  promptCacheKey?: string
  signal?: AbortSignal
  /** Per-call timeout (v1.5: script 180 s). */
  timeoutMs?: number
}

export interface ScriptResponse {
  text: string
  usage: TokenUsage
  model: string
}

export interface ReviewRequest {
  channel: Channel
  title: string
  script: string
  research: ResearchData | null
  model: string
  signal?: AbortSignal
}

export interface ReviewResponse {
  issues: ValidationIssue[]
  usage: TokenUsage
  model: string
}

export interface AnalyzeTemplateRequest {
  channel: Channel
  exampleScript: string
  instructions: string
  model: string
  signal?: AbortSignal
}

export interface AnalyzeTemplateResponse {
  sections: ScriptSection[]
  systemPrompt: string
  observations: string[]
  caveats: string[]
  usage: TokenUsage
  model: string
}

export interface AnalyzeStyleRequest {
  channel: Channel
  contentType: string
  references: Array<Pick<ReferenceScript, 'title' | 'text'>>
  instructions: string
  model: string
  signal?: AbortSignal
}

export interface AnalyzeStyleResponse {
  findings: StyleFinding[]
  sections: ScriptSection[]
  systemPrompt: string
  unknowns: string[]
  caveats: string[]
  usage: TokenUsage
  model: string
}

export interface CompareStyleRequest {
  channel: Channel
  title: string
  script: string
  references: Array<Pick<ReferenceScript, 'title' | 'text'>>
  research: ResearchData | null
  model: string
  signal?: AbortSignal
}

export interface CompareStyleResponse {
  styleDeviations: Array<{ severity: 'error' | 'warning'; message: string }>
  unsupportedClaims: Array<{ severity: 'error' | 'warning'; message: string }>
  usage: TokenUsage
  model: string
}

export interface OpenAIProvider {
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>
  listModels(signal?: AbortSignal): Promise<OpenAIModelInfo[]>
  research(req: ResearchRequest): Promise<ResearchResponse>
  writeScript(req: ScriptRequest): Promise<ScriptResponse>
  reviewScript(req: ReviewRequest): Promise<ReviewResponse>
  analyzeTemplate(req: AnalyzeTemplateRequest): Promise<AnalyzeTemplateResponse>
  analyzeStyle(req: AnalyzeStyleRequest): Promise<AnalyzeStyleResponse>
  compareStyle(req: CompareStyleRequest): Promise<CompareStyleResponse>
}

export interface TtsRequest {
  text: string
  voiceId: string
  modelId: string
  outputFormat: string
  voiceSettings: VoiceSettings
  previousText?: string
  nextText?: string
  signal?: AbortSignal
  /** Per-call timeout (v1.5: one TTS part 120 s). */
  timeoutMs?: number
}

export interface TtsResponse {
  audio: Buffer
  requestId: string | null
}

export interface ElevenLabsProvider {
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>
  listVoices(signal?: AbortSignal): Promise<ElevenVoice[]>
  listModels(signal?: AbortSignal): Promise<ElevenModel[]>
  getSubscription(signal?: AbortSignal): Promise<ElevenSubscription | null>
  synthesize(req: TtsRequest): Promise<TtsResponse>
  fetchPreview(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }>
}
