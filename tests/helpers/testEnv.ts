import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from '../../src/main/db/database'
import { buildRepos, EventBus, type ProviderFactory, type Services } from '../../src/main/services/container'
import { Logger } from '../../src/main/services/logger'
import { SecretStore, type Encryptor } from '../../src/main/services/secrets'
import { seedDefaults } from '../../src/main/services/seed'
import type { ElevenLabsProvider, OpenAIProvider } from '../../src/main/providers/types'
import { MockElevenLabs, MockOpenAI } from './mockProviders'

process.env.NODE_ENV = 'test'

/** A reversible fake "OS" encryptor so SecretStore can be tested without Electron. */
export function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`),
    decryptString: (b) => {
      const str = b.toString('utf8')
      if (!str.startsWith('enc:')) throw new Error('bad blob')
      return Buffer.from(str.slice(4), 'base64').toString('utf8')
    },
    backendName: () => 'test-encryptor'
  }
}

export interface TestEnv {
  s: Services
  dir: string
  openai: MockOpenAI
  eleven: MockElevenLabs
  cleanup: () => void
  reopen: () => TestEnv
}

export function createTestEnv(opts: { dir?: string; openai?: MockOpenAI; eleven?: MockElevenLabs; seed?: boolean } = {}): TestEnv {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vf-test-'))
  const userData = path.join(dir, 'userData')
  const output = path.join(dir, 'output')
  fs.mkdirSync(userData, { recursive: true })
  const logger = new Logger()
  logger.init(path.join(userData, 'logs'), 'error')
  const db = new Database(path.join(userData, 'voiceforge.sqlite'))
  const repos = buildRepos(db)
  const secrets = new SecretStore(userData, fakeEncryptor())
  const openai = opts.openai ?? new MockOpenAI()
  const eleven = opts.eleven ?? new MockElevenLabs()
  const providers: ProviderFactory = {
    openai: () => openai as unknown as OpenAIProvider,
    eleven: () => eleven as unknown as ElevenLabsProvider,
    reset: () => undefined
  }
  const s: Services = {
    db,
    ...repos,
    secrets,
    providers,
    events: new EventBus(),
    logger,
    paths: { userData, logs: path.join(userData, 'logs'), defaultOutputRoot: output, outputRoot: () => repos.settings.get().general.outputRoot || output },
    appVersion: '0.0.0-test'
  }
  if (opts.seed !== false) {
    seedDefaults(s)
    // The seeded profiles intentionally ship without a voice; tests assign the mock voice.
    for (const c of repos.channels.list()) repos.channels.update(c.id, { elevenVoiceId: 'voice-1', elevenVoiceName: 'Test Voice' })
  }
  secrets.set('openai', 'sk-test-openai-key-1234567890')
  secrets.set('elevenlabs', '0123456789abcdef0123456789abcdef')
  const cleanup = (): void => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const reopen = (): TestEnv => {
    db.close()
    return createTestEnv({ dir, openai, eleven, seed: false })
  }
  return { s, dir, openai, eleven, cleanup, reopen }
}

export function makeTemplateActive(s: Services, channelId: string, structureLabels: string[] = ['Gameplay', 'Combat', 'Pros', 'Cons', 'Conclusion']): string {
  const { version } = s.channels.createTemplate(channelId, 'Test template', {
    systemPrompt: 'Write the review.',
    structure: structureLabels.map((l) => ({ key: l.toLowerCase().replace(/[^a-z]+/g, '_'), label: l, required: true, aliases: l === 'Combat' ? ['Combat & Exploration'] : [], guidance: '' })),
    exampleScript: null,
    notes: 'test',
    placeholder: false
  })
  s.channels.setActiveVersion(channelId, version.id)
  return version.id
}

export function waitFor(fn: () => boolean, timeoutMs = 10000, interval = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const t = setInterval(() => {
      try {
        if (fn()) {
          clearInterval(t)
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(t)
          reject(new Error('waitFor timeout'))
        }
      } catch (e) {
        clearInterval(t)
        reject(e)
      }
    }, interval)
  })
}
