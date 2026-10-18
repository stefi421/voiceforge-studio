import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTestEnv, makeTemplateActive, waitFor, type TestEnv } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { BackupService } from '../src/main/services/backup'
import { Logger } from '../src/main/services/logger'
import { AppError } from '../src/main/util/errors'
import { fakeMp3, goodScript, researchFor } from './helpers/mockProviders'
import { parseMp3 } from '../src/main/pipeline/mp3'
import { DEFAULT_RESEARCH, DEFAULT_VALIDATION, DEFAULT_VOICE_SETTINGS } from '../src/shared/defaults'
import type { ChannelInput } from '../src/shared/types'

function channelInput(name: string): ChannelInput {
  return {
    name,
    icon: '🎮',
    color: '#123456',
    description: 'd',
    category: 'gaming',
    language: 'en',
    writingInstructions: 'w',
    writingStyle: '',
    introRequirements: '',
    outroRequirements: '',
    targetDurationSec: 240,
    minChars: 1000,
    maxChars: 6000,
    pronunciationRules: [],
    elevenVoiceId: 'voice-1',
    elevenVoiceName: 'Test Voice',
    elevenModelId: 'eleven_multilingual_v2',
    elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
    outputFormat: 'mp3_44100_128',
    outputFolder: null,
    openaiModel: null,
    research: DEFAULT_RESEARCH,
    validation: { ...DEFAULT_VALIDATION, aiReviewPass: false },
    archived: false
  }
}

let env: TestEnv
let engine: QueueEngine
let gen: GenerationService

function boot(e: TestEnv): void {
  env = e
  engine = new QueueEngine(env.s, new Logger().child('q'))
  gen = new GenerationService(env.s, engine)
}

beforeEach(() => {
  boot(createTestEnv())
})

afterEach(async () => {
  await engine.stop()
  env.cleanup()
})

async function runBatch(titles: string[], channelId: string, mode: 'auto' | 'review_before_voice' | 'scripts_only' = 'auto') {
  engine.start()
  const res = gen.createBatch({ channelId, mode, entries: titles.map((t) => ({ title: t, channelId: null })), skipExisting: false })
  return res
}

const settle = (ids: string[], statuses: string[], timeout = 15000) => waitFor(() => ids.every((id) => statuses.includes(env.s.jobs.get(id)!.status)), timeout)

describe('channels and templates', () => {
  it('seeds the five initial profiles with independent templates', () => {
    const names = env.s.channels.list().map((c) => c.name)
    expect(names).toEqual(['PlayTopia', 'Game Vault', 'VoidPulse', 'RiftForge Tech', 'RENVO'])
    const gv = env.s.channels.getByName('Game Vault')!
    expect(env.s.channels.getVersion(gv.activeTemplateVersionId!)!.placeholder).toBe(false)
    const pt = env.s.channels.getByName('PlayTopia')!
    expect(env.s.channels.getVersion(pt.activeTemplateVersionId!)!.placeholder).toBe(true)
  })

  it('creates, edits and isolates channels', () => {
    const a = env.s.channels.create(channelInput('Alpha'))
    const b = env.s.channels.create(channelInput('Beta'))
    env.s.channels.update(a.id, { maxChars: 4700, validation: { ...a.validation, forbiddenPhrases: ['AAA'] }, elevenVoiceId: 'voice-9' })
    const a2 = env.s.channels.get(a.id)!
    const b2 = env.s.channels.get(b.id)!
    expect(a2.maxChars).toBe(4700)
    expect(a2.validation.forbiddenPhrases).toEqual(['AAA'])
    expect(a2.elevenVoiceId).toBe('voice-9')
    expect(b2.maxChars).toBe(6000)
    expect(b2.validation.forbiddenPhrases).toEqual([])
    expect(b2.elevenVoiceId).toBe('voice-1')
    expect(a2.slug).not.toBe(b2.slug)
    const dup = env.s.channels.create(channelInput('Alpha'))
    expect(dup.slug).toBe('alpha-2')
  })

  it('versions templates and records the active version per channel', () => {
    const c = env.s.channels.create(channelInput('Versioned'))
    const { template, version: v1 } = env.s.channels.createTemplate(c.id, 'T', { systemPrompt: 'v1', structure: [], exampleScript: null, notes: '' })
    const v2 = env.s.channels.addVersion(template.id, { systemPrompt: 'v2', structure: [], exampleScript: null, notes: 'second' })
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    env.s.channels.setActiveVersion(c.id, v2.id)
    expect(env.s.channels.get(c.id)!.activeTemplateVersionId).toBe(v2.id)
    expect(env.s.channels.listTemplates(c.id)[0]!.latestVersion).toBe(2)
    expect(env.s.channels.listTemplates(c.id)[0]!.activeVersionId).toBe(v2.id)
    const other = env.s.channels.create(channelInput('Other'))
    expect(() => env.s.channels.setActiveVersion(other.id, v2.id)).toThrow(/another channel/)
  })

  it('exports and imports a channel with its templates (no secrets)', () => {
    const backup = new BackupService(env.s)
    const gv = env.s.channels.getByName('Game Vault')!
    const json = JSON.stringify(backup.exportChannel(gv.id))
    expect(json).not.toContain('sk-test')
    const id = backup.importChannel(json)
    const imported = env.s.channels.get(id)!
    expect(imported.name).toBe('Game Vault (2)')
    expect(imported.validation.forbiddenPhrases).toEqual(['AAA'])
    const tv = env.s.channels.getVersion(imported.activeTemplateVersionId!)!
    expect(tv.structure.map((s) => s.label)).toEqual(['Gameplay', 'Combat', 'Pros', 'Cons', 'Conclusion'])
    expect(() => backup.importChannel('{"nope":1}')).toThrow(/not a VoiceForge/)
  })

  it('deleting a channel removes its DB rows but keeps project files unless asked', async () => {
    const c = env.s.channels.create(channelInput('Temp'))
    makeTemplateActive(env.s, c.id)
    const { jobIds } = await runBatch(['Keep Me'], c.id, 'scripts_only')
    await settle(jobIds, ['completed'])
    const project = env.s.projects.get(env.s.jobs.get(jobIds[0]!)!.projectId)!
    expect(fs.existsSync(path.join(project.folderPath!, 'Script.txt'))).toBe(true)
    for (const p of env.s.projects.listByChannel(c.id)) env.s.projects.delete(p.id)
    env.s.channels.delete(c.id)
    expect(env.s.channels.get(c.id)).toBeUndefined()
    expect(fs.existsSync(path.join(project.folderPath!, 'Script.txt'))).toBe(true)
  })
})

