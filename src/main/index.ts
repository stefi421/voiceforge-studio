import { app, BrowserWindow, Notification, protocol, safeStorage, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Database, DatabaseClosedError } from './db/database'
import { buildRepos, EventBus, type Services } from './services/container'
import { logger } from './services/logger'
import { electronEncryptor, SecretStore } from './services/secrets'
import { createProviderFactory } from './providers/factory'
import { QueueEngine } from './queue/engine'
import { GenerationService } from './services/generation'
import { BackupService } from './services/backup'
import { IpcRegistry } from './ipc/registry'
import { registerHandlers } from './ipc/handlers'
import { seedDefaults } from './services/seed'
import { applyReferencePack } from './services/referencePack'
import { cleanupTempFiles } from './services/files'
import { ElevenLabsClientProvider } from './providers/elevenlabs'
import { UpdateService } from './services/updater'

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const RENDERER_ORIGIN = isDev ? new URL(process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173').origin : 'file://'

// Single instance: a second launch focuses the existing window instead of running two queues.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

protocol.registerSchemesAsPrivileged([{ scheme: 'vfmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }])

let mainWindow: BrowserWindow | null = null
let services: Services | null = null
let engine: QueueEngine | null = null
let restartRequested = false
let quitting = false

function swapInPendingRestore(dbPath: string): void {
  const pending = path.join(app.getPath('userData'), 'restore-pending.sqlite')
  if (!fs.existsSync(pending)) return
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.before-restore-${stamp}`)
    for (const suffix of ['-wal', '-shm']) {
      const f = `${dbPath}${suffix}`
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    fs.renameSync(pending, dbPath)
    logger.log('info', 'restore', 'Database restored from backup', { dbPath })
  } catch (err) {
    logger.log('error', 'restore', 'Failed to apply pending restore', { error: (err as Error).message })
  }
}

function openDatabaseWithRecovery(dbPath: string): Database {
  try {
    const db = new Database(dbPath)
    const check = db.integrityCheck()
    if (!check.ok) throw new Error(`integrity check failed: ${check.details}`)
    return db
  } catch (err) {
    logger.log('error', 'db', 'Database failed to open; moving it aside and starting fresh', { error: (err as Error).message })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.corrupt-${stamp}`)
      for (const suffix of ['-wal', '-shm']) {
        const f = `${dbPath}${suffix}`
        if (fs.existsSync(f)) fs.renameSync(f, `${f}.corrupt-${stamp}`)
      }
    } catch {
      /* ignore */
    }
    return new Database(dbPath)
  }
}

function bootstrap(): Services {
  const userData = app.getPath('userData')
  const logs = path.join(userData, 'logs')
  logger.init(logs, 'info')
  const dbPath = path.join(userData, 'voiceforge.sqlite')
  swapInPendingRestore(dbPath)
  const db = openDatabaseWithRecovery(dbPath)
  const repos = buildRepos(db)
  logger.setLevel(repos.settings.get().advanced.logLevel)
  const secrets = new SecretStore(userData, electronEncryptor(safeStorage))
  const defaultOutputRoot = path.join(app.getPath('documents'), 'VoiceForge Studio')
  const paths = {
    userData,
    logs,
    defaultOutputRoot,
    outputRoot: () => {
      const configured = repos.settings.get().general.outputRoot
      return configured && configured.trim() ? configured : defaultOutputRoot
    }
  }
  const events = new EventBus()
  const providers = createProviderFactory(secrets, repos.settings, logger)
  const s: Services = { db, ...repos, secrets, providers, events, logger, paths, appVersion: app.getVersion() }
  seedDefaults(s)
  try {
    applyReferencePack(s, undefined, { notifyDelayMs: 6000 })
  } catch (err) {
    logger.log('error', 'reference-pack', 'Applying the reference pack failed', { error: (err as Error).message })
  }
  return s
}

function createWindow(s: Services): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'VoiceForge Studio',
    // Packaged: build/icon.ico is shipped next to app.asar via extraResources; dev: read it from the repo.
    icon: process.platform === 'win32' ? (app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, '../../build/icon.ico')) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(RENDERER_ORIGIN)) e.preventDefault()
  })
  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    mainWindow = null
  })
  installSmokeTest(win)
  // Forward domain events to the renderer.
  const forward = <E extends Parameters<typeof s.events.on>[0]>(name: E): void => {
    s.events.on(name, (payload) => {
      if (!win.isDestroyed()) win.webContents.send(name, payload)
    })
  }
  forward('job:changed')
  forward('queue:stats')
  forward('batch:completed')
  forward('notification')
  forward('settings:changed')
  forward('secrets:changed')
  forward('update:status')
  return win
}

