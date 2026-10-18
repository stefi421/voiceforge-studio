import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, UpdateStatus } from '@shared/types'
import type { Services } from './container'
import type { ScopedLogger } from './logger'
import { AppError } from '../util/errors'

/**
 * In-app updates via electron-updater + GitHub Releases.
 *
 * Security posture (see docs/SECURITY.md):
 * - Nothing is downloaded or installed without the user clicking "Download" and
 *   "Restart and install". Only the *check* runs automatically (and only if enabled).
 * - electron-updater verifies the sha512 of the downloaded installer against the
 *   `latest.yml` published alongside it, so a corrupted/tampered download is rejected.
 * - The installer is the same NSIS package that is shipped for manual installs; it
 *   upgrades in place and keeps %APPDATA%\VoiceForge Studio.
 * - No remote code is ever evaluated; the update is a signed/unsigned installer file.
 *
 * The portable build cannot replace its own running executable, so it only reports
 * that a newer version exists and opens the releases page.
 */
type ElectronUpdater = typeof import('electron-updater')

const RELEASE_NOTES_MAX = 8000

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function isPortableBuild(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_FILE || !!process.env.PORTABLE_EXECUTABLE_DIR
}

export class UpdateService {
  private status: UpdateStatus
  private updater: ElectronUpdater['autoUpdater'] | null = null
  private configuredFeed: string | null = null
  private checkPromise: Promise<UpdateStatus> | null = null
  private downloadPromise: Promise<UpdateStatus> | null = null
  private readonly portable = isPortableBuild()
  private readonly supported: boolean