describe('batch creation and generation pipeline', () => {
  it('creates jobs, skips duplicates and runs research → script → audio → files', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    const { batchId, jobIds, skipped } = await runBatch(['Emberward', 'emberward', 'Police Chief Simulator'], gv.id)
    expect(jobIds).toHaveLength(2)
    expect(skipped).toHaveLength(1)
    await settle(jobIds, ['completed', 'failed'])
    for (const id of jobIds) {
      const job = env.s.jobs.getView(id)!
      expect(job.status, job.lastError?.message).toBe('completed')
      expect(job.projectFolder).toBeTruthy()
      const files = fs.readdirSync(job.projectFolder!)
      expect(files).toEqual(expect.arrayContaining(['Script.txt', 'Voice.mp3', 'Research.json', 'project.json']))
      const audio = env.s.audio.get(job.audioId!)!
      expect(audio.status).toBe('ready')
      expect(audio.sha256).toHaveLength(64)
      expect(parseMp3(fs.readFileSync(audio.filePath)).valid).toBe(true)
      const script = env.s.scripts.get(job.scriptId!)!
      expect(script.templateVersionId).toBe(gv.activeTemplateVersionId)
      expect(script.templateVersionNumber).toBe(1)
      expect(fs.readFileSync(script.filePath!, 'utf8').trim()).toBe(script.text)
      const research = JSON.parse(fs.readFileSync(path.join(job.projectFolder!, 'Research.json'), 'utf8'))
      expect(research.sources).toHaveLength(1)
      expect(script.text).not.toContain('https://')
    }
    expect(env.s.jobs.getBatch(batchId)!.completed).toBe(2)
    const usage = env.s.usage.summary(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 60000).toISOString())
    expect(usage.openai.requests).toBe(6) // 2 research + 2 scripts + 2 AI review passes
    expect(usage.elevenlabs.characters).toBeGreaterThan(0)
    expect(usage.elevenlabs.estimatedCost).toBeGreaterThan(0)
    expect(usage.byChannel[0]!.channelName).toBe('Game Vault')
  }, 20000)

  it('runs the AI review pass when enabled and records its usage', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    expect(gv.validation.aiReviewPass).toBe(true)
    const { jobIds } = await runBatch(['Reviewed Game'], gv.id, 'scripts_only')
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(env.openai.count('review')).toBe(1)
  })

  it('blocks generation while a channel uses a placeholder template', async () => {
    const pt = env.s.channels.getByName('PlayTopia')!
    const { jobIds } = await runBatch(['Some Game'], pt.id)
    await settle(jobIds, ['failed'])
    const job = env.s.jobs.get(jobIds[0]!)!
    expect(job.lastError?.kind).toBe('config')
    expect(job.lastError?.message).toMatch(/placeholder/)
    expect(env.openai.count('script')).toBe(0)
  })

  it('scripts-only mode saves TXT without calling ElevenLabs', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    const { jobIds } = await runBatch(['Active Matter'], gv.id, 'scripts_only')
    await settle(jobIds, ['completed', 'failed'])
    const job = env.s.jobs.getView(jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(0)
    expect(fs.existsSync(path.join(job.projectFolder!, 'Script.txt'))).toBe(true)
    expect(fs.existsSync(path.join(job.projectFolder!, 'Voice.mp3'))).toBe(false)
  })

  it('review-before-voice waits for approval, then generates audio', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    const { jobIds } = await runBatch(['ENDLESS Legend 2'], gv.id, 'review_before_voice')
    await settle(jobIds, ['awaiting_approval'])
    expect(env.eleven.calls).toHaveLength(0)
    engine.approveScript(jobIds[0]!)
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(1)
    expect(env.s.scripts.get(env.s.jobs.get(jobIds[0]!)!.scriptId!)!.status).toBe('approved')
  })

  it('rewrites a script that fails validation and fails the job after max attempts', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.settings.update({ generation: { maxRewriteAttempts: 1 } })
    env.s.channels.update(gv.id, { validation: { ...gv.validation, maxRewriteAttempts: 1, aiReviewPass: false } })
    let n = 0
    env.openai.scriptImpl = (req) => {
      n++
      return { text: n === 1 ? goodScript(req.title).replace('Cons\n', 'Cons\nVisit https://example.com for more.\n') : goodScript(req.title), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' }
    }
    const { jobIds } = await runBatch(['Rewrite Me'], gv.id, 'scripts_only')
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(n).toBe(2)
    expect(env.openai.calls.filter((c) => c.kind === 'script')[1]!.req).toMatchObject({ issues: expect.stringMatching(/URL/) })
    expect(env.s.scripts.versions(env.s.jobs.get(jobIds[0]!)!.projectId)).toHaveLength(2)

    // Now always bad → job fails, no audio, script kept as invalid for manual editing
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title).replace('Cons\n', 'Cons\nVisit https://example.com for more.\n'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const r2 = await runBatch(['Always Bad'], gv.id)
    await settle(r2.jobIds, ['completed', 'failed'])
    const job = env.s.jobs.get(r2.jobIds[0]!)!
    expect(job.status).toBe('failed')
    expect(job.lastError?.kind).toBe('validation')
    expect(env.eleven.calls).toHaveLength(0)
    expect(env.s.scripts.get(job.scriptId!)!.status).toBe('invalid')
  }, 20000)

  it('never sends a failed/invalid script to ElevenLabs even when approved manually', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title).replace('Cons\n', 'Cons\nSee https://example.com.\n'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const { jobIds } = await runBatch(['Bad Script'], gv.id)
    await settle(jobIds, ['failed'])
    expect(() => engine.approveScript(jobIds[0]!)).toThrow(/fails validation/)
    expect(env.eleven.calls).toHaveLength(0)
  }, 20000)

  it('converges on length: strict inside the loop, one tighten pass, tolerance only for the final verdict', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.settings.update({ generation: { maxRewriteAttempts: 1, lengthToleranceChars: 150 } })
    env.s.channels.update(gv.id, { minChars: 3000, maxChars: 4500, validation: { ...gv.validation, maxRewriteAttempts: 1, aiReviewPass: false } })
    // Every draft is 4536 chars (36 over). Expected: strict rewrite (told exactly what to cut) →
    // tighten pass → still 36 over → accepted as a WARNING under the 150-char tolerance.
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title, undefined, 4536).slice(0, 4536).trimEnd().padEnd(4536, 'x'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const a = await runBatch(['Slightly Long'], gv.id, 'scripts_only')
    await settle(a.jobIds, ['completed', 'failed'])
    const jobA = env.s.jobs.get(a.jobIds[0]!)!
    expect(jobA.status).toBe('completed')
    const scriptA = env.s.scripts.get(jobA.scriptId!)!
    expect(scriptA.status).toBe('validated')
    expect(scriptA.validation!.issues.some((i) => i.code === 'too_long' && i.severity === 'warning')).toBe(true)
    const callsA = env.openai.calls.filter((c) => c.kind === 'script').map((c) => c.req as { issues?: string; tighten?: { cut: number; max: number; target: number } })
    expect(callsA).toHaveLength(3)
    expect(callsA[1]!.issues).toMatch(/Cut at least 37 characters — aim for about \d+ characters/)
    expect(callsA[2]!.tighten).toMatchObject({ cut: 36, max: 4500 })
    expect(callsA[2]!.tighten!.target).toBeLessThanOrEqual(4140)
    expect(env.s.jobs.listEvents({ jobId: jobA.id }).some((e) => e.event === 'tighten')).toBe(true)
    expect(env.s.jobs.listEvents({ jobId: jobA.id }).some((e) => e.event === 'validation_warnings')).toBe(true)

    // Far too long every time: after the attempts a single "tighten" request is sent; when that
    // still fails the job fails (nothing is force-accepted beyond the tolerance).
    env.openai.calls.length = 0
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title, undefined, 5300).slice(0, 5300).trimEnd().padEnd(5300, 'x'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const b = await runBatch(['Way Too Long'], gv.id, 'scripts_only')
    await settle(b.jobIds, ['completed', 'failed'])
    const jobB = env.s.jobs.get(b.jobIds[0]!)!
    expect(jobB.status).toBe('failed')
    const scriptCalls = env.openai.calls.filter((c) => c.kind === 'script').map((c) => c.req as { tighten?: { cut: number; max: number } })
    expect(scriptCalls).toHaveLength(3) // first draft + 1 rewrite + tighten
    expect(scriptCalls[2]!.tighten).toMatchObject({ max: 4500, cut: 800 })
    expect(env.s.scripts.get(jobB.scriptId!)!.status).toBe('invalid')

    // Strict mode never tolerates overshoot.
    env.s.settings.update({ generation: { validationStrictness: 'strict' } })
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title, undefined, 4536).slice(0, 4536).trimEnd().padEnd(4536, 'x'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const c = await runBatch(['Strict Long'], gv.id, 'scripts_only')
    await settle(c.jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(c.jobIds[0]!)!.status).toBe('failed')
  }, 30000)

  it('lets the user approve a failed script anyway (force) and records it; audio regeneration accepts it', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title).replace('Cons\n', 'Cons\nSee https://example.com.\n'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const { jobIds } = await runBatch(['Force Me'], gv.id)
    await settle(jobIds, ['failed'])
    const jobId = jobIds[0]!
    let err: AppError | null = null
    try {
      engine.approveScript(jobId)
    } catch (e) {
      err = e as AppError
    }
    expect(err?.code).toBe('APPROVE_NEEDS_FORCE')
    engine.approveScript(jobId, true)
    await settle(jobIds, ['completed', 'failed'])
    const job = env.s.jobs.get(jobId)!
    expect(job.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(1)
    const script = env.s.scripts.get(job.scriptId!)!
    expect(script.status).toBe('approved')
    expect(script.approvedWithIssues).toBe(true)
    expect(env.s.jobs.listEvents({ jobId }).some((e) => e.event === 'approved_with_issues')).toBe(true)
    // Re-validation keeps the forced approval instead of flipping the script back to invalid.
    const report = engine.pipeline.revalidate(script.id)
    expect(report.ok).toBe(false)
    expect(env.s.scripts.get(script.id)!.status).toBe('approved')
    // Audio-only regeneration of the force-approved script is allowed.
    const regen = engine.regenerateAudio({ projectId: job.projectId, scriptId: script.id })
    await settle([regen.id], ['completed', 'failed'])
    expect(env.s.jobs.get(regen.id)!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(2)
  }, 30000)

  it('reports stage-level progress and an ETA while a single job runs', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    expect(engine.stats().progressPercent).toBe(0)
    env.openai.delayMs = 150
    const { jobIds } = await runBatch(['Progress'], gv.id)
    const seen: number[] = []
    await waitFor(() => {
      const st = engine.stats()
      seen.push(st.progressPercent)
      return env.s.jobs.get(jobIds[0]!)!.status === 'completed'
    }, 15000)
    // Progress moved through intermediate values before reaching 100 (never stuck at 0 while running).
    expect(seen.some((p) => p > 0 && p < 100)).toBe(true)
    expect(engine.stats().progressPercent).toBe(100)
    // ETA: defaults give a number immediately; after one completed job the medians come from history.
    env.openai.delayMs = 0
    const r2 = await runBatch(['Progress 2'], gv.id)
    const st = engine.stats()
    expect(st.estimatedSecondsRemaining).not.toBeNull()
    expect(st.estimatedSecondsRemaining!).toBeGreaterThan(0)
    await settle(r2.jobIds, ['completed', 'failed'])
    expect(engine.stageSeconds().research).toBeGreaterThan(0)
  }, 30000)

  it('keeps the user title as the project/folder name; research only stores the canonical title', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.researchImpl = (req) => ({ data: researchFor(req.title, { canonicalTitle: `${req.title}: Definitive Edition` }), sources: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const { jobIds } = await runBatch(['Canon Test'], gv.id, 'scripts_only')
    await settle(jobIds, ['completed', 'failed'])
    const job = env.s.jobs.get(jobIds[0]!)!
    const project = env.s.projects.get(job.projectId)!
    expect(job.title).toBe('Canon Test')
    expect(project.title).toBe('Canon Test')
    expect(project.folderName).toBe('Canon Test')
    expect(project.canonicalTitle).toBe('Canon Test: Definitive Edition')
  }, 20000)

  it('asks the user when the title is ambiguous and continues after resolution', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    let call = 0
    env.openai.researchImpl = (req) => {
      call++
      if (call === 1) {
        return {
          data: researchFor(req.title, { confidence: 0.4, ambiguityCandidates: [{ title: 'Dark Quest 4', developer: 'A', year: '2026', note: '' }, { title: 'Dark Quest (2014)', developer: 'B', year: '2014', note: '' }] }),
          sources: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'gpt-test'
        }
      }
      expect(req.manualNotes).toMatch(/Dark Quest 4/)
      return { data: researchFor('Dark Quest 4'), sources: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' }
    }
    const { jobIds } = await runBatch(['Dark Quest'], gv.id, 'scripts_only')
    await settle(jobIds, ['research_review_required'])
    const research = env.s.research.get(env.s.jobs.get(jobIds[0]!)!.researchId!)!
    expect(research.status).toBe('ambiguous')
    expect(research.data.ambiguityCandidates).toHaveLength(2)
    engine.resolveResearch(jobIds[0]!, { candidateIndex: 0 })
    await settle(jobIds, ['completed', 'failed'])
    const job = env.s.jobs.get(jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(job.title).toBe('Dark Quest 4')
    expect(call).toBe(2)
    // An explicit choice renames the project and its folder; the script lives in the renamed folder.
    const project = env.s.projects.get(job.projectId)!
    expect(project.title).toBe('Dark Quest 4')
    expect(project.folderName).toBe('Dark Quest 4')
    expect(fs.existsSync(path.join(project.folderPath!, 'Script.txt'))).toBe(true)
    expect(env.s.jobs.listEvents({ jobId: job.id }).some((e) => e.event === 'title_changed')).toBe(true)
  })

  it('stops when research is insufficient instead of inventing a review', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.researchImpl = (req) => ({ data: researchFor(req.title, { confidence: 0.1, insufficientReason: 'No official information found.' }), sources: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const { jobIds } = await runBatch(['Nonexistent Game 9000'], gv.id)
    await settle(jobIds, ['research_review_required'])
    expect(env.openai.count('script')).toBe(0)
    expect(env.s.research.latestForJob(jobIds[0]!)!.status).toBe('insufficient')
  })

  it('reuses cached research for the same title', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    const first = await runBatch(['Cached Game'], gv.id, 'scripts_only')
    await settle(first.jobIds, ['completed'])
    const second = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Cached Game', channelId: null }], skipExisting: false })
    await settle(second.jobIds, ['completed'])
    expect(env.openai.count('research')).toBe(1)
    expect(env.s.scripts.versions(env.s.jobs.get(second.jobIds[0]!)!.projectId)).toHaveLength(2)
  })

  it('chunks long narration and concatenates audio in order', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { maxChars: 20000, minChars: 100, validation: { ...gv.validation, aiReviewPass: false } })
    env.s.settings.update({ elevenlabs: { maxCharsPerRequest: 1500 } })
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title, undefined, 6000), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const { jobIds } = await runBatch(['Long One'], gv.id)
    await settle(jobIds, ['completed', 'failed'])
    const job = env.s.jobs.get(jobIds[0]!)!
    expect(job.status, job.lastError?.message).toBe('completed')
    expect(env.eleven.calls.length).toBeGreaterThan(3)
    expect(env.eleven.calls[1]!.previousText).toBeTruthy()
    const joined = env.eleven.calls.map((c) => c.text).join(' ').replace(/\s+/g, ' ')
    expect(joined).toBe(env.s.scripts.get(job.scriptId!)!.text.replace(/\s+/g, ' '))
    const audio = env.s.audio.get(job.audioId!)!
    expect(audio.chunkCount).toBe(env.eleven.calls.length)
    expect(parseMp3(fs.readFileSync(audio.filePath)).valid).toBe(true)
    expect(fs.readdirSync(path.dirname(audio.filePath)).some((f) => f.endsWith('.part'))).toBe(false)
  }, 20000)

  it('rejects invalid audio from the provider and surfaces insufficient credits / invalid keys', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false } })
    env.eleven.synthImpl = () => ({ audio: Buffer.from('not audio at all but long enough to be checked'), requestId: null })
    env.s.settings.update({ generation: { maxStageRetries: 0 }, elevenlabs: { maxRetries: 0 } })
    const a = await runBatch(['Garbage Audio'], gv.id)
    await settle(a.jobIds, ['failed'])
    expect(env.s.jobs.get(a.jobIds[0]!)!.lastError?.message).toMatch(/not a valid MP3/)
    expect(fs.existsSync(path.join(env.s.jobs.getView(a.jobIds[0]!)!.projectFolder!, 'Voice.mp3'))).toBe(false)

    env.eleven.synthImpl = () => {
      throw new AppError('quota', 'Not enough credits', { retryable: false })
    }
    const b = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'No Credits', channelId: null }], skipExisting: false })
    await settle(b.jobIds, ['failed'])
    expect(env.s.jobs.get(b.jobIds[0]!)!.lastError?.kind).toBe('quota')

    env.openai.researchImpl = () => {
      throw new AppError('auth', 'Invalid key', { retryable: false })
    }
    const c = gen.createBatch({ channelId: gv.id, mode: 'auto', entries: [{ title: 'Bad Key', channelId: null }], skipExisting: false })
    await settle(c.jobIds, ['failed'])
    expect(env.s.jobs.get(c.jobIds[0]!)!.lastError?.kind).toBe('auth')
    expect(env.s.jobs.get(c.jobIds[0]!)!.lastError?.action).toMatch(/API key/)
  }, 20000)

  it('schedules automatic retries for rate limits and succeeds afterwards', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false } })
    env.s.settings.update({ elevenlabs: { maxRetries: 2 } })
    let n = 0
    const original = env.eleven.synthImpl
    env.eleven.synthImpl = (req) => {
      n++
      if (n <= 2) throw new AppError('rate_limit', '429 too many requests', { retryable: true, retryAfterMs: 10 })
      return original(req)
    }
    const { jobIds } = await runBatch(['Rate Limited'], gv.id)
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(n).toBe(3)
    expect(env.s.jobs.listEvents({ jobId: jobIds[0]! }).some((e) => e.event === 'retry')).toBe(true)
  }, 20000)

  it('respects spending limits by pausing new requests', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.usage.record({ provider: 'openai', kind: 'x', model: 'm', jobId: null, channelId: null, projectId: null, inputTokens: 0, outputTokens: 0, characters: 0, estimatedCost: 5, reported: null })
    env.s.settings.update({ spending: { dailyLimitUsd: 1 } })
    const { jobIds } = await runBatch(['Too Expensive'], gv.id)
    await waitFor(() => engine.stats().spendingPaused)
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('pending')
    expect(env.openai.count('research')).toBe(0)
    env.s.settings.update({ spending: { dailyLimitUsd: 100 } })
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
  })
})