/**
 * Headless smoke test used by CI/dev: VF_SMOKE_TEST=<dir> starts the app, waits for the
 * renderer, writes a screenshot + console log into <dir>, then quits. Inert otherwise.
 */
function installSmokeTest(win: BrowserWindow): void {
  const dir = process.env.VF_SMOKE_TEST
  if (!dir) return
  const consoleLines: string[] = []
  win.webContents.on('console-message', (event) => {
    consoleLines.push(`[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const pages = (process.env.VF_SMOKE_PAGES ?? 'dashboard').split(',')
        for (const page of pages) {
          await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('vf:navigate', { detail: ${JSON.stringify(page)} })); true`).catch(() => undefined)
          await new Promise((r) => setTimeout(r, 1200))
          const image = await win.webContents.capturePage()
          fs.writeFileSync(path.join(dir, `${page}.png`), image.toPNG())
        }
        fs.writeFileSync(path.join(dir, 'console.log'), consoleLines.join('\n'))
      } catch (err) {
        fs.writeFileSync(path.join(dir, 'smoke-error.txt'), String((err as Error).stack ?? err))
      } finally {
        app.quit()
      }
    }, 2500)
  })
}

function installCsp(): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: vfmedia:",
    "media-src 'self' vfmedia:",
    "font-src 'self' data:",
    "connect-src 'self' vfmedia:" + (isDev ? ' ws: http://localhost:*' : ''),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // The renderer never needs any permission (camera, notifications via web API, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
}

function installMediaProtocol(s: Services): void {
  protocol.handle('vfmedia', async (request) => {
    try {
      const url = new URL(request.url)
      const kind = url.hostname
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (kind === 'audio') {
        const audio = s.audio.get(id)
        if (!audio) return new Response('Not found', { status: 404 })
        // Paths come from our own database rows (never from the renderer); still refuse anything odd.
        if (!path.isAbsolute(audio.filePath) || !/\.(mp3|pcm|opus)$/i.test(audio.filePath)) return new Response('Forbidden', { status: 403 })
        if (!fs.existsSync(audio.filePath)) return new Response('Missing file', { status: 404 })
        const data = await fs.promises.readFile(audio.filePath)
        const type = audio.outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'application/octet-stream'
        return new Response(data, { headers: { 'Content-Type': type, 'Content-Length': String(data.length), 'Accept-Ranges': 'bytes' } })
      }
      if (kind === 'preview') {
        const voices = s.cache.get<Array<{ voiceId: string; previewUrl: string | null }>>('eleven_voices', 7 * 24 * 3600 * 1000) ?? []
        const voice = voices.find((v) => v.voiceId === id)
        if (!voice?.previewUrl) return new Response('No preview', { status: 404 })
        const provider = s.providers.eleven() as ElevenLabsClientProvider
        const { bytes, contentType } = await provider.fetchPreview(voice.previewUrl)
        return new Response(bytes, { headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) } })
      }
      return new Response('Not found', { status: 404 })
    } catch (err) {
      logger.log('warn', 'media', 'vfmedia request failed', { error: (err as Error).message })
      return new Response('Error', { status: 500 })
    }
  })
}

