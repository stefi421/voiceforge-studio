/**
 * 1.4.0: built-in reference pack (owner-approved, 2026-10-18) → approved formats with locked
 * intro/outro and labelled structure, exact-paragraph validation, presentation normaliser and
 * the format skeleton in the writer prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { StyleService } from '../src/main/services/style'
import { applyReferencePack, GAME_VAULT_INTRO, PACK_CHANNELS, readReferencePack, REFERENCE_PACK_MARKER } from '../src/main/services/referencePack'
import { buildFormatSkeleton, normalizeLockedText, splitParagraphs, validateFixedBlocks } from '../src/main/pipeline/style'
import { scriptSystemPrompt } from '../src/main/providers/prompts'
import { validateScript } from '../src/main/pipeline/validator'
import type { Channel, TemplateVersion } from '../src/shared/types'

const PACK_DIR = path.join(__dirname, '..', 'resources', 'reference-pack-2026-10-18')

let env: TestEnv
beforeEach(() => {
  env = createTestEnv()
})
afterEach(() => env.cleanup())

const fmt = (name: string): { channel: Channel; v: TemplateVersion; templateId: string } => {
  const channel = env.s.channels.getByName(name)!
  const t = name === 'VoidPulse' ? env.s.channels.getTemplateByContentType(channel.id, 'review')! : env.s.channels.defaultTemplate(channel.id)!
  return { channel: env.s.channels.get(channel.id)!, v: env.s.channels.activeVersionOf(t.id)!, templateId: t.id }
}

/** A script that follows the skeleton exactly, with new game-specific paragraphs, about 4,750 characters long. */
function skeletonScript(v: TemplateVersion, refs: Array<{ text: string }>, title: string, total = 4750): string {
  const parts = buildFormatSkeleton(v, refs)
  const fixed = parts.filter((p) => p.kind !== 'opening').reduce((a, p) => a + p.text.length + 2, 0)
  const count = parts.reduce((a, p) => a + (p.kind === 'opening' || p.kind === 'section' ? Math.max(1, p.paragraphs) : 0), 0)
  const per = Math.floor((total - fixed) / count) - 2
  const filler = `${title} rewards careful decisions, and its systems shape later options for the player in a clear and steady way. `
  const para = (i: number, k: number): string => {
    const head = `Part ${i}.${k + 1}: `
    let t = head
    while (t.length + filler.length <= per) t += filler
    return t.trim()
  }
  const out: string[] = []
  parts.forEach((p, i) => {
    const body = Array.from({ length: Math.max(1, p.paragraphs) }, (_, k) => para(i, k))
    if (p.kind === 'intro' || p.kind === 'outro') out.push(p.text)
    else if (p.kind === 'opening') out.push(...body)
    else out.push(p.text, ...body)
  })
  return out.join('\n\n')
}

describe('reading the pack', () => {
  it('finds 15 channels with identical first/last paragraphs and 5 headings each', () => {
    const packs = readReferencePack(PACK_DIR)
    expect(packs).toHaveLength(15)
    expect(new Set(packs.map((p) => p.channelName))).toEqual(new Set(Object.values(PACK_CHANNELS)))
    for (const p of packs) {
      expect(p.scripts).toHaveLength(5)
      expect(p.headings).toHaveLength(5)
      for (const sc of p.scripts) {
        const paras = splitParagraphs(sc.text)
        expect(paras).toHaveLength(19)
        expect(paras[0]).toBe(p.intro)
        expect(paras[18]).toBe(p.outro)
        expect(sc.text.length).toBeGreaterThan(4600)
        expect(sc.text.length).toBeLessThan(4900)
      }
    }
    expect(packs.find((p) => p.channelName === 'GameSense')!.headings[4]).toBe('Is It Worth Playing?')
    expect(packs.find((p) => p.channelName === 'Game Vault')!.headings).toEqual(['Gameplay', 'Combat & Exploration', 'Pros', 'Cons', 'Conclusion'])
    expect(packs.find((p) => p.channelName === 'RazorFrame')!.scripts.map((s) => s.title)).toContain('RuneScape: Dragonwilds')
  })
})

