/**
 * 1.7.0: long-form / short-form formats. Form factor and per-format length windows (migration,
 * validator, prompt, estimate, TTS), the short-form seed for PlayTopia / RiftForge Tech / RENVO,
 * "(Short)" output folders and Game Library research reused between long and short.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { goodScript } from './helpers/mockProviders'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { seedDefaults, SHORTS_SEED_KEY } from '../src/main/services/seed'
import { validateScript } from '../src/main/pipeline/validator'
import { buildScriptPrompt } from '../src/main/providers/prompts'
import { splitForParallel } from '../src/main/pipeline/chunker'
import { versionToInput } from '../src/main/services/style'
import { applyFormatLimits, type Channel, type Template } from '../src/shared/types'
import type { ScriptRequest } from '../src/main/providers/types'

let env: TestEnv
let engine: QueueEngine
let gen: GenerationService

beforeEach(() => {
  env = createTestEnv()
  engine = new QueueEngine(env.s, new Logger().child('t'))
  gen = new GenerationService(env.s, engine)
})
afterEach(async () => {
  await engine.stop()
  env.cleanup()
})

const byName = (n: string): Channel => env.s.channels.getByName(n)!
const fmt = (channel: string, contentType: string): Template => env.s.channels.getTemplateByContentType(byName(channel).id, contentType)!
const DONE = ['completed', 'failed', 'awaiting_approval', 'research_review_required']
const settle = (ids: string[], timeout = 15000) => waitFor(() => ids.every((id) => DONE.includes(env.s.jobs.get(id)!.status)), timeout)

/** A ~450-character PlayTopia short in three short paragraphs. */
function shortText(title: string): string {
  return [
    `Think you have seen every cozy builder? ${title} will change your mind in seconds.`,
    `${title} is a relaxed town builder where every street you lay down changes how the whole place grows, and the town reacts to each choice you make.`,
    'The crafting is deep, the music is calm and the changing seasons keep every new day of building feeling fresh. Give it a look this weekend.'
  ].join('\n\n')
}

function useMockWriter(): void {
  env.openai.scriptImpl = (req: ScriptRequest) => ({
    text: req.formFactor === 'short' ? shortText(req.title) : goodScript(req.title, req.template.structure.map((s) => s.label), 4200),
    usage: { inputTokens: 1500, outputTokens: 300 },
    model: 'gpt-test'
  })
}

/** PlayTopia's long review is "needs references" in the seed; approve it like the owner would. */
function approvePlayTopiaReview(): void {
  const t = fmt('PlayTopia', 'review')
  const v = env.s.channels.addVersion(t.id, { ...versionToInput(env.s.channels.activeVersionOf(t.id)!), placeholder: false })
  env.s.channels.setVersionStatus(v.id, 'approved')
  env.s.channels.setActiveVersion(byName('PlayTopia').id, v.id)
}