describe('queue control', () => {
  it('pauses and resumes a running job and the whole queue', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.delayMs = 150
    const { jobIds } = await runBatch(['Pausable'], gv.id, 'scripts_only')
    await waitFor(() => env.s.jobs.get(jobIds[0]!)!.status === 'researching')
    engine.pauseJob(jobIds[0]!)
    await settle(jobIds, ['paused'])
    const paused = env.s.jobs.get(jobIds[0]!)!
    expect(paused.stage).toBe('research')
    engine.resumeJob(jobIds[0]!)
    await settle(jobIds, ['completed'])
    env.openai.delayMs = 0
    engine.pauseAll()
    const second = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Queued While Paused', channelId: null }], skipExisting: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(env.s.jobs.get(second.jobIds[0]!)!.status).toBe('pending')
    expect(engine.stats().queuePaused).toBe(true)
    engine.resumeAll()
    await settle(second.jobIds, ['completed'])
  })

  it('cancels a running job and can retry it from the failed stage', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.openai.delayMs = 150
    const { jobIds } = await runBatch(['Cancel Me'], gv.id, 'scripts_only')
    await waitFor(() => env.s.jobs.get(jobIds[0]!)!.status === 'researching')
    engine.cancelJob(jobIds[0]!)
    await settle(jobIds, ['cancelled'])
    env.openai.delayMs = 0
    engine.retryJob(jobIds[0]!)
    await settle(jobIds, ['completed'])
    expect(env.openai.count('research')).toBe(2)
  })

  it('retrying a job that failed at the audio stage does not redo research or the script', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false } })
    env.s.settings.update({ generation: { maxStageRetries: 0 }, elevenlabs: { maxRetries: 0 } })
    env.eleven.synthImpl = () => {
      throw new AppError('provider_down', '500', { retryable: true })
    }
    const { jobIds } = await runBatch(['Audio Fails'], gv.id)
    await settle(jobIds, ['failed'])
    const scripts = env.openai.count('script')
    const research = env.openai.count('research')
    env.eleven.synthImpl = (req) => ({ audio: fakeMp3(Math.max(2, req.text.length / 15)), requestId: null })
    engine.retryJob(jobIds[0]!)
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(env.openai.count('script')).toBe(scripts)
    expect(env.openai.count('research')).toBe(research)
  }, 20000)

  it('regenerates audio for an existing script without rewriting it, as a new version', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    const { jobIds } = await runBatch(['Regen Audio'], gv.id)
    await settle(jobIds, ['completed'])
    const project = env.s.jobs.get(jobIds[0]!)!.projectId
    const before = env.openai.count('script')
    const job = engine.regenerateAudio({ projectId: project, voiceId: 'voice-2', voiceName: 'Other Voice' })
    await settle([job.id], ['completed', 'failed'])
    expect(env.s.jobs.get(job.id)!.status).toBe('completed')
    expect(env.openai.count('script')).toBe(before)
    const versions = env.s.audio.versions(project)
    expect(versions).toHaveLength(2)
    expect(versions[0]!.voiceId).toBe('voice-2')
    expect(versions[0]!.version).toBe(2)
    expect(path.basename(versions[0]!.filePath)).toBe('Voice_v2.mp3')
    expect(fs.existsSync(versions[1]!.filePath)).toBe(true)
    expect(fs.existsSync(versions[0]!.filePath)).toBe(true)
  })

  it('honours per-provider concurrency limits and handles 100 queued jobs', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false }, research: { ...gv.research, enabled: false } })
    env.s.settings.update({ generation: { maxConcurrentJobs: 6 }, openai: { concurrency: 2 }, elevenlabs: { concurrency: 1 } })
    let activeOpenAI = 0
    let peakOpenAI = 0
    let activeEleven = 0
    let peakEleven = 0
    env.openai.scriptImpl = async (req) => {
      activeOpenAI++
      peakOpenAI = Math.max(peakOpenAI, activeOpenAI)
      await new Promise((r) => setTimeout(r, 5))
      activeOpenAI--
      return { text: goodScript(req.title), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' }
    }
    const origSynth = env.eleven.synthImpl
    env.eleven.synthImpl = async (req) => {
      activeEleven++
      peakEleven = Math.max(peakEleven, activeEleven)
      await new Promise((r) => setTimeout(r, 5))
      activeEleven--
      return origSynth(req)
    }
    const titles = Array.from({ length: 100 }, (_, i) => `Game ${i + 1}`)
    const { jobIds } = await runBatch(titles, gv.id)
    expect(jobIds).toHaveLength(100)
    await settle(jobIds, ['completed', 'failed'], 60000)
    expect(jobIds.every((id) => env.s.jobs.get(id)!.status === 'completed')).toBe(true)
    expect(peakOpenAI).toBeLessThanOrEqual(2)
    expect(peakEleven).toBeLessThanOrEqual(1)
    expect(engine.stats().completed).toBe(100)
  }, 90000)
})

