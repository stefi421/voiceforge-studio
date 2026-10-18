import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai'
import type { ResponseCreateParamsNonStreaming, Response as OpenAIResponse, Tool } from 'openai/resources/responses/responses'
import type { ConnectionTestResult, OpenAIModelInfo, ResearchData, ResearchSource, ScriptSection, StyleFinding, ValidationIssue } from '@shared/types'
import { AppError, parseRetryAfter, toAppError } from '../util/errors'
import type { ScopedLogger } from '../services/logger'
import { parseOpenAIRateHeaders, providerTelemetry } from '../queue/limits'
import {
  ANALYZE_JSON_SCHEMA,
  REVIEW_JSON_SCHEMA,
  RESEARCH_JSON_SCHEMA,
  STYLE_ANALYSIS_JSON_SCHEMA,
  STYLE_COMPARE_JSON_SCHEMA,
  analyzeInstructions,
  styleAnalysisInstructions,
  styleCompareInstructions,
  researchInstructions,
  researchUserInput,
  reviewInstructions,
  scriptSystemPrompt,
  scriptUserInput
} from './prompts'
import type {
  AnalyzeStyleRequest,
  AnalyzeStyleResponse,
  CompareStyleRequest,
  CompareStyleResponse,
  AnalyzeTemplateRequest,
  AnalyzeTemplateResponse,
  OpenAIProvider,
  ResearchRequest,
  ResearchResponse,
  ReviewRequest,
  ReviewResponse,
  ScriptRequest,
  ScriptResponse,
  TokenUsage
} from './types'

export interface OpenAIClientConfig {
  apiKey: string
  timeoutMs: number
}

/** Reasoning models reject `temperature`; chat models reject `reasoning`. */
export function isReasoningModel(model: string): boolean {
  // o-series and every gpt-5+ generation (gpt-5.x, gpt-6-*) take `reasoning`; `*-chat*` variants and gpt-4* take `temperature`.
  // If a model rejects either parameter the request is retried once without it (see `create`).
  return /^(o\d|gpt-[5-9](?![^-]*-chat))/i.test(model)
}

export function mapOpenAIError(err: unknown): AppError {
  if (err instanceof APIUserAbortError) return new AppError('cancelled', 'The OpenAI request was cancelled.', { retryable: false })
  if (err instanceof APIConnectionTimeoutError) {
    return new AppError('network', 'The OpenAI request timed out.', { action: 'Increase the OpenAI timeout in Settings or retry; the job will retry automatically.', retryable: true })
  }
  if (err instanceof APIConnectionError) {
    return new AppError('network', 'Could not connect to the OpenAI API.', { details: err.message, retryable: true })
  }
  if (err instanceof APIError) {
    const status = err.status
    const body = typeof err.message === 'string' ? err.message : JSON.stringify(err.error ?? {})
    const code = (err.code ?? (err.error as { code?: string } | undefined)?.code ?? '') as string
    if (status === 401) return new AppError('auth', 'OpenAI rejected the API key.', { details: body, retryable: false, code: 'OPENAI_AUTH' })
    if (status === 403) return new AppError('auth', 'The OpenAI API key does not have permission for this request.', { details: body, retryable: false })
    if (status === 429 && (code === 'insufficient_quota' || /insufficient_quota|exceeded your current quota|billing/i.test(body))) {
      return new AppError('quota', 'Your OpenAI account has run out of credit or quota.', { details: body, retryable: false, code: 'OPENAI_QUOTA' })
    }
    if (status === 429) {
      return new AppError('rate_limit', 'OpenAI rate limit reached.', { details: body, retryable: true, retryAfterMs: parseRetryAfter(err.headers?.get('retry-after')) })
    }
    if (status === 404 && /model/i.test(body)) {
      return new AppError('config', `OpenAI does not know the selected model: ${body}`, { action: 'Pick another model in Settings → OpenAI or in the channel profile.', retryable: false })
    }
    if (status === 400 || status === 422) {
      return new AppError('config', `OpenAI rejected the request: ${body}`, { action: 'Check the model and generation settings; the request parameters were not accepted.', retryable: false })
    }
    if (status !== undefined && status >= 500) {
      return new AppError('provider_down', `OpenAI returned a server error (${status}).`, { details: body, retryable: true })
    }
    return new AppError('unknown', `OpenAI error ${status ?? ''}: ${body}`, { details: body })
  }
  return toAppError(err)
}

