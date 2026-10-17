import { ElevenLabsClient, ElevenLabsError, ElevenLabsTimeoutError } from '@elevenlabs/elevenlabs-js'
import type { ElevenLabs as EL } from '@elevenlabs/elevenlabs-js'
import type { ConnectionTestResult, ElevenModel, ElevenSubscription, ElevenVoice, VoiceSettings } from '@shared/types'
import { AppError, parseRetryAfter, toAppError } from '../util/errors'
import type { ScopedLogger } from '../services/logger'
import type { ElevenLabsProvider, TtsRequest, TtsResponse } from './types'

export interface ElevenClientConfig {
  apiKey: string
  timeoutMs: number
}

/**
 * Capability table used when the live models list is unavailable. Values
 * mirror the provider's documentation for the current model family; the
 * live `models.list()` response always takes precedence in the UI.
 */
export const KNOWN_MODEL_LIMITS: Record<string, { maxChars: number; style: boolean; speakerBoost: boolean; speed: boolean }> = {
  eleven_multilingual_v2: { maxChars: 10000, style: true, speakerBoost: true, speed: true },
  eleven_flash_v2_5: { maxChars: 40000, style: true, speakerBoost: true, speed: true },
  eleven_flash_v2: { maxChars: 30000, style: true, speakerBoost: true, speed: true },
  eleven_turbo_v2_5: { maxChars: 40000, style: true, speakerBoost: true, speed: true },
  eleven_turbo_v2: { maxChars: 30000, style: true, speakerBoost: true, speed: true },
  eleven_v3: { maxChars: 5000, style: false, speakerBoost: false, speed: false }
}

export function modelSupportsSpeed(modelId: string): boolean {
  const k = KNOWN_MODEL_LIMITS[modelId]
  if (k) return k.speed
  return !/^eleven_v3/.test(modelId)
}

/** Keep only the voice-setting keys the chosen model accepts. */
export function voiceSettingsForModel(modelId: string, settings: VoiceSettings, live?: ElevenModel | null): EL.VoiceSettings {
  const out: EL.VoiceSettings = {}
  if (settings.stability !== undefined) out.stability = settings.stability
  if (settings.similarityBoost !== undefined) out.similarityBoost = settings.similarityBoost
  const canStyle = live ? live.canUseStyle : (KNOWN_MODEL_LIMITS[modelId]?.style ?? true)
  const canBoost = live ? live.canUseSpeakerBoost : (KNOWN_MODEL_LIMITS[modelId]?.speakerBoost ?? true)
  if (canStyle && settings.style !== undefined) out.style = settings.style
  if (canBoost && settings.useSpeakerBoost !== undefined) out.useSpeakerBoost = settings.useSpeakerBoost
  if (modelSupportsSpeed(modelId) && settings.speed !== undefined && settings.speed !== 1) out.speed = settings.speed
  if (/^eleven_v3/.test(modelId) && out.stability !== undefined) {
    // v3 accepts discrete stability values only.
    out.stability = out.stability < 0.25 ? 0 : out.stability < 0.75 ? 0.5 : 1
  }
  return out
}

export function mapElevenError(err: unknown): AppError {
  if (err instanceof ElevenLabsTimeoutError) {
    return new AppError('network', 'The ElevenLabs request timed out.', { action: 'Increase the ElevenLabs timeout in Settings or retry.', retryable: true })
  }
  if (err instanceof ElevenLabsError) {
    const status = err.statusCode
    const body = err.body
    const detail = extractDetail(body)
    const text = detail || err.message || ''
    if (status === 401) return new AppError('auth', 'ElevenLabs rejected the API key.', { details: text, retryable: false, code: 'ELEVEN_AUTH' })
    if (status === 402 || /quota_exceeded|insufficient|not enough credits|character limit/i.test(text)) {
      return new AppError('quota', 'Your ElevenLabs account does not have enough characters/credits left.', { details: text, retryable: false, code: 'ELEVEN_QUOTA' })
    }
    if (status === 403) return new AppError('auth', 'The ElevenLabs API key is not allowed to perform this action.', { details: text, retryable: false })
    if (status === 429) {
      const ra = parseRetryAfter((err.rawResponse?.headers as Headers | undefined)?.get?.('retry-after'))
      return new AppError('rate_limit', 'ElevenLabs rate limit or concurrency limit reached.', { details: text, retryable: true, retryAfterMs: ra })
    }
    if (status === 404 && /voice/i.test(text)) {
      return new AppError('config', 'The selected ElevenLabs voice no longer exists or is not accessible with this key.', { action: 'Select another voice in the channel profile.', retryable: false })
    }
    if (status === 400 || status === 422) {
      return new AppError('config', `ElevenLabs rejected the request: ${text}`, { action: 'Check the model, output format and voice settings in the channel profile.', retryable: false })
    }
    if (status !== undefined && status >= 500) return new AppError('provider_down', `ElevenLabs returned a server error (${status}).`, { details: text, retryable: true })
    if (status === undefined) return new AppError('network', 'Could not connect to ElevenLabs.', { details: text, retryable: true })
    return new AppError('unknown', `ElevenLabs error ${status}: ${text}`, { details: text })
  }
  const generic = toAppError(err)
  return generic
}