describe('crash recovery and persistence', () => {
  it('recovers interrupted jobs after a restart without duplicating finished work', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false } })
    env.eleven.delayMs = 10_000
    const { jobIds } = await runBatch(['Crash Test'], gv.id)
    await waitFor(() => env.s.jobs.get(jobIds[0]!)!.status === 'generating_audio')
    const scriptCalls = env.openai.count('script')
    // Simulate a crash: drop the engine without graceful stop, reopen the database.
    engine.stop = async () => undefined
    const reopened = env.reopen()
    env.eleven.delayMs = 0
    boot(reopened)
    const stuck = env.s.jobs.get(jobIds[0]!)!
    expect(stuck.status).toBe('generating_audio')
    engine.start()
    await settle(jobIds, ['completed', 'failed'], 20000)
    const job = env.s.jobs.get(jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(env.openai.count('script')).toBe(scriptCalls)
    expect(env.s.jobs.listEvents({ jobId: job.id }).some((e) => e.event === 'recovered')).toBe(true)
    expect(env.s.audio.versions(job.projectId).filter((a) => a.status === 'ready')).toHaveLength(1)
  }, 30000)

  it('adopts a complete audio file written before the crash instead of regenerating', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { validation: { ...gv.validation, aiReviewPass: false } })
    const { jobIds } = await runBatch(['Adopt Audio'], gv.id)
    await settle(jobIds, ['completed'])
    const job = env.s.jobs.get(jobIds[0]!)!
    const audio = env.s.audio.get(job.audioId!)!
    // Rewind the DB as if the process died right after writing the file but before marking it ready.
    env.s.audio.update(audio.id, { status: 'generating', sha256: null, bytes: 0 })
    env.s.jobs.update(job.id, { stage: 'audio' })
    env.s.jobs.setStatus(job.id, 'generating_audio')
    const elevenCalls = env.eleven.calls.length
    const reopened = env.reopen()
    boot(reopened)
    engine.start()
    await settle(jobIds, ['completed', 'failed'])
    expect(env.s.jobs.get(job.id)!.status).toBe('completed')
    expect(env.eleven.calls.length).toBe(elevenCalls)
    expect(env.s.audio.get(audio.id)!.status).toBe('ready')
    expect(env.s.audio.get(audio.id)!.sha256).toHaveLength(64)
  })

  it('persists channels, settings, jobs and history across reopen', async () => {
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.settings.update({ general: { theme: 'light' } })
    const { jobIds } = await runBatch(['Persist Me'], gv.id, 'scripts_only')
    await settle(jobIds, ['completed'])
    const reopened = env.reopen()
    boot(reopened)
    expect(env.s.settings.get().general.theme).toBe('light')
    expect(env.s.channels.list()).toHaveLength(5)
    expect(env.s.jobs.get(jobIds[0]!)!.status).toBe('completed')
    expect(env.s.jobs.listEvents({ jobId: jobIds[0]! }).length).toBeGreaterThan(3)
    expect(env.s.secrets.get('openai')).toBe('sk-test-openai-key-1234567890')
  })
})