function usageOf(res: OpenAIResponse): TokenUsage {
  return {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    reported: res.usage ? { ...res.usage } : undefined
  }
}

function extractSources(res: OpenAIResponse): ResearchSource[] {
  const out: ResearchSource[] = []
  const seen = new Set<string>()
  for (const item of res.output ?? []) {
    if (item.type === 'web_search_call') {
      const action = (item as { action?: { sources?: Array<{ url: string }> } }).action
      for (const s of action?.sources ?? []) {
        if (s.url && !seen.has(s.url)) {
          seen.add(s.url)
          out.push({ title: s.url, url: s.url })
        }
      }
    }
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') {
          for (const a of c.annotations ?? []) {
            if (a.type === 'url_citation' && a.url && !seen.has(a.url)) {
              seen.add(a.url)
              out.push({ title: a.title || a.url, url: a.url })
            }
          }
        }
      }
    }
  }
  return out
}

function outputText(res: OpenAIResponse): string {
  if (typeof res.output_text === 'string' && res.output_text.length) return res.output_text
  const parts: string[] = []
  for (const item of res.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) if (c.type === 'output_text') parts.push(c.text)
    }
  }
  return parts.join('\n')
}

function parseJsonOutput<T>(res: OpenAIResponse, what: string): T {
  const text = outputText(res).trim()
  if (res.status === 'incomplete') {
    const reason = res.incomplete_details?.reason ?? 'unknown'
    throw new AppError('config', `OpenAI stopped the ${what} response early (${reason}).`, {
      action: reason === 'max_output_tokens' ? 'Increase "Max output tokens" in Settings → OpenAI.' : 'Retry; if it repeats, change the model.',
      retryable: reason !== 'max_output_tokens'
    })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as T
      } catch {
        /* fall through */
      }
    }
    throw new AppError('provider_down', `OpenAI returned a non-JSON ${what} result.`, { details: text.slice(0, 500), retryable: true })
  }
}

export class OpenAIClientProvider implements OpenAIProvider {
  private client: OpenAI