function extractDetail(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body.slice(0, 500)
  const b = body as { detail?: unknown }
  if (typeof b.detail === 'string') return b.detail
  if (b.detail && typeof b.detail === 'object') {
    const d = b.detail as { message?: string; status?: string }
    return [d.status, d.message].filter(Boolean).join(': ')
  }
  try {
    return JSON.stringify(body).slice(0, 500)
  } catch {
    return ''
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new AppError('cancelled', 'Audio download cancelled.', { retryable: false })
      }
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

export class ElevenLabsClientProvider implements ElevenLabsProvider {
  private client: ElevenLabsClient

  constructor(
    cfg: ElevenClientConfig,
    private log: ScopedLogger
  ) {
    this.client = new ElevenLabsClient({ apiKey: cfg.apiKey, timeoutInSeconds: Math.ceil(cfg.timeoutMs / 1000), maxRetries: 0 })
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const sub = await this.client.user.subscription.get({ abortSignal: signal })
      const used = sub.characterCount ?? 0
      const limit = sub.characterLimit ?? 0
      return { ok: true, message: `Connected to ElevenLabs (${sub.tier} plan). ${used.toLocaleString()} / ${limit.toLocaleString()} characters used this period.` }
    } catch (err) {
      const e = mapElevenError(err)
      return { ok: false, message: e.message, details: e.action }
    }
  }

  async listVoices(signal?: AbortSignal): Promise<ElevenVoice[]> {
    try {
      const voices: ElevenVoice[] = []
      let token: string | undefined
      for (let page = 0; page < 20; page++) {
        const res = await this.client.voices.search({ pageSize: 100, nextPageToken: token, includeTotalCount: true }, { abortSignal: signal })
        for (const v of res.voices ?? []) {
          voices.push({
            voiceId: v.voiceId,
            name: v.name ?? v.voiceId,
            category: String(v.category ?? ''),
            description: v.description ?? '',
            previewUrl: v.previewUrl ?? null,
            labels: v.labels ?? {},
            favorite: false
          })
        }
        if (!res.hasMore || !res.nextPageToken) break
        token = res.nextPageToken
      }
      this.log.info('Fetched ElevenLabs voices', { count: voices.length })
      return voices
    } catch (err) {
      throw mapElevenError(err)
    }
  }

  async listModels(signal?: AbortSignal): Promise<ElevenModel[]> {
    try {
      const models = await this.client.models.list({ abortSignal: signal })
      return models
        .filter((m) => m.canDoTextToSpeech !== false)
        .map((m) => ({
          modelId: m.modelId,
          name: m.name ?? m.modelId,
          description: m.description ?? '',
          canDoTextToSpeech: m.canDoTextToSpeech ?? true,
          canUseStyle: m.canUseStyle ?? KNOWN_MODEL_LIMITS[m.modelId]?.style ?? false,
          canUseSpeakerBoost: m.canUseSpeakerBoost ?? KNOWN_MODEL_LIMITS[m.modelId]?.speakerBoost ?? false,
          maxCharacters: m.maximumTextLengthPerRequest ?? m.maxCharactersRequestSubscribedUser ?? KNOWN_MODEL_LIMITS[m.modelId]?.maxChars ?? null,
          languages: (m.languages ?? []).map((l) => l.languageId ?? '').filter(Boolean)
        }))
    } catch (err) {
      throw mapElevenError(err)
    }
  }

  async getSubscription(signal?: AbortSignal): Promise<ElevenSubscription | null> {
    try {
      const sub = await this.client.user.subscription.get({ abortSignal: signal })
      return {
        tier: sub.tier,
        characterCount: sub.characterCount,
        characterLimit: sub.characterLimit,
        nextResetUnix: sub.nextCharacterCountResetUnix ?? null,
        status: String(sub.status ?? '')
      }
    } catch (err) {
      const e = mapElevenError(err)
      if (e.kind === 'auth') throw e
      this.log.warn('Subscription info unavailable', { error: e.message })
      return null
    }
  }

  async synthesize(req: TtsRequest): Promise<TtsResponse> {
    try {
      const body: EL.BodyTextToSpeechFull = {
        text: req.text,
        modelId: req.modelId,
        outputFormat: req.outputFormat as EL.BodyTextToSpeechFull['outputFormat'],
        voiceSettings: req.voiceSettings as EL.VoiceSettings
      }
      if (req.previousText) body.previousText = req.previousText
      if (req.nextText) body.nextText = req.nextText
      const promise = this.client.textToSpeech.convert(req.voiceId, body, { abortSignal: req.signal })
      const { data: stream, rawResponse } = await promise.withRawResponse()
      const audio = await readAll(stream, req.signal)
      const requestId = (rawResponse?.headers as Headers | undefined)?.get?.('request-id') ?? null
      return { audio, requestId }
    } catch (err) {
      throw mapElevenError(err)
    }
  }

  async fetchPreview(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !/elevenlabs\.io$|\.elevenlabs\.io$|elevenlabs\.com$|\.elevenlabs\.com$|amazonaws\.com$|storage\.googleapis\.com$/.test(parsed.hostname)) {
      throw new AppError('config', 'Preview URL is not from an allowed host.', { retryable: false })
    }
    const res = await fetch(url, { signal })
    if (!res.ok) throw new AppError('provider_down', `Preview download failed (${res.status}).`, { retryable: true })
    const bytes = Buffer.from(await res.arrayBuffer())
    return { bytes, contentType: res.headers.get('content-type') ?? 'audio/mpeg' }
  }
}