function scheduleBackups(s: Services, backup: BackupService): void {
  const run = async (): Promise<void> => {
    if (quitting || !s.db.isOpen) return
    const hours = s.settings.get().storage.autoBackupEveryHours
    if (hours <= 0) return
    const last = s.backups.list()[0]
    const due = !last || Date.now() - new Date(last.createdAt).getTime() > hours * 3600 * 1000
    if (due) {
      try {
        await backup.create()
        logger.log('info', 'backup', 'Automatic backup created')
      } catch (err) {
        logger.log('warn', 'backup', 'Automatic backup failed', { error: (err as Error).message })
      }
    }
  }
  timers.push(setTimeout(() => void run(), 30_000))
  timers.push(setInterval(() => void run(), 30 * 60_000))
}

/** Background timers that must not fire after the database is closed. */
const timers: Array<ReturnType<typeof setTimeout>> = []
let disposeUpdates: () => void = () => undefined
function clearTimers(): void {
  for (const t of timers.splice(0)) clearTimeout(t)
  disposeUpdates()
}

function desktopNotifications(s: Services): void {
  s.events.on('batch:completed', (b) => {
    if (!s.settings.get().general.notifications || !Notification.isSupported()) return
    new Notification({ title: 'VoiceForge Studio — batch finished', body: `${b.name}: ${b.completed} completed, ${b.failed} failed` }).show()
    if (s.settings.get().general.autoOpenFolderOnBatchComplete) void shell.openPath(s.paths.outputRoot())
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  app.setAppUserModelId('com.voiceforge.studio')
  installCsp()
  const s = bootstrap()
  services = s
  installMediaProtocol(s)
  engine = new QueueEngine(s, logger.child('queue'))
  // 1.6.0: research saved by earlier versions becomes part of the permanent Game Library (once).
  try {
    engine.pipeline.library.importLegacyResearch()
  } catch (err) {
    logger.log('warn', 'library', 'Importing earlier research into the Game Library failed', { error: (err as Error).message })
  }
  const generation = new GenerationService(s, engine)
  const backup = new BackupService(s)
  const updates = new UpdateService(s, logger.child('updates'))
  const registry = new IpcRegistry(logger, [RENDERER_ORIGIN])
  registerHandlers(registry, {
    s,
    engine,
    generation,
    backup,
    updates,
    getWindow: () => mainWindow,
    requestRestart: () => {
      restartRequested = true
      app.relaunch()
      app.quit()
    },
    prepareShutdown: async () => {
      quitting = true
      clearTimers()
      await engine?.stop()
      services?.db.close()
      logger.log('info', 'app', 'Shutting down to install an update')
    }
  })
  desktopNotifications(s)
  mainWindow = createWindow(s)
  engine.start()
  scheduleBackups(s, backup)
  updates.scheduleStartupCheck()
  disposeUpdates = () => updates.dispose()
  timers.push(setTimeout(() => void engine?.pipeline.cleanTtsCache().then((n) => n && logger.log('info', 'cleanup', 'Removed old cached voice parts', { count: n })).catch(() => undefined), 20_000))
  if (s.settings.get().storage.cleanupTempFiles) {
    timers.push(setTimeout(() => void cleanupTempFiles(s.paths.outputRoot()).then((n) => n && logger.log('info', 'cleanup', 'Removed stale temp files', { count: n })), 15_000))
  }
  app.setLoginItemSettings({ openAtLogin: s.settings.get().general.launchAtStartup })
  s.settings.onChange((next) => app.setLoginItemSettings({ openAtLogin: next.general.launchAtStartup }))
  logger.log('info', 'app', 'VoiceForge Studio started', { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && services) mainWindow = createWindow(services)
  })
})

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void (async () => {
    try {
      clearTimers()
      await engine?.stop()
      services?.db.close()
      logger.log('info', 'app', restartRequested ? 'Restarting' : 'Shutdown complete')
    } finally {
      app.exit(0)
    }
  })()
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (err) => {
  logger.log('error', 'process', 'Uncaught exception', { error: err.message, stack: err.stack })
})
process.on('unhandledRejection', (reason) => {
  // Late work (an in-flight request finishing) can touch the closed database while quitting; that is expected.
  if (quitting && reason instanceof DatabaseClosedError) {
    logger.log('debug', 'process', 'Ignored database access during shutdown', { error: reason.message })
    return
  }
  logger.log('error', 'process', 'Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) })
})
