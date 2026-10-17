/**
 * Updater service tests. `electron` and `electron-updater` are mocked: no network, no
 * real installer. Covers the state machine the Settings → Updates page relies on,
 * the "never download without the user" rule and the honest "unsupported" states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { UpdateStatus } from '../src/shared/types'
import { createTestEnv, type TestEnv } from './helpers/testEnv'

const electronMock = { app: { isPackaged: true, getVersion: () => '1.1.0' } }
vi.mock('electron', () => electronMock)

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  logger: unknown = null
  feed: unknown = null
  checks = 0
  downloads = 0
  installs = 0
  nextVersion: string | null = '1.2.0'
  failCheck: Error | null = null
  setFeedURL(opts: unknown): void {
    this.feed = opts
  }
  async checkForUpdates(): Promise<void> {
    this.checks++
    this.emit('checking-for-update')
    if (this.failCheck) {
      this.emit('error', this.failCheck)
      return
    }
    if (this.nextVersion) this.emit('update-available', { version: this.nextVersion, releaseNotes: '<p>Fixes &amp; <b>polish</b></p>', releaseDate: '2026-10-20' })
    else this.emit('update-not-available', { version: '1.1.0' })
  }
  async downloadUpdate(): Promise<void> {
    this.downloads++
    this.emit('download-progress', { percent: 42.4, bytesPerSecond: 1000 })
    this.emit('update-downloaded', { version: this.nextVersion })
  }
  quitAndInstall(): void {
    this.installs++
  }
}
const fake = new FakeAutoUpdater()
vi.mock('electron-updater', () => ({ autoUpdater: fake }))

// process.resourcesPath does not exist under Node; the service checks for app-update.yml there.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, default: { ...real, existsSync: (p: string) => (String(p).endsWith('app-update.yml') ? true : real.existsSync(p)) } }
})

describe('UpdateService', () => {
  let env: TestEnv
  const states: UpdateStatus[] = []
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    ;(process as unknown as { resourcesPath: string }).resourcesPath = '/fake/resources'
    env = createTestEnv()
    states.length = 0
    env.s.events.on('update:status', (st) => states.push(st))
    fake.checks = fake.downloads = fake.installs = 0
    fake.failCheck = null
    fake.nextVersion = '1.2.0'
    delete process.env.PORTABLE_EXECUTABLE_FILE
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    env.cleanup()
  })

  it('checks, downloads only on request, installs after shutdown, and never auto-downloads', async () => {
    const { UpdateService } = await import('../src/main/services/updater')
    const svc = new UpdateService(env.s, env.s.logger.child('upd'))
    expect(svc.getStatus().state).toBe('idle')
    expect(svc.getStatus().feed).toEqual({ owner: 'stefi421', repo: 'voiceforge-studio' })

    const after = await svc.check()
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(fake.feed).toEqual({ provider: 'github', owner: 'stefi421', repo: 'voiceforge-studio' })
    expect(after.state).toBe('available')
    expect(after.latestVersion).toBe('1.2.0')
    expect(after.releaseNotes).toBe('Fixes & polish')
    expect(fake.downloads).toBe(0)

    const dl = await svc.download()
    expect(dl.state).toBe('downloaded')
    expect(states.some((s) => s.state === 'downloading' && s.progressPercent === 42)).toBe(true)

    let shutdowns = 0
    const res = await svc.install(async () => {
      shutdowns++
    })
    expect(res.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(shutdowns).toBe(1)
    expect(fake.installs).toBe(1)
  })

  it('reports "up to date", turns provider errors into actionable messages and refuses download before check', async () => {
    const { UpdateService } = await import('../src/main/services/updater')
    const svc = new UpdateService(env.s, env.s.logger.child('upd'))
    await expect(svc.download()).rejects.toMatchObject({ kind: 'config' })
    fake.nextVersion = null
    expect((await svc.check()).state).toBe('not_available')
    fake.failCheck = new Error('HttpError: 404 Not Found')
    const st = await svc.check()
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/No release was found/)
  })

  it('follows feed changes from settings and reports the portable build as unsupported', async () => {
    const { UpdateService } = await import('../src/main/services/updater')
    const svc = new UpdateService(env.s, env.s.logger.child('upd'))
    env.s.settings.update({ updates: { owner: 'someone', repo: 'releases-only' } })
    expect(svc.getStatus().feed).toEqual({ owner: 'someone', repo: 'releases-only' })
    expect(svc.getStatus().releaseUrl).toBe('https://github.com/someone/releases-only/releases/latest')
    await svc.check()
    expect(fake.feed).toEqual({ provider: 'github', owner: 'someone', repo: 'releases-only' })

    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Tools\\VoiceForge.exe'
    const portable = new UpdateService(env.s, env.s.logger.child('upd'))
    expect(portable.getStatus().state).toBe('unsupported')
    expect(portable.getStatus().portable).toBe(true)
    await expect(portable.check()).rejects.toMatchObject({ kind: 'config' })
  })
})
