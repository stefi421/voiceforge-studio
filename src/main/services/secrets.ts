import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './files'

/**
 * Secret storage.
 *
 * On Windows the Electron `safeStorage` API encrypts with DPAPI, bound to the
 * logged-in Windows user — the same protection class Windows Credential
 * Manager uses, without a native add-on (keytar is archived/unmaintained).
 * Encrypted blobs are kept in `<userData>/secrets.json`; they are never
 * written to SQLite, logs, backups or exports.
 */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
  backendName(): string
}

export type SecretProvider = 'openai' | 'elevenlabs'

interface SecretsFile {
  version: 1
  backend: string
  entries: Record<string, string> // base64 encrypted
}

export class SecretStore {
  private cache = new Map<SecretProvider, string>()
  private filePath: string

  constructor(
    userDataDir: string,
    private encryptor: Encryptor
  ) {
    this.filePath = path.join(userDataDir, 'secrets.json')
  }

  get backend(): string {
    return this.encryptor.backendName()
  }

  get encryptionAvailable(): boolean {
    return this.encryptor.isEncryptionAvailable()
  }

  private readFile(): SecretsFile {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, backend: this.backend, entries: {} }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SecretsFile
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { version: 1, backend: this.backend, entries: {} }
      return parsed
    } catch {
      return { version: 1, backend: this.backend, entries: {} }
    }
  }

  private writeFile(data: SecretsFile): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2))
  }

  has(provider: SecretProvider): boolean {
    if (this.cache.has(provider)) return true
    return !!this.readFile().entries[provider]
  }

  get(provider: SecretProvider): string | null {
    const cached = this.cache.get(provider)
    if (cached) return cached
    const entry = this.readFile().entries[provider]
    if (!entry) return null
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable; stored API keys cannot be decrypted on this machine. Re-enter the key in Settings.')
    }
    try {
      const plain = this.encryptor.decryptString(Buffer.from(entry, 'base64'))
      this.cache.set(provider, plain)
      return plain
    } catch {
      throw new Error('Stored API key could not be decrypted (it was saved by a different Windows user or machine). Re-enter the key in Settings.')
    }
  }

  set(provider: SecretProvider, value: string): void {
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable, so the API key cannot be stored securely. On Windows this requires a signed-in user session.')
    }
    const trimmed = value.trim()
    const data = this.readFile()
    data.entries[provider] = this.encryptor.encryptString(trimmed).toString('base64')
    data.backend = this.backend
    this.writeFile(data)
    this.cache.set(provider, trimmed)
  }

  clear(provider: SecretProvider): void {
    const data = this.readFile()
    delete data.entries[provider]
    this.writeFile(data)
    this.cache.delete(provider)
  }

  status(): { openai: boolean; elevenlabs: boolean; backend: string; encryptionAvailable: boolean } {
    return { openai: this.has('openai'), elevenlabs: this.has('elevenlabs'), backend: this.backend, encryptionAvailable: this.encryptionAvailable }
  }
}

/** Adapter around Electron's safeStorage. Created lazily so tests never import electron. */
export function electronEncryptor(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  getSelectedStorageBackend?: () => string
}): Encryptor {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
    backendName: () => {
      if (process.platform === 'win32') return 'Windows DPAPI (user-bound, via Electron safeStorage)'
      if (process.platform === 'darwin') return 'macOS Keychain (via Electron safeStorage)'
      try {
        return `Electron safeStorage (${safeStorage.getSelectedStorageBackend?.() ?? 'linux'})`
      } catch {
        return 'Electron safeStorage'
      }
    }
  }
}