describe('form factor and per-format limits', () => {
  it('defaults existing formats to long form with the channel limits and marks short_review short', () => {
    for (const c of env.s.channels.list()) {
      for (const t of env.s.channels.listTemplates(c.id)) {
        if (['short', 'short_review'].includes(t.contentType)) continue
        expect(t.formFactor, `${c.name} › ${t.contentType}`).toBe('long')
        expect([t.minChars, t.maxChars, t.targetDurationSec]).toEqual([null, null, null])
      }
    }
    const gv = byName('Game Vault')
    const t = env.s.channels.listTemplates(gv.id)[0]!
    expect(applyFormatLimits(gv, t)).toBe(gv)
    const rf = fmt('RiftForge Tech', 'short_review')
    expect(rf.formFactor).toBe('short')
    expect([rf.minChars, rf.maxChars, rf.targetDurationSec]).toEqual([120, 260, 11])
  })

  it('the migration marks pre-1.7 short_review formats short and leaves the rest long', () => {
    // Simulate a 1.6 database: column defaults, nothing set.
    env.s.db.run("UPDATE templates SET form_factor = 'long', min_chars = NULL, max_chars = NULL, target_duration_sec = NULL")
    env.s.db.run("UPDATE templates SET form_factor = 'short' WHERE content_type IN ('short_review', 'short')")
    expect(fmt('RiftForge Tech', 'short_review').formFactor).toBe('short')
    expect(fmt('RiftForge Tech', 'full_review').formFactor).toBe('long')
    expect(fmt('Game Vault', env.s.channels.listTemplates(byName('Game Vault').id)[0]!.contentType).formFactor).toBe('long')
  })

  it('validator, prompt and estimate use the format window; the Writing tab limits stay the channel default', () => {
    const pt = byName('PlayTopia')
    const short = fmt('PlayTopia', 'short')
    const eff = applyFormatLimits(pt, short)
    expect([eff.minChars, eff.maxChars, eff.targetDurationSec]).toEqual([350, 650, 35])
    expect([pt.minChars, pt.maxChars]).toEqual([3800, 4700])

    const text = shortText('Emberward')
    const version = env.s.channels.activeVersionOf(short.id)!
    const ok = validateScript(text, { channel: eff, template: version, formFactor: 'short', expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard' })
    expect(ok.issues.filter((i) => i.severity === 'error')).toEqual([])
    // Against the channel (long) window the same short is far too short.
    const asLong = validateScript(text, { channel: pt, template: version, expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard' })
    expect(asLong.issues.map((i) => i.code)).toContain('too_short')
    const long = validateScript(text + '\n\n' + 'More words about the game. '.repeat(30), { channel: eff, template: version, formFactor: 'short', expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard', strictLength: true })
    expect(long.issues.map((i) => i.code)).toContain('too_long')

    const prompt = buildScriptPrompt({ channel: eff, template: version, title: 'Emberward', research: null, researchSources: [], formFactor: 'short' })
    expect(prompt.instructions).toContain('minimum 350, maximum 650')
    expect(prompt.instructions).toContain('roughly 35 seconds')
    expect(prompt.instructions).toContain('SHORT-FORM VOICEOVER')
    expect(prompt.instructions).not.toContain('Required structure — write each section label')
    expect(prompt.instructions).not.toContain('FORMAT SKELETON')
    const longPrompt = buildScriptPrompt({ channel: pt, template: env.s.channels.activeVersionOf(fmt('PlayTopia', 'review').id)!, title: 'Emberward', research: null, researchSources: [] })
    expect(longPrompt.instructions).toContain('maximum 4700')
    expect(longPrompt.instructions).not.toContain('SHORT-FORM')

    const entries = [{ title: 'Emberward', channelId: null }]
    const estShort = gen.estimate({ channelId: pt.id, templateId: short.id, mode: 'review_before_voice', entries, skipExisting: false })
    const estLong = gen.estimate({ channelId: pt.id, templateId: fmt('PlayTopia', 'review').id, mode: 'review_before_voice', entries, skipExisting: false })
    expect(estShort.estimatedCharacters).toBe(500)
    expect(estLong.estimatedCharacters).toBe(4250)
  })

  it('applies the short-form validator rules', () => {
    const rf = byName('RiftForge Tech')
    const t = fmt('RiftForge Tech', 'short_review')
    const ch = applyFormatLimits({ ...rf, validation: { ...rf.validation, forbidUrls: false, forbidMarkdown: false } }, t)
    const v = env.s.channels.activeVersionOf(t.id)!
    const base = 'This tiny keyboard punches way above its size. The Keychron Q1 Max has a gasket mount, hot-swap switches, qmk and via support and usb-c plus 2.4 ghz wireless.'
    const ctx = { channel: ch, template: v, formFactor: 'short' as const, expectedTitle: 'Keychron Q1 Max', researchConfirmed: true, strictness: 'standard' as const }
    expect(validateScript(base, ctx).ok).toBe(true)
    const codes = (s: string, title = 'Keychron Q1 Max') => validateScript(s, { ...ctx, expectedTitle: title }).issues.filter((i) => i.severity === 'error').map((i) => i.code)
    expect(codes(`${base} See keychron.com/q1`)).toContain('url')
    expect(codes(`**Hook**\n${base}`)).toContain('markdown')
    expect(codes(`Hook\n${base}`)).toContain('short_heading')
    expect(codes(base, 'Razer Huntsman V3')).toContain('title_missing')
    // Long-form keeps "title missing" as a warning.
    const longCtx = { ...ctx, formFactor: 'long' as const, expectedTitle: 'Razer Huntsman V3' }
    expect(validateScript(base, longCtx).issues.find((i) => i.code === 'title_missing')?.severity).toBe('warning')
  })
})

describe('short-form seed (idempotent)', () => {
  it('creates the three short formats with their limits, provisional, without touching edited formats', () => {
    const pt = fmt('PlayTopia', 'short')
    expect(pt.name).toBe('Short form')
    expect(pt.formFactor).toBe('short')
    const ptv = env.s.channels.listVersions(pt.id)[0]!
    expect(ptv.structure.map((s) => s.label)).toEqual(['Hook', 'What the game is', 'Key points', 'Closing line'])
    expect(ptv.structure.every((s) => !s.required)).toBe(true)
    expect(ptv.headingsSpoken).toBe(false)
    expect(ptv.fixedBlocks).toEqual([])
    expect(ptv.unverified.join(' ')).toContain('Approved PlayTopia short-form example scripts')
    expect(ptv.unverified.join(' ')).toContain('provisional default — adjust after approving your first shorts')
    const renvo = fmt('RENVO', 'short')
    expect([renvo.formFactor, renvo.minChars, renvo.maxChars, renvo.targetDurationSec]).toEqual(['short', 120, 260, 11])
    expect(fmt('RENVO', 'youtube_review').formFactor).toBe('long')
    expect(fmt('RENVO', 'product_overview').formFactor).toBe('long')
    expect(fmt('RiftForge Tech', 'unboxing').formFactor).toBe('long')
    const rfv = env.s.channels.activeVersionOf(fmt('RiftForge Tech', 'short_review').id)!
    expect(rfv.confirmedRules).toContain('HOOK → product NAME → 3–4 key specs')
    expect(rfv.confirmedRules).toContain('usb-c, qmk, via, ghz')
    // The default (long) format stays the channel default.
    expect(env.s.channels.defaultTemplate(byName('RiftForge Tech').id)!.contentType).toBe('full_review')
  })

  it('upgrades a 1.6 install once and never overwrites owner changes', () => {
    const s = env.s
    // Back to a 1.6 state: no PlayTopia/RENVO shorts, RiftForge short_review as seeded by 1.6.
    for (const name of ['PlayTopia', 'RENVO']) s.channels.deleteTemplate(fmt(name, 'short').id)
    const rf = fmt('RiftForge Tech', 'short_review')
    s.channels.setTemplateLimits(rf.id, { formFactor: 'short', minChars: null, maxChars: null, targetDurationSec: null })
    // The owner already changed the RENVO channel and edited the RiftForge short_review text.
    const edited = s.channels.addVersion(rf.id, { systemPrompt: 'My own short format', structure: [], exampleScript: null, notes: 'owner edit' })
    s.channels.setActiveVersion(byName('RiftForge Tech').id, edited.id)
    s.settingsRepo.set(SHORTS_SEED_KEY, false)

    seedDefaults(s)
    expect(fmt('PlayTopia', 'short').formFactor).toBe('short')
    expect(fmt('RENVO', 'short').maxChars).toBe(260)
    const after = fmt('RiftForge Tech', 'short_review')
    expect([after.minChars, after.maxChars, after.targetDurationSec]).toEqual([120, 260, 11])
    expect(s.channels.activeVersionOf(after.id)!.id).toBe(edited.id)

    // Second run (and a forced re-run) changes nothing; owner limits survive.
    s.channels.setTemplateLimits(fmt('PlayTopia', 'short').id, { formFactor: 'short', minChars: 400, maxChars: 700, targetDurationSec: 40 })
    const count = () => s.channels.list().reduce((n, c) => n + s.channels.listTemplates(c.id).length, 0)
    const versions = () => s.channels.list().reduce((n, c) => n + s.channels.listTemplates(c.id).reduce((m, t) => m + s.channels.listVersions(t.id).length, 0), 0)
    const before = [count(), versions()]
    seedDefaults(s)
    s.settingsRepo.set(SHORTS_SEED_KEY, false)
    seedDefaults(s)
    expect([count(), versions()]).toEqual(before)
    expect(fmt('PlayTopia', 'short').maxChars).toBe(700)
  })
})

describe('short-form generation', () => {
  it('voices a short in one piece even with parallel parts, into "<Title> (Short)/Script.txt + Voice.mp3"', async () => {
    useMockWriter()
    env.s.settings.update({ elevenlabs: { parallelParts: 3, concurrency: 3 } })
    // Without the short-form rule the narration could be split into parts (paragraph boundaries).
    expect(splitForParallel(shortText('Emberward'), 3, 5000, { minChars: 0 }).length).toBeGreaterThan(1)
    engine.start()
    const pt = byName('PlayTopia')
    const r = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'short').id, mode: 'auto', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(r.jobIds)
    const job = env.s.jobs.getView(r.jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(job.formFactor).toBe('short')
    expect(env.eleven.calls.length).toBe(1)
    const scriptReq = env.openai.calls.find((c) => c.kind === 'script')!.req as ScriptRequest
    expect(scriptReq.formFactor).toBe('short')
    expect(scriptReq.channel.maxChars).toBe(650)
    const project = env.s.projects.get(job.projectId)!
    expect(project.formFactor).toBe('short')
    expect(project.folderName).toBe('Emberward (Short)')
    expect(fs.readdirSync(project.folderPath!).sort()).toEqual(['Script.txt', 'Voice.mp3'])
    expect(path.basename(project.folderPath!)).toBe('Emberward (Short)')
  })

  it('flat layout writes "<Title> (Short).txt/.mp3" next to the long-form files', async () => {
    useMockWriter()
    approvePlayTopiaReview()
    env.s.settings.update({ storage: { outputLayout: 'flat' } })
    engine.start()
    const pt = byName('PlayTopia')
    const a = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'review').id, mode: 'auto', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(a.jobIds)
    const b = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'short').id, mode: 'auto', entries: [{ title: 'Emberward', channelId: null }], skipExisting: true })
    expect(b.skipped).toEqual([])
    await settle(b.jobIds)
    expect(env.s.jobs.get(a.jobIds[0]!)!.status).toBe('completed')
    expect(env.s.jobs.get(b.jobIds[0]!)!.status).toBe('completed')
    const dir = env.s.projects.get(env.s.jobs.get(b.jobIds[0]!)!.projectId)!.folderPath!
    expect(fs.readdirSync(dir).sort()).toEqual(['Emberward (Short).mp3', 'Emberward (Short).txt', 'Emberward.mp3', 'Emberward.txt'])
  })

  it('reuses Game Library research between long and short (no new research calls)', async () => {
    useMockWriter()
    approvePlayTopiaReview()
    engine.start()
    const pt = byName('PlayTopia')
    const long = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'review').id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(long.jobIds)
    expect(env.openai.count('research')).toBe(1)
    const est = gen.estimate({ channelId: pt.id, templateId: fmt('PlayTopia', 'short').id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    expect([est.savedResearch, est.newResearch]).toEqual([1, 0])
    const short = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'short').id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await settle(short.jobIds)
    expect(env.s.jobs.get(short.jobIds[0]!)!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(1)

    // And the other way round: short first, then long, on another title.
    const s2 = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'short').id, mode: 'scripts_only', entries: [{ title: 'Frosthaven', channelId: null }], skipExisting: false })
    await settle(s2.jobIds)
    const l2 = gen.createBatch({ channelId: pt.id, templateId: fmt('PlayTopia', 'review').id, mode: 'scripts_only', entries: [{ title: 'Frosthaven', channelId: null }], skipExisting: false })
    await settle(l2.jobIds)
    expect(env.s.jobs.get(l2.jobIds[0]!)!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(2)
    expect(env.s.settings.get().ui.formFactorByChannel[pt.id]).toBe('long')
  })
})
