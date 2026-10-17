import type {
  Channel,
  ConnectionTestResult,
  ElevenModel,
  ElevenSubscription,
  ElevenVoice,
  OpenAIModelInfo,
  ResearchData,
  ResearchSettings,
  ResearchSource,
  ScriptSection,
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
  signal?: AbortSignal
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

export interface OpenAIProvider {
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>
  listModels(signal?: AbortSignal): Promise<OpenAIModelInfo[]>
  research(req: ResearchRequest): Promise<ResearchResponse>
  writeScript(req: ScriptRequest): Promise<ScriptResponse>
  reviewScript(req: ReviewRequest): Promise<ReviewResponse>
  analyzeTemplate(req: AnalyzeTemplateRequest): Promise<AnalyzeTemplateResponse>
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