describe('applying the pack', () => {
  it('approves 15 formats with references, locked intro/outro and structure; idempotent', () => {
    const notes: string[] = []
    env.s.events.on('notification', (n) => notes.push(n.message))
    const res = applyReferencePack(env.s, PACK_DIR)!
    expect(res.applied).toHaveLength(15)
    expect(res.awaitingApproval).toEqual([])
    const packs = readReferencePack(PACK_DIR)
    for (const p of packs) {
      const { channel, v, templateId } = fmt(p.channelName)
      expect(v.approvalStatus).toBe('approved')
      expect(v.notes).toContain(REFERENCE_PACK_MARKER)
      expect(v.notes).toMatch(/reconstructions/)
      expect(env.s.channels.listReferences(templateId)).toHaveLength(5)
      expect(v.referenceSetVersion).toBe(env.s.channels.referenceSetVersion(templateId))
      expect(v.structure.map((s) => s.label)).toEqual(p.headings)
      expect(v.headingsSpoken).toBe(true)
      const intro = v.fixedBlocks.find((b) => b.kind === 'intro')!
      const outro = v.fixedBlocks.find((b) => b.kind === 'outro')!
      expect(intro).toMatchObject({ locked: true, spoken: true, wholeParagraph: true, provenance: 'user_confirmed' })
      expect(intro.text).toBe(p.channelName === 'Game Vault' ? GAME_VAULT_INTRO : p.intro)
      expect(outro).toMatchObject({ text: p.outro, locked: true, wholeParagraph: true })
      expect(v.confirmedRules).toMatch(/reference pack 2026-10-18/)
      expect(channel.minChars).toBe(4500)
      expect(channel.maxChars).toBe(5000)
      expect(channel.validation.enforceSectionOrder).toBe(true)
      // The approved pack version is the one generation uses.
      expect(new StyleService(env.s).resolve(channel)!.version.id).toBe(p.channelName === 'VoidPulse' ? env.s.channels.get(channel.id)!.activeTemplateVersionId : v.id)
    }
    expect(fmt('Game Vault').v.structure.find((s) => s.label === 'Combat & Exploration')!.aliases).toContain('Combat')
    expect(fmt('Game Vault').v.confirmedRules).not.toMatch(/3,500/)
    expect(fmt('Game Vault').v.confirmedRules).toMatch(/4,700–4,850 characters/)
    expect(notes.some((m) => m.includes('Reference pack applied: 15 channel formats approved'))).toBe(true)
    // Second run: no-op.
    const versions = env.s.channels.listVersions(fmt('Nexora').templateId).length
    expect(applyReferencePack(env.s, PACK_DIR)).toBeNull()
    expect(env.s.channels.listVersions(fmt('Nexora').templateId)).toHaveLength(versions)
    expect(env.s.channels.listReferences(fmt('Nexora').templateId)).toHaveLength(5)
  })

  it('does not activate over a format the owner edited, and keeps owner-set limits', () => {
    const { channel, v, templateId } = fmt('Nexora')
    const own = env.s.channels.addVersion(templateId, { systemPrompt: 'My own Nexora prompt', structure: [], exampleScript: null, notes: 'Mine', approvalStatus: 'provisional' })
    env.s.channels.setActiveVersion(channel.id, own.id)
    env.s.channels.update(channel.id, { minChars: 3000, maxChars: 4100 })
    const notes: string[] = []
    env.s.events.on('notification', (n) => notes.push(n.message))
    const res = applyReferencePack(env.s, PACK_DIR)!
    expect(res.awaitingApproval).toEqual(['Nexora'])
    const after = env.s.channels.activeVersionOf(templateId)!
    expect(after.id).toBe(own.id)
    const pending = env.s.channels.listVersions(templateId).find((x) => x.notes.includes(REFERENCE_PACK_MARKER))!
    expect(pending.approvalStatus).toBe('awaiting_approval')
    expect(env.s.channels.get(channel.id)!.maxChars).toBe(4100)
    expect(notes.some((m) => m.includes('Channels → Nexora → Formats'))).toBe(true)
    expect(v.id).not.toBe(pending.id)
  })

  it('is a no-op when the pack folder is missing', () => {
    const missing = path.join(os.tmpdir(), 'vf-no-pack-' + Date.now())
    expect(applyReferencePack(env.s, missing)).toBeNull()
    expect(fs.existsSync(missing)).toBe(false)
    // Not marked as applied, so a later build that ships the pack still applies it.
    expect(applyReferencePack(env.s, PACK_DIR)!.applied).toHaveLength(15)
  })
})