  constructor(
    private readonly s: Services,
    private readonly log: ScopedLogger
  ) {
    const feed = this.feed(s.settings.get())
    // electron-updater needs the packaged app-update.yml; dev runs report "unsupported" honestly.
    const hasUpdateConfig = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))
    this.supported = hasUpdateConfig && process.platform === 'win32' && !this.portable
    this.status = {
      state: this.supported ? 'idle' : 'unsupported',
      currentVersion: s.appVersion,
      latestVersion: null,
      releaseNotes: null,
      releaseDate: null,
      progressPercent: null,
      bytesPerSecond: null,
      error: this.supported ? null : this.unsupportedReason(hasUpdateConfig),
      checkedAt: null,
      feed,
      portable: this.portable,
      releaseUrl: this.releaseUrl(feed)
    }
    s.settings.onChange((next) => {
      const f = this.feed(next)
      if (f.owner !== this.status.feed.owner || f.repo !== this.status.feed.repo) {
        this.patch({ feed: f, releaseUrl: this.releaseUrl(f), latestVersion: null, state: this.supported ? 'idle' : 'unsupported' })
      }
    })
  }

  private unsupportedReason(hasUpdateConfig: boolean): string {
    if (this.portable) return 'The portable build cannot replace itself. Download the new version from the releases page and replace the file.'
    if (!app.isPackaged) return 'Updates are only available in the packaged application (not in development mode).'
    if (process.platform !== 'win32') return 'In-app updates are only built for Windows.'
    if (!hasUpdateConfig) return 'This build was packaged without update metadata (app-update.yml).'
    return 'Updates are unavailable in this build.'
  }

  private feed(settings: AppSettings): { owner: string; repo: string } {
    return { owner: settings.updates.owner.trim(), repo: settings.updates.repo.trim() }
  }

  private releaseUrl(feed: { owner: string; repo: string }): string | null {
    if (!feed.owner || !feed.repo) return null
    return `https://github.com/${encodeURIComponent(feed.owner)}/${encodeURIComponent(feed.repo)}/releases/latest`
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  private patch(p: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...p }
    this.s.events.emit('update:status', this.getStatus())
  }

  private async ensureUpdater(): Promise<ElectronUpdater['autoUpdater']> {
    if (!this.supported) {
      throw new AppError('config', this.status.error ?? 'Updates are unavailable in this build.', { retryable: false, action: this.status.releaseUrl ? 'Open the releases page to download the latest version manually.' : undefined })
    }
    const settings = this.s.settings.get()
    const feed = this.feed(settings)
    if (!feed.owner || !feed.repo) {
      throw new AppError('config', 'No update source is configured.', { action: 'Enter the GitHub owner and repository in Settings → Updates.', retryable: false })
    }
    if (!this.updater) {
      // Lazy import keeps startup cheap and lets tests substitute electron-updater.
      // The main bundle is CommonJS, so a dynamic import of a CJS package may arrive as
      // { default: module } — read the export from either shape (v1.1.0 shipped with only the
      // first form and the startup check crashed with "Cannot set properties of undefined").
      const mod = (await import('electron-updater')) as ElectronUpdater & { default?: ElectronUpdater }
      const u = mod.autoUpdater ?? mod.default?.autoUpdater
      if (!u) throw new AppError('config', 'The update module could not be loaded in this build.', { retryable: false })
      u.autoDownload = false
      u.autoInstallOnAppQuit = false
      u.logger = {
        info: (m: unknown) => this.log.info(String(m)),
        warn: (m: unknown) => this.log.warn(String(m)),
        error: (m: unknown) => this.log.error(String(m)),
        debug: (m: unknown) => this.log.debug(String(m))
      }
      u.on('checking-for-update', () => this.patch({ state: 'checking', error: null }))
      u.on('update-available', (info) => {
        this.patch({
          state: 'available',
          latestVersion: info.version,
          releaseNotes: this.notes(info.releaseNotes),
          releaseDate: info.releaseDate ?? null,
          checkedAt: new Date().toISOString(),
          error: null
        })
      })
      u.on('update-not-available', (info) => {
        this.patch({ state: 'not_available', latestVersion: info.version, checkedAt: new Date().toISOString(), error: null, progressPercent: null })
      })
      u.on('download-progress', (p) => {
        this.patch({ state: 'downloading', progressPercent: Math.round(p.percent), bytesPerSecond: Math.round(p.bytesPerSecond) })
      })
      u.on('update-downloaded', (info) => {
        this.patch({ state: 'downloaded', latestVersion: info.version, progressPercent: 100, error: null })
        this.s.events.notify('success', 'Update ready', `VoiceForge Studio ${info.version} has been downloaded. Restart to install it.`)
      })
      u.on('error', (err) => {
        const message = this.friendlyError(err)
        this.log.warn('Updater error', { error: err?.message })
        this.patch({ state: 'error', error: message, progressPercent: null })
      })
      this.updater = u
    }
    const feedKey = `${feed.owner}/${feed.repo}/${settings.updates.allowPrerelease ? 'pre' : 'stable'}`
    if (this.configuredFeed !== feedKey) {
      this.updater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo })
      this.updater.allowPrerelease = settings.updates.allowPrerelease
      this.configuredFeed = feedKey
    }
    return this.updater
  }

  private notes(raw: unknown): string | null {
    if (!raw) return null
    if (typeof raw === 'string') return stripHtml(raw).slice(0, RELEASE_NOTES_MAX)
    if (Array.isArray(raw)) {
      return raw
        .map((n) => (n && typeof n === 'object' && 'note' in n ? `${(n as { version?: string }).version ?? ''}\n${stripHtml(String((n as { note: unknown }).note ?? ''))}` : ''))
        .filter(Boolean)
        .join('\n\n')
        .slice(0, RELEASE_NOTES_MAX)
    }
    return null
  }

  private friendlyError(err: Error | null | undefined): string {
    const m = err?.message ?? 'Unknown error'
    if (/404|Cannot find|not found/i.test(m)) return 'No release was found for the configured repository. Check Settings → Updates (owner / repository) or publish a release first.'
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|getaddrinfo/i.test(m)) return 'Could not reach GitHub. Check your internet connection and try again.'
    if (/sha512|checksum|integrity/i.test(m)) return 'The downloaded file failed its integrity check and was discarded. Try again; if it keeps failing, download the installer manually from the releases page.'
    return m
  }

  async check(): Promise<UpdateStatus> {
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = (async () => {
      const u = await this.ensureUpdater()
      try {
        await u.checkForUpdates()
      } catch (err) {
        this.patch({ state: 'error', error: this.friendlyError(err as Error), checkedAt: new Date().toISOString() })
      }
      return this.getStatus()
    })().finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  async download(): Promise<UpdateStatus> {
    if (this.downloadPromise) return this.downloadPromise
    if (this.status.state === 'downloaded') return this.getStatus()
    if (this.status.state !== 'available') {
      throw new AppError('config', 'There is no update to download yet.', { action: 'Click "Check for updates" first.', retryable: false })
    }
    this.downloadPromise = (async () => {
      const u = await this.ensureUpdater()
      this.patch({ state: 'downloading', progressPercent: 0, error: null })
      try {
        await u.downloadUpdate()
      } catch (err) {
        this.patch({ state: 'error', error: this.friendlyError(err as Error), progressPercent: null })
      }
      return this.getStatus()
    })().finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  }

  /** Quits the app and runs the downloaded installer (silent upgrade, relaunch when done). */
  async install(beforeQuit: () => Promise<void>): Promise<{ ok: boolean; message?: string }> {
    if (this.status.state !== 'downloaded') {
      return { ok: false, message: 'The update has not been downloaded yet.' }
    }
    const u = await this.ensureUpdater()
    void beforeQuit().finally(() => {
      setImmediate(() => u.quitAndInstall(true, true))
    })
    return { ok: true }
  }

  /** Called once after startup when the user has "check on startup" enabled. Never downloads. */
  scheduleStartupCheck(delayMs = 20_000): void {
    if (!this.supported) return
    setTimeout(() => {
      try {
        if (!this.s.settings.get().updates.checkOnStartup) return
        this.check()
          .then((st) => {
            if (st.state === 'available') {
              this.s.events.notify('info', 'Update available', `VoiceForge Studio ${st.latestVersion} is available. Open Settings → Updates to download it.`)
            }
          })
          .catch((err: unknown) => {
            // Never let a background check surface as an unhandled rejection; the status panel shows the error.
            const message = err instanceof Error ? err.message : String(err)
            this.log.warn('Startup update check failed', { error: message })
            this.patch({ state: 'error', error: message })
          })
      } catch (err) {
        this.log.warn('Startup update check could not start', { error: (err as Error).message })
      }
    }, delayMs)
  }
}
