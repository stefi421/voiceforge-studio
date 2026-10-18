/**
 * Channel Style Preservation Studio: reference import, fixed-text detection,
 * analysis provenance, approval gating, locked text, narration text, style
 * tests, the 18-channel seed and migration 3. Mocked providers only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { BackupService } from '../src/main/services/backup'
import { Logger } from '../src/main/services/logger'
import { StyleService, extractReferenceText } from '../src/main/services/style'
import { buildNarrationText, detectFixedText, validateFixedBlocks } from '../src/main/pipeline/style'
import { validateScript } from '../src/main/pipeline/validator'
import { seedDefaults } from '../src/main/services/seed'
import { Database } from '../src/main/db/database'
import { MIGRATIONS } from '../src/main/db/schema'
import { ChannelRepo } from '../src/main/db/repos/channelRepo'
import { ScriptRepo } from '../src/main/db/repos/contentRepo'
import { LEGACY_SEED_V1 } from '../src/shared/defaults'
import { SEED_CHANNELS } from '../src/shared/seedChannels'
import { goodScript } from './helpers/mockProviders'
import type { Channel, FixedTextBlock, TemplateVersion } from '../src/shared/types'

let env: TestEnv
let style: StyleService
let tmp: string

beforeEach(() => {
  env = createTestEnv()
  style = new StyleService(env.s)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-style-'))
})
afterEach(() => {
  env.cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const INTRO = 'Welcome to the Vault, where every game gets a fair hearing.'
const OUTRO = 'That is the verdict, and we will see you in the next one.'
function refText(game: string): string {
  return `${INTRO}\n\nGameplay\n${game} asks you to build, explore and survive across a long campaign with many systems. The loop rewards patience and planning.\n\nConclusion\n${game} is worth a look for fans of the genre. ${OUTRO}`
}
function template(over: Partial<TemplateVersion> = {}): TemplateVersion {
  return {
    id: 'v', templateId: 't', channelId: 'c', version: 1, systemPrompt: '', structure: [{ key: 'gameplay', label: 'Gameplay', required: true, aliases: [], guidance: '' }],
    exampleScript: null, notes: '', placeholder: false, approvalStatus: 'approved', fixedBlocks: [], findings: [], confirmedRules: '', unverified: [], headingsSpoken: false,
    referenceSetVersion: null, approvedAt: null, createdAt: '', ...over
  }
}
const block = (kind: FixedTextBlock['kind'], text: string, locked = true, spoken = true): FixedTextBlock => ({ id: `${kind}-${text.length}`, kind, text, locked, provenance: 'consistent', spoken, occurrences: 3 })

function minimalPdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function minimalDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function gameVault(): { channel: Channel; templateId: string; versionId: string } {
  const channel = env.s.channels.getByName('Game Vault')!
  const t = env.s.channels.defaultTemplate(channel.id)!
  return { channel, templateId: t.id, versionId: env.s.channels.activeVersionOf(t.id)!.id }
}

describe('reference import', () => {
  it('reads TXT, Markdown, DOCX and PDF and rejects unsupported files', async () => {
    const txt = path.join(tmp, 'a.txt')
    fs.writeFileSync(txt, `﻿${refText('Alpha')}\r\n\r\n\r\n`)
    const md = path.join(tmp, 'b.md')
    fs.writeFileSync(md, refText('Beta'))
    const docx = path.join(tmp, 'c.docx')
    fs.writeFileSync(docx, await minimalDocx(['Welcome to the Vault, where every game gets a fair hearing.', 'Gameplay', 'Gamma is a long survival campaign with many systems to master.']))
    const pdf = path.join(tmp, 'd.pdf')
    fs.writeFileSync(pdf, minimalPdf('Welcome to the Vault, where every game gets a fair hearing. Delta review text for the PDF import test.'))
    expect((await extractReferenceText(txt)).text.startsWith('Welcome')).toBe(true)
    expect((await extractReferenceText(docx)).text).toContain('Gamma is a long survival campaign')
    expect((await extractReferenceText(pdf)).text).toContain('Delta review text')
    await expect(extractReferenceText(path.join(tmp, 'x.exe'))).rejects.toMatchObject({ code: 'REFERENCE_UNSUPPORTED' })

    const pt = env.s.channels.getByName('PlayTopia')!
    const t = env.s.channels.defaultTemplate(pt.id)!
    const before = env.s.channels.referenceSetVersion(t.id)
    const res = await style.importFiles(t.id, [txt, md, docx, pdf, path.join(tmp, 'missing.txt'), 'relative.txt'])
    expect(res.added.map((r) => r.sourceFormat)).toEqual(['txt', 'md', 'docx', 'pdf'])
    expect(res.failed).toHaveLength(2)
    expect(env.s.channels.referenceSetVersion(t.id)).toBe(before + 4)
    expect(env.s.channels.activeVersionOf(t.id)!.approvalStatus).toBe('references_imported')
    expect(env.s.channels.getTemplate(t.id)!.referenceCount).toBe(4)
  })

  it('enforces size and count limits and bumps the reference set on edits and deletes', () => {
    const { templateId } = gameVault()
    expect(() => style.addReference({ templateId, title: 'tiny', text: 'too short' })).toThrow(/too short/)
    const r = style.addReference({ templateId, title: 'One', text: refText('One') })
    const v1 = env.s.channels.referenceSetVersion(templateId)
    style.updateReference(r.id, { title: 'Renamed' })
    expect(env.s.channels.referenceSetVersion(templateId)).toBe(v1)
    style.updateReference(r.id, { text: refText('Changed') })
    expect(env.s.channels.referenceSetVersion(templateId)).toBe(v1 + 1)
    style.deleteReference(r.id)
    expect(env.s.channels.referenceSetVersion(templateId)).toBe(v1 + 2)
    for (let i = 0; i < 30; i++) style.addReference({ templateId, title: `R${i}`, text: refText(`Game ${i}`) })
    expect(() => style.addReference({ templateId, title: 'R31', text: refText('Too many') })).toThrow(/at most 30/)
  })
})

describe('fixed-text detection and analysis', () => {
  it('proposes repeated intro, heading and outro text with provenance, unlocked', () => {
    const refs = [{ text: refText('Alpha') }, { text: refText('Beta') }, { text: `${INTRO}\n\nGameplay\nGamma has a different body entirely, built around careful stealth.` }]
    const blocks = detectFixedText(refs)
    const intro = blocks.find((b) => b.kind === 'intro')!
    expect(intro.text).toBe(INTRO)
    expect(intro.provenance).toBe('consistent')
    const heading = blocks.find((b) => b.kind === 'heading' && b.text === 'Gameplay')!
    expect(heading.spoken).toBe(false)
    const outro = blocks.find((b) => b.text === OUTRO)!
    expect(outro.provenance).toBe('inferred')
    expect(outro.occurrences).toBe(2)
    expect(blocks.every((b) => !b.locked)).toBe(true)
    expect(detectFixedText([{ text: refText('Solo') }])).toEqual([])
  })

  it('never marks findings as confirmed, caveats single references and moves the format to template_extracted', async () => {
    const pt = env.s.channels.getByName('PlayTopia')!
    const t = env.s.channels.defaultTemplate(pt.id)!
    await expect(style.analyze(t.id)).rejects.toMatchObject({ code: 'REFERENCES_REQUIRED' })
    style.addReference({ templateId: t.id, title: 'Only one', text: refText('Alpha') })
    env.openai.analyzeStyleImpl = () => ({
      findings: [{ aspect: 'opening_wording', finding: 'Fixed greeting', provenance: 'consistent', evidence: 'Welcome to the Vault' }],
      sections: [], systemPrompt: 'p', unknowns: [], caveats: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test'
    })
    const single = await style.analyze(t.id)
    expect(single.caveats[0]).toMatch(/one example cannot establish/i)
    expect(single.fixedBlocks).toEqual([])
    expect(single.findings.every((f) => f.provenance !== 'user_confirmed')).toBe(true)
    style.addReference({ templateId: t.id, title: 'Two', text: refText('Beta') })
    style.addReference({ templateId: t.id, title: 'Three', text: refText('Gamma') })
    const a = await style.analyze(t.id, 'Max 4,700 characters.')
    expect(a.stats.count).toBe(3)
    expect(a.fixedBlocks.some((b) => b.kind === 'intro' && b.text === INTRO)).toBe(true)
    expect(a.referenceSetVersion).toBe(env.s.channels.referenceSetVersion(t.id))
    expect(env.s.channels.lastAnalysis(t.id)!.analyzedAt).toBe(a.analyzedAt)
    expect(env.s.channels.activeVersionOf(t.id)!.approvalStatus).toBe('template_extracted')
    const req = env.openai.calls.filter((c) => c.kind === 'analyzeStyle').pop()!.req as { instructions: string; references: unknown[] }
    expect(req.instructions).toContain('Max 4,700 characters.')
    expect(req.references).toHaveLength(3)
  })
})

describe('approval and gating', () => {
  function engineAndGen(): { engine: QueueEngine; gen: GenerationService } {
    const engine = new QueueEngine(env.s, new Logger().child('test'))
    return { engine, gen: new GenerationService(env.s, engine) }
  }

  it('refuses Fully automatic for unapproved formats, allows supervised modes with a warning, blocks unconfigured ones', async () => {
    const { engine, gen } = engineAndGen()
    const { channel, versionId } = gameVault()
    env.s.channels.setVersionStatus(versionId, 'provisional')
    const entries = [{ title: 'Emberward', channelId: null }]
    expect(() => gen.createBatch({ channelId: channel.id, mode: 'auto', entries, skipExisting: false })).toThrow(expect.objectContaining({ code: 'FORMAT_NOT_APPROVED' }))
    const est = gen.estimate({ channelId: channel.id, mode: 'review_before_voice', entries, skipExisting: false })
    expect(est.warnings.join(' ')).toMatch(/not approved/)
    const ok = gen.createBatch({ channelId: channel.id, mode: 'review_before_voice', entries, skipExisting: false })
    expect(ok.jobIds).toHaveLength(1)
    expect(env.s.jobs.get(ok.jobIds[0]!)!.overrides?.templateId).toBe(env.s.channels.getVersion(versionId)!.templateId)
    const nexora = env.s.channels.getByName('Nexora')!
    expect(() => gen.createBatch({ channelId: nexora.id, mode: 'review_before_voice', entries, skipExisting: false })).toThrow(expect.objectContaining({ code: 'FORMAT_NOT_CONFIGURED' }))
    style.setApproval(versionId, 'approved')
    expect(env.s.channels.getVersion(versionId)!.approvedAt).toBeTruthy()
    expect(gen.createBatch({ channelId: channel.id, mode: 'auto', entries: [{ title: 'Another', channelId: null }], skipExisting: false }).jobIds).toHaveLength(1)
    await engine.stop()
  })

  it('uses the chosen content type and refuses a format from another channel', () => {
    const { gen } = engineAndGen()
    const vp = env.s.channels.getByName('VoidPulse')!
    const types = env.s.channels.listTemplates(vp.id).map((t) => t.contentType)
    expect(types).toEqual(['review', 'gameplay'])
    const gameplay = env.s.channels.getTemplateByContentType(vp.id, 'gameplay')!
    const gv = gameVault()
    expect(() => gen.createBatch({ channelId: gv.channel.id, mode: 'review_before_voice', entries: [{ title: 'X', channelId: null }], skipExisting: false, templateId: gameplay.id })).toThrow(expect.objectContaining({ code: 'FORMAT_NOT_FOUND' }))
  })

  it('never edits an approved version in place and never lets the app approve on its own', () => {
    const { versionId, templateId } = gameVault()
    style.setApproval(versionId, 'approved')
    const blocks = [block('intro', INTRO, true)]
    const next = style.setFixedBlocks(versionId, blocks)
    expect(next.id).not.toBe(versionId)
    expect(next.approvalStatus).toBe('awaiting_approval')
    expect(env.s.channels.getVersion(versionId)!.fixedBlocks).toEqual([])
    expect(env.s.channels.activeVersionOf(templateId)!.id).toBe(versionId)
    expect(() => style.setApproval(versionId, 'test_passed')).toThrow(/style test/)
    const added = env.s.channels.addVersion(templateId, { systemPrompt: 'x', structure: [], exampleScript: null, notes: '', approvalStatus: 'approved' })
    expect(added.approvalStatus).toBe('awaiting_approval')
    const pt = env.s.channels.getByName('PlayTopia')!
    expect(() => style.setApproval(env.s.channels.activeVersionOf(env.s.channels.defaultTemplate(pt.id)!.id)!.id, 'approved')).toThrow(/placeholder/)
  })
})

describe('locked text and narration', () => {
  const channel = (): Channel => env.s.channels.getByName('Game Vault')!

  it('enforces locked intro, outro and headings word for word', () => {
    const tv = template({ fixedBlocks: [block('intro', INTRO), block('outro', OUTRO), block('heading', 'Gameplay', true, false)] })
    expect(validateFixedBlocks(refText('Alpha'), tv)).toEqual([])
    const reworded = refText('Alpha').replace('fair hearing', 'honest hearing')
    expect(validateFixedBlocks(reworded, tv).map((i) => i.code)).toEqual(['fixed_intro'])
    expect(validateFixedBlocks(`${refText('Alpha')} Subscribe!`, tv).map((i) => i.code)).toEqual(['fixed_outro'])
    expect(validateFixedBlocks(refText('Alpha').replace('Gameplay\n', ''), tv).map((i) => i.code)).toContain('fixed_heading')
    // Curly quotes / dashes / a leading title heading do not count as changes.
    expect(validateFixedBlocks(`Alpha Review\n${refText('Alpha')}`, template({ fixedBlocks: [block('intro', INTRO)] }))).toEqual([])
    expect(validateFixedBlocks(reworded, template({ fixedBlocks: [block('intro', INTRO, false)] }))).toEqual([])
    const report = validateScript(reworded, { channel: channel(), template: tv, expectedTitle: 'Alpha', researchConfirmed: true, strictness: 'standard' })
    expect(report.ok).toBe(false)
  })

  it('removes non-spoken headings from the ElevenLabs narration but keeps them in Script.txt', () => {
    const text = goodScript('Alpha')
    const narr = buildNarrationText(text, template({ structure: env.s.channels.activeVersionOf(gameVault().templateId)!.structure }), channel())
    expect(narr).not.toMatch(/^Gameplay$/m)
    expect(narr).toContain('Today we look at Alpha')
    const spoken = buildNarrationText(text, template({ headingsSpoken: true, structure: env.s.channels.activeVersionOf(gameVault().templateId)!.structure }), channel())
    expect(spoken).toMatch(/^Gameplay$/m)
  })

  it('records format provenance on generated scripts and writes Narration.txt', async () => {
    const engine = new QueueEngine(env.s, new Logger().child('test'))
    const gen = new GenerationService(env.s, engine)
    const { channel: gv, templateId } = gameVault()
    style.addReference({ templateId, title: 'Ref', text: refText('Ref') })
    engine.start()
    const { jobIds } = gen.createBatch({ channelId: gv.id, mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }], skipExisting: false })
    await waitFor(() => ['completed', 'failed'].includes(env.s.jobs.get(jobIds[0]!)!.status), 15000)
    const job = env.s.jobs.get(jobIds[0]!)!
    expect(job.status, job.lastError?.message).toBe('completed')
    const script = env.s.scripts.get(job.scriptId!)!
    expect(script.templateId).toBe(templateId)
    expect(script.contentType).toBe('review')
    expect(script.referenceSetVersion).toBe(env.s.channels.referenceSetVersion(templateId))
    expect(script.researchId).toBe(job.researchId)
    const dir = path.dirname(script.filePath!)
    expect(fs.readFileSync(path.join(dir, 'Narration.txt'), 'utf8')).not.toMatch(/^Gameplay$/m)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
    expect(meta.script.contentType).toBe('review')
    const writerReq = env.openai.calls.find((c) => c.kind === 'script')!.req as { references: Array<{ text: string }> }
    expect(writerReq.references[0]!.text).toContain('Welcome to the Vault')
    await engine.stop()
  })
})

describe('style test', () => {
  it('reports compliance checks without scores and records test_failed / test_passed', async () => {
    const { templateId, versionId } = gameVault()
    style.setApproval(versionId, 'approved')
    style.addReference({ templateId, title: 'Ref', text: goodScript('Ref') })
    env.openai.compareStyleImpl = () => ({ styleDeviations: [{ severity: 'error', message: 'Opening does not follow the references.' }], unsupportedClaims: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const failed = await style.runTest(templateId, 'Emberward')
    expect(failed.passed).toBe(false)
    expect(failed.checks.map((c) => c.key)).toEqual(['sections', 'order', 'intro', 'outro', 'fixed_text', 'length', 'prohibited', 'style', 'claims'])
    expect(JSON.stringify(failed.checks)).not.toMatch(/%/)
    expect(env.s.channels.getVersion(versionId)!.approvalStatus).toBe('test_failed')
    env.openai.compareStyleImpl = () => ({ styleDeviations: [], unsupportedClaims: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    style.setApproval(versionId, 'approved')
    const passed = await style.runTest(templateId, 'Emberward')
    expect(passed.passed).toBe(true)
    expect(env.s.channels.getVersion(versionId)!.approvalStatus).toBe('test_passed')
    expect(env.s.channels.listStyleTests(templateId)).toHaveLength(2)
    // Test scripts never enter the libraries.
    expect(env.s.scripts.count()).toBe(0)
    await expect(style.runTest(env.s.channels.defaultTemplate(env.s.channels.getByName('Nexora')!.id)!.id, 'X')).rejects.toMatchObject({ code: 'FORMAT_NOT_CONFIGURED' })
  })
})

describe('seed and upgrades', () => {
  it('creates 18 channels with the documented statuses and keeps branding out of prompts', () => {
    const fresh = createTestEnv({ approveSeeded: false })
    try {
      const names = fresh.s.channels.list().map((c) => c.name)
      expect(names).toEqual(SEED_CHANNELS.map((c) => c.channel.name))
      const status = (name: string, ct?: string): string => {
        const c = fresh.s.channels.getByName(name)!
        const t = ct ? fresh.s.channels.getTemplateByContentType(c.id, ct)! : fresh.s.channels.defaultTemplate(c.id)!
        return t.approvalStatus
      }
      expect(status('Game Vault')).toBe('provisional')
      expect(status('RENVO', 'youtube_review')).toBe('provisional')
      expect(status('RiftForge Tech', 'full_review')).toBe('provisional')
      expect(status('PlayTopia')).toBe('not_configured')
      expect(status('Nexora')).toBe('not_configured')
      expect(fresh.s.channels.listTemplates(fresh.s.channels.getByName('RiftForge Tech')!.id).map((t) => t.contentType)).toEqual(['full_review', 'unboxing', 'short_review'])
      expect(fresh.s.channels.getByName('PlayTopia')!.maxChars).toBe(4700)
      expect(fresh.s.channels.getByName('Game Vault')!.validation.forbiddenPhrases).toEqual(['AAA'])
      for (const c of fresh.s.channels.list()) {
        for (const t of fresh.s.channels.listTemplates(c.id)) {
          const v = fresh.s.channels.activeVersionOf(t.id)!
          expect(v.systemPrompt).not.toContain('Every game has its own rhythm')
          expect(v.systemPrompt).not.toContain('Three minutes. One game')
          expect(v.fixedBlocks).toEqual([])
          expect(v.approvalStatus).not.toBe('approved')
        }
      }
      expect(fresh.s.channels.getByName('VoidPulse')!.description).toContain('never narrated')
    } finally {
      fresh.cleanup()
    }
  })

  it('upgrades an untouched 1.1 install, adds the missing channels and never touches edited ones', () => {
    const old = createTestEnv({ seed: false })
    try {
      // Simulate the 1.0/1.1 seed.
      LEGACY_SEED_V1.forEach((seed, i) => {
        const c = old.s.channels.create({ ...seed.channel, position: i })
        const { version } = old.s.channels.createTemplate(c.id, seed.templateName, seed.template)
        old.s.channels.setVersionStatus(version.id, seed.template.placeholder ? 'not_configured' : 'provisional')
        old.s.channels.setActiveVersion(c.id, version.id)
      })
      old.s.settingsRepo.set('seeded_v1', true)
      const vp = old.s.channels.getByName('VoidPulse')!
      old.s.channels.addVersion(old.s.channels.defaultTemplate(vp.id)!.id, { systemPrompt: 'My own VoidPulse prompt', structure: [], exampleScript: null, notes: 'mine' })
      const gvBefore = old.s.channels.getByName('Game Vault')!
      old.s.channels.update(gvBefore.id, { elevenVoiceId: 'my-voice', maxChars: 6000 })
      seedDefaults(old.s)
      expect(old.s.channels.list()).toHaveLength(18)
      const gv = old.s.channels.getByName('Game Vault')!
      expect(gv.elevenVoiceId).toBe('my-voice')
      expect(gv.maxChars).toBe(6000)
      expect(gv.introRequirements).toBe('')
      const gvT = old.s.channels.defaultTemplate(gv.id)!
      expect(gvT.latestVersion).toBe(2)
      expect(gvT.approvalStatus).toBe('provisional')
      expect(old.s.channels.activeVersionOf(gvT.id)!.notes).toContain('[seed:v3]')
      expect(old.s.channels.listTemplates(old.s.channels.getByName('RiftForge Tech')!.id).map((t) => t.contentType)).toEqual(['full_review', 'unboxing', 'short_review'])
      const vpTemplates = old.s.channels.listTemplates(vp.id)
      expect(vpTemplates).toHaveLength(1)
      expect(old.s.channels.listVersions(vpTemplates[0]!.id)).toHaveLength(2)
      // Idempotent.
      seedDefaults(old.s)
      expect(old.s.channels.list()).toHaveLength(18)
    } finally {
      old.cleanup()
    }
  })

  it('migrates a 1.1 database (migration 3) keeping data and mapping statuses', () => {
    const file = path.join(tmp, 'old.sqlite')
    const raw = new DatabaseSync(file)
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    for (const m of MIGRATIONS.filter((m) => m.id <= 2)) {
      raw.exec(m.sql)
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x')
    }
    const ts = '2026-10-01T00:00:00.000Z'
    raw.prepare(`INSERT INTO channels (id, name, slug, validation_json, active_template_version_id, created_at, updated_at) VALUES ('c1','Game Vault','game-vault','{"narrateSectionHeadings":false}','v1',?,?)`).run(ts, ts)
    raw.prepare(`INSERT INTO templates (id, channel_id, name, created_at, updated_at) VALUES ('t1','c1','GV',?,?), ('t2','c1','GV alt',?,?)`).run(ts, ts, ts, ts)
    raw.prepare(`INSERT INTO template_versions (id, template_id, channel_id, version, system_prompt, placeholder, created_at) VALUES ('v1','t1','c1',1,'p',0,?), ('v2','t2','c1',1,'p',1,?)`).run(ts, ts)
    raw.prepare(`INSERT INTO projects (id, channel_id, title, title_normalized, folder_name, created_at, updated_at) VALUES ('p1','c1','Emberward','emberward','Emberward',?,?)`).run(ts, ts)
    raw.prepare(`INSERT INTO scripts (id, project_id, version, text, char_count, word_count, estimated_duration_sec, status, source, created_at) VALUES ('s1','p1',1,'Hello there',11,2,1,'validated','ai',?)`).run(ts)
    raw.close()
    const db = new Database(file)
    const env2 = { channels: new ChannelRepo(db), scripts: new ScriptRepo(db) }
    const t1 = env2.channels.getTemplate('t1')!
    expect(t1.activeVersionId).toBe('v1')
    expect(t1.approvalStatus).toBe('provisional')
    expect(new Set([t1.contentType, env2.channels.getTemplate('t2')!.contentType]).size).toBe(2)
    expect(env2.channels.getVersion('v2')!.approvalStatus).toBe('not_configured')
    expect(env2.channels.getVersion('v1')!.headingsSpoken).toBe(false)
    const s1 = env2.scripts.get('s1')!
    expect(s1.narrationText).toBe('Hello there')
    expect(s1.templateId).toBeNull()
    db.close()
  })

  it('export/import keeps formats, references and the user\'s approvals', () => {
    const { channel, templateId, versionId } = gameVault()
    style.addReference({ templateId, title: 'Ref', text: refText('Ref') })
    style.setApproval(versionId, 'approved')
    const backup = new BackupService(env.s)
    const exported = backup.exportChannel(channel.id)
    exported.channel.name = 'Game Vault PC2'
    const id = backup.importChannel(JSON.stringify(exported))
    const t = env.s.channels.defaultTemplate(id)!
    expect(t.contentType).toBe('review')
    expect(t.approvalStatus).toBe('approved')
    expect(env.s.channels.listReferences(t.id)).toHaveLength(1)
  })
})
