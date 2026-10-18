/**
 * Not a real test: when VF_DEMO_DIR is set, this generates a populated database
 * (completed jobs, scripts, audio, usage) in that directory so the UI can be
 * smoke-tested with realistic data. Skipped otherwise.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTestEnv, waitFor } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { AppError } from '../src/main/util/errors'

describe.skipIf(!process.env.VF_DEMO_DIR)('demo data', () => {
  it('populates a demo database', async () => {
    const dir = process.env.VF_DEMO_DIR!
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const env = createTestEnv({ dir })
    env.s.settings.update({ general: { outputRoot: path.join(dir, 'output') } })
    const engine = new QueueEngine(env.s, new Logger().child('demo'))
    const gen = new GenerationService(env.s, engine)
    const gv = env.s.channels.getByName('Game Vault')!
    const rf = env.s.channels.getByName('RiftForge Tech')!
    engine.start()
    const a = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: ['Emberward', 'Police Chief Simulator', 'RuneScape: Dragonwilds', 'Active Matter'].map((t) => ({ title: t, channelId: null })), skipExisting: false, name: 'Game Vault — October batch' })
    const b = gen.createBatch({ channelId: rf.id, mode: 'review_before_voice', entries: [{ title: 'Keychron Q1 HE', channelId: null }, { title: 'MINISFORUM UM890 Pro', channelId: null }], skipExisting: false, name: 'RiftForge — keyboards & mini PCs' })
    await waitFor(() => a.jobIds.every((id) => ['completed', 'failed'].includes(env.s.jobs.get(id)!.status)), 30000)
    await waitFor(() => b.jobIds.every((id) => ['awaiting_approval', 'failed'].includes(env.s.jobs.get(id)!.status)), 30000)
    // 1.6.0: reuse — the same titles again (saved research) and an identical voiceover (0 characters).
    const again = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: ['Emberward', 'Active Matter'].map((t) => ({ title: t, channelId: null })), skipExisting: false, name: 'Game Vault — reuse' })
    await waitFor(() => again.jobIds.every((id) => ['completed', 'failed'].includes(env.s.jobs.get(id)!.status)), 30000)
    const regen = engine.regenerateAudio({ projectId: env.s.jobs.get(a.jobIds[0]!)!.projectId })
    await waitFor(() => ['completed', 'failed'].includes(env.s.jobs.get(regen.id)!.status), 30000)
    env.openai.researchImpl = () => {
      throw new AppError('auth', 'OpenAI rejected the API key.', { retryable: false })
    }
    const c = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'ENDLESS Legend 2', channelId: null }], skipExisting: false, name: 'Failed example' })
    await waitFor(() => env.s.jobs.get(c.jobIds[0]!)!.status === 'failed', 10000)
    engine.pauseAll()
    gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'iRacing Studios NASCAR 26', channelId: null }, { title: 'Dark Quest 4', channelId: null }], skipExisting: false, name: 'Queued (paused)' })
    await engine.stop()
    env.s.db.close()
    expect(fs.existsSync(path.join(dir, 'userData', 'voiceforge.sqlite'))).toBe(true)
  }, 90000)
})
