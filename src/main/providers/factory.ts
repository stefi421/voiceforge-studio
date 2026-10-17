import type { ProviderFactory } from '../services/container'
import type { SecretStore } from '../services/secrets'
import type { SettingsService } from '../services/settings'
import type { Logger } from '../services/logger'
import { AppError } from '../util/errors'
import { OpenAIClientProvider } from './openai'
import { ElevenLabsClientProvider } from './elevenlabs'
import type { ElevenLabsProvider, OpenAIProvider } from './types'

export function createProviderFactory(secrets: SecretStore, settings: SettingsService, logger: Logger): ProviderFactory {
  let openaiCache: { key: string; timeout: number; provider: OpenAIProvider } | null = null
  let elevenCache: { key: string; timeout: number; provider: ElevenLabsProvider } | null = null
  return {
    openai() {
      const key = secrets.get('openai')
      if (!key) throw new AppError('auth', 'No OpenAI API key is configured.', { action: 'Open Settings → OpenAI and enter your API key.', retryable: false, code: 'OPENAI_KEY_MISSING' })
      const timeout = settings.get().openai.timeoutMs
      if (!openaiCache || openaiCache.key !== key || openaiCache.timeout !== timeout) {
        openaiCache = { key, timeout, provider: new OpenAIClientProvider({ apiKey: key, timeoutMs: timeout }, logger.child('openai')) }
      }
      return openaiCache.provider
    },
    eleven() {
      const key = secrets.get('elevenlabs')
      if (!key) throw new AppError('auth', 'No ElevenLabs API key is configured.', { action: 'Open Settings → ElevenLabs and enter your API key.', retryable: false, code: 'ELEVEN_KEY_MISSING' })
      const timeout = settings.get().elevenlabs.timeoutMs
      if (!elevenCache || elevenCache.key !== key || elevenCache.timeout !== timeout) {
        elevenCache = { key, timeout, provider: new ElevenLabsClientProvider({ apiKey: key, timeoutMs: timeout }, logger.child('elevenlabs')) }
      }
      return elevenCache.provider
    },
    reset() {
      openaiCache = null
      elevenCache = null
    }
  }
}
