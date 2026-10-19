/**
 * 1.7.0 IPC: formats listed with their form factor and length window, and templates:setLimits
 * (zod validation, max ≥ min, unknown format), through the real IpcRegistry with Electron mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  clipboard: '',
  savePath: '' as string,
  openPath: '' as string
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => h.handlers.set(ch, fn) },
  app: { getPath: () => os.tmpdir(), getVersion: () => '1.6.0', isPackaged: false },
  clipboard: { writeText: (t: string) => (h.clipboard = t), readText: () => h.clipboard },
  dialog: {
    showSaveDialog: async () => ({ canceled: !h.savePath, filePath: h.savePath }),
    showOpenDialog: async () => ({ canceled: !h.openPath, filePaths: h.openPath ? [h.openPath] : [] })
  },
  shell: { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined },
  BrowserWindow: class {}
}))

import { createTestEnv, type TestEnv } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { BackupService } from '../src/main/services/backup'
import { Logger } from '../src/main/services/logger'
import { IpcRegistry } from '../src/main/ipc/registry'
import { registerHandlers } from '../src/main/ipc/handlers'
import type { UpdateService } from '../src/main/services/updater'

let env: TestEnv
let engine: QueueEngine
let gen: GenerationService

const call = async <T,>(channel: string, payload?: unknown): Promise<T> => {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  const res = (await fn({ senderFrame: { url: 'file:///index.html' } }, payload)) as { ok: boolean; data?: T; error?: { code: string; message: string } }
  if (!res.ok) throw Object.assign(new Error(res.error!.message), { code: res.error!.code })
  return res.data as T
}

beforeEach(() => {
  h.handlers.clear()
  env = createTestEnv()
  engine = new QueueEngine(env.s, new Logger().child('t'))
  gen = new GenerationService(env.s, engine)
  const reg = new IpcRegistry(new Logger(), ['file://'])
  registerHandlers(reg, {
    s: env.s,
    engine,
    generation: gen,
    backup: new BackupService(env.s),
    updates: {} as UpdateService,
    getWindow: () => null,
    requestRestart: () => undefined,
    prepareShutdown: async () => undefined
  })
})
afterEach(async () => {
  await engine.stop()
  env.cleanup()
})

describe('Formats IPC (1.7.0)', () => {
  it('lists formats with form factor and limits, and edits them', async () => {
    const rf = env.s.channels.getByName('RiftForge Tech')!
    const list = await call<Array<{ id: string; contentType: string; formFactor: string; minChars: number | null; maxChars: number | null; targetDurationSec: number | null }>>('templates:list', { channelId: rf.id })
    const by = Object.fromEntries(list.map((t) => [t.contentType, t]))
    expect(by.full_review!.formFactor).toBe('long')
    expect(by.full_review!.minChars).toBeNull()
    expect(by.unboxing!.formFactor).toBe('long')
    expect([by.short_review!.formFactor, by.short_review!.minChars, by.short_review!.maxChars, by.short_review!.targetDurationSec]).toEqual(['short', 120, 260, 11])

    const updated = await call<{ formFactor: string; minChars: number | null; maxChars: number | null; targetDurationSec: number | null }>('templates:setLimits', { templateId: by.unboxing!.id, formFactor: 'short', minChars: 300, maxChars: 550, targetDurationSec: 30 })
    expect(updated).toMatchObject({ formFactor: 'short', minChars: 300, maxChars: 550, targetDurationSec: 30 })
    const back = await call<{ formFactor: string; minChars: number | null }>('templates:setLimits', { templateId: by.unboxing!.id, formFactor: 'long', minChars: null, maxChars: null, targetDurationSec: null })
    expect(back).toMatchObject({ formFactor: 'long', minChars: null })

    await expect(call('templates:setLimits', { templateId: by.unboxing!.id, minChars: 600, maxChars: 500 })).rejects.toThrow()
    await expect(call('templates:setLimits', { templateId: by.unboxing!.id, formFactor: 'medium' })).rejects.toThrow()
    await expect(call('templates:setLimits', { templateId: 'nope', formFactor: 'short' })).rejects.toThrow(/Format not found/)
  })
})
