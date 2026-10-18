/**
 * 1.6.0 IPC: Games page channels, "Copy all scripts" and the "Saved by reuse" summary,
 * called through the real IpcRegistry (zod validation + error mapping) with Electron mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { researchFor } from './helpers/mockProviders'
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

describe('Games IPC', () => {
  it('lists, edits, corrects, aliases, refreshes, exports, imports and deletes saved games', async () => {
    const lib = engine.pipeline.library
    const g = lib.record({ typedTitle: 'Emberward', subject: 'game', data: researchFor('Emberward'), sources: [{ title: 'Store', url: 'https://store.example.com/x' }], model: 'gpt-test', tokens: 1200 })

    const list = await call<Array<{ id: string; canonicalTitle: string; scriptCount: number }>>('games:list', {})
    expect(list.map((x) => x.canonicalTitle)).toEqual(['Emberward'])
    expect(await call<unknown[]>('games:list', { query: 'nothing like it' })).toEqual([])

    await call('games:update', { id: g.id, userNotes: 'Sponsored by nobody', pinned: true })
    await call('games:addFact', { id: g.id, text: 'Photo mode arrives in 1.2.' })
    const wrong = g.data.gameplayMechanics[0]!
    let v = await call<{ removedFacts: string[]; userFacts: string[]; pinned: boolean; userNotes: string }>('games:removeFact', { id: g.id, text: wrong })
    expect(v.removedFacts).toContain(wrong)
    expect(v.userFacts).toContain('Photo mode arrives in 1.2.')
    expect(v).toMatchObject({ pinned: true, userNotes: 'Sponsored by nobody' })
    v = await call('games:restoreFact', { id: g.id, text: wrong })
    expect(v.removedFacts).not.toContain(wrong)

    await call('games:addAlias', { id: g.id, alias: 'Ember Ward' })
    const matches = await call<Array<{ kind: string; gameId: string | null }>>('games:match', { titles: ['ember ward', 'Something Else'], channelId: env.s.channels.getByName('Game Vault')!.id })
    expect(matches.map((m) => m.kind)).toEqual(['exact', 'none'])
    expect(matches[0]!.gameId).toBe(g.id)
    // An alias used by another entry is refused with a clear message.
    const other = lib.record({ typedTitle: 'Iron Coast', subject: 'game', data: researchFor('Iron Coast'), sources: [], model: 'gpt-test', tokens: 1 })
    await expect(call('games:addAlias', { id: other.id, alias: 'Ember Ward' })).rejects.toThrow()
    const afterRemove = await call<{ aliases: string[] }>('games:removeAlias', { id: g.id, alias: 'Ember Ward' })
    expect(afterRemove.aliases).not.toContain('Ember Ward')

    // Renaming keeps the old name as an alias.
    const renamed = await call<{ canonicalTitle: string; aliases: string[] }>('games:update', { id: g.id, canonicalTitle: 'Emberward: Forge Edition' })
    expect(renamed.canonicalTitle).toBe('Emberward: Forge Edition')
    expect(renamed.aliases).toContain('Emberward')

    const before = env.openai.count('research')
    await call('games:refresh', { id: g.id })
    expect(env.openai.count('research')).toBe(before + 1)

    // Export → delete → import round trip.
    h.savePath = path.join(env.dir, 'games.json')
    const exp = await call<{ path: string; count: number }>('games:export')
    expect(exp.count).toBe(2)
    expect(JSON.parse(fs.readFileSync(h.savePath, 'utf8')).games).toHaveLength(2)
    await call('games:delete', { id: g.id })
    await expect(call('games:get', { id: g.id })).rejects.toMatchObject({ code: 'GAME_NOT_FOUND' })
    h.openPath = h.savePath
    expect(await call('games:import')).toEqual({ added: 1, merged: 1 })
    h.savePath = ''
    expect(await call('games:export')).toBeNull()

    // Validation errors never reach the code.
    await expect(call('games:addFact', { id: other.id, text: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('copies every finished script of a batch, title above each, and reports reuse savings', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    engine.start()
    const r = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Alpha Game', channelId: null }, { title: 'Beta Game', channelId: null }], skipExisting: false })
    await waitFor(() => r.jobIds.every((id) => env.s.jobs.get(id)!.status === 'completed'), 15000)
    const res = await call<{ count: number; characters: number }>('queue:copyScripts', { batchId: r.batchId })
    expect(res.count).toBe(2)
    expect(h.clipboard.startsWith('Alpha Game\n\nWelcome back to Game Vault')).toBe(true)
    expect(h.clipboard).toContain('\n\n\nBeta Game\n\nWelcome back to Game Vault')
    expect(res.characters).toBe(h.clipboard.length)

    // Second batch of the same titles: research is reused and shows up in the savings card.
    const r2 = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Alpha Game', channelId: null }], skipExisting: false })
    await waitFor(() => r2.jobIds.every((id) => env.s.jobs.get(id)!.status === 'completed'), 15000)
    const savings = await call<{ researchCallsAvoided: number; estimatedTokensSaved: number; estimatedUsdSaved: number }>('usage:savings', {})
    expect(savings.researchCallsAvoided).toBe(1)
    expect(savings.estimatedTokensSaved).toBeGreaterThan(0)
    expect(savings.estimatedUsdSaved).toBeGreaterThan(0)
  }, 30000)
})