describe('backup and restore', () => {
  it('creates a consistent backup and restores from it', async () => {
    const backup = new BackupService(env.s)
    const gv = env.s.channels.getByName('Game Vault')!
    env.s.channels.update(gv.id, { description: 'before backup' })
    const info = await backup.create()
    expect(fs.existsSync(info.path)).toBe(true)
    expect(fs.readFileSync(info.path).subarray(0, 15).toString()).toBe('SQLite format 3')
    expect(fs.readFileSync(`${info.path}.json`, 'utf8')).not.toContain('sk-test')
    expect(backup.list()).toHaveLength(1)
    env.s.channels.update(gv.id, { description: 'after backup' })
    const staged = await backup.stageRestore(info.path)
    expect(fs.existsSync(staged)).toBe(true)
    // Apply the restore the way main does on startup.
    env.s.db.close()
    const dbPath = env.s.db.path
    fs.renameSync(staged, dbPath)
    for (const sfx of ['-wal', '-shm']) if (fs.existsSync(dbPath + sfx)) fs.unlinkSync(dbPath + sfx)
    const reopened = createTestEnv({ dir: env.dir, openai: env.openai, eleven: env.eleven, seed: false })
    boot(reopened)
    expect(env.s.channels.get(gv.id)!.description).toBe('before backup')
    await expect(backup.stageRestore(path.join(env.dir, 'missing.sqlite'))).rejects.toThrow()
  })

  it('exports and imports data files', async () => {
    const backup = new BackupService(env.s)
    const json = backup.exportData('all')
    expect(json).toContain('"format": "voiceforge-export"')
    expect(json).not.toContain('sk-test')
    const before = env.s.channels.list().length
    const result = backup.importData(json)
    expect(result.channels).toBe(5)
    expect(env.s.channels.list().length).toBe(before + 5)
  })
})

