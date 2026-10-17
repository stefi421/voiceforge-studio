import type { ConnectionTestResult, ElevenModel, ElevenSubscription, ElevenVoice, OpenAIModelInfo, ResearchData } from '../../src/shared/types'
import type {
  AnalyzeTemplateRequest,
  AnalyzeTemplateResponse,
  ResearchRequest,
  ResearchResponse,
  ReviewRequest,
  ReviewResponse,
  ScriptRequest,
  ScriptResponse,
  TtsRequest,
  TtsResponse
} from '../../src/main/providers/types'
import { AppError } from '../../src/main/util/errors'

/** Builds a syntactically valid MPEG-1 Layer III 44.1kHz 128kbps stream of roughly `seconds` seconds. */
export function fakeMp3(seconds = 10): Buffer {
  const frameLen = 417
  const frames = Math.ceil((seconds * 44100) / 1152)
  const buf = Buffer.alloc(frameLen * frames)
  for (let i = 0; i < frames; i++) {
    const o = i * frameLen
    buf[o] = 0xff
    buf[o + 1] = 0xfb
    buf[o + 2] = 0x90
    buf[o + 3] = 0x00
    for (let j = 4; j < frameLen; j++) buf[o + j] = (i * 31 + j) & 0xff
  }
  return buf
}

export function researchFor(title: string, overrides: Partial<ResearchData> = {}): ResearchData {
  return {
    subjectType: 'game',
    canonicalTitle: title,
    developer: 'Test Studio',
    publisher: 'Test Publisher',
    genre: 'Action',
    releaseStatus: 'released',
    releaseDate: '2026-01-01',
    platforms: ['PC'],
    summary: `${title} is a test game.`,
    gameplayMechanics: ['running', 'jumping'],
    combatSystems: 'Melee and ranged.',
    explorationSystems: 'Open world.',
    multiplayer: 'Co-op',
    keyMechanics: ['crafting'],
    technicalInfo: [],
    specifications: [],
    confirmedFacts: ['Released on PC'],
    uncertainFacts: [],
    confidence: 0.95,
    ambiguityCandidates: [],
    insufficientReason: '',
    ...overrides
  }
}

export function goodScript(title: string, sections: string[] = ['Gameplay', 'Combat', 'Pros', 'Cons', 'Conclusion'], padTo = 3600): string {
  const intro = `Welcome back to Game Vault, where we mine the hidden gems and dive into the big releases—breaking down the mechanics that matter. Today we look at ${title}.`
  const filler = 'The game keeps a steady rhythm as you move between quiet planning moments and quick bursts of action, and every system feeds back into the next decision you make. '
  const body = sections.map((s) => `${s}\n${filler.repeat(5)}`).join('\n\n')
  let text = `${intro}\n\n${body}`
  while (text.length < padTo) text += `\n\n${filler}`
  return text
}

export class MockOpenAI {
  calls: Array<{ kind: string; req: unknown }> = []
  researchImpl: (req: ResearchRequest) => ResearchResponse | Promise<ResearchResponse> = (req) => ({ data: researchFor(req.title), sources: [{ title: 'Store', url: 'https://store.example.com/x' }], usage: { inputTokens: 1000, outputTokens: 500 }, model: 'gpt-test' })
  scriptImpl: (req: ScriptRequest) => ScriptResponse | Promise<ScriptResponse> = (req) => ({ text: goodScript(req.title, req.template.structure.map((s) => s.label)), usage: { inputTokens: 2000, outputTokens: 1200 }, model: 'gpt-test' })
  reviewImpl: (req: ReviewRequest) => ReviewResponse | Promise<ReviewResponse> = () => ({ issues: [], usage: { inputTokens: 1500, outputTokens: 50 }, model: 'gpt-test' })
  delayMs = 0

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: 'mock' }
  }
  async listModels(): Promise<OpenAIModelInfo[]> {
    return [{ id: 'gpt-test', created: 1 }]
  }
  async research(req: ResearchRequest): Promise<ResearchResponse> {
    this.calls.push({ kind: 'research', req })
    await this.delay(req.signal)
    return this.researchImpl(req)
  }
  async writeScript(req: ScriptRequest): Promise<ScriptResponse> {
    this.calls.push({ kind: 'script', req })
    await this.delay(req.signal)
    return this.scriptImpl(req)
  }
  async reviewScript(req: ReviewRequest): Promise<ReviewResponse> {
    this.calls.push({ kind: 'review', req })
    return this.reviewImpl(req)
  }
  async analyzeTemplate(req: AnalyzeTemplateRequest): Promise<AnalyzeTemplateResponse> {
    this.calls.push({ kind: 'analyze', req })
    return { sections: [{ key: 'intro', label: 'Intro', required: true, aliases: [], guidance: '' }], systemPrompt: 'Analyzed prompt', observations: ['obs'], caveats: ['one example is not enough'], usage: { inputTokens: 10, outputTokens: 10 }, model: 'gpt-test' }
  }
  count(kind: string): number {
    return this.calls.filter((c) => c.kind === kind).length
  }
  private async delay(signal?: AbortSignal): Promise<void> {
    if (!this.delayMs) return
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new AppError('cancelled', 'aborted', { retryable: false }))
      })
    })
  }
}

export class MockElevenLabs {
  calls: TtsRequest[] = []
  synthImpl: (req: TtsRequest) => TtsResponse | Promise<TtsResponse> = (req) => ({ audio: fakeMp3(Math.max(2, req.text.length / 15)), requestId: `req-${this.calls.length}` })
  voices: ElevenVoice[] = [{ voiceId: 'voice-1', name: 'Test Voice', category: 'premade', description: '', previewUrl: null, labels: {}, favorite: false }]
  models: ElevenModel[] = [{ modelId: 'eleven_multilingual_v2', name: 'Multilingual v2', description: '', canDoTextToSpeech: true, canUseStyle: true, canUseSpeakerBoost: true, maxCharacters: 10000, languages: ['en'] }]
  delayMs = 0

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: 'mock' }
  }
  async listVoices(): Promise<ElevenVoice[]> {
    return this.voices
  }
  async listModels(): Promise<ElevenModel[]> {
    return this.models
  }
  async getSubscription(): Promise<ElevenSubscription | null> {
    return { tier: 'creator', characterCount: 1000, characterLimit: 100000, nextResetUnix: null, status: 'active' }
  }
  async synthesize(req: TtsRequest): Promise<TtsResponse> {
    this.calls.push(req)
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs)
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new AppError('cancelled', 'aborted', { retryable: false }))
        })
      })
    }
    return this.synthImpl(req)
  }
  async fetchPreview(): Promise<{ bytes: Buffer; contentType: string }> {
    return { bytes: fakeMp3(1), contentType: 'audio/mpeg' }
  }
}