describe('exact format reproduction', () => {
  beforeEach(() => {
    applyReferencePack(env.s, PACK_DIR)
  })

  it('puts the format skeleton and two reference scripts in the writer prompt', () => {
    const { channel, v, templateId } = fmt('GameSense')
    const refs = new StyleService(env.s).promptReferences(templateId)
    expect(refs).toHaveLength(2)
    const prompt = scriptSystemPrompt(channel, v, refs)
    expect(prompt).toContain('FORMAT SKELETON')
    expect(prompt).toContain('Welcome back to GameSense. Is this game worth playing? Let\'s find out.')
    expect(prompt).toContain('Is It Worth Playing?\n[2 paragraphs]')
    expect(prompt).toContain('The Setup\n[2 paragraphs]')
    expect(prompt).toContain('Moment-to-Moment Gameplay\n[3 paragraphs]')
    expect(prompt).toContain("[1 paragraph introducing today's title")
    expect(prompt).toMatch(/never reuse their game facts/)
  })

  it('validates a skeleton-built script and gives a targeted error for a changed outro', () => {
    const { channel, v, templateId } = fmt('Fluxor')
    const refs = env.s.channels.listReferences(templateId)
    const script = skeletonScript(v, refs, 'Hollow Bastion')
    const ctx = { channel, template: v, expectedTitle: 'Hollow Bastion', researchConfirmed: true, strictness: 'standard' as const, lengthToleranceChars: 150 }
    expect(validateFixedBlocks(script, v)).toEqual([])
    const changed = script.replace('That\'s the breakdown. Thanks for watching Fluxor.', 'Thanks for watching, see you soon.')
    const issues = validateFixedBlocks(changed, v)
    expect(issues.map((i) => i.code)).toEqual(['fixed_outro'])
    expect(issues[0]!.message).toContain("That's the breakdown. Thanks for watching Fluxor.")
    expect(validateScript(changed, ctx).ok).toBe(false)
    // Intro merged with the next paragraph is not "the first paragraph exactly".
    const merged = script.replace(`${v.fixedBlocks[0]!.text}\n\n`, `${v.fixedBlocks[0]!.text} `)
    expect(validateFixedBlocks(merged, v).map((i) => i.code)).toEqual(['fixed_intro'])
  })

  it('normaliser fixes presentation only: case/colon/markdown labels, quote and dash style, merged intro/outro', () => {
    const { v, templateId } = fmt('Game Vault')
    const refs = env.s.channels.listReferences(templateId)
    const good = skeletonScript(v, refs, 'Hollow Bastion')
    const messy = good
      .replace(GAME_VAULT_INTRO, `${GAME_VAULT_INTRO.replace('—', ' - ')} Today we look at Hollow Bastion.`)
      .replace('\nPros\n', '\n## pros:\n')
      .replace('\nCons\n', '\n**Cons**\n')
      .replace("That's it for today's Game Vault review.", 'That’s it for today’s Game Vault review.')
      .replace(/\n\nThat’s it/, ' That’s it')
    expect(validateFixedBlocks(messy, v).length).toBeGreaterThan(0)
    const fixed = normalizeLockedText(messy, v)
    expect(validateFixedBlocks(fixed, v)).toEqual([])
    const paras = splitParagraphs(fixed)
    expect(paras[0]).toBe(GAME_VAULT_INTRO)
    expect(paras[1]).toBe('Today we look at Hollow Bastion.')
    expect(paras[paras.length - 1]).toBe("That's it for today's Game Vault review. Thanks for watching, and stay glorious.")
    expect(fixed).toContain('\nPros\n')
    expect(fixed).toContain('\nCons\n')
    // Reworded text is left alone for the validator.
    const reworded = good.replace('Thanks for watching, and stay glorious.', 'Thanks for watching!')
    expect(normalizeLockedText(reworded, v)).toBe(reworded)
  })

  it('generation with the mock writer: skeleton output completes, a changed outro is rewritten then fails', async () => {
    const engine = new QueueEngine(env.s, new Logger().child('t'))
    const gen = new GenerationService(env.s, engine)
    const { channel, v, templateId } = fmt('VELIX')
    env.s.channels.update(channel.id, { elevenVoiceId: 'voice-1', elevenVoiceName: 'Test' })
    const refs = env.s.channels.listReferences(templateId)
    env.openai.scriptImpl = (req) => ({ text: skeletonScript(req.template, refs, req.title), usage: { inputTokens: 100, outputTokens: 100 }, model: 'gpt-test' })
    engine.start()
    const ok = gen.createBatch({ channelId: channel.id, mode: 'auto', entries: [{ title: 'Hollow Bastion', channelId: null }], skipExisting: false })
    await waitFor(() => ['completed', 'failed'].includes(env.s.jobs.get(ok.jobIds[0]!)!.status), 15000)
    expect(env.s.jobs.get(ok.jobIds[0]!)!.status).toBe('completed')
    const req = env.openai.calls.filter((c) => c.kind === 'script').pop()!.req as { template: TemplateVersion; references: unknown[]; skeletonReferences?: unknown[] }
    expect(req.template.id).toBe(v.id)
    // 1.6.0: a format with ≥3 locked elements sends ONE full reference; the skeleton still uses all of them.
    expect(req.references).toHaveLength(1)
    expect((req.skeletonReferences ?? []).length).toBeGreaterThanOrEqual(2)

    env.openai.scriptImpl = (req) => ({ text: skeletonScript(req.template, refs, req.title).replace('Thanks for watching VELIX. See you in the next review.', 'Bye for now.'), usage: { inputTokens: 100, outputTokens: 100 }, model: 'gpt-test' })
    const bad = gen.createBatch({ channelId: channel.id, mode: 'auto', entries: [{ title: 'Iron Coast', channelId: null }], skipExisting: false })
    await waitFor(() => ['completed', 'failed'].includes(env.s.jobs.get(bad.jobIds[0]!)!.status), 15000)
    const job = env.s.jobs.get(bad.jobIds[0]!)!
    expect(job.status).toBe('failed')
    expect(job.lastError?.message ?? '').toMatch(/last paragraph must be exactly the locked closing/)
    await engine.stop()
  }, 30000)
})
