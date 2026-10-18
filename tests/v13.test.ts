/**
 * 1.3.0: channel openings (Game Vault intro restored + Writing-tab fast path), unverified
 * formats usable under supervision, clean output folders (folders + flat layouts), speed
 * changes (no AI fact check by default, token cap fallback, research ambiguity rule) and
 * the one-time upgrade from a 1.2.0 database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { goodScript, researchFor } from './helpers/mockProviders'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { StyleService } from '../src/main/services/style'
import { seedDefaults } from '../src/main/services/seed'
import { scriptSystemPrompt } from '../src/main/providers/prompts'
import { validateScript } from '../src/main/pipeline/validator'
import { AppError } from '../src/main/util/errors'
import { GAME_VAULT_INTRO } from '../src/shared/seedChannels'

let env: TestEnv
let engine: QueueEngine
let gen: GenerationService
let style: StyleService

beforeEach(() => {
  env = createTestEnv()
  engine = new QueueEngine(env.s, new Logger().child('t'))
  gen = new GenerationService(env.s, engine)
  style = new StyleService(env.s)
})
afterEach(async () => {
  await engine.stop()
  env.cleanup()
})

const gvSetup = () => {
  const gv = env.s.channels.getByName('Game Vault')!
  env.s.channels.update(gv.id, { elevenVoiceId: 'voice-1', elevenVoiceName: 'Test' })
  const t = env.s.channels.defaultTemplate(gv.id)!
  const v = env.s.channels.activeVersionOf(t.id)!
  return { gv: env.s.channels.get(gv.id)!, t, v }
}
const settle = (ids: string[]) => waitFor(() => ids.every((id) => ['completed', 'failed', 'awaiting_approval', 'research_review_required'].includes(env.s.jobs.get(id)!.status)), 15000)

describe('channel openings', () => {
  it('Game Vault ships with the owner-stated intro, locked and enforced by the validator', () => {
    const { gv, v } = gvSetup()
    const intro = v.fixedBlocks.find((b) => b.kind === 'intro')!
    expect(intro).toMatchObject({ text: GAME_VAULT_INTRO, locked: true, provenance: 'user_confirmed', spoken: true })
    expect(scriptSystemPrompt(gv, v)).toContain(GAME_VAULT_INTRO)
    const ok = validateScript(goodScript('Emberward'), { channel: gv, template: v, expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard', lengthToleranceChars: 150 })
    expect(ok.issues.filter((i) => i.severity === 'error')).toEqual([])
    const cold = goodScript('Emberward').replace(/^Welcome back to Game Vault[^.]*\./, 'Emberward is a game.')
    const bad = validateScript(cold, { channel: gv, template: v, expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard', lengthToleranceChars: 150 })
    expect(bad.ok).toBe(false)
  })

  it('channels without a locked intro are told to open with a short channel introduction (toggleable)', () => {
    const nexora = env.s.channels.getByName('Nexora')!
    const v = env.s.channels.activeVersionOf(env.s.channels.defaultTemplate(nexora.id)!.id)!
    expect(scriptSystemPrompt(nexora, v)).toMatch(/OPENING: begin with a short spoken introduction[^\n]*"Nexora"/)
    const off = { ...nexora, validation: { ...nexora.validation, openWithChannelIntro: false } }
    expect(scriptSystemPrompt(off, v)).not.toContain('OPENING:')
    expect(scriptSystemPrompt(nexora, v)).toContain('The title is not part of the script')
  })

  it('setOpening stores a locked intro/outro in a NEW version that keeps the status', () => {
    const playtopia = env.s.channels.getByName('PlayTopia')!
    const t = env.s.channels.defaultTemplate(playtopia.id)!
    const before = env.s.channels.activeVersionOf(t.id)!
    expect(style.getOpening(playtopia.id)).toMatchObject({ intro: '', outro: '', openWithChannelIntro: true })
    const res = style.setOpening(playtopia.id, { intro: 'Hey everyone, welcome back to PlayTopia!', outro: 'See you in the next one.', openWithChannelIntro: true })
    expect(res.intro).toBe('Hey everyone, welcome back to PlayTopia!')
    expect(res.versionId).not.toBe(before.id)
    const after = env.s.channels.activeVersionOf(t.id)!
    expect(after.approvalStatus).toBe(before.approvalStatus)
    expect(after.fixedBlocks.filter((b) => b.locked).map((b) => b.kind)).toEqual(['intro', 'outro'])
    expect(env.s.channels.getVersion(before.id)!.fixedBlocks).toEqual(before.fixedBlocks) // never edited in place
    // Unchanged text creates no extra version; the toggle is stored on the channel.
    const again = style.setOpening(playtopia.id, { intro: res.intro, outro: res.outro, openWithChannelIntro: false })
    expect(again.versionId).toBe(res.versionId)
    expect(env.s.channels.get(playtopia.id)!.validation.openWithChannelIntro).toBe(false)
    // Approved formats stay approved (the owner typed the words themselves).
    env.s.channels.setVersionStatus(after.id, 'approved')
    style.setOpening(playtopia.id, { intro: 'Welcome to PlayTopia.', outro: '', openWithChannelIntro: true })
    expect(env.s.channels.activeVersionOf(t.id)!.approvalStatus).toBe('approved')
  })
})

describe('clean output folder', () => {
  it('folders layout: only Script.txt and Voice.mp3 appear, and only once the job is complete', async () => {
    const { gv, v } = gvSetup()
    env.s.channels.setVersionStatus(v.id, 'approved')
    let seenDuringAudio: string[] | null = null
    const orig = env.eleven.synthImpl
    env.eleven.synthImpl = async (req) => {
      const dir = path.join(env.s.paths.outputRoot(), 'Game Vault', 'Emberward')
      seenDuringAudio = fs.existsSync(dir) ? fs.readdirSync(dir) : []
      return orig(req)
    }
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(jobIds)
    const job = env.s.jobs.getView(jobIds[0]!)!
    expect(job.status, job.lastError?.message).toBe('completed')
    expect(seenDuringAudio).toEqual([])
    expect(fs.readdirSync(path.join(env.s.paths.outputRoot(), 'Game Vault')).sort()).toEqual(['Emberward'])
    expect(fs.readdirSync(job.projectFolder!).sort()).toEqual(['Script.txt', 'Voice.mp3'])
    const script = fs.readFileSync(path.join(job.projectFolder!, 'Script.txt'), 'utf8')
    expect(script.startsWith('Welcome back to Game Vault')).toBe(true)
    // Explicit audio regeneration adds Voice_v2.mp3 next to the original.
    const regen = engine.regenerateAudio({ projectId: job.projectId })
    await settle([regen.id])
    expect(env.s.jobs.get(regen.id)!.status).toBe('completed')
    expect(fs.readdirSync(job.projectFolder!).sort()).toEqual(['Script.txt', 'Voice.mp3', 'Voice_v2.mp3'])
  })

  it('flat layout: <Channel>/<Title>.txt + <Title>.mp3, and deleting a project removes only its files', async () => {
    const { gv, v } = gvSetup()
    env.s.channels.setVersionStatus(v.id, 'approved')
    env.s.settings.update({ storage: { outputLayout: 'flat' } })
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'Emberward', channelId: null }, { title: 'Active Matter', channelId: null }], skipExisting: false })
    await settle(jobIds)
    for (const id of jobIds) expect(env.s.jobs.get(id)!.status, env.s.jobs.get(id)!.lastError?.message).toBe('completed')
    const channelDir = path.join(env.s.paths.outputRoot(), 'Game Vault')
    expect(fs.readdirSync(channelDir).sort()).toEqual(['Active Matter.mp3', 'Active Matter.txt', 'Emberward.mp3', 'Emberward.txt'])
    const p = env.s.projects.get(env.s.jobs.get(jobIds[0]!)!.projectId)!
    expect(p.layout).toBe('flat')
    const audio = env.s.audio.versions(p.id)[0]!
    expect(audio.filePath).toBe(path.join(channelDir, 'Emberward.mp3'))
  })
})

describe('speed', () => {
  it('the AI fact check is off by default (one OpenAI call less per script)', async () => {
    const { gv, v } = gvSetup()
    env.s.channels.setVersionStatus(v.id, 'approved')
    expect(env.s.settings.get().generation.aiReviewPass).toBe(false)
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(jobIds)
    expect(env.openai.count('review')).toBe(0)
    expect(env.openai.count('script')).toBe(1)
    expect(env.openai.count('research')).toBe(1)
  })

  it('caps writer tokens and retries once with the full limit when the model runs out', async () => {
    const { gv, v } = gvSetup()
    env.s.channels.setVersionStatus(v.id, 'approved')
    const seen: number[] = []
    env.openai.scriptImpl = (req) => {
      seen.push(req.maxOutputTokens)
      if (seen.length === 1) throw new AppError('config', 'OpenAI stopped the script early (max_output_tokens).', { retryable: false, code: 'MAX_OUTPUT_TOKENS' })
      return { text: goodScript(req.title, req.template.structure.map((s) => s.label)), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' }
    }
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(jobIds)
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(seen[0]).toBeLessThan(env.s.settings.get().openai.maxOutputTokens)
    expect(seen[1]).toBe(env.s.settings.get().openai.maxOutputTokens)
    const req = env.openai.calls.find((c) => c.kind === 'script')!.req as { promptCacheKey?: string }
    expect(req.promptCacheKey).toBe(`vf:${v.id}`)
  })

  it('does not stop for a title choice when the typed title is the confident top candidate', async () => {
    const { gv, v } = gvSetup()
    env.s.channels.setVersionStatus(v.id, 'approved')
    env.openai.researchImpl = (req) => ({
      data: { ...researchFor(req.title), confidence: 0.7, ambiguityCandidates: [{ title: req.title, developer: 'A', year: '2026', note: '' }, { title: `${req.title} Remastered`, developer: 'B', year: '2020', note: '' }] },
      sources: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-test'
    })
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }, { title: 'Something Else', channelId: null }], skipExisting: false })
    await settle(jobIds)
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
  })

  it('estimates the batch wall time from stage timings and concurrency', () => {
    const { gv } = gvSetup()
    const one = gen.estimate({ channelId: gv.id, mode: 'review_before_voice', entries: [{ title: 'A', channelId: null }], skipExisting: false })
    const ten = gen.estimate({ channelId: gv.id, mode: 'review_before_voice', entries: Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, channelId: null })), skipExisting: false })
    expect(one.estimatedSeconds).toBeGreaterThan(0)
    expect(ten.estimatedSeconds).toBeGreaterThan(one.estimatedSeconds)
    expect(ten.estimatedSeconds).toBeLessThan(one.estimatedSeconds * 10) // pipelined, not serial
  })
})

describe('upgrade from 1.2.0', () => {
  it('restores the Game Vault intro in untouched seed versions, keeps statuses, never touches edited formats', () => {
    const { gv, t } = gvSetup()
    // Recreate the 1.2.0 state: a seed:v3 version without the intro, old limits, old speed defaults.
    const v3 = env.s.channels.addVersion(t.id, { systemPrompt: 'old', structure: [], exampleScript: null, notes: '[seed:v3] old seed', fixedBlocks: [], approvalStatus: 'provisional' })
    env.s.channels.setVersionStatus(v3.id, 'approved')
    env.s.channels.setActiveVersion(gv.id, v3.id)
    env.s.channels.update(gv.id, { minChars: 3600, maxChars: 4700 })
    const nexora = env.s.channels.getByName('Nexora')!
    const nt = env.s.channels.defaultTemplate(nexora.id)!
    const mine = env.s.channels.addVersion(nt.id, { systemPrompt: 'My own Nexora prompt', structure: [], exampleScript: null, notes: 'mine' })
    env.s.channels.setActiveVersion(nexora.id, mine.id)
    env.s.channels.update(nexora.id, { research: { ...nexora.research, searchContextSize: 'medium' } })
    env.s.settings.update({ openai: { concurrency: 2 }, elevenlabs: { concurrency: 1 }, generation: { maxConcurrentJobs: 2 } })
    env.s.settingsRepo.set('seeded_v4', false)

    seedDefaults(env.s)

    const active = env.s.channels.activeVersionOf(t.id)!
    expect(active.id).not.toBe(v3.id)
    expect(active.approvalStatus).toBe('approved')
    expect(active.fixedBlocks.some((b) => b.kind === 'intro' && b.locked && b.text === GAME_VAULT_INTRO)).toBe(true)
    expect(env.s.channels.get(gv.id)!).toMatchObject({ minChars: 3500, maxChars: 4500 })
    expect(env.s.channels.activeVersionOf(nt.id)!.id).toBe(mine.id)
    expect(env.s.channels.get(nexora.id)!.research.searchContextSize).toBe('low')
    expect(env.s.settings.get()).toMatchObject({ openai: { concurrency: 4 }, elevenlabs: { concurrency: 3 }, generation: { maxConcurrentJobs: 6 } })
    // Runs once.
    const versions = env.s.channels.listVersions(t.id).length
    seedDefaults(env.s)
    expect(env.s.channels.listVersions(t.id)).toHaveLength(versions)
  })
})