  constructor(
    cfg: OpenAIClientConfig,
    private log: ScopedLogger
  ) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0 })
  }

  /** One request; response headers (rate limits) are reported to the concurrency governor. */
  private async send(params: ResponseCreateParamsNonStreaming, signal?: AbortSignal, timeoutMs?: number): Promise<OpenAIResponse> {
    const { data, response } = await this.client.responses.create(params, { signal, ...(timeoutMs ? { timeout: timeoutMs } : {}) }).withResponse()
    try {
      const info = parseOpenAIRateHeaders(response.headers)
      if (info) providerTelemetry.onOpenAI?.(info)
    } catch {
      /* telemetry is best-effort */
    }
    return data
  }

  private async create(params: ResponseCreateParamsNonStreaming, signal?: AbortSignal, timeoutMs?: number): Promise<OpenAIResponse> {
    try {
      return await this.send(params, signal, timeoutMs)
    } catch (err) {
      if (err instanceof APIError) {
        try {
          const info = parseOpenAIRateHeaders(err.headers as unknown as Headers)
          if (info) providerTelemetry.onOpenAI?.(info)
        } catch {
          /* ignore */
        }
      }
      // Some models reject temperature/reasoning; retry once without the unsupported parameter.
      if (err instanceof APIError && err.status === 400 && /(temperature|reasoning|verbosity)/i.test(err.message)) {
        const retry = { ...params }
        delete retry.temperature
        delete retry.reasoning
        if (retry.text) {
          const t = { ...retry.text }
          delete t.verbosity
          retry.text = t
        }
        this.log.warn('Retrying OpenAI request without unsupported parameter', { reason: err.message })
        try {
          return await this.send(retry, signal, timeoutMs)
        } catch (err2) {
          throw mapOpenAIError(err2)
        }
      }
      throw mapOpenAIError(err)
    }
  }

  private baseParams(model: string, opts: { temperature?: number; reasoningEffort?: string; maxOutputTokens?: number }): ResponseCreateParamsNonStreaming {
    const params: ResponseCreateParamsNonStreaming = { model, input: '', store: false }
    if (opts.maxOutputTokens) params.max_output_tokens = opts.maxOutputTokens
    if (isReasoningModel(model)) {
      if (opts.reasoningEffort && opts.reasoningEffort !== 'none') {
        params.reasoning = { effort: opts.reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' }
      }
    } else if (opts.temperature !== undefined) {
      params.temperature = opts.temperature
    }
    return params
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const page = await this.client.models.list({ signal })
      const count = page.data?.length ?? 0
      return { ok: true, message: `Connected to OpenAI. ${count} models visible to this key.` }
    } catch (err) {
      const e = mapOpenAIError(err)
      return { ok: false, message: e.message, details: e.action }
    }
  }

  async listModels(signal?: AbortSignal): Promise<OpenAIModelInfo[]> {
    try {
      const page = await this.client.models.list({ signal })
      return (page.data ?? [])
        .filter((m) => /^(gpt-|o\d|chatgpt)/.test(m.id) && !/(embedding|tts|whisper|audio|realtime|image|moderation|transcribe|search|dall|codex|instruct|computer)/.test(m.id))
        .map((m) => ({ id: m.id, created: m.created }))
        .sort((a, b) => b.created - a.created)
    } catch (err) {
      throw mapOpenAIError(err)
    }
  }

  async research(req: ResearchRequest): Promise<ResearchResponse> {
    const useWeb = req.settings.mode === 'openai_web_search'
    // Speed: the research JSON is small; a tight cap keeps reasoning short. 'low' context by default.
    const params = this.baseParams(req.model, { reasoningEffort: 'low', maxOutputTokens: 5000 })
    params.prompt_cache_key = `vf:research:${req.category}`
    params.instructions = researchInstructions(req.category, req.settings, useWeb)
    params.input = researchUserInput(req.title, req.category, req.manualNotes)
    params.text = { format: { type: 'json_schema', name: 'research_result', schema: RESEARCH_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } }
    if (useWeb) {
      const tool: Tool = { type: 'web_search', search_context_size: req.settings.searchContextSize }
      params.tools = [tool]
      params.tool_choice = 'auto'
      params.include = ['web_search_call.action.sources']
    }
    const res = await this.create(params, req.signal, req.timeoutMs)
    const data = parseJsonOutput<ResearchData>(res, 'research')
    data.confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0))
    const sources = extractSources(res)
    this.log.info('Research completed', { title: req.title, confidence: data.confidence, sources: sources.length, candidates: data.ambiguityCandidates?.length ?? 0 })
    return { data, sources, usage: usageOf(res), model: res.model ?? req.model }
  }

  async writeScript(req: ScriptRequest): Promise<ScriptResponse> {
    const params = this.baseParams(req.model, { temperature: req.temperature, reasoningEffort: req.reasoningEffort, maxOutputTokens: req.maxOutputTokens })
    params.instructions = scriptSystemPrompt(req.channel, req.template, req.references ?? [])
    params.input = scriptUserInput(req.title, req.research, req.researchSources, { previousScript: req.previousScript, issues: req.issues, feedback: req.feedback, tighten: req.tighten })
    if (req.promptCacheKey) params.prompt_cache_key = req.promptCacheKey
    const res = await this.create(params, req.signal, req.timeoutMs)
    if (res.status === 'incomplete') {
      const reason = res.incomplete_details?.reason ?? 'unknown'
      throw new AppError('config', `OpenAI stopped the script early (${reason}).`, {
        action: reason === 'max_output_tokens' ? 'Increase "Max output tokens" in Settings → OpenAI.' : 'Retry the job.',
        retryable: reason !== 'max_output_tokens',
        code: reason === 'max_output_tokens' ? 'MAX_OUTPUT_TOKENS' : undefined
      })
    }
    const text = cleanScriptText(outputText(res))
    if (!text) throw new AppError('provider_down', 'OpenAI returned an empty script.', { retryable: true })
    return { text, usage: usageOf(res), model: res.model ?? req.model }
  }

  async reviewScript(req: ReviewRequest): Promise<ReviewResponse> {
    const params = this.baseParams(req.model, { reasoningEffort: 'low', maxOutputTokens: 4000 })
    params.instructions = reviewInstructions()
    params.input = [
      `Title: ${req.title}`,
      req.research ? `<research_data>\n${JSON.stringify(req.research, null, 2)}\n</research_data>` : 'No research data available; flag any specific unsupported claim as a warning.',
      `<script>\n${req.script}\n</script>`
    ].join('\n\n')
    params.text = { format: { type: 'json_schema', name: 'review_result', schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } }
    const res = await this.create(params, req.signal)
    const parsed = parseJsonOutput<{ issues: Array<{ severity: 'error' | 'warning'; message: string; quote: string }> }>(res, 'review')
    const issues: ValidationIssue[] = (parsed.issues ?? []).slice(0, 25).map((i) => ({
      code: 'ai_review',
      severity: i.severity === 'error' ? 'error' : 'warning',
      message: i.quote ? `${i.message} — "${i.quote.slice(0, 160)}"` : i.message
    }))
    return { issues, usage: usageOf(res), model: res.model ?? req.model }
  }

  async analyzeTemplate(req: AnalyzeTemplateRequest): Promise<AnalyzeTemplateResponse> {
    const params = this.baseParams(req.model, { reasoningEffort: 'medium', maxOutputTokens: 6000 })
    params.instructions = analyzeInstructions()
    params.input = [
      `Channel: ${req.channel.name} (${req.channel.category})`,
      req.instructions.trim() ? `<writing_instructions>\n${req.instructions.trim()}\n</writing_instructions>` : '',
      `<approved_script>\n${req.exampleScript.trim()}\n</approved_script>`
    ]
      .filter(Boolean)
      .join('\n\n')
    params.text = { format: { type: 'json_schema', name: 'template_analysis', schema: ANALYZE_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } }
    const res = await this.create(params, req.signal)
    const parsed = parseJsonOutput<{ sections: Array<{ label: string; guidance: string; required: boolean }>; systemPrompt: string; observations: string[]; caveats: string[] }>(res, 'analysis')
    const sections: ScriptSection[] = (parsed.sections ?? []).slice(0, 30).map((s, i) => ({
      key: s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `section_${i + 1}`,
      label: s.label.trim(),
      required: !!s.required,
      aliases: [],
      guidance: s.guidance?.trim() ?? ''
    }))
    return { sections, systemPrompt: parsed.systemPrompt ?? '', observations: parsed.observations ?? [], caveats: parsed.caveats ?? [], usage: usageOf(res), model: res.model ?? req.model }
  }

  async analyzeStyle(req: AnalyzeStyleRequest): Promise<AnalyzeStyleResponse> {
    const params = this.baseParams(req.model, { reasoningEffort: 'medium', maxOutputTokens: 12000 })
    params.instructions = styleAnalysisInstructions()
    params.input = [
      `Channel: ${req.channel.name} (${req.channel.category}). Content type: ${req.contentType}. Number of approved reference scripts: ${req.references.length}.`,
      req.instructions.trim() ? `<owner_instructions>\n${req.instructions.trim()}\n</owner_instructions>` : '',
      ...req.references.map((r, i) => `<reference_script index="${i + 1}" title="${r.title.replace(/"/g, "'")}">\n${r.text.trim()}\n</reference_script>`)
    ]
      .filter(Boolean)
      .join('\n\n')
    params.text = { format: { type: 'json_schema', name: 'style_analysis', schema: STYLE_ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } }
    const res = await this.create(params, req.signal)
    const parsed = parseJsonOutput<{
      findings: Array<{ aspect: string; finding: string; provenance: string; evidence: string }>
      sections: Array<{ label: string; guidance: string; required: boolean; aliases: string[] }>
      systemPrompt: string
      unknowns: string[]
      caveats: string[]
    }>(res, 'style analysis')
    const single = req.references.length < 2
    const findings: StyleFinding[] = (parsed.findings ?? []).slice(0, 60).map((f) => ({
      aspect: f.aspect,
      finding: f.finding.trim(),
      // With one reference nothing can be "consistent across references".
      provenance: f.provenance === 'unknown' ? 'unknown' : f.provenance === 'consistent' && !single ? 'consistent' : 'inferred',
      evidence: f.evidence?.trim() ? f.evidence.trim().slice(0, 200) : null
    }))
    const sections: ScriptSection[] = (parsed.sections ?? []).slice(0, 30).map((s, i) => ({ key: sectionKey(s.label, i), label: s.label.trim(), required: !!s.required, aliases: (s.aliases ?? []).filter(Boolean).slice(0, 5), guidance: s.guidance?.trim() ?? '' }))
    return { findings, sections, systemPrompt: parsed.systemPrompt ?? '', unknowns: parsed.unknowns ?? [], caveats: parsed.caveats ?? [], usage: usageOf(res), model: res.model ?? req.model }
  }

  async compareStyle(req: CompareStyleRequest): Promise<CompareStyleResponse> {
    const params = this.baseParams(req.model, { reasoningEffort: 'low', maxOutputTokens: 4000 })
    params.instructions = styleCompareInstructions()
    params.input = [
      `Channel: ${req.channel.name}. Title: ${req.title}`,
      ...req.references.map((r, i) => `<reference_script index="${i + 1}">\n${r.text.trim()}\n</reference_script>`),
      req.research ? `<research_data>\n${JSON.stringify(req.research, null, 2)}\n</research_data>` : 'No research data was available.',
      `<script>\n${req.script}\n</script>`
    ].join('\n\n')
    params.text = { format: { type: 'json_schema', name: 'style_compare', schema: STYLE_COMPARE_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } }
    const res = await this.create(params, req.signal)
    const parsed = parseJsonOutput<{ styleDeviations: Array<{ severity: string; message: string }>; unsupportedClaims: Array<{ severity: string; message: string }> }>(res, 'style comparison')
    const norm = (xs: Array<{ severity: string; message: string }> | undefined) => (xs ?? []).slice(0, 25).map((x) => ({ severity: (x.severity === 'error' ? 'error' : 'warning') as 'error' | 'warning', message: x.message.trim() }))
    return { styleDeviations: norm(parsed.styleDeviations), unsupportedClaims: norm(parsed.unsupportedClaims), usage: usageOf(res), model: res.model ?? req.model }
  }
}

export function sectionKey(label: string, i: number): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `section_${i + 1}`
}

/** Removes wrapper artefacts models sometimes add (code fences, "Script:" labels, trailing notes). */
export function cleanScriptText(raw: string): string {
  let t = raw.replace(/\r\n/g, '\n').trim()
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  t = t.replace(/^(?:script|final script|here(?:'s| is) the script)\s*:?\s*\n+/i, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}