describe('upgrade from 1.0.0', () => {
  it('fills new settings fields and keeps the stored values of an older database', () => {
    const legacy = JSON.parse(JSON.stringify(env.s.settings.get())) as Record<string, Record<string, unknown>>
    delete legacy.updates
    delete legacy.general!.onboardingCompleted
    delete legacy.generation!.lengthToleranceChars
    legacy.openai!.defaultModel = 'gpt-5'
    ;(legacy.spending!.pricing as { openai: Record<string, unknown> }).openai = { default: { input: 2.5, output: 10 }, 'gpt-5': { input: 1.25, output: 10 } }
    env.s.settingsRepo.set('app_settings', legacy)
    const reopened = env.reopen()
    const st = reopened.s.settings.get()
    expect(st.openai.defaultModel).toBe('gpt-5')
    expect(st.general.onboardingCompleted).toBe(false)
    expect(st.updates.owner).toBe('stefi421')
    expect(st.generation.lengthToleranceChars).toBe(150)
    expect(st.spending.pricing.openai['gpt-6.1-sol']).toBeDefined()
    expect(st.spending.pricing.openai['gpt-5']).toEqual({ input: 1.25, output: 10 })
    // New columns exist on an upgraded database.
    expect(reopened.s.db.all<{ name: string }>("SELECT name FROM pragma_table_info('scripts')").some((c) => c.name === 'approved_with_issues')).toBe(true)
    expect(reopened.s.db.all<{ name: string }>("SELECT name FROM pragma_table_info('projects')").some((c) => c.name === 'canonical_title')).toBe(true)
    boot(reopened)
  })
})
